import { rawFetch } from "./_fetch";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WIN } from "./_os";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PHONEDESK_HOME = mkdtempSync(join(tmpdir(), "pd-srv-"));

const { startServer } = await import("../src/server");
const { SoundLibrary } = await import("../src/sounds");
const { isLocal } = await import("../src/net");
const { defaultLayout } = await import("../src/config");

const hookDir = mkdtempSync(join(tmpdir(), "pd-srv-hooks-"));
const q = (id: any) => ({ id, name: id, windows: [{ id: "w", label: "5 hours", usedPercent: 10 }], updatedAt: 1 });
let fakeSessions: any[] = [{ id: "s1", tool: "claude", project: "app", state: "idle", updatedAt: 1 }];
const fakeAi = {
  omni: async () => q("omni"),
  claude: async () => q("claude"),
  codex: async () => q("codex"),
  antigravity: async () => ({ ...q("antigravity"), windows: [], error: "agy is not installed" }),
  sessions: async () => fakeSessions,
};
const ran: any[] = [];
const volumeCalls: any[] = [];
let statsCb: (s: any) => void = () => {};
let fakeMedia: any = { app: "Music", title: "T1", artist: "A", album: "Al", playing: true, position: 10, duration: 200 };
const spawned: { argv: string[]; killed: boolean; finish: () => void }[] = [];
let app: Awaited<ReturnType<typeof startServer>>;
let base: string;
let token: string;
let deviceId: string;

function connect(tok: string, port = app.port) {
  const ws = new WebSocket(`ws://localhost:${port}/ws?token=${tok}`);
  const msgs: any[] = [];
  const waiters: Array<() => void> = [];
  ws.onmessage = (e) => { msgs.push(JSON.parse(String(e.data))); waiters.forEach((w) => w()); };
  const next = (pred: (m: any) => boolean, ms = 3000) =>
    new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), ms);
      const check = () => {
        const i = msgs.findIndex(pred);
        if (i >= 0) { clearTimeout(t); resolve(msgs.splice(i, 1)[0]); return true; }
        return false;
      };
      if (check()) return;
      const w = () => {
        if (check()) waiters.splice(waiters.indexOf(w), 1);
      };
      waiters.push(w);
    });
  const closed = new Promise<number>((r) => { ws.onclose = (e) => r(e.code); });
  return { ws, next, closed };
}

beforeAll(async () => {
  app = await startServer({
    port: 0,
    pin: "111111",
    deps: {
      runAction: async (a) => { ran.push(a); if (a.type === "shell" && a.command === "fail") throw new Error("boom"); },
      startStats: (cb) => {
        statsCb = cb;
        return () => {};
      },
      setVolume: async (v) => { volumeCalls.push(v); },
      readVolume: async () => ({ level: 33, muted: false }),
      readMedia: async () => fakeMedia,
      fetchArtwork: async () => "data:image/jpeg;base64,AAAA",
      topProcesses: async (sort, limit) => [{ pid: 1, name: `p-${sort}-${limit}`, cpu: 1.5, mem: 2048 }],
    },
    mediaPollMs: 40,
    aiSources: fakeAi,
    aiSessionsMs: 50,
    hookSecret: "test-secret",
    hostName: async () => "my-mac",
    sounds: new SoundLibrary({ home: mkdtempSync(join(tmpdir(), "pd-snd-home-")), run: async () => "estimated duration: 1.5 sec" }),
    soundSpawn: (argv) => {
      let finish!: () => void;
      const exited = new Promise<void>((r) => { finish = r; });
      const rec = { argv, killed: false, finish };
      spawned.push(rec);
      return { kill: () => { rec.killed = true; finish(); }, exited };
    },
    permissionTimeoutMs: 400,
    hookPaths: { claude: join(hookDir, "claude-settings.json"), codex: join(hookDir, "codex-hooks.json") },
  });
  base = `http://localhost:${app.port}`;
  const r = await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin: "111111", name: "t" }) });
  ({ token, deviceId } = await r.json() as any);
});
afterAll(() => app.stop());

