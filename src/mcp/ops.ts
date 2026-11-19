import { moveItem as reflowMove, placeItem, resizeItem as reflowResize } from "../../web/shared/reflow";
import { validateLayout, WIDGET_KINDS, type Item, type Layout, type Page, type WidgetKind } from "../config";

export type OpResult = { ok: true; layout: Layout; note: string } | { ok: false; reason: string };
const fail = (reason: string): OpResult => ({ ok: false, reason });

/** Preferred size of a widget (columns x rows), as the management page uses. */
export const WIDGET_SIZE: Record<WidgetKind, [number, number]> = {
  clock: [4, 2], nowplaying: [4, 2], cpu: [2, 1], memory: [2, 1], uptime: [2, 1], load: [2, 1], network: [2, 1], quota: [2, 2], sessions: [2, 3], entity: [2, 1], value: [2, 1], weather: [2, 2], notifications: [2, 2], polymarket: [4, 1],
};

export const THEME_KEYS = ["mode", "accent", "background", "tile", "radius", "gap", "fontScale", "tileStyle", "iconScale", "iconStroke", "showLabels", "text", "orientation"];
/** Fields an item may carry besides id/kind/x/y/w/h. */
const ITEM_FIELDS = ["label", "icon", "color", "action", "widget", "provider", "clock", "metric", "quota", "entity", "push", "style", "textColor", "hideLabel"];
const GEOMETRY = ["x", "y", "w", "h"];

interface Rect { x: number; y: number; w: number; h: number }
const rectOf = (it: Item): Rect => ({ x: it.x ?? 0, y: it.y ?? 0, w: it.w ?? 1, h: it.h ?? 1 });
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r: Rect, p: Page) => r.x >= 0 && r.y >= 0 && r.w >= 1 && r.h >= 1 && r.x + r.w <= p.columns && r.y + r.h <= p.rows;
const blockers = (p: Page, r: Rect, ignore?: string) => p.items.filter((o) => o.id !== ignore && overlaps(rectOf(o), r));

/** Cells where a w x h tile fits, row by row. */
export function freeSpots(p: Page, w: number, h: number, ignore?: string, limit = 5): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y + h <= p.rows && out.length < limit; y++) for (let x = 0; x + w <= p.columns && out.length < limit; x++) if (blockers(p, { x, y, w, h }, ignore).length === 0) out.push({ x, y });
  return out;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

function pageOf(layout: Layout, ref: unknown): Page | string {
  if (typeof ref !== "string" || !ref) return 'argument "page" (a page id or name) is required';
  const hit = layout.pages.find((p) => p.id === ref) ?? layout.pages.find((p) => p.name.toLowerCase() === ref.toLowerCase());
  return hit ?? `no page "${ref}" (pages: ${layout.pages.map((p) => `${p.id} "${p.name}"`).join(", ")})`;
}

function itemOf(page: Page, ref: unknown): Item | string {
  if (typeof ref !== "string" || !ref) return 'argument "id" (an item id) is required';
  return page.items.find((i) => i.id === ref) ?? `no item "${ref}" on page "${page.id}" (items: ${page.items.map((i) => i.id).join(", ") || "none"})`;
}

/** Runs the whole layout through validateLayout (schema, bounds, overlap) and returns the normalized copy. */
function finish(layout: Layout, note: string): OpResult {
  try {
    return { ok: true, layout: validateLayout(layout), note };
  } catch (err: any) {
    return fail(err?.message ?? String(err));
  }
}

