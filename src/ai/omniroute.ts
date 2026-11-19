import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { ProviderQuota, QuotaWindow } from "./types";

/** Raw allowance and usage facts read from the local OmniRoute store. */
export interface OmniValues {
  spend: { value: string; sub: string };
  volume: { value: string; sub: string };
  health: { value: number; sub: string };
  updatedAt: number;
}

const DB = join(homedir(), ".omniroute", "storage.sqlite");
const WINDOW_LABEL: Record<string, string> = {
  mcp_monthly: "Month",
  weekly: "Week",
  session: "Session",
};
const WINDOW_ORDER = ["mcp_monthly", "weekly", "session"];
const PROVIDER_NAME: Record<string, string> = {
  "opencode-go": "OpencodeGo",
  antigravity: "Antigravity",
  codex: "Codex",
  "grok-cli": "Grok",
};

const compact = (n: number): string => {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
};

function open(): Database | null {
  return existsSync(DB) ? new Database(DB, { readonly: true }) : null;
}

/** Latest allowance snapshot per OpenCode Go window. The MCP quota tool reports a generic 100%, so read the store. */
export function readOmniAllowance(): ProviderQuota | null {
  const db = open();
  if (!db) return null;
  try {
    const rows = db.query<{ window_key: string; remaining_percentage: number; next_reset_at: string | null; created_at: string }, []>(`
      SELECT q.window_key, q.remaining_percentage, q.next_reset_at, q.created_at
      FROM quota_snapshots q
      JOIN (SELECT window_key, MAX(created_at) AS newest FROM quota_snapshots
            WHERE provider = 'opencode-go' GROUP BY window_key) m
        ON m.window_key = q.window_key AND m.newest = q.created_at
      WHERE q.provider = 'opencode-go'
    `).all();
    const byKey = new Map(rows.map((r) => [r.window_key, r]));
    const windows: QuotaWindow[] = [];
    let updatedAt = 0;
    for (const key of WINDOW_ORDER) {
      const r = byKey.get(key);
      if (!r) continue;
      const at = Date.parse(r.created_at);
      if (Number.isFinite(at)) updatedAt = Math.max(updatedAt, at);
      windows.push({
        id: key,
        label: WINDOW_LABEL[key] ?? key,
        usedPercent: Math.max(0, Math.min(100, 100 - Number(r.remaining_percentage))),
        ...(r.next_reset_at && Number.isFinite(Date.parse(r.next_reset_at)) ? { resetsAt: Date.parse(r.next_reset_at) } : {}),
      });
    }
    return windows.length ? { id: "omni", name: "OpenCode Go", windows, updatedAt, source: "omniroute-local" } : null;
  } finally {
    db.close();
  }
}

/** Rolling 24 h spend, token volume and gateway state, all from OmniRoute's own tables. */
export function readOmniValues(): OmniValues | null {
  const db = open();
  if (!db) return null;
  try {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const names = new Map<string, string>();
    for (const r of db.query<{ provider: string; name: string | null }, []>(
      "SELECT provider, name FROM provider_connections WHERE is_active = 1",
    ).all()) if (r.name && !names.has(r.provider)) names.set(r.provider, r.name);
    const label = (provider: string) => PROVIDER_NAME[provider] ?? names.get(provider) ?? provider;

    const cost = db.query<{ total: number; requests: number }, [string]>(`
      SELECT COALESCE(SUM(amount_usd), 0) AS total, COUNT(*) AS requests
      FROM request_cost_ledger WHERE timestamp >= ?
    `).get(since)!;
    const top = db.query<{ provider: string; amount: number }, [string]>(`
      SELECT provider, SUM(amount_usd) AS amount FROM request_cost_ledger
      WHERE timestamp >= ? GROUP BY provider ORDER BY amount DESC LIMIT 1
    `).get(since);
    const spend: OmniValues["spend"] = {
      value: cost.total.toFixed(2),
      sub: `${top ? label(top.provider) + " " + top.amount.toFixed(2) : "no cost"}`,
    };

    const vol = db.query<{ requests: number; tokens: number; omni: number }, [string]>(`
      SELECT COUNT(*) AS requests,
             COALESCE(SUM(tokens_input + tokens_output), 0) AS tokens,
             COALESCE(SUM(CASE WHEN provider = 'opencode-go' THEN tokens_input + tokens_output ELSE 0 END), 0) AS omni
      FROM usage_history WHERE timestamp >= ?
    `).get(since)!;
    const share = vol.tokens > 0 ? Math.round((vol.omni / vol.tokens) * 100) : 0;
    const volume: OmniValues["volume"] = {
      value: compact(vol.tokens),
      sub: `Go ${share}% · ${compact(vol.requests)} req`,
    };

    const connections = db.query<{ total: number; bad: number }, []>(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN error_code IS NOT NULL
                       OR (rate_limited_until IS NOT NULL AND rate_limited_until > datetime('now'))
                  THEN 1 ELSE 0 END) AS bad
      FROM provider_connections WHERE is_active = 1
    `).get()!;
    const openCircuits = db.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM domain_circuit_breakers WHERE state = 'OPEN'",
    ).get()!.n;
    const health: OmniValues["health"] = {
      value: connections.total,
      sub: `${connections.bad} lim · ${openCircuits} open`,
    };
    return { spend, volume, health, updatedAt: Date.now() };
  } finally {
    db.close();
  }
}
