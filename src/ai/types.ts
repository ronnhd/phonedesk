import { t } from "../i18n";
export type AiProviderId = "claude" | "codex" | "antigravity" | "opencode" | "grok" | "omni";
export type QuotaSource = "claude-code" | "codex-sessions" | "antigravity-local" | "opencode-local" | "grok-cli" | "omniroute-local" | "none";
export const QUOTA_SOURCE: Record<AiProviderId, QuotaSource> = { claude: "claude-code", codex: "codex-sessions", antigravity: "antigravity-local", opencode: "opencode-local", grok: "grok-cli", omni: "omniroute-local" };
/** The tools whose sessions the sessions widget lists. */
export type SessionTool = "claude" | "codex" | "opencode" | "grok";

export interface QuotaWindow {
  id: string;
  label: string; // translated, e.g. "5 hours", "7 days"
  /** 0-100; null when the tool has a period but does not report usage for it (Grok on a plan without a percentage). */
  usedPercent: number | null;
  resetsAt?: number; // ms since epoch
  windowMinutes?: number;
  /** usedPercent samples [ms, percent], one per 5 minutes for up to 24 h, at most 48 points. */
  history?: [number, number][];
}

export interface QuotaExtra {
  label: string;
  value: number;
  unit: string;
}

export interface ProviderQuota {
  id: AiProviderId;
  name: string;
  plan?: string;
  windows: QuotaWindow[];
  error?: string;
  updatedAt: number;
  /** Where the windows come from. Read-only: Claude Code's own token, Codex's local session files, the local Antigravity tools. */
  source?: QuotaSource;
  /** Balances (credits, resets...). */
  extras?: QuotaExtra[];
}

export type SessionState = "working" | "waiting" | "idle";

export interface AiSession {
  id: string;
  tool: SessionTool;
  project: string;
  title?: string;
  model?: string;
  /**
   * "waiting" = it needs YOU: the turn is finished and it waits for you to type (or a permission request / question is pending,
   * see `prompt`). "working" = written to in the last 20 s. Otherwise "idle".
   */
  state: SessionState;
  /** A permission request or question of this session is pending right now (already shown as a sheet on the phone). */
  prompt?: true;
  updatedAt: number;
  tokens?: number;
  /** Listed as running by the tool itself (Grok active_sessions.json, OpenCode 2.x /api/session/active). */
  running?: true;
  /** Money spent, when the tool records it (OpenCode). */
  cost?: number;
}

export interface AiSnapshot {
  providers: ProviderQuota[];
  sessions: AiSession[];
}

/** What a pending permission request tells the session scanner, to mark sessions "waiting". */
export interface WaitingHint {
  source: SessionTool;
  sessionId?: string;
  cwd?: string;
}

/**
 * Grok Build also runs the hooks it finds in ~/.claude/settings.json (compat.claude.hooks), so `phonedesk hook claude`
 * and `claude-ask` can be fed a Grok payload. Grok's stdin uses camelCase names (hookEventName, notificationType,
 * toolName, sessionId) and snake_case event NAMES ("pre_tool_use"); Claude Code's is snake_case keys (hook_event_name,
 * tool_name, session_id) with CamelCase event names ("PreToolUse"). Such a payload must never reach the phone as a Claude request.
 */
export function isGrokPayload(o: any): boolean {
  if (!o || typeof o !== "object") return false;
  if ("hookEventName" in o || "notificationType" in o || "toolName" in o || "toolInput" in o) return true;
  const ev = o.hook_event_name ?? o.hookEventName;
  if (typeof ev === "string" && /^[a-z]+(_[a-z]+)+$/.test(ev)) return true; // "pre_tool_use"
  if (typeof o.sessionId === "string" && typeof o.session_id !== "string") return true;
  return typeof o.client === "string" ? /grok/i.test(o.client) : typeof o.source === "string" && /grok/i.test(o.source);
}

export const clampPercent = (n: number): number => Math.round(Math.min(100, Math.max(0, n)) * 10) / 10;

/** "5 hours", "7 days", "30 days", "45 min" from a window length. */
export function windowLabel(minutes: number): string {
  if (minutes < 60) return t("{n} min", { n: minutes });
  const hours = minutes / 60;
  if (hours < 48) return t("{n} hours", { n: Math.round(hours) });
  return t("{n} days", { n: Math.round(hours / 24) });
}

export function safeHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "";
}
