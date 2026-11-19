import { getPlatform, hotkeyText, type Platform } from "@/lib/platform";
import { pageMove, pageResize } from "@shared/reflow";
import { t } from "@/lib/i18n";
import { MAX_ROWS, MAX_COLUMNS, type Action, type ActionType, type Item, type Layout, type Page, type WidgetKind, METRIC_CHARTS_FOR, METRIC_WIDGETS, type MetricWidget } from "@/types";

export function randomId(prefix: string, taken: Set<string>): string {
  for (;;) {
    const id = `${prefix}-${Math.random().toString(36).slice(2, 7)}`;
    if (!taken.has(id)) return id;
  }
}

export function slug(name: string): string {
  return String(name).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\u0111/g, "d").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page";
}

export function uniquePageId(name: string, pages: Page[]): string {
  const taken = new Set(pages.map((p) => p.id));
  const base = slug(name);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export function defaultAction(type: ActionType, firstPage = ""): Action {
  switch (type) {
    case "open": return { type, target: "" };
    case "hotkey": return { type, keys: "" };
    case "type": return { type, text: "" };
    case "shell": return { type, command: "" };
    case "media": return { type, command: "playpause" };
    case "volume": return { type, command: "up" };
    case "page": return { type, page: firstPage };
    case "sound": return { type, sound: "", on: "mac", volume: 100, mode: "restart" };
    case "sound-stop": return { type };
    case "hass": return { type, service: "" };
    case "macro": return { type, steps: [{ kind: "hotkey", keys: "" }] };
  }
}

// ---------- fixed grid ----------

export const GRID_PRESETS: { label: string; columns: number; rows: number }[] = [
  { label: "8×2", columns: 8, rows: 2 },
  { label: "8×3", columns: 8, rows: 3 },
  { label: "5×3 (MK.2)", columns: 5, rows: 3 },
  { label: "4×2", columns: 4, rows: 2 },
  { label: "8×4 (XL)", columns: 8, rows: 4 },
];

export interface Rect { x: number; y: number; w: number; h: number }

export const rectOf = (it: Item): Rect => ({ x: it.x ?? 0, y: it.y ?? 0, w: it.w ?? 1, h: it.h ?? 1 });
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r: Rect, page: Pick<Page, "columns" | "rows">) =>
  r.x >= 0 && r.y >= 0 && r.w >= 1 && r.h >= 1 && r.x + r.w <= page.columns && r.y + r.h <= page.rows;

/** Items (other than `ignore`) that overlap a rectangle. */
export function itemsIn(page: Page, r: Rect, ignore?: string): Item[] {
  return page.items.filter((o) => o.id !== ignore && overlaps(rectOf(o), r));
}

export function itemAt(page: Page, x: number, y: number): Item | undefined {
  return itemsIn(page, { x, y, w: 1, h: 1 })[0];
}

/** First free cell (row by row) where a w x h tile fits. */
export function findFree(page: Page, w = 1, h = 1): { x: number; y: number } | undefined {
  for (let y = 0; y + h <= page.rows; y++) {
    for (let x = 0; x + w <= page.columns; x++) {
      if (itemsIn(page, { x, y, w, h }).length === 0) return { x, y };
    }
  }
  return undefined;
}

/** Preferred size of a widget: big for clock and now-playing, 2x1 for the metrics. */
export const WIDGET_SIZE: Record<WidgetKind, [number, number]> = {
  clock: [4, 2], nowplaying: [4, 2], cpu: [2, 1], memory: [2, 1], uptime: [2, 1], load: [2, 1], network: [2, 1], quota: [2, 2], sessions: [2, 3], entity: [1, 1], weather: [2, 2], value: [2, 1], notifications: [2, 2], polymarket: [4, 1],
};

/** Candidate sizes, largest first, ending with 1x1. */
const sizeChain = (kind: WidgetKind): [number, number][] => {
  const [w, h] = WIDGET_SIZE[kind];
  return [[w, h], [Math.min(w, 2), 1], [1, 1]];
};