describe("http", () => {
  test("isLocal", () => {
    expect(isLocal("127.0.0.1")).toBe(true);
    expect(isLocal("::1")).toBe(true);
    expect(isLocal("::ffff:127.0.0.1")).toBe(true);
    expect(isLocal("192.168.1.5")).toBe(false);
    expect(isLocal(undefined)).toBe(false);
  });

  test("bad pin -> 401", async () => {
    const r = await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin: "999999" }) });
    expect(r.status).toBe(401);
  });

  test("static routes", async () => {
    const r = await fetch(`${base}/editor`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/manage/");
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  test("GET /api/about: version, build, commit, platform; localhost only; no network", async () => {
    const { DECK_BUILD } = await import("../src/assets.gen");
    const a = await (await fetch(`${base}/api/about`)).json() as any;
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    expect(a).toMatchObject({ name: "PhoneDesk", version: pkg.version, build: DECK_BUILD, repo: "https://github.com/howznguyen/phonedesk", license: "MIT" });
    expect(typeof a.commit).toBe("string");
    expect(typeof a.dirty).toBe("boolean");
    expect(Number.isNaN(Date.parse(a.builtAt))).toBe(false);
    expect(["darwin", "win32", "linux"]).toContain(a.platform);
    expect(a.arch).toBeTruthy();
    expect(a.bun).toBe(Bun.version);
    expect((await fetch(`${base}/api/about`, { headers: { host: "evil.example" } })).status).toBeGreaterThanOrEqual(400);
    expect((await fetch(`${base}/api/about`, { method: "POST" })).status).not.toBe(200);
  });

  test("pairing endpoints (localhost)", async () => {
    const a = await (await fetch(`${base}/api/pairing`)).json() as any;
    expect(a.pin).toBe("111111");
    expect(a.port).toBe(app.port);
    expect(a.url).toBe(`http://${a.lanIp}:${a.port}/?pin=111111`);
    expect((await fetch(`${base}/api/pairing/regenerate`)).status).toBe(405);
    const b = await (await fetch(`${base}/api/pairing/regenerate`, { method: "POST" })).json() as any;
    expect(b.pin).toMatch(/^\d{6}$/);
    expect(app.pin).toBe(b.pin);
  });

  test("PUT /api/layout validates", async () => {
    const r = await fetch(`${base}/api/layout`, { method: "PUT", body: JSON.stringify({ pages: [] }) });
    expect(r.status).toBe(400);
    expect((await r.json() as any).error).toContain("at least one page");
  });
});

describe("websocket", () => {
  test("invalid token closes 4401", async () => {
    const c = connect("bad");
    expect(await c.closed).toBe(4401);
  });

  test("hello, layout, ping, press", async () => {
    const c = connect(token);
    const hello = await c.next((m) => m.type === "hello");
    expect(hello.deviceId).toBe(deviceId);
    expect(hello.pages.length).toBeGreaterThan(0);
    await c.next((m) => m.type === "layout");

    c.ws.send(JSON.stringify({ type: "ping" }));
    await c.next((m) => m.type === "pong");

    c.ws.send(JSON.stringify({ type: "press", reqId: 1, pageId: "home", itemId: "b-web" }));
    expect(await c.next((m) => m.type === "result")).toEqual({ type: "result", reqId: 1, ok: true });
    expect(ran.at(-1)).toEqual({ type: "open", target: "https://github.com" });

    c.ws.send(JSON.stringify({ type: "press", reqId: 2, pageId: "home", itemId: "b-dev" }));
    expect((await c.next((m) => m.reqId === 2)).ok).toBe(true);
    expect(ran.length).toBe(1); // page action not run

    c.ws.send(JSON.stringify({ type: "press", reqId: 3, pageId: "home", itemId: "missing" }));
    expect((await c.next((m) => m.reqId === 3)).ok).toBe(false);
    c.ws.close();
  });

  test("runAction error -> result error; layout save pushes", async () => {
    const c = connect(token);
    await c.next((m) => m.type === "layout");
    const layout = defaultLayout();
    layout.pages.find((p) => p.id === "home")!.items.push({ id: "b-fail", kind: "button", label: "F", action: { type: "shell", command: "fail" } });
    const r = await fetch(`${base}/api/layout`, { method: "PUT", body: JSON.stringify(layout) });
    expect(r.status).toBe(200);
    const pushed = await c.next((m) => m.type === "layout");
    expect(pushed.layout.pages.find((p: any) => p.id === "home").items.some((i: any) => i.id === "b-fail")).toBe(true);
    c.ws.send(JSON.stringify({ type: "press", reqId: 9, pageId: "home", itemId: "b-fail" }));
    expect(await c.next((m) => m.reqId === 9)).toEqual({ type: "result", reqId: 9, ok: false, error: "boom" });
    c.ws.close();
  });

  test("lastSeen updates and DELETE device revokes", async () => {
    const c = connect(token);
    await c.next((m) => m.type === "layout");
    await Bun.sleep(100);
    const devs = await (await fetch(`${base}/api/devices`)).json() as any[];
    // bun runs test files in one process, so devices.json may hold other files' devices
    const mine = devs.find((d) => d.id === deviceId);
    expect(mine.lastSeen).toBeTruthy();
    expect(mine.tokenHash).toBeUndefined();
    const del = await fetch(`${base}/api/devices/${deviceId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    await c.next((m) => m.type === "pair-revoked");
    expect(await c.closed).toBe(4403);
    const again = connect(token);
    expect(await again.closed).toBe(4401);
  });
});

describe("media and volume", () => {
  let token: string; // the revoke test above deletes the first device, so pair a fresh one
  beforeAll(async () => {
    const r = await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin: app.pin, name: "m" }) });
    ({ token } = await r.json() as any);
  });

  test("media on connect, change push, artwork only on track change, polling stops with no sockets", async () => {
    const c = connect(token);
    await c.next((m) => m.type === "layout");
    const first = await c.next((m) => m.type === "media" && m.media?.title === "T1" && m.media.artwork);
    expect(first.media.artwork).toStartWith("data:image/jpeg");

    fakeMedia = { ...fakeMedia, playing: false };
    const paused = await c.next((m) => m.type === "media" && m.media?.playing === false);
    expect(paused.media.artwork).toBeUndefined();
    expect(paused.media.title).toBe("T1");

    fakeMedia = { ...fakeMedia, title: "T2" };
    const t2 = await c.next((m) => m.type === "media" && m.media?.title === "T2");
    expect(t2.media.artwork).toStartWith("data:image/jpeg");

    fakeMedia = null;
    expect((await c.next((m) => m.type === "media" && m.media === null)).media).toBeNull();

    // a new connection gets the current value straight away
    fakeMedia = { app: "Spotify", title: "S", artist: "B", album: "", playing: true, position: 1, duration: 2 };
    const d = connect(token);
    const hello = await d.next((m) => m.type === "media");
    expect(hello.media === null || hello.media.title === "S").toBe(true);
    c.ws.close();
    d.ws.close();
    fakeMedia = { app: "Music", title: "T1", artist: "A", album: "Al", playing: true, position: 10, duration: 200 };
  });

  test("media/volume commands validate strictly and answer result", async () => {
    const c = connect(token);
    await c.next((m) => m.type === "layout");
    const ask = async (msg: any) => {
      c.ws.send(JSON.stringify(msg));
      return c.next((m) => m.type === "result" && m.reqId === msg.reqId);
    };
    expect((await ask({ type: "media", reqId: 1, command: "next" })).ok).toBe(true);
    expect(ran.at(-1)).toEqual({ type: "media", command: "next" });
    expect((await ask({ type: "media", reqId: 2, command: "rm -rf" })).ok).toBe(false);
    expect((await ask({ type: "volume", reqId: 3, level: 40 })).ok).toBe(true);
    expect(volumeCalls.at(-1)).toEqual({ level: 40 });
    expect((await ask({ type: "volume", reqId: 4, muted: true })).ok).toBe(true);
    expect(volumeCalls.at(-1)).toEqual({ muted: true });
    const n = volumeCalls.length;
    for (const [i, bad] of [{ level: 101 }, { level: 1.5 }, { level: "5" }, { muted: "yes" }, {}, { level: 5, muted: true }].entries()) {
      const r = await ask({ type: "volume", reqId: 10 + i, ...bad });
      expect(r.ok).toBe(false);
    }
    expect(volumeCalls.length).toBe(n);

    // after a volume change a fresh stats message with the new volume is pushed
    statsCb({ cpu: 1, memUsed: 1, memTotal: 2, uptime: 1, load: [0, 0, 0], time: 1, host: "h", net: { rx: 0, tx: 0 }, volume: null });
    await c.next((m) => m.type === "stats");
    await ask({ type: "volume", reqId: 30, level: 33 });
    const st = await c.next((m) => m.type === "stats");
    expect(st.stats.volume).toEqual({ level: 33, muted: false });
    c.ws.close();
  });
});

describe("AI, permissions, integrations, processes", () => {
  let token: string;
  beforeAll(async () => {
    const r = await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin: app.pin, name: "ai" }) });
    ({ token } = await r.json() as any);
  });
  const hook = (body: any, secret: string | null = "test-secret") =>
    fetch(`${base}/api/hooks/permission`, {
      method: "POST",
      headers: secret ? { "x-phonedesk-hook": secret } : {},
      body: JSON.stringify(body),
    });
  const toolCall = { source: "claude", toolName: "Bash", toolInput: { command: "ls" }, cwd: "/w/app", sessionId: "s1" };

  test("ai snapshot on connect and sessions change push", async () => {
    const c = connect(token);
    // earlier tests may already have loaded the hub, so the connect snapshot can be complete
    const loaded = await c.next((m) => m.type === "ai" && m.ai.providers[0].windows.length > 0 && m.ai.sessions.length > 0);
    expect(loaded.ai.providers.map((p: any) => p.id)).toEqual(["omni", "claude", "codex", "antigravity", "opencode", "grok"]);
    expect(loaded.ai.providers[0].windows[0].usedPercent).toBe(10);
    expect(loaded.ai.sessions[0]).toMatchObject({ tool: "claude", project: "app", state: "idle" });
    fakeSessions = [{ ...fakeSessions[0], state: "working" }];
    const changed = await c.next((m) => m.type === "ai" && m.ai.sessions[0]?.state === "working");
    expect(changed.ai.sessions.length).toBe(1);
    c.ws.close();
  });

  test("hook endpoint: secret required; no phone -> null at once", async () => {
    expect((await hook(toolCall, null)).status).toBe(401);
    expect((await hook(toolCall, "wrong")).status).toBe(401);
    expect((await hook({ source: "x" })).status).toBe(400);
    await Bun.sleep(150); // let sockets closed by earlier tests drain
    const t0 = Date.now();
    expect(await (await hook(toolCall)).json()).toEqual({ decision: null });
    expect(Date.now() - t0).toBeLessThan(300);
  });

  test("permission flow: push, first answer wins, resolved broadcast", async () => {
    const a = connect(token);
    const b = connect(token);
    await a.next((m) => m.type === "ai");
    await b.next((m) => m.type === "ai");
    const pending = hook(toolCall);
    const pa = await a.next((m) => m.type === "permission");
    const pb = await b.next((m) => m.type === "permission");
    expect(pa.request).toMatchObject({ source: "claude", project: "app", tool: "Bash", summary: "ls" });
    expect(pb.request.id).toBe(pa.request.id);

    a.ws.send(JSON.stringify({ type: "permission-answer", reqId: 1, id: pa.request.id, decision: "allow" }));
    expect((await a.next((m) => m.type === "result" && m.reqId === 1)).ok).toBe(true);
    b.ws.send(JSON.stringify({ type: "permission-answer", reqId: 2, id: pa.request.id, decision: "deny" }));
    expect((await b.next((m) => m.type === "result" && m.reqId === 2)).ok).toBe(false);
    expect(await (await pending).json()).toEqual({ decision: "allow" });
    expect(await a.next((m) => m.type === "permission-resolved")).toEqual({ type: "permission-resolved", id: pa.request.id, decision: "allow" });
    expect((await b.next((m) => m.type === "permission-resolved")).decision).toBe("allow");

    a.ws.send(JSON.stringify({ type: "permission-answer", reqId: 3, id: "x", decision: "maybe" }));
    expect((await a.next((m) => m.reqId === 3)).ok).toBe(false);
    a.ws.close();
    b.ws.close();
  });

  test("permission timeout answers null; a late phone gets pending ones on connect", async () => {
    const a = connect(token);
    await a.next((m) => m.type === "ai");
    const pending = hook(toolCall);
    const p = await a.next((m) => m.type === "permission");
    const late = connect(token);
    expect((await late.next((m) => m.type === "permission")).request.id).toBe(p.request.id);
    expect(await (await pending).json()).toEqual({ decision: null });
    expect((await a.next((m) => m.type === "permission-resolved")).decision).toBe("timeout");
    a.ws.close();
    late.ws.close();
  });

  test("processes", async () => {
    const c = connect(token);
    await c.next((m) => m.type === "ai");
    c.ws.send(JSON.stringify({ type: "processes", reqId: 5, sort: "mem", limit: 3 }));
    expect(await c.next((m) => m.type === "processes")).toEqual({ type: "processes", reqId: 5, sort: "mem", processes: [{ pid: 1, name: "p-mem-3", cpu: 1.5, mem: 2048 }] });
    c.ws.send(JSON.stringify({ type: "processes", reqId: 6, sort: "name" }));
    expect((await c.next((m) => m.reqId === 6)).ok).toBe(false);
    c.ws.close();
  });

  test("integrations: status, install, idempotent, uninstall (temp files only)", async () => {
    const status = async () => await (await fetch(`${base}/api/integrations`)).json() as any;
    let s = await status();
    expect(s.claude).toMatchObject({ installed: false, settingsPath: join(hookDir, "claude-settings.json") });
    expect(s.claude.quota.ok).toBe(true);
    expect(s.antigravity.quota).toMatchObject({ ok: false, error: "agy is not installed" });
    expect(Array.isArray(s.antigravity.quota.windows)).toBe(true);
    expect(typeof s.antigravity.available).toBe("boolean");
    expect(s.claude.quota.source).toBe("claude-code");

    const post = await (await fetch(`${base}/api/integrations/claude/hook`, { method: "POST" })).json() as any;
    expect(post).toMatchObject({ ok: true, changed: true, installed: true });
    expect((await status()).claude.installed).toBe(true);
    expect((await status()).codex.installed).toBe(false);
    expect((await (await fetch(`${base}/api/integrations/claude/hook`, { method: "POST" })).json() as any).changed).toBe(false);
    const del = await (await fetch(`${base}/api/integrations/claude/hook`, { method: "DELETE" })).json() as any;
    expect(del).toMatchObject({ ok: true, changed: true, installed: false });
    expect((await status()).claude.installed).toBe(false);
    expect((await fetch(`${base}/api/integrations/nope/hook`, { method: "POST" })).status).toBe(404);
  });
});

describe("quotas are read-only: no OAuth routes", () => {
  test("the account and login routes are gone", async () => {
    for (const [method, path] of [["GET", "/api/accounts"], ["POST", "/api/accounts/claude/login"], ["GET", "/api/accounts/login/x"], ["POST", "/api/accounts/refresh"], ["DELETE", "/api/accounts/x"]] as const) {
      expect([404, 405]).toContain((await fetch(`${base}${path}`, { method })).status);
    }
  });

  test("/api/integrations reports the read-only source and a readable reason", async () => {
    const s = await (await fetch(`${base}/api/integrations`)).json() as any;
    expect(s.claude.quota.source).toBe("claude-code");
    expect(s.codex.quota.source).toBe("codex-sessions");
    expect(s.antigravity.quota.source).toBe("antigravity-local");
    expect(s.antigravity.quota).toMatchObject({ ok: false, error: "agy is not installed", reason: "agy is not installed" });
    expect(s.claude.quota.ok).toBe(true);
    expect("reason" in s.claude.quota).toBe(false);
    expect(JSON.stringify(s)).not.toContain("accounts");
  });
});

describe("permissions: no policy", () => {
  test("every request goes to the phone, risk is display only, scope is ignored; policy endpoints are gone", async () => {
    const hookReq = (cmd: string) => fetch(`${base}/api/hooks/permission`, { method: "POST", headers: { "x-phonedesk-hook": "test-secret" }, body: JSON.stringify({ source: "claude", toolName: "Bash", toolInput: { command: cmd }, cwd: "/w/app", sessionId: "sx" }) });
    await Bun.sleep(500); // let earlier tests' pending requests expire
    const fresh = await (await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin: app.pin, name: "np" }) })).json() as any; // earlier tests may have revoked `token`
    const c = connect(fresh.token);
    await c.next((m) => m.type === "ai");
    for (const [cmd, risk, scope] of [["ls", "low", "always"], ["ls", "low", "session"], ["sudo ls", "high", undefined]] as const) {
      const pending = hookReq(cmd);
      const { request } = await c.next((m) => m.type === "permission" && m.request.sessionId === "sx");
      expect(request).toMatchObject({ risk, sessionId: "sx" });
      c.ws.send(JSON.stringify({ type: "permission-answer", reqId: 1, id: request.id, decision: "allow", ...(scope ? { scope } : {}) }));
      expect(await (await pending).json()).toEqual({ decision: "allow" }); // asked again every time
    }
    c.ws.close();
    for (const [m, p] of [["GET", "policy"], ["PUT", "policy"], ["GET", "history"], ["GET", "pending"], ["DELETE", "rules/x"], ["POST", "x/answer"]] as const) {
      expect([p, (await fetch(`${base}/api/permissions/${p}`, { method: m })).status]).toEqual([p, 404]);
    }
    expect((await fetch(`${base}/api/events`)).status).toBe(404);
  });
});


describe("media: nothing playing, resume, open", () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let u: string;
  let tok: string;
  let playing: any = { app: "Spotify", title: "Song", artist: "Art", album: "Alb", playing: true, position: 61, duration: 180 };
  const resumed: any[] = [];
  const opened: any[] = [];
  const lastFile = join(mkdtempSync(join(tmpdir(), "pd-lastsrv-")), "last-media.json");
  const mk = async () => startServer({
    port: 0, pin: "444444", mediaPollMs: 40, lastMediaFile: lastFile, hookSecret: "k",
    deps: {
      runAction: async () => {}, startStats: () => () => {}, setVolume: async () => {}, readVolume: async () => null,
      readMedia: async () => playing, fetchArtwork: async () => "data:image/jpeg;base64,AAAA",
      resumeMedia: async (a) => { resumed.push(a); if (a === "boom") throw new Error("cannot play"); },
      openMediaApp: async (a) => { opened.push(a); },
      topProcesses: async () => [],
    },
    aiSources: { claude: async () => q("claude"), codex: async () => q("codex"), antigravity: async () => q("antigravity"), sessions: async () => [] },
    hookPaths: { claude: join(hookDir, "c4.json"), codex: join(hookDir, "x4.json") },
  });
  beforeAll(async () => {
    srv = await mk();
    u = `http://localhost:${srv.port}`;
    ({ token: tok } = await (await fetch(`${u}/api/pair`, { method: "POST", body: JSON.stringify({ pin: "444444", name: "m" }) })).json() as any);
  });
  afterAll(() => srv.stop());

  test("last rides along only when media is null, and is persisted and reloaded", async () => {
    const c = connect(tok, srv.port);
    const live = await c.next((m) => m.type === "media" && m.media?.title === "Song");
    expect("last" in live).toBe(false);
    await Bun.sleep(150);
    playing = null;
    const idle = await c.next((m) => m.type === "media" && m.media === null && m.last); // (the connect-time null, sent before the first poll, has no last)
    expect(idle.last).toMatchObject({ app: "Spotify", title: "Song", artist: "Art", album: "Alb", duration: 180, position: 61, artwork: "data:image/jpeg;base64,AAAA", at: expect.any(Number) });
    expect(JSON.parse(readFileSync(lastFile, "utf8")).title).toBe("Song");
    c.ws.close();
    // a new connection while idle gets it at once, and a restarted agent still has it
    const d = connect(tok, srv.port);
    expect((await d.next((m) => m.type === "media")).last.title).toBe("Song");
    d.ws.close();
    srv.stop();
    srv = await mk();
    u = `http://localhost:${srv.port}`;
    ({ token: tok } = await (await fetch(`${u}/api/pair`, { method: "POST", body: JSON.stringify({ pin: "444444", name: "m2" }) })).json() as any);
    const e = connect(tok, srv.port);
    expect((await e.next((m) => m.type === "media" && m.media === null)).last).toMatchObject({ title: "Song", app: "Spotify" });
    e.ws.close();
  });

  test("resume and open: validated, answered, last app is passed; failures are reported", async () => {
    const c = connect(tok, srv.port);
    await c.next((m) => m.type === "media");
    const ask = async (msg: any) => { c.ws.send(JSON.stringify(msg)); return c.next((m) => m.type === "result" && m.reqId === msg.reqId); };
    expect((await ask({ type: "media", reqId: 1, command: "resume" })).ok).toBe(true);
    expect(resumed.at(-1)).toBe("Spotify"); // app of the last track
    expect((await ask({ type: "media", reqId: 2, command: "open", app: "Music" })).ok).toBe(true);
    expect(opened).toEqual(["Music"]);
    for (const [i, bad] of [{ command: "open" }, { command: "open", app: "Safari" }, { command: "resume2" }].entries()) {
      const r = await ask({ type: "media", reqId: 10 + i, ...bad });
      expect(r.ok).toBe(false);
    }
    expect(opened).toEqual(["Music"]);
    expect(resumed.length).toBe(1);
    // fresh media is pushed after a command
    playing = { app: "Spotify", title: "Resumed", artist: "Art", album: "", playing: true, position: 61, duration: 180 };
    await ask({ type: "media", reqId: 3, command: "resume" });
    expect((await c.next((m) => m.type === "media" && m.media?.title === "Resumed")).media.playing).toBe(true);
    c.ws.close();
  });
});

describe("icons, apps, layout assets, near-end polling, quota history", () => {
  const { Icons } = require("../src/icons") as typeof import("../src/icons");
  const { ICONS, BRANDS, ICON_ALIASES } = require("../web/shared/icons") as typeof import("../web/shared/icons");
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
  let srv: Awaited<ReturnType<typeof startServer>>;
  let u: string;
  let tok: string;
  let reads = 0;
  let track: any = { app: "Music", title: "Long", artist: "A", album: "", playing: true, position: 10, duration: 400 };
  const appsRoot = mkdtempSync(join(tmpdir(), "pd-srvapps-"));
  const sipsCalls: string[][] = [];
  const catalogName = (() => {
    const cat = JSON.parse(readFileSync(join(import.meta.dir, "..", "web", "shared", "icon-catalog.json"), "utf8")).icons as Record<string, any>;
    return Object.keys(cat).find((n) => !(n in ICONS) && !(n in BRANDS) && !(n in ICON_ALIASES))!;
  })();
  let originalLayout: any;

  beforeAll(async () => {
    const app = join(appsRoot, "Zed.app", "Contents");
    require("node:fs").mkdirSync(join(app, "Resources"), { recursive: true });
    require("node:fs").writeFileSync(join(app, "Info.plist"), JSON.stringify({ CFBundleIdentifier: "dev.zed.Zed", CFBundleName: "Zed", CFBundleIconFile: "z" }));
    require("node:fs").writeFileSync(join(app, "Resources", "z.icns"), "icns");
    const run = async (argv: string[]) => {
      if (argv[0] === "plutil") return readFileSync(argv[5]!, "utf8");
      sipsCalls.push(argv);
      if (argv[1] === "-g") return "pixelWidth: 300\\npixelHeight: 300".replace(/\\n/g, "\n");
      require("node:fs").writeFileSync(argv[argv.indexOf("--out") + 1]!, PNG);
      return "";
    };
    srv = await startServer({
      port: 0, pin: "555555", mediaPollMs: 1500, hookSecret: "k", lastMediaFile: join(mkdtempSync(join(tmpdir(), "pd-lm-")), "l.json"),
      quotaHistoryFile: join(mkdtempSync(join(tmpdir(), "pd-qhs-")), "qh.json"),
      icons: new Icons({ home: mkdtempSync(join(tmpdir(), "pd-ic-")), dirs: [appsRoot], run, catalog: async () => readFileSync(join(import.meta.dir, "..", "web", "shared", "icon-catalog.json"), "utf8") }),
      deps: { runAction: async () => {}, startStats: () => () => {}, setVolume: async () => {}, readVolume: async () => null, readMedia: async () => { reads++; return track; }, fetchArtwork: async () => undefined, topProcesses: async () => [] },
      aiSources: { omni: async () => q("omni"), claude: async () => q("claude"), codex: async () => q("codex"), antigravity: async () => q("antigravity"), sessions: async () => [] },
      hookPaths: { claude: join(hookDir, "c5.json"), codex: join(hookDir, "x5.json") },
    });
    u = `http://localhost:${srv.port}`;
    ({ token: tok } = await (await fetch(`${u}/api/pair`, { method: "POST", body: JSON.stringify({ pin: "555555", name: "i" }) })).json() as any);
    originalLayout = await (await fetch(`${u}/api/layout`)).json();
  });
  afterAll(async () => {
    if (originalLayout) await fetch(`${u}/api/layout`, { method: "PUT", body: JSON.stringify(originalLayout) });
    srv.stop();
  });

  test.skipIf(WIN)("apps and app icons", async () => {
    expect(await (await fetch(`${u}/api/apps`)).json()).toEqual([{ name: "Zed", bundleId: "dev.zed.Zed", path: join(appsRoot, "Zed.app"), category: null }]);
    const r = await fetch(`${u}/api/apps/icon?bundleId=dev.zed.Zed`);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(PNG);
    expect((await fetch(`${u}/api/apps/icon?bundleId=com.none`)).status).toBe(404);
    expect((await fetch(`${u}/api/apps/icon?bundleId=a%3Bb`)).status).toBe(400);
    expect((await fetch(`${u}/api/apps/icon`)).status).toBe(400);
  });

  test.skipIf(WIN)("uploads: validation, round trip, delete", async () => {
    const post = (body: any, type = "image/png") => fetch(`${u}/api/icons`, { method: "POST", headers: { "content-type": type }, body });
    expect((await post("<svg/>", "image/svg+xml")).status).toBe(415);
    expect((await post("not an image")).status).toBe(400);
    expect((await post(new Uint8Array(512 * 1024 + 10).fill(1))).status).toBe(413);
    const ok = await post(PNG);
    expect(ok.status).toBe(200);
    const { id } = await ok.json() as any;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    const img = await fetch(`${u}/api/icons/img/${id}`);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
    expect((await fetch(`${u}/api/icons/img/zzzz`)).status).toBe(400);
    expect((await fetch(`${u}/api/icons/img/0123456789abcdef`)).status).toBe(404);
    expect((await fetch(`${u}/api/icons/img/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${u}/api/icons/img/${id}`, { method: "DELETE" })).status).toBe(404);
    expect((await fetch(`${u}/api/icons/img/${id}`)).status).toBe(404);
  }, 20000);

  test("catalog: json, gzip when accepted, long cache", async () => {
    const plain = await fetch(`${u}/api/icons/catalog`, { headers: { "accept-encoding": "identity" } });
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(plain.headers.get("cache-control")).toContain("max-age=");
    const j = await plain.json() as any;
    expect(Object.keys(j.icons).length).toBeGreaterThan(5000);
    const gz = await fetch(`${u}/api/icons/catalog`, { headers: { "accept-encoding": "gzip" }, decompress: false } as any);
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(Number(gz.headers.get("content-length") ?? (await gz.clone().arrayBuffer()).byteLength)).toBeLessThan(JSON.stringify(j).length / 2);
  });

  test.skipIf(WIN)("layout assets on connect and on every save; only what the deck lacks", async () => {
    const id = (await (await fetch(`${u}/api/icons`, { method: "POST", headers: { "content-type": "image/png" }, body: PNG })).json() as any).id;
    const layout = JSON.parse(JSON.stringify(originalLayout));
    const items = layout.pages.flatMap((p: any) => p.items).filter((i: any) => i.kind === "button");
    items[0].icon = catalogName;
    items[1].icon = "app:dev.zed.Zed";
    items[2].icon = `img:${id}`;
    items[3].icon = "🙂";
    const c = connect(tok, srv.port);
    await c.next((m) => m.type === "layout");
    expect((await fetch(`${u}/api/layout`, { method: "PUT", body: JSON.stringify(layout) })).status).toBe(200);
    const pushed = await c.next((m) => m.type === "layout" && m.assets && Object.keys(m.assets).length > 0);
    expect(Object.keys(pushed.assets).sort()).toEqual([catalogName, "app:dev.zed.Zed", `img:${id}`].sort());
    expect(typeof pushed.assets[catalogName].svg).toBe("string");
    expect(["O", "F"]).toContain(pushed.assets[catalogName].variant);
    expect(pushed.assets["app:dev.zed.Zed"].img).toStartWith("data:image/png;base64,");
    expect(pushed.assets[`img:${id}`].img).toStartWith("data:image/png;base64,");
    // the management preview asks for the same map for a layout that is not saved
    const draft = JSON.parse(JSON.stringify(layout));
    draft.pages.flatMap((p: any) => p.items).filter((i: any) => i.kind === "button")[3].icon = "app:dev.zed.Zed";
    const preview = await fetch(`${u}/api/layout/assets`, { method: "POST", body: JSON.stringify({ layout: draft }) });
    expect(preview.status).toBe(200);
    expect(Object.keys(await preview.json() as object).sort()).toEqual([catalogName, "app:dev.zed.Zed", `img:${id}`].sort());
    expect(await (await fetch(`${u}/api/layout/assets`, { method: "POST", body: JSON.stringify({ layout }) })).json()).toEqual(pushed.assets);
    const bad = await fetch(`${u}/api/layout/assets`, { method: "POST", body: JSON.stringify({ layout: { version: 1, pages: [] } }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toBeTruthy();
    expect((await fetch(`${u}/api/layout/assets`, { method: "POST", body: "{}" })).status).toBe(400);
    expect((await rawFetch(`${u}/api/layout/assets`, { method: "POST", body: JSON.stringify({ layout }), headers: { "content-type": "text/plain" } })).status).toBe(403);
    // a phone connecting later gets them with the layout
    const d = connect(tok, srv.port);
    expect(Object.keys((await d.next((m) => m.type === "layout")).assets).length).toBe(3);
    // deleting the upload recomputes and re-pushes
    await fetch(`${u}/api/icons/img/${id}`, { method: "DELETE" });
    const after = await c.next((m) => m.type === "layout" && m.assets && !(`img:${id}` in m.assets));
    expect(Object.keys(after.assets).length).toBe(2);
    c.ws.close();
    d.ws.close();
    await fetch(`${u}/api/layout`, { method: "PUT", body: JSON.stringify(originalLayout) });
  });

  test("polls every 0.3 s near the end of a playing track, 1.5 s otherwise", async () => {
    const c = connect(tok, srv.port);
    await c.next((m) => m.type === "media");
    await Bun.sleep(100);
    reads = 0;
    await Bun.sleep(1100);
    expect(reads).toBeLessThanOrEqual(2); // long track: ~1.5 s cadence
    track = { ...track, title: "Short", position: 5, duration: 12 };
    await Bun.sleep(1700); // the pending 1.5 s tick still has to fire once
    reads = 0;
    await Bun.sleep(1200);
    expect(reads).toBeGreaterThanOrEqual(3);
    track = { ...track, title: "Next", position: 1, duration: 300 }; // new track: back to the slow cadence
    await Bun.sleep(600);
    reads = 0;
    await Bun.sleep(1100);
    expect(reads).toBeLessThanOrEqual(2);
    c.ws.close();
  }, 20000);

  test("quota history rides in the ai message", async () => {
    const c = connect(tok, srv.port);
    const ai = await c.next((m) => m.type === "ai" && m.ai.providers[0].windows[0]?.history);
    expect(ai.ai.providers[0].windows[0].history).toEqual([[expect.any(Number), 10]]);
    c.ws.close();
  });
});


describe("force reload of phones", () => {
  test("hello carries the deck build id; POST /api/devices/reload goes to all or one device; localhost, validated", async () => {
    const { DECK_BUILD } = await import("../src/assets.gen");
    const mkTok = async (name: string) => (await (await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin: app.pin, name }) })).json() as any);
    const a = await mkTok("ra");
    const b = await mkTok("rb");
    const ca = connect(a.token);
    const cb = connect(b.token);
    const hello = await ca.next((m) => m.type === "hello");
    expect(hello.build).toBe(DECK_BUILD);
    expect(typeof hello.build).toBe("string");
    await cb.next((m) => m.type === "hello");

    const reload = (body?: any) => fetch(`${base}/api/devices/reload`, { method: "POST", ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
    expect(await (await reload({ deviceId: b.deviceId })).json()).toEqual({ ok: true, count: 1 });
    await cb.next((m) => m.type === "reload");
    await Bun.sleep(80);
    expect(await (await reload()).json()).toEqual({ ok: true, count: 2 });
    await ca.next((m) => m.type === "reload");
    await cb.next((m) => m.type === "reload");
    expect(await (await reload({ deviceId: "nobody" })).json()).toEqual({ ok: true, count: 0 });
    expect((await reload("{ nope")).status).toBe(400);
    expect((await reload({ deviceId: 5 })).status).toBe(400);
    expect((await fetch(`${base}/api/devices/reload`)).status).not.toBe(200); // GET is not the reload
    ca.ws.close();
    cb.ws.close();
  });

  test("the deck page is never cached, hashed assets are immutable", async () => {
    const html = await fetch(`${base}/`);
    expect(html.headers.get("cache-control")).toBe("no-cache");
    const { DECK } = await import("../src/assets.gen");
    const hashed = Object.keys(DECK).find((k) => k.startsWith("assets/") && k.endsWith(".js"));
    if (hashed) expect((await fetch(`${base}/${hashed}`)).headers.get("cache-control")).toContain("immutable");
    for (const k of Object.keys(DECK).filter((k) => !k.startsWith("assets/"))) {
      expect([k, (await fetch(`${base}/${k}`)).headers.get("cache-control")]).toEqual([k, "no-cache"]);
    }
  });
});


describe("pairing survives restarts: cookie, expiry, .local address", () => {
  const pairNew = async (name: string) => {
    const { pin } = await (await fetch(`${base}/api/pairing`)).json() as any; // earlier tests may have regenerated the PIN
    const r = await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin, name }) });
    return { res: r, body: await r.json() as any };
  };
  const wsWith = (headers: Record<string, string>, query = "") =>
    new Promise<{ code?: number; hello?: any }>((resolve) => {
      const ws = new (WebSocket as any)(`ws://localhost:${app.port}/ws${query}`, { headers });
      ws.onmessage = (e: MessageEvent) => { const m = JSON.parse(String(e.data)); if (m.type === "hello") { resolve({ hello: m }); ws.close(); } };
      ws.onclose = (e: CloseEvent) => resolve({ code: e.code });
    });

  test("pairing sets an HttpOnly pd_token cookie, one year, Lax, no Secure", async () => {
    const { res, body } = await pairNew("cookie");
    const c = res.headers.get("set-cookie")!;
    expect(c).toStartWith(`pd_token=${body.token};`);
    expect(c).toContain("Path=/");
    expect(c).toContain("Max-Age=31536000");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).not.toContain("Secure");
    expect(body.deviceId).toMatch(/^[0-9a-f]{16}$/);
    const { loadDevices } = await import("../src/config");
    const d = (await loadDevices()).find((x) => x.id === body.deviceId)!;
    expect(Date.parse(d.expiresAt!) - Date.parse(d.createdAt)).toBeCloseTo(365 * 86400_000, -4);
  });

  test("WebSocket accepts the cookie alone, ?token= still works, a wrong cookie is refused; connect slides lastSeen and expiresAt", async () => {
    const { body } = await pairNew("ws-cookie");
    const viaCookie = await wsWith({ cookie: `theme=x; pd_token=${body.token}; other=1` });
    expect(viaCookie.hello?.deviceId).toBe(body.deviceId);
    expect((await wsWith({}, `?token=${body.token}`)).hello?.deviceId).toBe(body.deviceId);
    expect((await wsWith({ cookie: "pd_token=" + "0".repeat(64) })).code).toBe(4401);
    expect((await wsWith({})).code).toBe(4401);
    const { loadDevices } = await import("../src/config");
    const d = (await loadDevices()).find((x) => x.id === body.deviceId)!;
    expect(Date.parse(d.expiresAt!) - Date.parse(d.lastSeen!)).toBeCloseTo(365 * 86400_000, -4);
  });

  test("a device unused for a year is rejected with 4401, and reconnecting before that renews it", async () => {
    const { body } = await pairNew("old");
    const { loadDevices, saveDevices } = await import("../src/config");
    const edit = async (fn: (d: any) => void) => { const all = await loadDevices(); fn(all.find((x) => x.id === body.deviceId)); await saveDevices(all); };
    await edit((d) => { d.expiresAt = new Date(Date.now() - 1000).toISOString(); });
    expect((await wsWith({ cookie: `pd_token=${body.token}` })).code).toBe(4401);
    // an entry saved before expiresAt existed: judged by lastSeen
    await edit((d) => { delete d.expiresAt; d.lastSeen = new Date(Date.now() - 366 * 86400_000).toISOString(); });
    expect((await wsWith({}, `?token=${body.token}`)).code).toBe(4401);
    await edit((d) => { d.lastSeen = new Date(Date.now() - 300 * 86400_000).toISOString(); });
    expect((await wsWith({}, `?token=${body.token}`)).hello?.deviceId).toBe(body.deviceId);
    const after = (await loadDevices()).find((x) => x.id === body.deviceId)!;
    expect(Date.parse(after.expiresAt!)).toBeGreaterThan(Date.now() + 364 * 86400_000);
  });

  test("/api/pairing returns host and a .local url next to the IP url", async () => {
    const info = await (await fetch(`${base}/api/pairing`)).json() as any;
    expect(info).toMatchObject({ host: "my-mac", port: app.port });
    expect(info.urlLocal).toBe(`http://my-mac.local:${app.port}/?pin=${info.pin}`);
    expect(info.url).toBe(`http://${info.lanIp}:${app.port}/?pin=${info.pin}`);
    const regen = await (await fetch(`${base}/api/pairing/regenerate`, { method: "POST" })).json() as any;
    expect(regen.urlLocal).toContain(`?pin=${regen.pin}`);
  });
});