const clone = (l: Layout): Layout => structuredClone(l);
const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
const uniqueId = (prefix: string, taken: Set<string>) => {
  for (let i = 0; i < 1000; i++) {
    const id = `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
    if (!taken.has(id)) return id;
  }
  return `${prefix}-${Date.now()}`;
};

function pickFields(args: Record<string, any>, allowed: string[], out: Record<string, any>): string | undefined {
  for (const [k, v] of Object.entries(args)) {
    if (["page", "id", "kind", "x", "y", "w", "h", "changes", "toPage"].includes(k) && !allowed.includes(k)) continue;
    if (!allowed.includes(k)) return `unknown item field "${k}" (allowed: ${allowed.join(", ")})`;
    out[k] = v;
  }
  return undefined;
}

export function addItem(layout: Layout, args: Record<string, any>): OpResult {
  const page = pageOf(layout, args.page);
  if (typeof page === "string") return fail(page);
  if (args.kind !== "button" && args.kind !== "widget") return fail('"kind" must be "button" or "widget"');
  const raw: Record<string, any> = {};
  const bad = pickFields(args, ITEM_FIELDS, raw);
  if (bad) return fail(bad);
  if (args.kind === "widget") {
    if (!WIDGET_KINDS.includes(raw.widget)) return fail(`"widget" must be one of ${WIDGET_KINDS.join(", ")}`);
  } else if (raw.widget !== undefined) return fail('"widget" only applies to kind "widget"');
  const next = clone(layout);
  const p = next.pages.find((x) => x.id === page.id)!;
  const id = typeof args.id === "string" && args.id ? args.id : uniqueId(args.kind === "widget" ? "w" : "b", new Set(p.items.map((i) => i.id)));
  if (p.items.some((i) => i.id === id)) return fail(`item id "${id}" already exists on page "${p.id}"`);
  const explicitSize = args.w !== undefined || args.h !== undefined;
  if ((args.w !== undefined && !isInt(args.w)) || (args.h !== undefined && !isInt(args.h))) return fail("w and h must be whole numbers");
  let sizes: [number, number][];
  if (explicitSize) sizes = [[args.w ?? 1, args.h ?? 1]];
  else if (args.kind === "widget") {
    const [w, h] = WIDGET_SIZE[raw.widget as WidgetKind];
    sizes = [[w, h], [Math.min(w, 2), 1], [1, 1]]; // largest first, shrink when the page is crowded
  } else sizes = [[1, 1]];
  let cell: { x: number; y: number; w: number; h: number } | undefined;
  let pushed: string[] = [];
  const base: Record<string, any> = { id, kind: args.kind, ...raw };
  if (args.x !== undefined || args.y !== undefined) {
    if (!isInt(args.x) || !isInt(args.y)) return fail("x and y must both be whole numbers");
    // an explicit cell: tiles in the way are pushed to the nearest free spot of the page (shared reflow rules)
    let why = "";
    for (const [w, h] of sizes) {
      const item = { ...base, ...(w !== 1 ? { w } : {}), ...(h !== 1 ? { h } : {}) } as Item;
      const r = placeItem(next, p.id, item, args.x, args.y);
      if (r.ok) { cell = { x: args.x, y: args.y, w, h }; pushed = r.pushed; next.pages = r.layout.pages; break; }
      why = r.reason;
    }
    if (!cell) {
      const [w, h] = sizes[0]!;
      return fail(why === "outside"
        ? `a ${w}x${h} tile at ${args.x},${args.y} does not fit the ${p.columns}x${p.rows} grid`
        : `no room: the tiles at ${args.x},${args.y} cannot be pushed elsewhere on page "${p.id}"; free spots for ${w}x${h}: ${JSON.stringify(freeSpots(p, w, h))}`);
    }
    return finish(next, `added ${args.kind} "${id}" at ${cell.x},${cell.y} (${cell.w}x${cell.h}) on page "${p.id}"${pushed.length ? `; pushed ${pushed.join(", ")}` : ""}`);
  }
  for (const [w, h] of sizes) {
    const spot = freeSpots(p, w, h, undefined, 1)[0];
    if (spot) { cell = { ...spot, w, h }; break; }
  }
  if (!cell) return fail(`page "${p.id}" has no free space for a ${sizes[0]![0]}x${sizes[0]![1]} tile; remove or resize something first`);
  const item: Record<string, any> = { ...base, x: cell.x, y: cell.y };
  if (cell.w !== 1) item.w = cell.w;
  if (cell.h !== 1) item.h = cell.h;
  p.items.push(item as Item);
  return finish(next, `added ${args.kind} "${id}" at ${cell.x},${cell.y} (${cell.w}x${cell.h}) on page "${p.id}"`);
}

export function updateItem(layout: Layout, args: Record<string, any>): OpResult {
  const page = pageOf(layout, args.page);
  if (typeof page === "string") return fail(page);
  const found = itemOf(page, args.id);
  if (typeof found === "string") return fail(found);
  const changes = args.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return fail('"changes" must be an object of fields to set (null removes a field)');
  const geo = Object.keys(changes).filter((k) => GEOMETRY.includes(k));
  if (geo.length) return fail(`${geo.join(", ")} cannot be changed here: use move_item or resize_item`);
  for (const k of ["id", "kind", "widget"]) if (k in changes) return fail(`"${k}" cannot be changed: remove the item and add a new one`);
  const next = clone(layout);
  const item = next.pages.find((p) => p.id === page.id)!.items.find((i) => i.id === found.id)! as Record<string, any>;
  for (const [k, v] of Object.entries(changes)) {
    if (!ITEM_FIELDS.includes(k)) return fail(`unknown item field "${k}" (allowed: ${ITEM_FIELDS.filter((f) => f !== "widget").join(", ")})`);
    if (v === null) delete item[k];
    else item[k] = v;
  }
  return finish(next, `updated "${found.id}" (${Object.keys(changes).join(", ")})`);
}

export function moveItem(layout: Layout, args: Record<string, any>): OpResult {
  const from = pageOf(layout, args.page);
  if (typeof from === "string") return fail(from);
  const found = itemOf(from, args.id);
  if (typeof found === "string") return fail(found);
  const to = args.toPage === undefined ? from : pageOf(layout, args.toPage);
  if (typeof to === "string") return fail(to);
  if (!isInt(args.x) || !isInt(args.y)) return fail("x and y must be whole numbers (0-based column and row)");
  const w = found.w ?? 1, h = found.h ?? 1;
  const reason = (r: string) => r === "outside"
    ? `"${found.id}" (${w}x${h}) does not fit at ${args.x},${args.y} on the ${to.columns}x${to.rows} page "${to.id}"`
    : `no room: tiles at ${args.x},${args.y} cannot be pushed elsewhere on page "${to.id}"; free spots for ${w}x${h}: ${JSON.stringify(freeSpots(to, w, h, to.id === from.id ? found.id : undefined))}`;
  if (to.id === from.id) {
    const r = reflowMove(layout, from.id, found.id, args.x, args.y);
    if (!r.ok) return fail(reason(r.reason));
    return finish(r.layout, `moved "${found.id}" to ${args.x},${args.y}${r.pushed.length ? `; pushed ${r.pushed.join(", ")}` : ""}`);
  }
  // another page: take it out, then drop it at the target cell
  const without = clone(layout);
  const src = without.pages.find((p) => p.id === from.id)!;
  const item = { ...src.items.find((i) => i.id === found.id)! } as Item;
  src.items = src.items.filter((i) => i.id !== found.id);
  const dst = without.pages.find((p) => p.id === to.id)!;
  if (dst.items.some((i) => i.id === item.id)) item.id = uniqueId(item.kind === "widget" ? "w" : "b", new Set(dst.items.map((i) => i.id)));
  const r = placeItem(without, to.id, item, args.x, args.y);
  if (!r.ok) return fail(reason(r.reason));
  return finish(r.layout, `moved "${found.id}" to ${args.x},${args.y} on page "${to.id}"${r.pushed.length ? `; pushed ${r.pushed.join(", ")}` : ""}`);
}

export function resizeItem(layout: Layout, args: Record<string, any>): OpResult {
  const page = pageOf(layout, args.page);
  if (typeof page === "string") return fail(page);
  const found = itemOf(page, args.id);
  if (typeof found === "string") return fail(found);
  if (!isInt(args.w) || !isInt(args.h) || args.w < 1 || args.h < 1) return fail("w and h must be whole numbers >= 1");
  const r = reflowResize(layout, page.id, found.id, args.w, args.h);
  if (!r.ok) {
    return fail(r.reason === "outside"
      ? `${args.w}x${args.h} at ${found.x ?? 0},${found.y ?? 0} does not fit the ${page.columns}x${page.rows} grid; move the item first or choose a smaller size`
      : `no room: tiles in the way cannot be pushed elsewhere on page "${page.id}"; free something up or choose a smaller size`);
  }
  // 1 is the default span: store it as absent
  const next = clone(r.layout);
  const item = next.pages.find((p) => p.id === page.id)!.items.find((i) => i.id === found.id)!;
  if (args.w === 1) delete item.w;
  if (args.h === 1) delete item.h;
  return finish(next, `resized "${found.id}" to ${args.w}x${args.h}${r.pushed.length ? `; pushed ${r.pushed.join(", ")}` : ""}`);
}

export function removeItem(layout: Layout, args: Record<string, any>): OpResult {
  const page = pageOf(layout, args.page);
  if (typeof page === "string") return fail(page);
  const found = itemOf(page, args.id);
  if (typeof found === "string") return fail(found);
  const next = clone(layout);
  const p = next.pages.find((x) => x.id === page.id)!;
  p.items = p.items.filter((i) => i.id !== found.id);
  return finish(next, `removed "${found.id}" from page "${p.id}"`);
}

export function addPage(layout: Layout, args: Record<string, any>): OpResult {
  if (typeof args.name !== "string" || !args.name.trim()) return fail('"name" is required');
  const columns = args.columns ?? 8, rows = args.rows ?? 3;
  if (!isInt(columns) || columns < 1 || columns > 12) return fail("columns must be a whole number 1-12");
  if (!isInt(rows) || rows < 1 || rows > 8) return fail("rows must be a whole number 1-8");
  const next = clone(layout);
  const taken = new Set(next.pages.map((p) => p.id));
  let id = typeof args.id === "string" && args.id ? args.id : slug(args.name) || "page";
  if (taken.has(id)) {
    if (typeof args.id === "string" && args.id) return fail(`page id "${id}" already exists`);
    let n = 2;
    while (taken.has(`${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  next.pages.push({ id, name: args.name.trim(), columns, rows, items: [] });
  return finish(next, `added page "${id}" (${columns}x${rows})`);
}

export function updatePage(layout: Layout, args: Record<string, any>): OpResult {
  const page = pageOf(layout, args.page);
  if (typeof page === "string") return fail(page);
  const next = clone(layout);
  const p = next.pages.find((x) => x.id === page.id)!;
  const changed: string[] = [];
  if (args.name !== undefined) {
    if (typeof args.name !== "string" || !args.name.trim()) return fail("name must be a non-empty string");
    p.name = args.name.trim();
    changed.push("name");
  }
  for (const [k, max] of [["columns", 12], ["rows", 8]] as const) {
    if (args[k] === undefined) continue;
    if (!isInt(args[k]) || args[k] < 1 || args[k] > max) return fail(`${k} must be a whole number 1-${max}`);
    p[k] = args[k];
    changed.push(k);
  }
  if (!changed.length) return fail("nothing to change: give name, columns or rows");
  // shrinking is refused by validateLayout when an item would fall outside the grid
  return finish(next, `updated page "${p.id}" (${changed.join(", ")})`);
}

export function removePage(layout: Layout, args: Record<string, any>): OpResult {
  const page = pageOf(layout, args.page);
  if (typeof page === "string") return fail(page);
  if (layout.pages.length === 1) return fail("a layout needs at least one page");
  const refs = layout.pages.flatMap((p) => p.items.filter((i) => i.kind === "button" && i.action?.type === "page" && i.action.page === page.id).map((i) => `${p.id}/${i.id}`));
  if (refs.length) return fail(`buttons still switch to page "${page.id}": ${refs.join(", ")}; change or remove them first`);
  const next = clone(layout);
  next.pages = next.pages.filter((p) => p.id !== page.id);
  return finish(next, `removed page "${page.id}" with ${page.items.length} item(s)`);
}

export function setTheme(layout: Layout, args: Record<string, any>): OpResult {
  const t = args.theme;
  if (!t || typeof t !== "object" || Array.isArray(t)) return fail('"theme" must be an object (null removes a field)');
  const unknown = Object.keys(t).filter((k) => !THEME_KEYS.includes(k));
  if (unknown.length) return fail(`unknown theme field ${unknown.join(", ")} (allowed: ${THEME_KEYS.join(", ")})`);
  const next = clone(layout);
  const theme: Record<string, any> = args.replace ? {} : { ...(next.theme ?? {}) };
  for (const [k, v] of Object.entries(t)) {
    if (v === null) delete theme[k];
    else theme[k] = v;
  }
  next.theme = theme as Layout["theme"];
  return finish(next, `theme ${args.replace ? "replaced" : "updated"} (${Object.keys(t).join(", ") || "reset"})`);
}

export const OPERATIONS: Record<string, (layout: Layout, args: Record<string, any>) => OpResult> = {
  add_item: addItem, update_item: updateItem, move_item: moveItem, resize_item: resizeItem, remove_item: removeItem,
  add_page: addPage, update_page: updatePage, remove_page: removePage, set_theme: setTheme,
};