export function newItem(kind: "button" | "widget", page: Page, at?: { x: number; y: number }, widget: WidgetKind = "clock"): Item | undefined {
  const id = randomId(kind === "widget" ? "w" : "b", new Set(page.items.map((i) => i.id)));
  if (kind === "button") {
    const cell = at && itemsIn(page, { ...at, w: 1, h: 1 }).length === 0 ? at : findFree(page);
    return cell ? { id, kind: "button", label: t("New button"), action: { type: "open", target: "" }, ...cell } : undefined;
  }
  for (const [w, h] of sizeChain(widget)) {
    const cell = at && inside({ ...at, w, h }, page) && itemsIn(page, { ...at, w, h }).length === 0 ? at : findFree(page, w, h);
    if (cell) return { id, kind: "widget", widget, ...(widget === "quota" ? { provider: "claude" as const } : {}), ...cell, ...(w > 1 || h > 1 ? { w, h } : {}) };
  }
  return undefined;
}

/** Changes a widget's kind and, when it fits, resizes it to the kind's preferred size. */
export function setWidgetKind(page: Page, id: string, widget: WidgetKind): Page {
  const items = page.items.map((i) => {
    if (i.id !== id || i.kind !== "widget") return i;
    const { provider, clock, metric, quota, entity, weather, push, ...rest } = i;
    // Keep the metric options only when the new widget still allows the chosen chart (the agent rejects the rest).
    const keepMetric = metric && (METRIC_WIDGETS as readonly string[]).includes(widget) && (!metric.chart || METRIC_CHARTS_FOR[widget as MetricWidget].includes(metric.chart));
    return { ...rest, widget, ...(widget === "clock" && clock ? { clock } : {}), ...(widget === "entity" && entity ? { entity } : {}), ...(widget === "weather" && weather ? { weather } : {}), ...(widget === "value" ? { push: push ?? { key: "value" } } : {}), ...(keepMetric ? { metric } : {}), ...(widget === "quota" ? { provider: provider ?? ("claude" as const), ...(quota ? { quota } : {}) } : {}) };
  });
  let cur: Page = { ...page, items };
  // Changing the kind only takes a bigger default size when it fits without pushing anything.
  const me = cur.items.find((i) => i.id === id);
  if (!me) return cur;
  const at = rectOf(me);
  for (const [w, h] of sizeChain(widget)) {
    const r: Rect = { ...at, w, h };
    if (inside(r, cur) && itemsIn(cur, r, id).length === 0) return replace(cur, cur.items.map((i) => (i.id === id ? { ...i, w, h } : i)));
  }
  return cur;
}

export function duplicateItem(it: Item, page: Page): Item | undefined {
  const r = rectOf(it);
  const cell = findFree(page, r.w, r.h);
  if (!cell) return undefined;
  const id = randomId(it.kind === "widget" ? "w" : "b", new Set(page.items.map((i) => i.id)));
  return { ...structuredClone(it), id, ...cell };
}

export type GridResult = { ok: true; page: Page } | { ok: false; error: string };

const replace = (page: Page, items: Item[]): Page => ({ ...page, items });

const full = () => t("The page is full, there is no room for the displaced tiles. Delete some tiles or increase the grid size.");
const reflowError = (reason: string) => (reason === "outside" ? t("This tile does not fit there (it would go outside the grid)") : full());

/** Moves a tile to (x, y); tiles in the way are pushed to the nearest free spots of the same page, or the move is refused. */
export function moveTile(page: Page, id: string, x: number, y: number): GridResult {
  if (!page.items.some((i) => i.id === id)) return { ok: false, error: t("Tile to move not found") };
  const r = pageMove(page, id, x, y);
  return r.ok ? { ok: true, page: replace(page, r.items) } : { ok: false, error: reflowError(r.reason) };
}

/** Resizes a tile (and optionally moves its top-left corner); neighbours are pushed away, or the change is refused. */
export function resizeTile(page: Page, id: string, w: number, h: number, x?: number, y?: number): GridResult {
  if (!page.items.some((i) => i.id === id)) return { ok: false, error: t("Tile not found") };
  const r = pageResize(page, id, w, h, x, y);
  return r.ok ? { ok: true, page: replace(page, r.items) } : { ok: false, error: reflowError(r.reason) };
}