describe("soundboard", () => {
  const mp3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]);
  const upload = (body: BodyInit, type = "audio/mpeg", name = "Airhorn.mp3") =>
    fetch(`${base}/api/sounds?name=${encodeURIComponent(name)}`, { method: "POST", body, headers: { "content-type": type } });

  test("upload validates type and magic bytes, lists, renames, serves with ranges, deletes", async () => {
    expect((await upload("x", "text/plain")).status).toBe(415);
    expect((await upload("<html>not audio at all</html>")).status).toBe(400);
    const r = await upload(mp3);
    const snd = await r.json() as any;
    expect(r.status).toBe(200);
    expect(snd).toMatchObject({ name: "Airhorn", durationMs: 1500, size: mp3.length });
    expect(snd.id).toMatch(/^snd:[0-9a-f]{16}$/);
    const hex = snd.id.slice(4);

    expect(((await (await fetch(`${base}/api/sounds`)).json()) as any[]).map((x) => x.id)).toContain(snd.id);
    const ren = await fetch(`${base}/api/sounds/${snd.id}`, { method: "PATCH", body: JSON.stringify({ name: "Horn" }) });
    expect((await ren.json() as any).name).toBe("Horn");
    expect((await fetch(`${base}/api/sounds/${snd.id}`, { method: "PATCH", body: JSON.stringify({ name: " " }) })).status).toBe(400);
    expect((await fetch(`${base}/api/sounds/snd:0000000000000000`, { method: "PATCH", body: JSON.stringify({ name: "x" }) })).status).toBe(404);
    expect((await fetch(`${base}/api/sounds/..%2Fx`, { method: "DELETE" })).status).toBe(400);

    const full = await fetch(`${base}/sounds/${hex}`);
    expect(full.headers.get("content-type")).toBe("audio/mpeg");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(mp3);
    const part = await fetch(`${base}/sounds/${hex}`, { headers: { range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 2-5/${mp3.length}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(mp3.slice(2, 6));
    expect((await fetch(`${base}/sounds/${hex}`, { headers: { range: "bytes=999-" } })).status).toBe(416);
    expect((await fetch(`${base}/sounds/nothex`)).status).toBe(404);

    expect((await fetch(`${base}/api/sounds/${snd.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${base}/sounds/${hex}`)).status).toBe(404);
    expect((await fetch(`${base}/api/sounds/${snd.id}`, { method: "DELETE" })).status).toBe(404);
  });

  test("pressing sound buttons: mac spawns afplay, phone sends play-sound to the presser only, stop kills all", async () => {
    const snd = await (await upload(mp3)).json() as any;
    const mk = (id: string, action: any) => ({ id, kind: "button", label: id, action });
    const layout = {
      version: 1,
      pages: [{ id: "snd", name: "Snd", columns: 4, rows: 2, items: [
        mk("mac", { type: "sound", sound: snd.id, volume: 50 }),
        mk("ph", { type: "sound", sound: snd.id, on: "phone", volume: 70, mode: "overlap" }),
        mk("both", { type: "sound", sound: snd.id, on: "both", mode: "toggle" }),
        mk("stop", { type: "sound-stop" }),
        mk("gone", { type: "sound", sound: "snd:ffffffffffffffff" }),
      ] }],
    };
    const put = await fetch(`${base}/api/layout`, { method: "PUT", body: JSON.stringify(layout) });
    expect(put.status).toBe(200);

    // earlier tests may have revoked the shared device: pair a fresh one
    const { pin } = await (await fetch(`${base}/api/pairing`)).json() as any;
    const fresh = (await (await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin, name: "snd" }) })).json() as any).token;
    const a = connect(fresh), b = connect(fresh);
    await a.next((m) => m.type === "layout");
    await b.next((m) => m.type === "layout");
    const press = (c: typeof a, itemId: string, reqId: string) => { c.ws.send(JSON.stringify({ type: "press", reqId, pageId: "snd", itemId })); return c.next((m) => m.type === "result" && m.reqId === reqId); };

    spawned.length = 0;
    expect((await press(a, "mac", "1")).ok).toBe(true);
    expect(spawned.length).toBe(1);
    expect(spawned[0]!.argv.slice(0, 2)).toEqual(process.platform === "darwin" ? ["afplay", "-v"] : spawned[0]!.argv.slice(0, 2));
    expect((await a.next((m) => m.type === "sounds-playing")).ids).toEqual([snd.id]);
    expect((await b.next((m) => m.type === "sounds-playing")).ids).toEqual([snd.id]);

    expect((await press(a, "ph", "2")).ok).toBe(true);
    const play = await a.next((m) => m.type === "play-sound");
    expect(play).toEqual({ type: "play-sound", id: snd.id, url: `/sounds/${snd.id.slice(4)}`, volume: 70, mode: "overlap" });
    await Bun.sleep(60);
    expect(b.next((m) => m.type === "play-sound", 150)).rejects.toThrow("timeout"); // the other device is not told
    expect(spawned.length).toBe(1); // phone-only does not start afplay

    expect((await press(a, "both", "3")).ok).toBe(true); // toggle: mac copy is already playing, so it stops it
    expect(spawned.length).toBe(1);
    expect(spawned[0]!.killed).toBe(true);
    await a.next((m) => m.type === "play-sound");

    const gone = await press(a, "gone", "4");
    expect(gone.ok).toBe(false);
    expect(gone.error).toContain("library");

    await press(a, "mac", "5");
    expect((await press(a, "stop", "6")).ok).toBe(true);
    await b.next((m) => m.type === "stop-sounds");
    expect(spawned.at(-1)!.killed).toBe(true);
    expect((await b.next((m) => m.type === "sounds-playing" && m.ids.length === 0)).ids).toEqual([]);
    a.ws.close(); b.ws.close();
    await fetch(`${base}/api/sounds/${snd.id}`, { method: "DELETE" });
  });
});


