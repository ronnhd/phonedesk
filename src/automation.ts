/**
 * Schema + validation for the automation features (user request 2026-11-17):
 * weather widget options, pushed values / notifications widgets, macro steps and rules.
 * Pure: no I/O. src/config.ts calls these from validateLayout.
 */

const fail = (msg: string): never => { throw new Error(msg); };
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const s = (v: unknown, where: string, max = 200): string => (typeof v === "string" ? v.slice(0, max) : fail(`${where} must be a string`));
const n = (v: unknown, where: string, min: number, max: number): number => {
  const x = Number(v);
  return Number.isFinite(x) && x >= min && x <= max ? x : fail(`${where} must be a number between ${min} and ${max}`);
};
const oneOf = <T extends string>(v: unknown, where: string, allowed: readonly T[]): T =>
  (allowed as readonly string[]).includes(v as string) ? (v as T) : fail(`${where} must be one of ${allowed.join(", ")}`);
const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;
const SERVICE_RE = /^[a-z_]+\.[a-z0-9_]+$/;
/** Keys for pushed values and webhook triggers: short, URL-safe. */
export const PUSH_KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,47}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// ---------- weather ----------

export interface WeatherOptions {
  source?: "auto" | "hass" | "open-meteo"; // auto: the HA weather entity when HA is connected, else Open-Meteo
  entity?: string;                          // weather.* entity for source hass/auto
  location?: { name: string; lat: number; lon: number }; // for Open-Meteo
  show?: "now" | "hourly" | "daily" | "auto";            // auto picks by tile size
  units?: "metric" | "imperial";
}

export function weatherOptions(v: any, where: string): WeatherOptions | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) fail(`${where} must be an object`);
  const out: WeatherOptions = {};
  if (v.source !== undefined) out.source = oneOf(v.source, `${where}.source`, ["auto", "hass", "open-meteo"] as const);
  if (v.entity !== undefined && v.entity !== "") {
    const e = s(v.entity, `${where}.entity`, 100);
    if (!/^weather\.[a-z0-9_]+$/.test(e)) fail(`${where}.entity must be a weather.* entity`);
    out.entity = e;
  }
  if (v.location !== undefined && v.location !== null) {
    if (!isObj(v.location)) fail(`${where}.location must be an object`);
    out.location = { name: s(v.location.name ?? "", `${where}.location.name`, 80), lat: n(v.location.lat, `${where}.location.lat`, -90, 90), lon: n(v.location.lon, `${where}.location.lon`, -180, 180) };
  }
  if (v.show !== undefined) out.show = oneOf(v.show, `${where}.show`, ["now", "hourly", "daily", "auto"] as const);
  if (v.units !== undefined) out.units = oneOf(v.units, `${where}.units`, ["metric", "imperial"] as const);
  return Object.keys(out).length ? out : undefined;
}

// ---------- pushed value / notifications widgets ----------

/** "value" widget: shows the latest value pushed to /api/push/<key>. */
export interface PushOptions { key: string; label?: string; unit?: string; pet?: boolean; }

export function pushOptions(v: any, where: string): PushOptions {
  if (!isObj(v)) fail(`${where} must be an object with a key`);
  const key = s(v.key, `${where}.key`, 48);
  if (!PUSH_KEY_RE.test(key)) fail(`${where}.key must be lowercase letters, digits, _ . - (max 48)`);
  const out: PushOptions = { key };
  if (v.label !== undefined && v.label !== "") out.label = s(v.label, `${where}.label`, 40);
  if (v.unit !== undefined && v.unit !== "") out.unit = s(v.unit, `${where}.unit`, 12);
  if (v.pet === true) out.pet = true;
  return out;
}

// ---------- macros ----------

export type MacroStep =
  | { kind: "hotkey"; keys: string }
  | { kind: "type"; text: string }
  | { kind: "wait"; ms: number }
  | { kind: "open"; target: string }
  | { kind: "shell"; command: string }
  | { kind: "media"; command: "playpause" | "next" | "previous" }
  | { kind: "volume"; command: "up" | "down" | "mute" }
  | { kind: "hass"; service: string; entityId?: string; data?: Record<string, unknown> }
  | { kind: "item"; pageId: string; itemId: string } // run another button's action (no nested macros beyond depth 2)
  | { kind: "notify"; text: string };

export const MACRO_MAX_STEPS = 20;