export function resizeGrid(page: Page, columns: number, rows: number): GridResult {
  const next = { ...page, columns, rows };
  const out = page.items.filter((i) => !inside(rectOf(i), next));
  if (out.length) {
    const names = out.slice(0, 3).map((i) => (i.kind === "button" ? i.label || i.id : i.widget)).join(", ");
    return { ok: false, error: t("Cannot shrink the grid: tiles that would fall outside it: {count} ({names}). Move or delete them first, or use \"Auto arrange\".", { count: out.length, names: `${names}${out.length > 3 ? ", …" : ""}` }) };
  }
  return { ok: true, page: next };
}

/** Packs every tile into the new grid, row by row in current reading order; fails when they do not all fit. */
export function repack(page: Page, columns: number, rows: number): GridResult {
  const sorted = page.items.slice().sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));
  let cur: Page = { ...page, columns, rows, items: [] };
  for (const it of sorted) {
    const r = rectOf(it);
    const w = Math.min(r.w, columns);
    const h = Math.min(r.h, rows);
    const cell = findFree(cur, w, h);
    if (!cell) return { ok: false, error: t("Not enough room for all tiles in this grid") };
    cur = { ...cur, items: [...cur.items, { ...it, ...cell, w, h }] };
  }
  return { ok: true, page: cur };
}

/** Auto-places items lacking x/y and fills in rows (for hand-edited JSON). The agent still validates on save. */
export function normalizeLayout(l: Layout): Layout {
  return {
    ...l,
    pages: l.pages.map((p) => {
      let cur: Page = { ...p, rows: p.rows ?? 1, items: [] };
      let rows = p.rows;
      const placed: Item[] = [];
      for (const it of p.items) {
        if (it.x !== undefined && it.y !== undefined) {
          placed.push(it);
          continue;
        }
        cur = { ...cur, rows: rows ?? MAX_ROWS, items: placed };
        const cell = findFree(cur, it.w ?? 1, it.h ?? 1);
        placed.push(cell ? { ...it, ...cell } : { ...it, x: 0, y: 0 });
      }
      if (rows === undefined) rows = Math.max(1, ...placed.map((i) => (i.y ?? 0) + (i.h ?? 1)));
      return { ...p, rows, items: placed };
    }),
  };
}

/** Minimal shape check so the editor never crashes on odd JSON. The agent does the real validation on save. */
export function shapeError(x: unknown): string | null {
  const l = x as Layout | null;
  if (!l || typeof l !== "object" || !Array.isArray(l.pages)) return t("layout.pages must be an array");
  if (l.pages.length === 0) return t("The layout needs at least one screen");
  for (const [i, p] of l.pages.entries()) {
    if (!p || typeof p !== "object") return t("pages[{i}] must be an object", { i });
    if (typeof p.id !== "string") return t("pages[{i}].id must be a string", { i });
    if (!Number.isInteger(p.columns) || p.columns < 1 || p.columns > MAX_COLUMNS) return t("pages[{i}].columns must be an integer from 1 to {max}", { i, max: MAX_COLUMNS });
    if (p.rows !== undefined && (!Number.isInteger(p.rows) || p.rows < 1 || p.rows > MAX_ROWS)) return t("pages[{i}].rows must be an integer from 1 to {max}", { i, max: MAX_ROWS });
    if (!Array.isArray(p.items)) return t("pages[{i}].items must be an array", { i });
    for (const [j, it] of p.items.entries()) {
      if (!it || typeof it !== "object" || typeof it.id !== "string" || (it.kind !== "button" && it.kind !== "widget")) {
        return t("pages[{i}].items[{j}] needs id and kind (\"button\" or \"widget\")", { i, j });
      }
    }
  }
  return null;
}

export function itemTitle(it: Item): string {
  if (it.kind === "widget") return t("Widget: {name}", { name: t(WIDGET_LABEL[it.widget] ?? it.widget) });
  return `${it.icon ? it.icon + " " : ""}${it.label || t("(unnamed)")}`;
}

export const PROVIDER_LABEL: Record<string, string> = { omni: "OpenCode Go", claude: "Claude", codex: "Codex", antigravity: "Antigravity", opencode: "OpenCode", grok: "Grok" };

export const WIDGET_HINT: Record<WidgetKind, string> = {
  clock: "Time and date", nowplaying: "Current track", cpu: "CPU usage (click to see processes)", memory: "Memory in use",
  uptime: "How long the Mac has been running", load: "System load", network: "Network speed", quota: "Claude / Codex / Antigravity quota", sessions: "Running AI sessions", entity: "Home Assistant device", weather: "Weather", value: "Value pushed from outside (webhook)", notifications: "Recent notifications", polymarket: "Live Polymarket open positions",
};