describe("CSRF / DNS-rebinding guard", () => {
  const J = { "content-type": "application/json", "x-phonedesk": "1" };
  const put = (headers: Record<string, string>, body: BodyInit = "{}") => rawFetch(`${base}/api/pairing/regenerate`, { method: "POST", body, headers });
  const stat = async (p: Promise<Response>) => (await p).status;

  test("legit localhost request passes (Host localhost / 127.0.0.1 / [::1], same-site Origin)", async () => {
    expect(await stat(put(J))).toBe(200);
    expect(await stat(rawFetch(`http://127.0.0.1:${app.port}/api/pairing/regenerate`, { method: "POST", body: "{}", headers: J }))).toBe(200);
    expect(await stat(put({ ...J, origin: `http://localhost:${app.port}` }))).toBe(200);
    expect(await stat(put({ ...J, origin: `http://127.0.0.1:${app.port}` }))).toBe(200);
    expect(await stat(put({ ...J, origin: `http://[::1]:${app.port}` }))).toBe(200);
    expect(await stat(put({ ...J, "content-type": "application/json; charset=utf-8" }))).toBe(200);
  });

  test("a browser on another machine gets a readable HTML 403 for pages, the API keeps JSON", async () => {
    const host = "evil.example";
    for (const path of ["/manage/", "/manage", "/manage/anything"]) {
      const r = await rawFetch(`${base}${path}`, { headers: { host, accept: "text/html" } });
      expect(r.status).toBe(403);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(r.headers.get("cache-control")).toBe("no-store");
      const html = await r.text();
      expect(html).toContain("<title>Management page is only on the computer");
      expect(html).toContain("only opens on the computer it runs on");
      expect(html).toContain(`http://localhost:${app.port}/manage/`);
      expect(html).toContain('href="/"');
      expect(html).toContain("#22d3ee"); // the brand mark and key colour
      expect(html).toContain("<svg");
      expect(html).not.toContain("forbidden: localhost only");
    }
    // Vietnamese by the browser's language when the layout sets none
    const vi = await (await rawFetch(`${base}/manage/`, { headers: { host, "accept-language": "vi-VN,vi;q=0.9" } })).text();
    expect(vi).toContain("Trang quản lý chỉ mở được trên máy tính");
    expect(vi).toContain('lang="vi"');
    // the API stays JSON, even when asked for html
    const api = await rawFetch(`${base}/api/layout`, { headers: { host, accept: "text/html" } });
    expect(api.status).toBe(403);
    expect(api.headers.get("content-type")).toContain("application/json");
    expect((await api.json() as any).error).toBeTruthy();
    // HEAD has no body
    const head = await rawFetch(`${base}/manage/`, { method: "HEAD", headers: { host } });
    expect(head.status).toBe(403);
    expect(await head.text()).toBe("");
  });

  test("foreign Host (DNS rebinding) is refused on every kind of localhost route", async () => {
    for (const host of ["evil.example:" + app.port, "evil.example", `localhost:${app.port + 1}`, `192.168.1.5:${app.port}`]) {
      expect(await stat(rawFetch(`${base}/api/layout`, { headers: { host } }))).toBe(403);
      expect(await stat(put({ ...J, host }))).toBe(403);
      expect(await stat(rawFetch(`${base}/manage/`, { headers: { host } }))).toBe(403);
    }
    expect(await stat(rawFetch(`${base}/api/layout`))).toBe(200);
  });

  test("cross-site Origin is refused (even with the header and JSON)", async () => {
    for (const origin of ["http://evil.example", "https://localhost:" + app.port, `http://localhost:${app.port + 1}`, "null", `http://localhost.evil.example:${app.port}`]) {
      expect(await stat(put({ ...J, origin }))).toBe(403);
      expect(await stat(rawFetch(`${base}/api/layout`, { headers: { origin } }))).toBe(403);
    }
  });

  test("state-changing requests need application/json and X-PhoneDesk: 1", async () => {
    const layout = await (await rawFetch(`${base}/api/layout`)).json();
    const body = JSON.stringify(layout);
    // the classic CSRF: a simple cross-site form/fetch POST with a text/plain body
    expect(await stat(rawFetch(`${base}/api/layout`, { method: "PUT", body, headers: { "content-type": "text/plain" } }))).toBe(403);
    expect(await stat(rawFetch(`${base}/api/layout`, { method: "PUT", body }))).toBe(403); // default text/plain
    expect(await stat(rawFetch(`${base}/api/layout`, { method: "PUT", body, headers: { "content-type": "application/json" } }))).toBe(403); // no custom header
    expect(await stat(rawFetch(`${base}/api/layout`, { method: "PUT", body, headers: { "x-phonedesk": "1" } }))).toBe(403); // no JSON type
    expect(await stat(rawFetch(`${base}/api/layout`, { method: "PUT", body, headers: { "content-type": "application/json", "x-phonedesk": "0" } }))).toBe(403);
    expect(await stat(rawFetch(`${base}/api/layout`, { method: "PUT", body, headers: J }))).toBe(200);
    expect(await stat(rawFetch(`${base}/api/devices/nope`, { method: "DELETE", headers: { "content-type": "text/plain" } }))).toBe(403);
    expect(await stat(rawFetch(`${base}/api/sounds/snd:0123456789abcdef`, { method: "PATCH", body: "{}", headers: { "content-type": "text/plain" } }))).toBe(403);
    expect(await stat(rawFetch(`${base}/api/sounds/snd:0123456789abcdef`, { method: "DELETE" }))).toBe(403);
    expect(await stat(rawFetch(`${base}/api/devices/reload`, { method: "POST", body: "{}" }))).toBe(403);
    expect(await stat(rawFetch(`${base}/api/layout/undo`, { method: "POST" }))).toBe(403);
    expect(await stat(rawFetch(`${base}/api/sounds`, { method: "POST", body: "x", headers: { "content-type": "audio/mpeg" } }))).toBe(403); // uploads need the header too
    expect(await stat(rawFetch(`${base}/api/icons`, { method: "POST", body: "x", headers: { "content-type": "image/png" } }))).toBe(403);
  });

  test("no CORS headers, ever; reads need no custom header", async () => {
    for (const r of [await rawFetch(`${base}/api/layout`), await put(J), await rawFetch(`${base}/api/layout`, { method: "OPTIONS" })]) {
      expect([...r.headers.keys()].some((k) => k.startsWith("access-control-"))).toBe(false);
    }
  });

  test("hook endpoint keeps the secret (no CSRF header needed for the hook CLI)", async () => {
    const r = await rawFetch(`${base}/api/hooks/permission`, { method: "POST", body: "{}", headers: { host: "evil.example" } });
    expect(r.status).toBe(403);
    const noSecret = await rawFetch(`${base}/api/hooks/permission`, { method: "POST", body: "{}" });
    expect(noSecret.status).toBe(401);
  });

  test("phone routes: LAN IP, <name>.local and localhost pass; other Hosts are refused", async () => {
    const lan = (await (await rawFetch(`${base}/api/pairing`)).json() as any).lanIp;
    for (const host of [`${lan}:${app.port}`, `my-mac.local:${app.port}`, `localhost:${app.port}`]) {
      expect(await stat(rawFetch(`${base}/`, { headers: { host } }))).toBe(200);
      expect(await stat(rawFetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin: "000000" }), headers: { host } }))).toBe(401); // reached the handler
    }
    for (const host of [`evil.example:${app.port}`, `my-mac.local.evil.example:${app.port}`, `${lan}:${app.port + 1}`, "evil.example"]) {
      expect(await stat(rawFetch(`${base}/`, { headers: { host } }))).toBe(403);
      expect(await stat(rawFetch(`${base}/api/pair`, { method: "POST", body: "{}", headers: { host } }))).toBe(403);
      expect(await stat(rawFetch(`${base}/sounds/0123456789abcdef`, { headers: { host } }))).toBe(403);
    }
    // phone POST /api/pair needs no CSRF header or JSON type
    expect(await stat(rawFetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin: "000000" }) }))).toBe(401);
  });

  test("/ws: Origin, when present, must match Host; foreign Host refused", async () => {
    const { token: tk } = await (await rawFetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin: (await (await rawFetch(`${base}/api/pairing`)).json() as any).pin, name: "g" }) })).json() as any;
    const open = (headers: Record<string, string>) => new Promise<string>((resolve) => {
      const ws = new (WebSocket as any)(`ws://localhost:${app.port}/ws?token=${tk}`, { headers });
      ws.onmessage = () => { resolve("open"); ws.close(); };
      ws.onerror = () => resolve("refused");
      ws.onclose = (e: CloseEvent) => resolve(e.code === 1000 ? "open" : "refused");
    });
    expect(await open({})).toBe("open");
    expect(await open({ origin: `http://localhost:${app.port}` })).toBe("open");
    expect(await open({ origin: "http://evil.example" })).toBe("refused");
    expect(await open({ host: `evil.example:${app.port}` })).toBe("refused");
  });
});
