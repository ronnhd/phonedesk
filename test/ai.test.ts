import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchClaudeQuota, parseCredentials, parseUsage, readClaudeToken, tokenFingerprint, TOKEN_EXPIRED, UNAUTHORIZED_BACKOFF_MS } from "../src/ai/claude";
import { fetchCodexQuota, parseLatestRateLimits, toQuotaWindows } from "../src/ai/codex";
import { fetchAntigravityQuota, parseAgyUsage } from "../src/ai/antigravity";
import { claudeNeedsInput, codexNeedsInput, decodeProjectDir, listSessions, projectName, sessionState, summarizeClaudeTail, summarizeCodex } from "../src/ai/sessions";
import { AiHub } from "../src/ai";
import { petStateFromAge, startOfTodayIso } from "../src/ai/omniroute";
import { windowLabel } from "../src/ai/types";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const FUTURE = 4_102_444_800_000; // year 2100
const CREDS = JSON.stringify({ claudeAiOauth: { accessToken: "tok-123", refreshToken: "r", expiresAt: FUTURE, subscriptionType: "max" } });

describe("claude quota", () => {
  test("parseCredentials", () => {
    expect(parseCredentials(CREDS)).toEqual({ accessToken: "tok-123", plan: "Max", expiresAt: FUTURE });
    expect(parseCredentials("{}")).toBeNull();
    expect(parseCredentials("nope")).toBeNull();
  });

  test("token: file first, then keychain, never keychain off macOS", async () => {
    let kc = 0;
    const readKeychain = async () => { kc++; return CREDS; };
    const fromFile = await readClaudeToken({ readFile: async () => CREDS, readKeychain, platform: "darwin" });
    expect(fromFile?.accessToken).toBe("tok-123");
    expect(kc).toBe(0);
    const fromKc = await readClaudeToken({ readFile: async () => { throw new Error("ENOENT"); }, readKeychain, platform: "darwin" });
    expect(fromKc?.accessToken).toBe("tok-123");
    expect(kc).toBe(1);
    expect(await readClaudeToken({ readFile: async () => { throw new Error("x"); }, readKeychain, platform: "linux" })).toBeNull();
    expect(kc).toBe(1);
  });

  test("parseUsage maps windows, skips nulls", () => {
    const w = parseUsage({
      five_hour: { utilization: 37.5, resets_at: "2026-11-17T15:00:00.000Z" },
      seven_day: { utilization: 12, resets_at: "2026-11-20T00:00:00Z" },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 3 },
      extra_usage: { is_enabled: false },
    });
    expect(w.map((x) => [x.id, x.label, x.usedPercent])).toEqual([
      ["five_hour", "5 hours", 37.5],
      ["seven_day", "7 days", 12],
      ["seven_day_sonnet", "7 days · Sonnet", 3],
    ]);
    expect(w[0]!.resetsAt).toBe(Date.parse("2026-11-17T15:00:00.000Z"));
    expect(w[0]!.windowMinutes).toBe(300);
    expect(w[2]!.resetsAt).toBeUndefined();
  });

  test("read-only: expired tokens are skipped, a 401 backs the token off for 30 min by fingerprint, nothing is refreshed or stored", async () => {
    const calls: string[] = [];
    const net = async (url: string, init: any) => { calls.push(`${init.method ?? "GET"} ${url}`); return new Response("no", { status: 401 }); };
    const blocked = new Map<string, number>();
    const stale = JSON.stringify({ claudeAiOauth: { accessToken: "old-tok", refreshToken: "r", expiresAt: 1000, subscriptionType: "pro" } });
    const skip = await fetchClaudeQuota({ readFile: async () => stale, fetch: net as any, now: () => 5000, blocked });
    expect(skip.error).toBe(TOKEN_EXPIRED);
    expect(calls).toEqual([]); // never asked the API with an expired token

    const first = await fetchClaudeQuota({ readFile: async () => CREDS, fetch: net as any, now: () => 10_000, blocked });
    expect(first.error).toBe(TOKEN_EXPIRED);
    expect(calls).toEqual(["GET https://api.anthropic.com/api/oauth/usage"]);
    const fp = tokenFingerprint("tok-123");
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect([...blocked.keys()]).toEqual([fp]);
    expect(JSON.stringify([...blocked])).not.toContain("tok-123");
    expect(blocked.get(fp)).toBe(10_000 + UNAUTHORIZED_BACKOFF_MS);

    await fetchClaudeQuota({ readFile: async () => CREDS, fetch: net as any, now: () => 10_000 + UNAUTHORIZED_BACKOFF_MS - 1, blocked });
    expect(calls.length).toBe(1); // still waiting
    const ok = { five_hour: { utilization: 5 } };
    const again = await fetchClaudeQuota({ readFile: async () => CREDS, fetch: (async () => Response.json(ok)) as any, now: () => 10_000 + UNAUTHORIZED_BACKOFF_MS, blocked });
    expect(again.error).toBeUndefined();
    expect(blocked.size).toBe(0);
    // a different token is not blocked by the first one
    blocked.set(fp, Number.MAX_SAFE_INTEGER);
    const other = JSON.stringify({ claudeAiOauth: { accessToken: "tok-other", expiresAt: FUTURE } });
    expect((await fetchClaudeQuota({ readFile: async () => other, fetch: (async () => Response.json(ok)) as any, blocked })).error).toBeUndefined();
  });

  test("fetch sends the right headers; 401 keeps last values with an error", async () => {
    let seen: any;
    const ok = await fetchClaudeQuota(
      { readFile: async () => CREDS, now: () => 5, fetch: async (url, init) => { seen = { url, init }; return Response.json({ five_hour: { utilization: 10 } }); } },
    );
    expect(seen.url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect((seen.init.headers as any).Authorization).toBe("Bearer tok-123");
    expect((seen.init.headers as any)["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(ok).toMatchObject({ id: "claude", plan: "Max", updatedAt: 5 });
    expect(ok.error).toBeUndefined();

    const expired = await fetchClaudeQuota({ readFile: async () => CREDS, blocked: new Map(), fetch: async () => new Response("no", { status: 401 }) }, ok);
    expect(expired.error).toBe(TOKEN_EXPIRED);
    expect(expired.windows).toEqual(ok.windows);

    const nothing = await fetchClaudeQuota({ readFile: async () => { throw new Error("x"); }, platform: "linux" });
    expect(nothing.error).toContain("Sign in to Claude Code");
    const limited = await fetchClaudeQuota({ readFile: async () => CREDS, blocked: new Map(), fetch: async () => new Response("slow down", { status: 429 }) }, ok);
    expect(limited.error).toContain("rate limiting");
    expect(limited.windows).toEqual(ok.windows);
    const boom = await fetchClaudeQuota({ readFile: async () => CREDS, blocked: new Map(), fetch: async () => { throw new Error("offline"); } }, ok);
    expect(boom.windows).toEqual(ok.windows);
    expect(boom.error).toContain("offline");
  });
});

describe("codex quota", () => {
  const ev = (ts: string, primary: any, secondary: any = null, extra: any = {}) =>
    JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "token_count", rate_limits: { limit_id: "codex", primary, secondary, plan_type: "plus", ...extra } } });

  test("parseLatestRateLimits takes the newest line with a primary window", () => {
    const text = [
      ev("2026-11-17T01:00:00Z", { used_percent: 5, window_minutes: 300, resets_at: 2000000000 }),
      "garbage",
      ev("2026-11-17T02:00:00Z", { used_percent: 9, window_minutes: 300, resets_at: 2000000100 }, { used_percent: 30, window_minutes: 10080, resets_at: 2000500000 }),
      JSON.stringify({ timestamp: "x", payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: null } } }),
      JSON.stringify({ timestamp: "2026-11-17T03:00:00Z", payload: { rate_limits: { limit_id: "other", primary: { used_percent: 99 } } } }),
    ].join("\n");
    const r = parseLatestRateLimits(text)!;
    expect(r.plan).toBe("plus");
    expect(r.windows.map((w) => [w.id, w.usedPercent, w.windowMinutes, w.resetsAt])).toEqual([
      ["primary", 9, 300, 2000000100_000],
      ["secondary", 30, 10080, 2000500000_000],
    ]);
    expect(parseLatestRateLimits("")).toBeNull();
  });

  test("expired windows show as fresh", () => {
    const w = toQuotaWindows({ at: 0, windows: [{ id: "primary", usedPercent: 80, windowMinutes: 300, resetsAt: 1000 }] }, 5000);
    expect(w).toEqual([{ id: "primary", label: "5 hours", usedPercent: 0, windowMinutes: 300 }]);
  });

  test("labels", () => {
    expect([300, 10080, 43200, 45].map(windowLabel)).toEqual(["5 hours", "7 days", "30 days", "45 min"]);
  });

  test("fetchCodexQuota from a temp tree picks the newest event across files", async () => {
    const dir = tmp("pd-codex-");
    const day = join(dir, "sessions", "2026", "11", "17");
    mkdirSync(day, { recursive: true });
    mkdirSync(join(dir, "archived_sessions"));
    const future = Math.floor(Date.now() / 1000) + 3600;
    writeFileSync(join(day, "rollout-a.jsonl"), ev("2026-11-17T01:00:00Z", { used_percent: 10, window_minutes: 300, resets_at: future }) + "\n");
    writeFileSync(join(dir, "archived_sessions", "rollout-b.jsonl"), ev("2026-11-17T05:00:00Z", { used_percent: 42, window_minutes: 300, resets_at: future }) + "\n");
    const q = await fetchCodexQuota(dir);
    expect(q.windows[0]).toMatchObject({ usedPercent: 42, label: "5 hours" });
    expect(q.plan).toBe("Plus");
    expect((await fetchCodexQuota(tmp("pd-empty-"))).error).toContain("No Codex quota data");
  });
});