export function macroSteps(v: any, where: string): MacroStep[] {
  if (!Array.isArray(v) || v.length === 0) fail(`${where} must be a non-empty list of steps`);
  if (v.length > MACRO_MAX_STEPS) fail(`${where} can have at most ${MACRO_MAX_STEPS} steps`);
  let totalWait = 0;
  return v.map((st: any, i: number): MacroStep => {
    const w = `${where}[${i}]`;
    if (!isObj(st)) fail(`${w} must be an object`);
    switch (st.kind) {
      case "hotkey": return { kind: "hotkey", keys: s(st.keys, `${w}.keys`, 60) };
      case "type": return { kind: "type", text: s(st.text, `${w}.text`, 2000) };
      case "wait": { const ms = n(st.ms, `${w}.ms`, 0, 10000); totalWait += ms; if (totalWait > 30000) fail(`${where}: waits add up to more than 30 s`); return { kind: "wait", ms }; }
      case "open": return { kind: "open", target: s(st.target, `${w}.target`, 500) };
      case "shell": return { kind: "shell", command: s(st.command, `${w}.command`, 2000) };
      case "media": return { kind: "media", command: oneOf(st.command, `${w}.command`, ["playpause", "next", "previous"] as const) };
      case "volume": return { kind: "volume", command: oneOf(st.command, `${w}.command`, ["up", "down", "mute"] as const) };
      case "hass": {
        const service = s(st.service, `${w}.service`, 100);
        if (!SERVICE_RE.test(service)) fail(`${w}.service must look like "domain.service"`);
        const out: any = { kind: "hass", service };
        if (st.entityId) { const e = s(st.entityId, `${w}.entityId`, 100); if (!ENTITY_RE.test(e)) fail(`${w}.entityId must look like "domain.object_id"`); out.entityId = e; }
        if (st.data !== undefined) { if (!isObj(st.data) || JSON.stringify(st.data).length > 2048) fail(`${w}.data must be a small object`); out.data = st.data; }
        return out;
      }
      case "item": return { kind: "item", pageId: s(st.pageId, `${w}.pageId`, 80), itemId: s(st.itemId, `${w}.itemId`, 80) };
      case "notify": return { kind: "notify", text: s(st.text, `${w}.text`, 200) };
      default: return fail(`${w}.kind "${st.kind}" is not supported`);
    }
  });
}

// ---------- rules ----------

export type RuleWhen =
  /**
   * An AI session finished its turn and waits for you to type (it needs you). Permission requests and questions
   * are NOT counted by default: they already open a sheet on whatever page is shown, so jumping pages for them is noise
   * (user feedback 2026-11-17). includePrompts: true counts them too.
   */
  | { kind: "ai-waiting"; provider?: "claude" | "codex" | "opencode" | "grok"; includePrompts?: boolean }
  | { kind: "media-playing" } | { kind: "media-stopped" }
  | { kind: "cpu-above"; percent: number; forSec?: number }
  | { kind: "quota-above"; provider: "claude" | "codex" | "antigravity" | "opencode"; percent: number }
  | { kind: "time-between"; from: string; to: string; days?: number[] } // HH:MM local, days 0=Sunday
  | { kind: "push"; key: string; op?: "=" | "!=" | ">" | "<"; value?: string | number } // a pushed value / webhook
  | { kind: "hass-state"; entityId: string; state: string }
  | { kind: "idle"; minutes: number };                              // no press on any phone for N minutes

export type RuleThen =
  | { kind: "goto-page"; pageId: string; countdown?: number }       // seconds of visible countdown, 0 = immediately
  | { kind: "notify"; text: string; level?: "info" | "warn" | "alert" }
  | { kind: "theme-mode"; mode: "dark" | "light" }
  | { kind: "run-item"; pageId: string; itemId: string };

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  when: RuleWhen;
  then: RuleThen[];
  /** Go back to the page shown before the rule fired when the condition ends (goto-page only). */
  revert?: boolean;
}

export const RULES_MAX = 40;

