import { fetchClaudeQuota } from "./claude";
import { fetchCodexQuota } from "./codex";
import { fetchAntigravityQuota } from "./antigravity";
import { fetchOpencodeQuota, detectOpencode, readOpencodeSessions, activeOpencodeSessions } from "./opencode";
import { grokQuota, readGrokSessions } from "./grok";
import { readOmniAllowance } from "./omniroute";
import { withToolState, type ToolStates } from "./states";
import { listSessions, MAX_SESSIONS } from "./sessions";
import type { QuotaHistory } from "./history";
import { t } from "../i18n";
import type { AiProviderId, AiSession, AiSnapshot, ProviderQuota, WaitingHint } from "./types";

export * from "./types";
import { QUOTA_SOURCE } from "./types";

/** The read-only readers (Claude Code's usage API, Codex files, agy) run at most this often. */
export const LOCAL_REFRESH_MS = 5 * 60_000;
/** The hub checks whether a refresh is due at most this often. */
export const QUOTA_REFRESH_MS = 60_000;

export interface AiSources {
  claude: (last?: ProviderQuota) => Promise<ProviderQuota>;
  codex: () => Promise<ProviderQuota>;
  antigravity: () => Promise<ProviderQuota>;
  /** Optional: a source set without them (older tests) shows these providers as "not read". */
  opencode?: () => Promise<ProviderQuota>;
  grok?: () => Promise<ProviderQuota>;
  omni?: () => Promise<ProviderQuota>;
  sessions: (hints: WaitingHint[]) => Promise<AiSession[]>;
}

export const realAiSources = (states?: ToolStates): AiSources => ({
  claude: (last) => fetchClaudeQuota({}, last),
  codex: () => fetchCodexQuota(),
  antigravity: () => fetchAntigravityQuota(),
  opencode: async () => fetchOpencodeQuota({ version: await detectOpencode() }),
  grok: () => grokQuota(),
  omni: async () => readOmniAllowance() ?? { id: "omni", name: "OpenCode Go", windows: [], error: t("OmniRoute data not found"), updatedAt: Date.now() },
  sessions: async (hints) => {
    const [base, oc, active, grok] = await Promise.all([
      listSessions(hints),
      Promise.resolve().then(() => readOpencodeSessions()).catch(() => [] as AiSession[]),
      activeOpencodeSessions().catch(() => [] as string[]),
      readGrokSessions({ states }).catch(() => [] as AiSession[]),
    ]);
    const opencode = oc.map((s) => {
      let r: AiSession = active.includes(s.id) ? { ...s, state: "working", running: true } : s;
      r = withToolState(r, states?.get("opencode", s.id));
      const prompt = hints.some((h) => h.source === "opencode" && (h.sessionId ? h.sessionId === s.id : false));
      return prompt ? { ...r, state: "waiting" as const, prompt: true as const } : r;
    });
    const grokOut = grok.map((s) => (hints.some((h) => h.source === "grok" && h.sessionId === s.id) ? { ...s, state: "waiting" as const, prompt: true as const } : s));
        return [...base, ...opencode, ...grokOut].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS);
  },
});

const ORDER: AiProviderId[] = ["omni", "claude", "codex", "antigravity", "opencode", "grok"];
const NAMES: Record<AiProviderId, string> = { omni: "OpenCode Go", claude: "Claude", codex: "Codex", antigravity: "Antigravity", opencode: "OpenCode", grok: "Grok" };

/**
 * Keeps the latest quotas and sessions; a refresh reports whether the snapshot changed.
 * Quotas are read-only (no own sign-in): Claude Code's token, Codex's local session files, local Antigravity tools.
 * Each reader runs at most every 5 minutes.
 */
export class AiHub {
  private providers = new Map<AiProviderId, ProviderQuota>();
  private local = new Map<AiProviderId, { q: ProviderQuota; at: number }>();
  private sessions: AiSession[] = [];
  private quotaAt = Number.NEGATIVE_INFINITY;
  private quotaBusy = false;
  private sessionsBusy = false;
  private lastJson = "";

  constructor(private src: AiSources, private now: () => number = Date.now, private history?: QuotaHistory) {}

  snapshot(): AiSnapshot {
    const providers = ORDER.map(
      (id) => this.providers.get(id) ?? { id, name: NAMES[id], windows: [], error: t("Reading…"), updatedAt: 0 },
    );
    return { providers: this.history ? this.history.decorate(providers) : providers, sessions: this.sessions };
  }

  get quotasStale(): boolean {
    return this.now() - this.quotaAt >= QUOTA_REFRESH_MS;
  }

  private changed(): boolean {
    const json = JSON.stringify(this.snapshot());
    if (json === this.lastJson) return false;
    this.lastJson = json;
    return true;
  }

  private async localQuota(id: AiProviderId): Promise<ProviderQuota> {
    const cached = this.local.get(id);
    if (cached && this.now() - cached.at < LOCAL_REFRESH_MS) return cached.q;
    let q: ProviderQuota;
    try {
      const fn = id === "claude" ? undefined : this.src[id];
      q = id === "claude" ? await this.src.claude(cached?.q) : fn ? await fn() : { id, name: NAMES[id], windows: [], error: t("Reading…"), updatedAt: this.now() };
    } catch (err: any) {
      q = { id, name: NAMES[id], windows: cached?.q.windows ?? [], error: String(err?.message ?? err), updatedAt: this.now() };
    }
    q = { ...q, source: QUOTA_SOURCE[id] };
    this.local.set(id, { q, at: this.now() });
    return q;
  }

  /** Reads the quotas. At most once per minute unless forced. True when the snapshot changed. */
  async refreshQuotas(force = false): Promise<boolean> {
    if (this.quotaBusy || (!force && !this.quotasStale)) return false;
    this.quotaBusy = true;
    this.quotaAt = this.now();
    try {
      await Promise.all(ORDER.map(async (id) => { this.providers.set(id, await this.localQuota(id)); }));
      this.history?.record([...this.providers.values()]);
    } finally {
      this.quotaBusy = false;
    }
    return this.changed();
  }

  async refreshSessions(hints: WaitingHint[]): Promise<boolean> {
    if (this.sessionsBusy) return false;
    this.sessionsBusy = true;
    try {
      this.sessions = await this.src.sessions(hints).catch(() => this.sessions);
    } finally {
      this.sessionsBusy = false;
    }
    return this.changed();
  }
}
