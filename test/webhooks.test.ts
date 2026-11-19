import { afterEach, describe, expect, test } from "bun:test";
import { WIN, MODE600, MODE644 } from "./_os";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTIFY_MAX, NotificationStore, PushStore, WebhookKey, parsePushBody, webhookExamples } from "../src/webhooks";

describe("WebhookKey", () => {
  const file = join(mkdtempSync(join(tmpdir(), "pd-wh-")), "sub", "webhook-key");
  test("created at 0600, stable, rotated, Bearer check", async () => {
    const k = new WebhookKey(file);
    const a = await k.get();
    expect(a.length).toBeGreaterThanOrEqual(24);
    expect(statSync(file).mode & 0o777).toBe(MODE600);
    expect(readFileSync(file, "utf8").trim()).toBe(a);
    expect(await new WebhookKey(file).get()).toBe(a);
    expect(await k.check(`Bearer ${a}`)).toBe(true);
    expect(await k.check(`bearer ${a}`)).toBe(true);
    expect(await k.check(`Bearer ${a}x`)).toBe(false);
    expect(await k.check(a)).toBe(false);
    expect(await k.check(null)).toBe(false);
    const b = await k.rotate();
    expect(b).not.toBe(a);
    expect(await k.check(`Bearer ${a}`)).toBe(false);
    expect(await k.check(`Bearer ${b}`)).toBe(true);
    expect(await new WebhookKey(file).get()).toBe(b);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
  test("mask and examples", () => {
    const m = WebhookKey.mask("abcdefghijklmnopqrstuvwxyz");
    expect(m.startsWith("abcd")).toBe(true);
    expect(m.endsWith("wxyz")).toBe(true);
    expect(m).toContain("****");
    const ex = webhookExamples({ ip: "192.168.1.5", host: "my-mac", port: 7420, key: "<KEY>" });
    expect(ex.join("\n")).toContain("http://192.168.1.5:7420/api/push/temp");
    expect(ex.join("\n")).toContain("http://my-mac.local:7420/api/push/co2");
    expect(ex.every((l) => l.includes("Bearer <KEY>"))).toBe(true);
  });
});

describe("PushStore", () => {
  afterEach(() => {});
  test("set, get, ttl expiry notifies, snapshot", async () => {
    let t = 1000;
    const events: [string, any][] = [];
    const s = new PushStore((k, v) => events.push([k, v?.value]), () => t);
    s.set("temp", 23.5);
    s.set("co2", 400, { sub: "living room", ttl: 0.05 });
    expect(s.get("temp")?.value).toBe(23.5);
    expect(s.snapshot()).toMatchObject({ temp: { value: 23.5 }, co2: { value: 400, sub: "living room" } });
    t += 100;
    await Bun.sleep(80);
    expect(s.get("co2")).toBeUndefined();
    expect(events.at(-1)).toEqual(["co2", undefined]);
    expect(Object.keys(s.snapshot())).toEqual(["temp"]);
    s.set("temp", 1); // replaces
    expect(s.get("temp")?.value).toBe(1);
    s.close();
  });
  test("a new value replaces the ttl", async () => {
    let t = 0;
    const s = new PushStore(undefined, () => t);
    s.set("k", 1, { ttl: 0.03 });
    s.set("k", 2);
    t += 1000;
    await Bun.sleep(60);
    expect(s.get("k")?.value).toBe(2);
    s.close();
  });
});

describe("NotificationStore", () => {
  test("keeps the newest 50, honours ttl, trims fields", () => {
    let t = 1;
    const n = new NotificationStore(() => t);
    for (let i = 0; i < 60; i++) { t++; n.add({ title: `n${i}` }); }
    const l = n.list();
    expect(l.length).toBe(NOTIFY_MAX);
    expect(l[0]!.title).toBe("n59");
    expect(new Set(l.map((x) => x.id)).size).toBe(NOTIFY_MAX);
    const x = n.add({ title: "t".repeat(500), body: "b".repeat(900), level: "alert", ttl: 10 });
    expect(x.title.length).toBe(120);
    expect(x.body!.length).toBe(500);
    expect(x.level).toBe("alert");
    expect(n.list()[0]!.id).toBe(x.id);
    t += 11_000;
    expect(n.list().some((y) => y.id === x.id)).toBe(false);
  });
});

describe("parsePushBody", () => {
  test("plain text, numbers, JSON, booleans, garbage", () => {
    expect(parsePushBody("23.5\n", "text/plain")).toEqual({ value: 23.5 });
    expect(parsePushBody("  on ", "text/plain")).toEqual({ value: "on" });
    expect(parsePushBody('{"value":42,"sub":"x","ttl":600}', "application/json")).toEqual({ value: 42, sub: "x", ttl: 600 });
    expect(parsePushBody('{"value":true}', "application/json")).toEqual({ value: "on" });
    expect(parsePushBody("42", "application/json")).toEqual({ value: 42 });
    expect(parsePushBody("", "text/plain")).toBeNull();
    expect(parsePushBody('{"nope":1}', "application/json")).toBeNull();
    expect(parsePushBody('{"value":{"a":1}}', "application/json")).toBeNull();
    expect(parsePushBody("x".repeat(500), "text/plain")!.value).toHaveLength(200);
  });
  test("keeps a string list for pushed widgets", () => {
    const parsed = parsePushBody('{"value":2,"items":["a~Yes~0.30~+0.1",3]}', "application/json");
    expect(parsed).toEqual({ value: 2, items: ["a~Yes~0.30~+0.1"] });
  });
});