describe("antigravity", () => {
  const JSON_OUT = JSON.stringify({
    status: "SUCCESS",
    response: "x",
    command: { name: "usage", data: { groups: [
      { name: "Gemini Models", buckets: [
        { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.9, reset_time: "2026-11-21T04:53:28Z" },
        { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-11-17T14:57:18Z" },
      ] },
      { name: "Claude and GPT models", buckets: [{ id: "cg-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.25 }] },
    ] } },
  });
  test("parses buckets (remaining -> used)", () => {
    const w = parseAgyUsage(JSON_OUT);
    expect(w.map((x) => [x.id, x.label, x.usedPercent])).toEqual([
      ["gemini-weekly", "Gemini · 7 days", 10],
      ["gemini-5h", "Gemini · 5 hours", 0],
      ["cg-5h", "Claude/GPT · 5 hours", 75],
    ]);
    expect(w[0]!.windowMinutes).toBe(10080);
  });
  test("falls back to the tab separated response", () => {
    const resp = "Gemini Models\tWeekly Limit Remaining\t80%\t2026-11-21T04:53:28Z\nGemini Models\tFive Hour Limit Remaining\t100%\t2026-11-17T14:57:18Z\n";
    const w = parseAgyUsage(JSON.stringify({ response: resp }));
    expect(w.map((x) => [x.label, x.usedPercent])).toEqual([["Gemini · 7 days", 20], ["Gemini · 5 hours", 0]]);
    expect(parseAgyUsage("not json")).toEqual([]);
  });
  test("fetch: no binary, failure, success", async () => {
    expect((await fetchAntigravityQuota(async () => "", 1, null)).error).toContain("not installed");
    expect((await fetchAntigravityQuota(async () => { throw new Error("timed out"); }, 1, "/x/agy")).error).toContain("timed out");
    let argv: string[] = [];
    const ok = await fetchAntigravityQuota(async (a) => { argv = a; return JSON_OUT; }, 1, "/x/agy");
    expect(argv).toEqual(["/x/agy", "-p", "/usage", "--output-format", "json"]);
    expect(ok.windows.length).toBe(3);
  });
});

describe("sessions", () => {
  test("pure helpers", () => {
    expect(sessionState(1000, 5000, false)).toBe("working");
    expect(sessionState(1000, 40000, false)).toBe("idle");
    expect(sessionState(1000, 40000, true)).toBe("waiting");
    expect(projectName("/a/b/my-app/")).toBe("my-app");
    expect(decodeProjectDir("-Users-me-code-app")).toBe("app");
  });

  test("summarizeClaudeTail returns metadata but never text", () => {
    const tail = [
      JSON.stringify({ type: "user", cwd: "/w/proj", message: { role: "user", content: "SECRET PROMPT" } }),
      JSON.stringify({ type: "custom-title", customTitle: "Fix login", sessionId: "s" }),
      JSON.stringify({ type: "assistant", cwd: "/w/proj", message: { model: "claude-sonnet-5-5", content: [{ type: "text", text: "SECRET REPLY" }] } }),
      "{ truncated",
    ].join("\n");
    const info = summarizeClaudeTail(tail);
    expect(info).toEqual({ cwd: "/w/proj", model: "claude-sonnet-5-5", title: "Fix login" });
    expect(JSON.stringify(info)).not.toContain("SECRET");
  });

  test("summarizeCodex", () => {
    const head = `{"type":"session_meta","payload":{"id":"x","cwd":"/w/my codex","base_instructions":"..."`;
    const tail = `{"payload":{"type":"turn_context","model":"gpt-5"}}\n{"payload":{"type":"turn_context","model":"gpt-5.1-codex"}}`;
    expect(summarizeCodex(head, tail)).toEqual({ cwd: "/w/my codex", model: "gpt-5.1-codex" });
  });

  test("listSessions over temp dirs: recent only, state, waiting, newest first, max 12", async () => {
    const claude = tmp("pd-cl-");
    const codex = tmp("pd-cx-");
    const now = Date.now();
    const touch = (file: string, ageMs: number) => { const t = (now - ageMs) / 1000; utimesSync(file, t, t); };
    const mk = (dir: string, name: string, lines: any[], ageMs: number) => {
      mkdirSync(dir, { recursive: true });
      const f = join(dir, name);
      writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      touch(f, ageMs);
    };
    const U1 = "11111111-1111-4111-8111-111111111111";
    const U2 = "22222222-2222-4222-8222-222222222222";
    const U3 = "33333333-3333-4333-8333-333333333333";
    mk(join(claude, "projects", "-w-alpha"), `${U1}.jsonl`, [{ type: "assistant", cwd: "/w/alpha", message: { model: "claude-opus-5-5" } }], 5_000);
    mk(join(claude, "projects", "-w-beta"), `${U2}.jsonl`, [{ type: "assistant", cwd: "/w/beta", message: { model: "m" } }], 600_000);
    mk(join(claude, "projects", "-w-old"), `${U3}.jsonl`, [{ type: "assistant", cwd: "/w/old" }], 30 * 3600_000);
    const d = new Date(now);
    const day = join(codex, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    mk(day, `rollout-2026-x-${U3}.jsonl`, [{ type: "session_meta", payload: { cwd: "/w/gamma" } }, { payload: { type: "turn_context", model: "gpt-5" } }], 100_000);

    const list = await listSessions([], now, { claude, codex });
    expect(list.map((s) => [s.tool, s.project, s.state, s.model])).toEqual([
      ["claude", "alpha", "working", "claude-opus-5-5"],
      ["codex", "gamma", "idle", "gpt-5"],
      ["claude", "beta", "idle", "m"],
    ]);
    expect(list[0]!.id).toBe(U1);
    expect(list[1]!.id).toBe(U3);

    const waiting = await listSessions([{ source: "claude", sessionId: U2 }, { source: "codex", cwd: "/w/gamma" }], now, { claude, codex });
    expect(waiting.find((s) => s.project === "beta")!.state).toBe("waiting");
    expect(waiting.find((s) => s.project === "gamma")!.state).toBe("waiting");
    expect(waiting.find((s) => s.project === "alpha")!.state).toBe("working");

    // cap at 12
    for (let i = 0; i < 15; i++) {
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`;
      mk(join(claude, "projects", "-w-many"), `${id}.jsonl`, [{ type: "assistant", cwd: "/w/many" }], 1000 * (i + 1));
    }
    expect((await listSessions([], now, { claude, codex })).length).toBe(12);
  });
});

describe("needs input (finished turn)", () => {
  const now = 1_000_000_000;
  const L = (...o: any[]) => o.map((x) => JSON.stringify(x)).join("\n");
  const done = { type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "x" }] } };
  test("claude: last assistant message without a tool call, recent, no newer user entry", () => {
    expect(claudeNeedsInput(L({ type: "user" }, done), now - 30_000, now)).toBe(true);
    expect(claudeNeedsInput(L(done, { type: "custom-title" }), now - 30_000, now)).toBe(true);
    expect(claudeNeedsInput(L(done, { type: "user" }), now - 30_000, now)).toBe(false);
    expect(claudeNeedsInput(L({ type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "tool_use" }] } }), now - 30_000, now)).toBe(false);
    expect(claudeNeedsInput(L(done), now - 11 * 60_000, now)).toBe(false);
    expect(claudeNeedsInput(L(done), now - 5_000, now)).toBe(true);
    expect(claudeNeedsInput(L({ type: "assistant", message: { content: [{ type: "text" }] } }), now - 5_000, now)).toBe(false); // no stop reason, still writing
    expect(claudeNeedsInput("", now, now)).toBe(false);
  });
  test("codex: assistant message or task_complete last", () => {
    const msg = { type: "response_item", payload: { type: "message", role: "assistant" } };
    expect(codexNeedsInput(L(msg), now - 30_000, now)).toBe(true);
    expect(codexNeedsInput(L(msg, { type: "event_msg", payload: { type: "user_message" } }), now - 30_000, now)).toBe(false);
    expect(codexNeedsInput(L({ type: "response_item", payload: { type: "function_call" } }), now - 30_000, now)).toBe(false);
    expect(codexNeedsInput(L(msg), now - 11 * 60_000, now)).toBe(false);
  });
  test("listSessions: finished turn is waiting without prompt flag; a pending hint sets prompt", async () => {
    const claude = tmp("pd-cl2-");
    const dir = join(claude, "projects", "-w-zeta");
    mkdirSync(dir, { recursive: true });
    const U = "44444444-4444-4444-8444-444444444444";
    const f = join(dir, `${U}.jsonl`);
    const t0 = Date.now();
    writeFileSync(f, L({ type: "user", cwd: "/w/zeta" }, { ...done, cwd: "/w/zeta" }) + "\n");
    utimesSync(f, (t0 - 60_000) / 1000, (t0 - 60_000) / 1000);
    const a = (await listSessions([], t0, { claude, codex: tmp("pd-cx2-") }))[0]!;
    expect(a.state).toBe("waiting");
    expect(a.prompt).toBeUndefined();
    const b = (await listSessions([{ source: "claude", sessionId: U }], t0, { claude, codex: tmp("pd-cx2-") }))[0]!;
    expect(b).toMatchObject({ state: "waiting", prompt: true });
  });
});

describe("AiHub", () => {
  test("refresh respects the 5 min interval and reports changes", async () => {
    let t = 0;
    let claudeCalls = 0;
    const q = (id: any, pct: number) => ({ id, name: id, windows: [{ id: "w", label: "5 hours", usedPercent: pct }], updatedAt: 0 });
    let pct = 10;
    const hub = new AiHub(
      { claude: async () => { claudeCalls++; return q("claude", pct); }, codex: async () => q("codex", 1), antigravity: async () => { throw new Error("agy down"); }, sessions: async () => [] },
      () => t,
    );
    expect(await hub.refreshQuotas()).toBe(true);
    expect(await hub.refreshQuotas()).toBe(false);
    expect(claudeCalls).toBe(1);
    t = 4 * 60_000;
    await hub.refreshQuotas();
    expect(claudeCalls).toBe(1);
    t = 5 * 60_000;
    pct = 20;
    expect(await hub.refreshQuotas()).toBe(true);
    expect(claudeCalls).toBe(2);
    const snap = hub.snapshot();
    expect(snap.providers.map((p) => p.id)).toEqual(["omni", "claude", "codex", "antigravity", "opencode", "grok"]);
    expect(snap.providers[3]!.error).toContain("agy down");
  });

  test("startOfTodayIso uses local midnight", () => {
    const now = new Date(2026, 10, 21, 15, 42, 7);
    expect(startOfTodayIso(now)).toBe(new Date(2026, 10, 21).toISOString());
  });

  test("omni pet activity thresholds", () => {
    expect(petStateFromAge(0)).toBe("busy");
    expect(petStateFromAge(12_000)).toBe("busy");
    expect(petStateFromAge(12_001)).toBe("idle");
    expect(petStateFromAge(90_000)).toBe("idle");
    expect(petStateFromAge(90_001)).toBe("sleep");
    expect(petStateFromAge(Infinity)).toBe("sleep");
  });
});