function ruleWhen(v: any, where: string): RuleWhen {
  if (!isObj(v)) fail(`${where} must be an object`);
  switch (v.kind) {
    case "ai-waiting": {
      const out: any = { kind: "ai-waiting" };
      if (v.provider) out.provider = oneOf(v.provider, `${where}.provider`, ["claude", "codex", "opencode", "grok"] as const);
      if (v.includePrompts === true) out.includePrompts = true;
      return out;
    }
    case "media-playing": return { kind: "media-playing" };
    case "media-stopped": return { kind: "media-stopped" };
    case "cpu-above": return { kind: "cpu-above", percent: n(v.percent, `${where}.percent`, 1, 100), ...(v.forSec !== undefined ? { forSec: n(v.forSec, `${where}.forSec`, 0, 3600) } : {}) };
    case "quota-above": return { kind: "quota-above", provider: oneOf(v.provider, `${where}.provider`, ["claude", "codex", "antigravity", "opencode"] as const), percent: n(v.percent, `${where}.percent`, 1, 100) };
    case "time-between": {
      const from = s(v.from, `${where}.from`, 5), to = s(v.to, `${where}.to`, 5);
      if (!HHMM_RE.test(from) || !HHMM_RE.test(to)) fail(`${where}: from/to must be HH:MM`);
      const out: any = { kind: "time-between", from, to };
      if (v.days !== undefined) { if (!Array.isArray(v.days) || v.days.some((d: any) => !Number.isInteger(d) || d < 0 || d > 6)) fail(`${where}.days must be 0-6`); out.days = [...new Set(v.days as number[])].sort(); }
      return out;
    }
    case "push": {
      const key = s(v.key, `${where}.key`, 48);
      if (!PUSH_KEY_RE.test(key)) fail(`${where}.key is invalid`);
      const out: any = { kind: "push", key };
      if (v.op !== undefined) out.op = oneOf(v.op, `${where}.op`, ["=", "!=", ">", "<"] as const);
      if (v.value !== undefined) out.value = typeof v.value === "number" ? v.value : s(v.value, `${where}.value`, 100);
      return out;
    }
    case "hass-state": {
      const e = s(v.entityId, `${where}.entityId`, 100);
      if (!ENTITY_RE.test(e)) fail(`${where}.entityId must look like "domain.object_id"`);
      return { kind: "hass-state", entityId: e, state: s(v.state, `${where}.state`, 60) };
    }
    case "idle": return { kind: "idle", minutes: n(v.minutes, `${where}.minutes`, 1, 1440) };
    default: return fail(`${where}.kind "${v.kind}" is not supported`);
  }
}

function ruleThen(v: any, where: string): RuleThen {
  if (!isObj(v)) fail(`${where} must be an object`);
  switch (v.kind) {
    case "goto-page": return { kind: "goto-page", pageId: s(v.pageId, `${where}.pageId`, 80), ...(v.countdown !== undefined ? { countdown: n(v.countdown, `${where}.countdown`, 0, 60) } : {}) };
    case "notify": return { kind: "notify", text: s(v.text, `${where}.text`, 200), ...(v.level !== undefined ? { level: oneOf(v.level, `${where}.level`, ["info", "warn", "alert"] as const) } : {}) };
    case "theme-mode": return { kind: "theme-mode", mode: oneOf(v.mode, `${where}.mode`, ["dark", "light"] as const) };
    case "run-item": return { kind: "run-item", pageId: s(v.pageId, `${where}.pageId`, 80), itemId: s(v.itemId, `${where}.itemId`, 80) };
    default: return fail(`${where}.kind "${v.kind}" is not supported`);
  }
}

/** Validates layout.rules; pageIds must exist (checked against the given set). */
export function validateRules(v: any, pageIds: Set<string>): Rule[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) fail("rules must be a list");
  if (v.length > RULES_MAX) fail(`at most ${RULES_MAX} rules`);
  const ids = new Set<string>();
  return v.map((r: any, i: number): Rule => {
    const w = `rules[${i}]`;
    if (!isObj(r)) fail(`${w} must be an object`);
    const id = s(r.id, `${w}.id`, 40);
    if (ids.has(id)) fail(`duplicate rule id "${id}"`);
    ids.add(id);
    if (!Array.isArray(r.then) || r.then.length === 0 || r.then.length > 5) fail(`${w}.then must have 1-5 actions`);
    const then = r.then.map((t: any, j: number) => ruleThen(t, `${w}.then[${j}]`));
    for (const t of then) if ((t.kind === "goto-page" || t.kind === "run-item") && !pageIds.has(t.pageId)) fail(`${w}: page "${t.pageId}" does not exist`);
    return { id, name: s(r.name ?? id, `${w}.name`, 60), enabled: r.enabled !== false, when: ruleWhen(r.when, `${w}.when`), then, ...(r.revert ? { revert: true } : {}) };
  });
}