export const WIDGET_LABEL: Record<string, string> = {
  clock: "Clock", cpu: "CPU", memory: "Memory", uptime: "Uptime", load: "System load", network: "Network", nowplaying: "Now playing", quota: "AI quota", sessions: "AI sessions", entity: "Home (Home Assistant)", weather: "Weather", value: "Pushed value", notifications: "Notifications", polymarket: "Polymarket",
};

export const ACTION_LABEL: Record<ActionType, string> = {
  open: "Open (URL, file, app)",
  hotkey: "Hotkey",
  type: "Type text",
  shell: "Shell command",
  media: "Play music",
  volume: "Volume",
  page: "Switch screen",
  sound: "Play sound",
  hass: "Home Assistant",
  macro: "Multi-step macro",
  "sound-stop": "Stop all sounds",
};

export const MEDIA_LABEL: Record<string, string> = { playpause: "Play / Pause", next: "Next track", previous: "Previous track" };
export const VOLUME_LABEL: Record<string, string> = { up: "Increase", down: "Decrease", mute: "Mute" };

export const ACTION_ICON: Record<ActionType, string> = {
  open: "external-link", hotkey: "keyboard", type: "type", shell: "square-terminal",
  media: "play", volume: "volume-2", page: "layout-grid", sound: "music", "sound-stop": "player-stop", hass: "home", macro: "bolt",
};

export const ACTION_SHORT: Record<ActionType, string> = {
  open: "Open", hotkey: "Hotkey", type: "Type", shell: "Command", media: "Music", volume: "Volume", page: "Screen", sound: "Sound", "sound-stop": "Stop sound", hass: "Home", macro: "Macro",
};

/** One-line summary of what a button does, for the item list. */
export function actionSummary(a: Action | undefined): string {
  if (!a) return t("No action");
  switch (a.type) {
    case "open": return t("Open {target}", { target: a.target || "…" });
    case "hotkey": return t("Hotkey {keys}", { keys: a.keys ? hotkeyText(a.keys) : "…" });
    case "type": return t("Type \"{text}\"", { text: a.text.length > 24 ? a.text.slice(0, 24) + "…" : a.text });
    case "shell": return t("Command: {command}", { command: a.command || "…" });
    case "media": return t(MEDIA_LABEL[a.command] ?? a.command);
    case "volume": return t("Volume: {mode}", { mode: t(VOLUME_LABEL[a.command] ?? a.command).toLowerCase() });
    case "page": return t("Go to screen {page}", { page: a.page || "…" });
    case "sound": return a.sound ? t("Play sound") : t("Play sound (no clip selected)");
    case "sound-stop": return t("Stop all sounds");
    case "macro": return t("Macro steps: {n}", { n: a.steps.length });
    case "hass": return a.service ? t("Home Assistant: {service}", { service: `${a.service}${a.entityId ? ` → ${a.entityId}` : ""}` }) : t("Home Assistant (no service selected)");
  }
}

/**
 * Builds the layout's canonical "cmd+shift+4" from a keydown event; undefined while only modifiers are held.
 * On Windows the agent presses Ctrl for cmd, so Ctrl (and the Windows key) are recorded as "cmd": the layout stays portable.
 */
export function hotkeyFromEvent(e: KeyboardEvent, platform: Platform = getPlatform()): string | undefined {
  const NAMED: Record<string, string> = {
    Enter: "return", Tab: "tab", " ": "space", Backspace: "delete", Delete: "forwarddelete", Escape: "escape",
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
    Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
  };
  let key: string | undefined = NAMED[e.key];
  if (!key && /^F([1-9]|1[0-2])$/.test(e.key)) key = e.key.toLowerCase();
  if (!key && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  if (!key && /^Digit\d$/.test(e.code)) key = e.code.slice(5);
  if (!key && e.key.length === 1) key = e.key.toLowerCase();
  if (!key) return undefined;
  const win = platform === "win32";
  const mods = [(win ? e.ctrlKey || e.metaKey : e.metaKey) && "cmd", !win && e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift"].filter(Boolean) as string[];
  return [...mods, key].join("+");
}
