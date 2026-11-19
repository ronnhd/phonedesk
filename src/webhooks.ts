import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HOME } from "./config";

export const NOTIFY_MAX = 50;
export const DEFAULT_PUSH_TTL_S = 0; // 0 = never expires

export const webhookKeyPath = () => join(HOME, "webhook-key");

const eq = (a: string, b: string) => {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
};

/** The shared secret for LAN callers (curl, Home Assistant, scripts). It only opens the webhook routes. */
export class WebhookKey {
  private key: string | undefined;
  constructor(private file: string = webhookKeyPath()) {}

  async get(): Promise<string> {
    if (this.key) return this.key;
    try {
      const t = (await readFile(this.file, "utf8")).trim();
      if (/^[A-Za-z0-9_-]{24,}$/.test(t)) return (this.key = t);
    } catch { /* create below */ }
    return this.rotate();
  }

  async rotate(): Promise<string> {
    const key = randomBytes(24).toString("base64url");
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, key + "\n", { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
    return (this.key = key);
  }

  /** Constant-time check of an `Authorization: Bearer <key>` header. */
  async check(header: string | null | undefined): Promise<boolean> {
    const m = /^Bearer\s+(\S+)$/i.exec(header ?? "");
    return !!m && eq(m[1]!, await this.get());
  }

  static mask(key: string): string { return `${key.slice(0, 4)}${"*".repeat(Math.max(4, key.length - 8))}${key.slice(-4)}`; }
}

export function webhookExamples(o: { ip: string; host: string; port: number; key: string }): string[] {
  const k = o.key;
  return [
    `curl -X POST -H "Authorization: Bearer ${k}" -d 23.5 http://${o.ip}:${o.port}/api/push/temp`,
    `curl -X POST -H "Authorization: Bearer ${k}" -H "Content-Type: application/json" -d '{"value":42,"sub":"living room","ttl":600}' http://${o.host}.local:${o.port}/api/push/co2`,
    `curl -X POST -H "Authorization: Bearer ${k}" -H "Content-Type: application/json" -d '{"title":"Done","body":"Build succeeded","level":"info"}' http://${o.ip}:${o.port}/api/notify`,
    `curl -X POST -H "Authorization: Bearer ${k}" "http://${o.ip}:${o.port}/api/goto/media?countdown=5"`,
  ];
}

export interface PushValue { value: string | number; sub?: string; at: number; expiresAt?: number; items?: string[] }

/** Latest value pushed per key; a value with a ttl disappears after it. */
export class PushStore {
  private map = new Map<string, PushValue>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private onChange: (key: string, v: PushValue | undefined) => void = () => {}, private now: () => number = Date.now) {}

  set(key: string, value: string | number, o: { sub?: string; ttl?: number; items?: string[] } = {}): PushValue {
    const at = this.now();
    const ttl = o.ttl && o.ttl > 0 ? Math.min(o.ttl, 30 * 86400) : 0;
    const v: PushValue = { value, ...(o.sub ? { sub: o.sub.slice(0, 80) } : {}), ...(o.items?.length ? { items: o.items.slice(0, 50) } : {}), at, ...(ttl ? { expiresAt: at + ttl * 1000 } : {}) };
    this.map.set(key, v);
    const old = this.timers.get(key);
    if (old) clearTimeout(old);
    if (ttl) {
      const t = setTimeout(() => this.expire(key), ttl * 1000);
      (t as any).unref?.();
      this.timers.set(key, t);
    } else this.timers.delete(key);
    this.onChange(key, v);
    return v;
  }

  private expire(key: string) {
    const v = this.map.get(key);
    if (v?.expiresAt && v.expiresAt <= this.now()) { this.map.delete(key); this.timers.delete(key); this.onChange(key, undefined); }
  }

  get(key: string): PushValue | undefined {
    const v = this.map.get(key);
    if (v?.expiresAt && v.expiresAt <= this.now()) { this.expire(key); return undefined; }
    return v;
  }

  snapshot(): Record<string, PushValue> {
    const out: Record<string, PushValue> = {};
    for (const k of [...this.map.keys()]) { const v = this.get(k); if (v) out[k] = v; }
    return out;
  }

  close() { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); }
}

export type NotifyLevel = "info" | "warn" | "alert";
export interface Notification { id: string; title: string; body?: string; level: NotifyLevel; at: number; expiresAt?: number; source?: string }

/** The 50 most recent notifications (newest first). */
export class NotificationStore {
  private items: Notification[] = [];
  private seq = 0;
  constructor(private now: () => number = Date.now) {}

  add(n: { title: string; body?: string; level?: NotifyLevel; ttl?: number; source?: string }): Notification {
    const at = this.now();
    const note: Notification = {
      id: `${at.toString(36)}${(this.seq++).toString(36)}`,
      title: n.title.slice(0, 120), ...(n.body ? { body: n.body.slice(0, 500) } : {}),
      level: n.level ?? "info", at, ...(n.ttl && n.ttl > 0 ? { expiresAt: at + Math.min(n.ttl, 86400) * 1000 } : {}), ...(n.source ? { source: n.source } : {}),
    };
    this.items.unshift(note);
    if (this.items.length > NOTIFY_MAX) this.items.length = NOTIFY_MAX;
    return note;
  }

  list(): Notification[] {
    const t = this.now();
    return this.items.filter((n) => !n.expiresAt || n.expiresAt > t);
  }

  clear() { this.items = []; }
}

/** Body of a push: plain text/number, or JSON {value, sub?, ttl?, items?}. */
export function parsePushBody(raw: string, contentType: string): { value: string | number; sub?: string; ttl?: number; items?: string[] } | null {
  const text = raw.trim();
  if (!text) return null;
  let value: unknown = text, sub: unknown, ttl: unknown, items: unknown;
  if (/json/i.test(contentType) || text.startsWith("{")) {
    try {
      const j = JSON.parse(text);
      if (j && typeof j === "object" && !Array.isArray(j)) { value = (j as any).value; sub = (j as any).sub; ttl = (j as any).ttl; items = (j as any).items; }
      else value = j;
    } catch { /* treat as plain text */ }
  }
  if (typeof value === "boolean") value = value ? "on" : "off";
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string") {
    value = value.slice(0, 200);
    const n = Number(value);
    if ((value as string).trim() !== "" && Number.isFinite(n)) value = n;
  }
  const t = Number(ttl);
  const cleanItems = Array.isArray(items) ? items.filter((x): x is string => typeof x === "string").slice(0, 50).map((x) => x.slice(0, 600)) : [];
  return { value: value as string | number, ...(typeof sub === "string" && sub ? { sub } : {}), ...(Number.isFinite(t) && t > 0 ? { ttl: t } : {}), ...(cleanItems.length ? { items: cleanItems } : {}) };
}
