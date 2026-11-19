import type { Server, ServerWebSocket } from "bun";
import { HOME, loadDevices, loadLayout, saveDevices, saveLayout, validateLayout, type Action, type Layout } from "./config";
import { resolveAsset } from "./assets";

/** Embedded text assets served gzipped when the client accepts it; compressed once and kept (they never change). */
const COMPRESSIBLE = /^(text\/|application\/(javascript|json|manifest\+json)|image\/svg\+xml)/;
const gzCache = new Map<string, Uint8Array>();
import { isLocal, lanIp, localHostName } from "./net";
import { Pairing, cookieToken, expiryFrom, tokenCookie, withDevicesLock } from "./pairing";
import { SOUND_MAX, SOUND_TYPES, SoundLibrary, SoundPlayer, bareId, SOUND_ID_HEX, type SpawnFn } from "./sounds";
import type { HassLike } from "./automation-types";
import { HassClient } from "./hass/client";
import { HassConfigStore } from "./hass/config";
import { wantedEntities } from "./hass/entities";
import { entityPress } from "./hass/press";
import { planControl } from "./hass/control";
import { tempUnitOf } from "./temperature";
import { PUSH_KEY_RE } from "./automation";
import { RuleEngine } from "./rules";
import { WeatherService } from "./weather";
import { NotificationStore, PushStore, WebhookKey, parsePushBody, webhookExamples, type NotifyLevel } from "./webhooks";
import { abortableSleep, runMacro, type MacroCtx } from "./macro";
import { hostAllowed, localRequestError, originAllowed, phoneNames } from "./guard";
import { LayoutHistory } from "./layout-history";
import { Icons, IMG_ID_RE, BUNDLE_ID_RE, UPLOAD_MAX } from "./icons";
import { QuotaHistory } from "./ai/history";
import { CATALOG, DECK_BUILD } from "./assets.gen";
import { NEAR_END_MS, NEAR_END_S, LastMediaStore, MediaTracker, openMediaApp as realOpenMediaApp, parseControl, resumeMedia as realResumeMedia, type MediaApp, type RawMedia } from "./media";
import type { Stats } from "./stats";
import type { VolumeChange, VolumeState } from "./actions";
import { AiHub, QUOTA_SOURCE, realAiSources, type AiProviderId, type AiSources } from "./ai";
import { agyPath } from "./ai/antigravity";
import { ToolStates, type ToolState } from "./ai/states";
import { detectOpencode, opencodeDataFound, installPlugin, isPluginInstalled, opencodePath, pluginPath, readOpencodeSessions, uninstallPlugin } from "./ai/opencode";
import { UpdateChecker } from "./update";
import { grokDataFound, grokQuota, grokHookFile, grokPath, installGrokHook, isGrokHookInstalled, readGrokSessions, uninstallGrokHook } from "./ai/grok";
import { readOmniValues } from "./ai/omniroute";
import { PermissionBroker, ensureHookSecret, parseHookInput, secretMatches, PERMISSION_TIMEOUT_MS } from "./permissions";
import { classifyRisk } from "./risk";
import { askHookCommand, hookCommand, hookConfigPath, installAskHook, installHook, isAskHookInstalled, isHookInstalled, uninstallAskHook, uninstallHook, type HookTool } from "./hooks-install";
import { AWAY_IDLE_SECONDS, AskSettingsStore, QUESTION_TIMEOUT_MS, QuestionBroker, parseQuestionInput, readIdleSeconds } from "./questions";
import { parseProcessesRequest, topProcesses as realTopProcesses, type ProcessInfo, type ProcessSort } from "./processes";
import { setLanguage, t } from "./i18n";
import { describeRequest, macIdentifier, realProbes, runDoctor, tccServiceFor, type DoctorReport, type Probes } from "./doctor";

/** One mDNS query to 224.0.0.251:5353: enough for macOS to list this binary under Local Network and show its prompt. */
async function touchLocalNetwork(): Promise<void> {
  // DNS header (1 question) + "_services._dns-sd._udp.local" PTR IN
  const q = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
  for (const label of ["_services", "_dns-sd", "_udp", "local"]) { q.push(label.length); for (const ch of label) q.push(ch.charCodeAt(0)); }
  q.push(0, 0, 12, 0, 1);
  const sock = await Bun.udpSocket({});
  try { sock.send(new Uint8Array(q), 5353, "224.0.0.251"); } finally { setTimeout(() => sock.close(), 500); }
}
import { currentInstance } from "./service";
import { platform } from "./platform";
import pkg from "../package.json" with { type: "json" };
import { aboutInfo } from "./about";
import { forbiddenPage, pickLanguage, wantsPage } from "./forbidden-page";

export type { Stats };

export interface Deps {
  runAction: (a: Action) => Promise<void>;
  startStats: (onTick: (s: Stats) => void, intervalMs?: number) => () => void;
  setVolume: (v: VolumeChange) => Promise<void>;
  /** Fresh volume read, used to push the new value right after a change. */
  readVolume: () => Promise<VolumeState | null>;
  readMedia: () => Promise<RawMedia | null>;
  fetchArtwork: (raw: RawMedia) => Promise<string | undefined>;
  /** User-initiated: play, launching the last app if no player is running. */
  resumeMedia: (lastApp?: string) => Promise<void>;
  /** User-initiated: launch/activate a player without playing. */
  openMediaApp: (app: MediaApp) => Promise<void>;
  topProcesses: (sort: ProcessSort, limit: number) => Promise<ProcessInfo[]>;
}

export interface StartOptions {
  port?: number;
  hostname?: string;
  deps?: Partial<Deps>;
  pin?: string;
  onPinChange?: (pin: string) => void;
  /** Media poll interval while a socket is connected (default 1500 ms). */
  mediaPollMs?: number;
  /** last-media.json location (tests: a temp file). */
  lastMediaFile?: string;
  /** quota-history.json location (tests: a temp file). */
  quotaHistoryFile?: string;
  /** App/icon service (tests: fake sips/plutil and temp dirs). */
  icons?: Icons;
  /** Home Assistant client (built separately); weather, hass actions, macros and rules use it when present. */
  hass?: HassLike;
  /** Webhook key file (tests). */
  webhookKeyFile?: string;
  /** fetch for Open-Meteo (tests). */
  weatherFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Weather refresh while phones are connected, default 15 min. */
  weatherMs?: number;
  /** Rules time/idle tick, default 30 s. */
  rulesTickMs?: number;
  /** Soundboard library (tests: temp home and fake afinfo). */
  sounds?: SoundLibrary;
  /** How sound player processes are started (tests: a fake; never plays audio). */
  soundSpawn?: SpawnFn;
  /** Machine name for the .local address (tests). */
  hostName?: () => Promise<string>;
  /** layout-history folder (tests: a temp dir). */
  layoutHistoryDir?: string;
  /** Quota/session sources (fakes in tests). */
  aiSources?: AiSources;
  aiSessionsMs?: number; // default 5000
  aiQuotaMs?: number; // how often to check quota staleness, default 60000 (a real fetch happens every 5 min)
  permissionTimeoutMs?: number;
  hookSecret?: string;
  /** Hook config file per tool (defaults to the real ~/.claude/settings.json and ~/.codex/hooks.json: tests must override). */
  hookPaths?: Partial<Record<HookTool, string>>;
  /** Where the OpenCode plugin / the Grok hook file go (tests point these into a temp dir). */
  opencodePluginFile?: string;
  /** Tests: a checker with a fake release lookup. */
  updateChecker?: import("./update").UpdateChecker;
  grokHookFile?: string;
  /** Claude's questions on the phone: settings file, idle-time reader (seconds, null = unknown) and timeout (tests). */
  askSettingsFile?: string;
  /** Probes for GET /api/doctor (fakes in tests: the real ones ask macOS). */
  doctorProbes?: Probes;
  /** How long GET /api/doctor waits for the first Claude quota read (default 5000). */
  doctorWaitMs?: number;
  idleSeconds?: () => Promise<number | null>;
  questionTimeoutMs?: number;
}

interface WsData {
  deviceId: string | null;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * Reads and drops a request body (up to 16 MB) before an early error reply. Answering while the client is still sending
 * can make the connection reset mid-upload, and the client then fails with "Unable to connect" instead of seeing the status.
 */
async function drainBody(req: Request): Promise<void> {
  if (Number(req.headers.get("content-length") ?? 0) > 16 * 1024 * 1024) return;
  try { await req.arrayBuffer(); } catch { /* the client went away */ }
}

export async function startServer(opts: StartOptions = {}) {
  // Real modules are loaded lazily so tests can inject fakes without them.
  const actions = opts.deps?.runAction && opts.deps.setVolume && opts.deps.readVolume ? undefined : await import("./actions");
  const media = opts.deps?.readMedia && opts.deps.fetchArtwork ? undefined : await import("./media");
  const deps: Deps = {
    runAction: opts.deps?.runAction ?? actions!.runAction,
    startStats: opts.deps?.startStats ?? (await import("./stats")).startStats,
    setVolume: opts.deps?.setVolume ?? actions!.setVolume,
    readVolume: opts.deps?.readVolume ?? actions!.readVolume,
    readMedia: opts.deps?.readMedia ?? media!.readMedia,
    fetchArtwork: opts.deps?.fetchArtwork ?? media!.fetchArtwork,
    resumeMedia: opts.deps?.resumeMedia ?? realResumeMedia,
    openMediaApp: opts.deps?.openMediaApp ?? realOpenMediaApp,
    topProcesses: opts.deps?.topProcesses ?? realTopProcesses,
  };
  const toolStates = new ToolStates();
  const baseSources = opts.aiSources ?? realAiSources(toolStates);
  const quotaHistory = new QuotaHistory(opts.quotaHistoryFile);
  await quotaHistory.load();
  const hub = new AiHub(baseSources, undefined, quotaHistory);
  const hookSecret = opts.hookSecret ?? (await ensureHookSecret());
  // the integrations blocks for the two newer tools (read-only facts about the local install)
  const opencodeBlock = async (quota: any) => {
    const bin = opencodePath();
    const v = await detectOpencode(undefined, bin);
    const sessions = readOpencodeSessions().length;
    const everything = readOpencodeSessions(undefined, Date.now(), 500, Number.POSITIVE_INFINITY);
    const last = everything[0];
    const noQuota = !v || v.major < 2;
    return {
      // a binary outside PATH (~/.opencode/bin ...) counts, and so does its data directory
      installed: bin !== null || opencodeDataFound(), ...(bin ? { binary: bin } : {}), ...(v ? { version: v.version, line: v.major } : {}), sessions, total: everything.length,
      ...(last ? { lastSessionAt: last.updatedAt } : {}), sessionsRule: "top-level sessions updated in the last 7 days, newest first",
      quota: noQuota ? null : quota,
      ...(noQuota ? { quotaReason: v ? "OpenCode 1.x has no usage limits (cost and tokens are shown per session)" : bin ? "could not read the OpenCode version" : "OpenCode was not found" } : {}),
      plugin: { installed: await isPluginInstalled(opts.opencodePluginFile ?? pluginPath()), path: opts.opencodePluginFile ?? pluginPath() },
    };
  };
  const grokBlock = async () => {
    const bin = grokPath();
    const recent = await readGrokSessions();
    const all = await readGrokSessions({ windowMs: Number.POSITIVE_INFINITY, limit: 500 });
    return {
    installed: bin !== null || grokDataFound(), ...(bin ? { binary: bin } : {}), sessions: recent.length, total: all.length, running: recent.filter((s) => s.running).length,
    ...(all[0] ? { lastSessionAt: all[0].updatedAt } : {}), sessionsRule: "sessions updated in the last 7 days, newest first; idle unless active_sessions.json lists them (running) or a hook reports busy/waiting",
    quota: await grokQuota().then((q) => (q.windows.length || q.plan ? q : null)).catch(() => null),
    quotaReason: "Usage comes from the Grok CLI itself (grok agent stdio, an internal and undocumented method); PhoneDesk never reads your Grok login or cookies",
    hook: { installed: await isGrokHookInstalled(opts.grokHookFile ?? grokHookFile()), path: opts.grokHookFile ?? grokHookFile() },
    };
  };
  const updates = opts.updateChecker ?? new UpdateChecker();
  const pathFor = (t: HookTool) => opts.hookPaths?.[t] ?? hookConfigPath(t);
  let layout: Layout = await loadLayout();
  setLanguage(layout.theme?.language);
  const icons = opts.icons ?? new Icons({ catalog: async () => (CATALOG ? Bun.file(CATALOG.path).text() : null) });
  /** Icons the phone cannot draw by itself (catalog SVGs, app icons, uploads), recomputed on every layout change. */
  let layoutAssets = await icons.layoutAssets(layout).catch(() => ({}));
  const layoutMsg = () => ({ type: "layout", layout, assets: layoutAssets });
  let catalogGz: Uint8Array | undefined;
  const sounds = opts.sounds ?? new SoundLibrary();
  const player = new SoundPlayer({ spawn: opts.soundSpawn, onChange: (ids) => broadcast({ type: "sounds-playing", ids }) });
  const history = new LayoutHistory(opts.layoutHistoryDir);
  // the layout in force is always the newest history entry (so the first undo has something to go back to)
  await history.push(layout).catch(() => {});
  const sockets = new Set<ServerWebSocket<WsData>>();
  const pairing = new Pairing(opts.onPinChange, opts.pin);

  const send = (ws: ServerWebSocket<WsData>, msg: unknown) => {
    try { ws.send(JSON.stringify(msg)); } catch {}
  };
  const broadcast = (msg: unknown) => {
    for (const ws of sockets) send(ws, msg);
  };


  // ----- automation: pushed values, notifications, macros, rules, weather -----
  // Home Assistant: the real client stays idle until a url and token are configured (then it connects and reconnects by itself)
  const hassClient: HassClient | undefined = opts.hass ? (opts.hass instanceof HassClient ? opts.hass : undefined) : new HassClient({ store: new HassConfigStore() });
  const hass: HassLike = opts.hass ?? hassClient!;
  const syncHass = () => hassClient?.setWanted(wantedEntities(layout));
  syncHass();
  hassClient?.onEntities((changed) => broadcast({ type: "hass", entities: changed, connected: hassClient.connected() }));
  let hassWasConnected = false;
  hassClient?.onStatus((st) => {
    broadcast({ type: "hass", entities: {}, connected: st.connected });
    // weather tiles on "auto" depend on whether Home Assistant is there: re-evaluate when that changes
    if (st.connected !== hassWasConnected) { hassWasConnected = st.connected; if (sockets.size) void pushWeather(); }
  });
  if (hassClient) void hassClient.start().catch((e) => console.error("hass", e));
  const webhookKey = new WebhookKey(opts.webhookKeyFile);
  const notes = new NotificationStore();
  let themeOverride: "dark" | "light" | null = null;
  const stopCtl = new AbortController();
  const pushes = new PushStore((key, v) => {
    rules.setPush(key, v?.value);
    broadcast({ type: "pushed", values: { [key]: v ? { value: v.value, ...(v.sub ? { sub: v.sub } : {}), ...(v.items?.length ? { items: v.items } : {}), at: v.at } : null } });
  });
  const addNote = (n: { title: string; body?: string; level?: NotifyLevel; ttl?: number; source?: string }) => {
    const notification = notes.add(n);
    broadcast({ type: "notify", notification });
    return notification;
  };
  const syncOmni = () => {
    try {
      const v = readOmniValues();
      if (!v) return;
      pushes.set("omni_spend", v.spend.value, { sub: v.spend.sub });
      pushes.set("omni_volume", v.volume.value, { sub: v.volume.sub });
      pushes.set("omni_health", v.health.value, { sub: v.health.sub });
    } catch (e) {
      console.error("omniroute", e);
    }
  };
  const findAction = (pageId: string, itemId: string) => {
    const it = layout.pages.find((p) => p.id === pageId)?.items.find((i) => i.id === itemId);
    return it && it.kind === "button" ? it.action : undefined;
  };
  async function execute(action: Action, depth = 0, ws?: ServerWebSocket<WsData>): Promise<void> {
    switch (action.type) {
      case "page": return;
      case "sound-stop":
        player.stopAll();
        broadcast({ type: "stop-sounds" });
        return;
      case "sound": {
        const info = await sounds.get(action.sound);
        if (!info) throw new Error(t("the sound is no longer in the library"));
        const on = action.on ?? "mac", volume = action.volume ?? 100, mode = action.mode ?? "restart";
        if (on === "mac" || on === "both") player.play(info.id, info.path, volume, mode);
        if ((on === "phone" || on === "both") && ws) send(ws, { type: "play-sound", id: info.id, url: `/sounds/${bareId(info.id)}`, volume, mode });
        return;
      }
      case "macro": {
        const ctx: MacroCtx = {
          exec: (a, d) => execute(a, d, ws),
          item: findAction,
          notify: (text) => void addNote({ title: text, source: "macro" }),
          sleep: abortableSleep,
          signal: stopCtl.signal,
        };
        return runMacro(action.steps, ctx, depth);
      }
      case "hass":
        if (!hass.connected()) throw new Error(t("Home Assistant is not connected"));
        return hass.callService(action.service, action.entityId, action.data);
      default: return deps.runAction(action);
    }
  }
  const rules: RuleEngine = new RuleEngine({
    rules: () => layout.rules ?? [],
    actions: {
      gotoPage: (pageId, o) => broadcast({ type: "goto", pageId, countdown: o.countdown, reason: o.reason, ruleId: o.ruleId, revert: o.revert }),
      gotoRevert: (ruleId) => broadcast({ type: "goto-revert", ruleId }),
      notify: (text, level, ruleId) => void addNote({ title: text, level, source: `rule:${ruleId}` }),
      themeMode: (mode) => { themeOverride = mode; broadcast({ type: "theme-override", mode }); },
      runItem: async (pageId, itemId) => {
        const a = findAction(pageId, itemId);
        if (!a) throw new Error(t("button {id} not found", { id: `${pageId}/${itemId}` }));
        await execute(a);
      },
    },
  });
  const rulesTimer = setInterval(() => rules.tick(), opts.rulesTickMs ?? 30_000);
  (rulesTimer as any).unref?.();
  const unsubHass = hass.onState?.((id, st) => rules.setHass(id, st?.state));
  syncOmni();
  const omniTimer = setInterval(syncOmni, 5 * 60_000);
  omniTimer.unref?.();

  const weather = new WeatherService({ fetch: opts.weatherFetch, hass: () => hass });
  async function weatherItems(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const jobs: Promise<void>[] = [];
    for (const page of layout.pages) for (const it of page.items) {
      if (it.kind !== "widget" || it.widget !== "weather") continue;
      const id = it.id;
      jobs.push(weather.get(it.weather ?? {}, false, layout.theme?.temperatureUnit).then((d) => { out[id] = d; }, (e) => { out[id] = { error: e?.message ?? String(e) }; }));
    }
    await Promise.all(jobs);
    return out;
  }
  let weatherTimer: ReturnType<typeof setInterval> | undefined;
  async function pushWeather(to?: ServerWebSocket<WsData>) {
    const items = await weatherItems();
    if (stopped || !Object.keys(items).length) return;
    if (to) send(to, { type: "weather", items }); else broadcast({ type: "weather", items });
  }

  const pairingInfo = async () => {
    const ip = lanIp();
    const port = server.port as number;
    const host = await (opts.hostName ?? localHostName)();
    return {
      pin: pairing.pin,
      url: `http://${ip}:${port}/?pin=${pairing.pin}`,
      lanIp: ip,
      port,
      host,
      /** Survives IP changes: the Bonjour/mDNS name of this machine. */
      urlLocal: `http://${host}.local:${port}/?pin=${pairing.pin}`,
    };
  };

  let lastStats: Stats | undefined;
  const stopStats = deps.startStats((stats) => {
    lastStats = stats;
    rules.setCpu(stats.cpu);
    broadcast({ type: "stats", stats });
  });

  // ----- media: polled only while at least one socket is connected -----
  const tracker = new MediaTracker({ read: deps.readMedia, artwork: deps.fetchArtwork });
  const lastMedia = new LastMediaStore(opts.lastMediaFile);
  await lastMedia.load();
  /** The media message: `last` rides along only when nothing is playing. */
  const mediaMsg = (media: unknown) => ({ type: "media", media, ...(media === null && lastMedia.last ? { last: lastMedia.last } : {}) });
  const pollMs = opts.mediaPollMs ?? 1500;
  let mediaTimer: ReturnType<typeof setTimeout> | undefined;
  let mediaGen = 0;
  let polling = false;
  let stopped = false;

  /** 1.5 s normally; 0.3 s while a playing track has under 15 s left, so the next track shows up at once. */
  function mediaDelay(): number {
    const m = tracker.seen;
    return m && m.playing && m.duration > 0 && m.duration - m.position < NEAR_END_S ? Math.min(NEAR_END_MS, pollMs) : pollMs;
  }
  function startMediaLoop() {
    const gen = ++mediaGen;
    const tick = async () => {
      await pollMedia();
      if (gen === mediaGen && !stopped) mediaTimer = setTimeout(() => void tick(), mediaDelay());
    };
    mediaTimer = setTimeout(() => void tick(), 0);
  }
  function stopMediaLoop() {
    mediaGen++;
    if (mediaTimer) clearTimeout(mediaTimer);
    mediaTimer = undefined;
  }

  async function pollMedia() {
    if (polling || stopped) return;
    polling = true;
    try {
      const r = await tracker.poll();
      if (tracker.seen) {
        lastMedia.remember(tracker.seen);
        void lastMedia.persist();
      } else if (r.changed) void lastMedia.persist(true); // stopped: keep the final position
      if (!r.changed || stopped) return;
      rules.setMedia(!!r.media?.playing);
      // artwork rides along on connect, track changes and when a cached cover changes
      const media = r.media && !r.trackChanged && !r.artworkChanged ? { ...r.media, artwork: undefined } : r.media;
      broadcast(mediaMsg(media));
    } finally {
      polling = false;
    }
  }

  // ----- AI quotas / sessions / permissions -----
  const broker = new PermissionBroker(
    {
      hasPhones: () => sockets.size > 0,
      notify: (request) => {
        broadcast({ type: "permission", request });
        rules.setAiPrompts(promptProviders());
        void refreshSessions();
      },
      resolved: (id, decision) => {
        broadcast({ type: "permission-resolved", id, decision });
        queueMicrotask(() => rules.setAiPrompts(promptProviders()));
        void refreshSessions();
      },
    },
    opts.permissionTimeoutMs ?? PERMISSION_TIMEOUT_MS,
  );
  const askSettings = new AskSettingsStore(opts.askSettingsFile);
  const doctorProbes = () => opts.doctorProbes ?? realProbes(pkg.version);
  async function doctorReport(): Promise<DoctorReport> {
    // the first quota read can still be in flight right after start: wait for it a little before judging
    const read = () => hub.snapshot().providers.find((x) => x.id === "claude");
    // quotas are only polled while a phone shows them; without one the read never starts, so start it here
    // (refreshQuotas keeps its own cache, like /api/integrations)
    if (read()?.updatedAt === 0) await hub.refreshQuotas().catch(() => false);
    let claude = read();
    for (let i = 0; i < Math.round((opts.doctorWaitMs ?? 5000) / 200) && claude && claude.updatedAt === 0; i++) { await new Promise((r) => setTimeout(r, 200)); claude = read(); }
    return runDoctor(doctorProbes(), {
      hass: hassClient ? await hassClient.status() : null,
      claude: claude ? (claude.updatedAt === 0 ? { ok: false, pending: true } : { ok: !claude.error && claude.windows.length > 0, ...(claude.error ? { error: claude.error } : {}) }) : null,
      instance: currentInstance(server.port),
    });
  }
  const questions: QuestionBroker = new QuestionBroker(
    {
      hasPhones: () => sockets.size > 0,
      notify: (request) => {
        broadcast({ type: "question", request });
        rules.setAiPrompts(promptProviders());
        void refreshSessions();
      },
      resolved: (id, how) => {
        broadcast({ type: "question-resolved", id, how });
        queueMicrotask(() => rules.setAiPrompts(promptProviders()));
        void refreshSessions();
      },
    },
    opts.questionTimeoutMs ?? QUESTION_TIMEOUT_MS,
  );
  const promptProviders = () => [...broker.list().map((r) => r.source), ...questions.hints().map((h) => h.source)];
  const pushAi = () => {
    const ai = hub.snapshot();
    const q: Partial<Record<"claude" | "codex" | "antigravity" | "opencode", number>> = {};
    for (const pr of ai.providers) { const used = pr.windows.flatMap((w) => (w.usedPercent === null ? [] : [w.usedPercent])); if (used.length && pr.id !== "grok" && pr.id !== "omni") q[pr.id] = Math.max(...used); }
    rules.setQuota(q);
    rules.setAiInput(ai.sessions.filter((x) => x.state === "waiting" && !x.prompt).map((x) => x.tool));
    broadcast({ type: "ai", ai });
  };
  async function refreshSessions() {
    if (stopped) return;
    if (await hub.refreshSessions([...broker.hints(), ...questions.hints()])) pushAi();
  }
  async function refreshQuotas(force = false) {
    if (stopped) return;
    if (await hub.refreshQuotas(force)) pushAi();
  }
  let aiSessionsTimer: ReturnType<typeof setInterval> | undefined;
  let aiQuotaTimer: ReturnType<typeof setInterval> | undefined;
  /** AI data is read while a phone or the management page is listening. */
  function startAi() {
    if (!aiSessionsTimer) {
      aiSessionsTimer = setInterval(() => void refreshSessions(), opts.aiSessionsMs ?? 5000);
      aiQuotaTimer = setInterval(() => void refreshQuotas(), opts.aiQuotaMs ?? 60_000);
      void refreshSessions();
    }
    if (hub.quotasStale) void refreshQuotas();
  }
  function stopAiIfIdle() {
    if (sockets.size === 0 && aiSessionsTimer) {
      clearInterval(aiSessionsTimer);
      clearInterval(aiQuotaTimer);
      aiSessionsTimer = aiQuotaTimer = undefined;
    }
  }

  /** Shortly after a control action the player/volume state has changed: push it without waiting for the timer. */
  function refreshSoon(what: "media" | "volume") {
    setTimeout(async () => {
      if (stopped || sockets.size === 0) return;
      if (what === "media") return void pollMedia();
      const volume = await deps.readVolume().catch(() => null);
      if (lastStats && !stopped) {
        lastStats = { ...lastStats, volume };
        broadcast({ type: "stats", stats: lastStats });
      }
    }, what === "media" ? 250 : 0);
  }

  // Localhost-only routes: peer must be this machine AND the request must come from our own pages (Host, Origin,
  // JSON content type, X-PhoneDesk header), so a web page open in a browser here cannot drive the API.
  const guardLocal = (server: Server<WsData>, req: Request, kind: { upload?: boolean; hook?: boolean } = {}): Response | null => {
    // a browser opening a page here from another machine gets a readable HTML page; the JSON API keeps JSON
    const refuse = (error: string): Response => {
      const path = new URL(req.url).pathname;
      if (!wantsPage(req.method, path)) return json({ error }, 403);
      const html = forbiddenPage(server.port as number, pickLanguage(layout.theme?.language, req.headers.get("accept-language")));
      return new Response(req.method === "HEAD" ? null : html, { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    };
    if (!isLocal(server.requestIP(req)?.address)) return refuse("forbidden: localhost only");
    const why = localRequestError({ port: server.port as number, method: req.method, headers: req.headers, ...kind });
    return why ? refuse(why) : null;
  };
  const isLocalPeer = (server: Server<WsData>, req: Request) => isLocal(server.requestIP(req)?.address);
  /** Phone-facing routes: only names that really are this machine (LAN IP, .local, localhost); other Hosts are rebinding. */
  const guardPhone = async (server: Server<WsData>, req: Request): Promise<Response | null> => {
    const host = await (opts.hostName ?? localHostName)().catch(() => "");
    const names = phoneNames([host]);
    return hostAllowed(req.headers.get("host"), server.port as number, names) ? null : json({ error: "forbidden: bad Host" }, 403);
  };

  async function readBody(req: Request): Promise<any> {
    try { return await req.json(); } catch { return undefined; }
  }

  const sndPhone = /^\/sounds\/[^/]+$/;

  /** A request that takes more than 10 s is logged (once, while it is still running): a hung route shows up in agent.err.log. */
  const slowWatch = <A extends unknown[], R>(h: (req: Request, ...rest: A) => Promise<R>) => async (req: Request, ...rest: A): Promise<R> => {
    const t0 = Date.now();
    const timer = setTimeout(() => console.warn(`[watchdog] ${req.method} ${new URL(req.url).pathname} has been running for more than 10 s`), 10_000);
    try { return await h(req, ...rest); } finally { clearTimeout(timer); const ms = Date.now() - t0; if (ms > 10_000) console.warn(`[watchdog] ${req.method} ${new URL(req.url).pathname} finished after ${Math.round(ms / 1000)} s`); }
  };

  const server = Bun.serve<WsData>({
    idleTimeout: 120, // permission hooks long-poll for up to 55 s
    port: opts.port ?? 7420,
    hostname: opts.hostname ?? "0.0.0.0",
    fetch: slowWatch(async (req: Request, server: any) => {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/ws" || path === "/api/pair" || sndPhone.test(path)) {
        const bad = await guardPhone(server, req);
        if (bad) return bad;
      }
      if (path === "/ws") {
        const org = req.headers.get("origin");
        if (org && org.replace(/^https?:\/\//i, "") !== req.headers.get("host")) return json({ error: "forbidden: Origin does not match Host" }, 403);
        // the token comes from ?token= or from the pd_token cookie set at pairing
        const token = url.searchParams.get("token") || cookieToken(req.headers.get("cookie"));
        const device = await pairing.findDevice(token);
        // a valid connect renews the cookie for another year
        const headers = device && token ? { "set-cookie": tokenCookie(token) } : undefined;
        if (server.upgrade(req, { data: { deviceId: device?.id ?? null }, ...(headers ? { headers } : {}) })) return undefined;
        return json({ error: "upgrade failed" }, 400);
      }

      if (path === "/api/pair" && req.method === "POST") {
        const body = await readBody(req);
        const res = await pairing.pair(body?.pin, body?.name);
        return res ? new Response(JSON.stringify(res), { headers: { "content-type": "application/json", "set-cookie": tokenCookie(res.token) } }) : json({ error: "invalid pin" }, 401);
      }

      if (path === "/api/apps" && req.method === "GET") {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        return json(await icons.listApps());
      }
      if (path === "/api/layout/assets" && req.method === "POST") {
        // the assets map the phone would get for this (unsaved) layout, so the management preview can draw every icon
        const denied = guardLocal(server, req);
        if (denied) return denied;
        const body = await readBody(req);
        let l: Layout;
        try { l = validateLayout(body?.layout); } catch (err: any) { return json({ error: err?.message ?? String(err) }, 400); }
        return json(await icons.layoutAssets(l).catch(() => ({})));
      }
      if (path === "/api/apps/icon" && req.method === "GET") {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        const id = url.searchParams.get("bundleId") ?? "";
        if (!BUNDLE_ID_RE.test(id)) return json({ error: "invalid bundleId" }, 400);
        const png = await icons.appIcon(id);
        return png ? new Response(png as unknown as BodyInit, { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } }) : json({ error: "no icon" }, 404);
      }
      if (path === "/api/icons/catalog" && req.method === "GET") {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        if (!CATALOG) return json({ error: "catalog not embedded" }, 404);
        const headers: Record<string, string> = { "content-type": CATALOG.type, "cache-control": "public, max-age=604800", vary: "accept-encoding" };
        if (/\bgzip\b/.test(req.headers.get("accept-encoding") ?? "")) {
          catalogGz ??= Bun.gzipSync(new Uint8Array(await Bun.file(CATALOG.path).arrayBuffer()));
          return new Response(catalogGz as unknown as BodyInit, { headers: { ...headers, "content-encoding": "gzip" } });
        }
        return new Response(Bun.file(CATALOG.path), { headers });
      }
      if (path === "/api/icons" && req.method === "POST") {
        const denied = guardLocal(server, req, { upload: true });
        if (denied) return denied;
        const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        if (type !== "image/png" && type !== "image/jpeg") { await drainBody(req); return json({ error: "content-type must be image/png or image/jpeg" }, 415); }
        if (Number(req.headers.get("content-length") ?? 0) > UPLOAD_MAX) { await drainBody(req); return json({ error: "image is larger than 512 KB" }, 413); }
        const bytes = new Uint8Array(await req.arrayBuffer());
        try {
          return json({ id: await icons.saveUpload(bytes) });
        } catch (err: any) {
          return json({ error: err?.message ?? String(err) }, bytes.length > UPLOAD_MAX ? 413 : 400);
        }
      }
      const imgRoute = path.match(/^\/api\/icons\/img\/([^/]+)$/);
      if (imgRoute) {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        const id = imgRoute[1]!;
        if (!IMG_ID_RE.test(id)) return json({ error: "invalid id" }, 400);
        if (req.method === "GET") {
          const png = await icons.upload(id);
          return png ? new Response(png as unknown as BodyInit, { headers: { "content-type": "image/png", "cache-control": "private, max-age=3600" } }) : json({ error: "not found" }, 404);
        }
        if (req.method === "DELETE") {
          if (!(await icons.deleteUpload(id))) return json({ error: "not found" }, 404);
          layoutAssets = await icons.layoutAssets(layout).catch(() => ({}));
          broadcast(layoutMsg()); // a layout still using it falls back to its text
          return json({ ok: true });
        }
        return json({ error: "method not allowed" }, 405);
      }

      if (path === "/api/sounds" && req.method === "POST") {
        const denied = guardLocal(server, req, { upload: true });
        if (denied) return denied;
        const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        if (!SOUND_TYPES.includes(type)) return json({ error: "content-type must be audio/mpeg, audio/mp4, audio/wav, audio/aac or audio/ogg" }, 415);
        if (Number(req.headers.get("content-length") ?? 0) > SOUND_MAX) { await drainBody(req); return json({ error: "file is larger than 5 MB" }, 413); }
        const bytes = new Uint8Array(await req.arrayBuffer());
        const rawName = url.searchParams.get("name") ?? req.headers.get("x-sound-name");
        let name = rawName ?? undefined;
        try { if (name && req.headers.get("x-sound-name") === name) name = decodeURIComponent(name); } catch { /* keep raw */ }
        try {
          const info = await sounds.add(bytes, name);
          return json({ id: info.id, name: info.name, durationMs: info.durationMs, size: info.size });
        } catch (err: any) {
          return json({ error: err?.message ?? String(err) }, bytes.length > SOUND_MAX ? 413 : 400);
        }
      }
      if (path === "/api/sounds" && req.method === "GET") {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        return json((await sounds.list()).map(({ id, name, durationMs, size, createdAt }) => ({ id, name, durationMs, size, createdAt })));
      }
      const sndApi = path.match(/^\/api\/sounds\/([^/]+)$/);
      if (sndApi && (req.method === "PATCH" || req.method === "DELETE")) {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        const id = decodeURIComponent(sndApi[1]!);
        if (!SOUND_ID_HEX.test(bareId(id))) return json({ error: "invalid id" }, 400);
        if (req.method === "DELETE") {
          player.stopId(`snd:${bareId(id)}`);
          return (await sounds.remove(id)) ? json({ ok: true }) : json({ error: "not found" }, 404);
        }
        const body = await readBody(req);
        if (typeof body?.name !== "string" || !body.name.trim()) return json({ error: "name must be a non-empty string" }, 400);
        const info = await sounds.rename(id, body.name);
        return info ? json({ id: info.id, name: info.name, durationMs: info.durationMs, size: info.size }) : json({ error: "not found" }, 404);
      }
      const sndFile = path.match(/^\/sounds\/([^/]+)$/);
      if (sndFile && (req.method === "GET" || req.method === "HEAD")) {
        // paired phones (token or cookie) and this computer
        if (!isLocalPeer(server, req)) {
          const device = await pairing.findDevice(url.searchParams.get("token") || cookieToken(req.headers.get("cookie")));
          if (!device) return json({ error: "unauthorized" }, 401);
        }
        const hex = bareId(decodeURIComponent(sndFile[1]!));
        const info = SOUND_ID_HEX.test(hex) ? await sounds.get(hex) : null;
        if (!info) return json({ error: "not found" }, 404);
        const file = Bun.file(info.path);
        const size = file.size;
        const headers: Record<string, string> = { "content-type": sounds.mime(info.ext), "accept-ranges": "bytes", "cache-control": "private, max-age=3600" };
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
        if (range && (range[1] || range[2])) {
          let start = range[1] ? Number(range[1]) : size - Number(range[2]);
          let end = range[1] && range[2] ? Number(range[2]) : size - 1;
          start = Math.max(0, start);
          end = Math.min(size - 1, end);
          if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
          return new Response(req.method === "HEAD" ? null : file.slice(start, end + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
        }
        return new Response(req.method === "HEAD" ? null : file, { headers: { ...headers, "content-length": String(size) } });
      }

      if (path === "/api/layout/history" && req.method === "GET") {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        return json(await history.list());
      }
      if (path === "/api/layout/undo" && req.method === "POST") {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        const prev = await history.undo();
        if (!prev) return json({ error: "nothing to undo" }, 409);
        await saveLayout(prev);
        layout = prev;
        setLanguage(layout.theme?.language);
        syncHass();
        layoutAssets = await icons.layoutAssets(layout).catch(() => ({}));
        broadcast(layoutMsg());
        return json({ ok: true, layout });
      }

      if (path === "/api/layout") {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        if (req.method === "GET") return json(layout);
        if (req.method === "PUT") {
          const body = await readBody(req);
          let next: Layout;
          try { next = validateLayout(body); } catch (err: any) { return json({ error: err?.message ?? String(err) }, 400); }
          await saveLayout(next);
          layout = next;
          setLanguage(layout.theme?.language);
          syncHass();
          await history.push(next).catch((e) => console.error("layout history", e));
          layoutAssets = await icons.layoutAssets(layout).catch(() => ({}));
          broadcast(layoutMsg());
          void pushWeather();
          rules.tick();
          return json({ ok: true });
        }
        return json({ error: "method not allowed" }, 405);
      }

      if (path === "/api/devices" && req.method === "GET") {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        const devices = await loadDevices();
        const online = new Set([...sockets].map((s) => s.data.deviceId));
        return json(devices.map(({ tokenHash, ...d }) => ({ ...d, online: online.has(d.id) })));
      }

      if (path === "/api/devices/reload" && req.method === "POST") {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        let target: string | undefined;
        const raw = (await req.text()).trim();
        if (raw) {
          let body: any;
          try { body = JSON.parse(raw); } catch { return json({ error: "invalid JSON" }, 400); }
          if (body?.deviceId !== undefined) {
            if (typeof body.deviceId !== "string" || !body.deviceId) return json({ error: "deviceId must be a string" }, 400);
            target = body.deviceId;
          }
        }
        let count = 0;
        for (const ws of sockets) {
          if (target !== undefined && ws.data.deviceId !== target) continue;
          send(ws, { type: "reload" });
          count++;
        }
        return json({ ok: true, count });
      }

      const m = path.match(/^\/api\/devices\/([^/]+)$/);
      if (m && req.method === "DELETE") {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        const id = decodeURIComponent(m[1]);
        const found = await withDevicesLock(async () => {
          const devices = await loadDevices();
          if (!devices.some((d) => d.id === id)) return false;
          await saveDevices(devices.filter((d) => d.id !== id));
          return true;
        });
        if (!found) return json({ error: "not found" }, 404);
        for (const ws of [...sockets]) {
          if (ws.data.deviceId !== id) continue;
          send(ws, { type: "pair-revoked" });
          ws.close(4403, "revoked");
        }
        return json({ ok: true });
      }

      if (path === "/api/hooks/permission" && req.method === "POST") {
        const denied = guardLocal(server, req, { hook: true });
        if (denied) return denied;
        if (!secretMatches(req.headers.get("x-phonedesk-hook"), hookSecret)) return json({ error: "bad hook secret" }, 401);
        const input = parseHookInput(await readBody(req));
        if ("error" in input) return json({ error: input.error }, 400);
        // risk is shown next to the request, it never decides anything
        const { risk, reason } = classifyRisk(input.toolName, input.toolInput, input.cwd);
        return json({ decision: await broker.request(input, req.signal, { risk, ...(reason ? { riskReason: reason } : {}) }) });
      }

      if (path === "/api/hooks/question" && req.method === "POST") {
        const denied = guardLocal(server, req, { hook: true });
        if (denied) return denied;
        if (!secretMatches(req.headers.get("x-phonedesk-hook"), hookSecret)) return json({ error: "bad hook secret" }, 401);
        const input = parseQuestionInput(await readBody(req));
        if ("error" in input) return json({ error: input.error }, 400);
        // "only when I am away": while the user is typing at this computer, Claude asks in the terminal
        if ((await askSettings.get()).onlyWhenAway) {
          const idle = await (opts.idleSeconds ?? readIdleSeconds)();
          if (idle !== null && idle <= AWAY_IDLE_SECONDS) return json({ answers: null, reason: "present" });
        }
        return json({ answers: await questions.request(input, req.signal) });
      }

      // busy / idle / waiting as the tools themselves report it (Grok hooks, the OpenCode 1.x plugin)
      if (path === "/api/hooks/state" && req.method === "POST") {
        const denied = guardLocal(server, req, { hook: true });
        if (denied) return denied;
        if (!secretMatches(req.headers.get("x-phonedesk-hook"), hookSecret)) return json({ error: "bad hook secret" }, 401);
        const b = await readBody(req);
        if (b?.source !== "grok" && b?.source !== "opencode") return json({ error: "source must be grok or opencode" }, 400);
        if (!["busy", "idle", "waiting"].includes(b?.state)) return json({ error: "state must be busy, idle or waiting" }, 400);
        if (typeof b.sessionId !== "string" || !b.sessionId) {
          // a Grok notification without a session id: nothing to attach it to
          return json({ ok: true, ignored: true });
        }
        toolStates.set(b.source, b.sessionId.slice(0, 200), b.state as ToolState);
        void refreshSessions();
        return json({ ok: true });
      }

      if (path === "/api/about" && req.method === "GET") {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        return json(aboutInfo());
      }
      if (path === "/api/update" && req.method === "GET") {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        return json(await updates.get(layout.theme?.updateCheck !== false, url.searchParams.get("refresh") === "1"));
      }
      if (path === "/api/platform" && req.method === "GET") {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        // what the management page needs to show the right key names: layouts always store cmd / option
        return json({ id: platform.id, label: platform.label, keyNames: platform.keyNames });
      }
      if (path === "/api/doctor" && req.method === "GET") {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        return json(await doctorReport());
      }
      if (path === "/api/doctor/request" && req.method === "POST") {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        const body = await readBody(req);
        const what = describeRequest(String(body?.id ?? ""));
        if (!what) return json({ error: "this check cannot be requested" }, 400);
        const probes = doctorProbes();
        // reset: clear a stale grant (an older build) so macOS asks again; only when the user pressed Reset
        if (body?.reset === true && platform.id === "darwin" && !opts.doctorProbes) {
          const svc = tccServiceFor(what.id);
          const ident = svc ? macIdentifier() : null;
          if (svc && ident) Bun.spawnSync(["tccutil", "reset", svc, ident], { stdout: "ignore", stderr: "ignore" });
        }
        // shows macOS's own prompt for THIS process (the phonedesk binary under the LaunchAgent)
        if (what.kind === "accessibility") await probes.requestAccessibility();
        else if (what.kind === "local-network") {
          // macOS shows the Local Network prompt when this process first reaches the LAN: an mDNS query plus a Home Assistant test
          if (!opts.doctorProbes) await touchLocalNetwork().catch(() => {});
          await hassClient?.test().catch(() => null);
        } else await probes.requestAutomation(what.bundle!);
        const item = (await doctorReport()).items.find((i) => i.id === what.id);
        return json({ ok: true, item });
      }

      if (path === "/api/integrations" && req.method === "GET") {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        // The management page is not a paired phone, so it never triggers the WS-driven refresh: refresh here
        // (refreshQuotas keeps its own 5 min cache, so reloading the page does not hammer the providers).
        await hub.refreshQuotas().catch(() => false);
        const snap = hub.snapshot();
        const quota = (id: string) => {
          const p = snap.providers.find((x) => x.id === id);
          const ok = !!p && !p.error && p.windows.length > 0;
          return {
            ok,
            // read-only sources: "claude-code" | "codex-sessions" | "antigravity-local"; reason = why there is nothing to show
            source: QUOTA_SOURCE[id as AiProviderId],
            ...(!ok && (p?.error ?? "") ? { reason: p!.error, error: p!.error } : {}),
            ...(p ? { name: p.name, plan: p.plan, windows: p.windows, updatedAt: p.updatedAt } : { windows: [] }),
            ...(p?.extras ? { extras: p.extras } : {}),
          };
        };
        const claudeFile = pathFor("claude");
        const codexFile = pathFor("codex");
        return json({
          claude: { installed: await isHookInstalled(claudeFile), askHook: { installed: await isAskHookInstalled(claudeFile), ...(await askSettings.get()) }, settingsPath: claudeFile, cli: !!Bun.which("claude"), quota: quota("claude") },
          codex: { installed: await isHookInstalled(codexFile), settingsPath: codexFile, cli: !!Bun.which("codex"), quota: quota("codex") },
          antigravity: { available: agyPath() !== null, quota: quota("antigravity") },
          opencode: await opencodeBlock(quota("opencode")),
          grok: await grokBlock(),
        });
      }

      if (path === "/api/integrations/opencode/plugin" && (req.method === "POST" || req.method === "DELETE")) {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        const file = opts.opencodePluginFile ?? pluginPath();
        try {
          if (req.method === "DELETE") return json({ ok: true, ...(await uninstallPlugin(file)), installed: false, pluginPath: file });
          const v = await detectOpencode();
          const r = await installPlugin({ port: server.port as number, home: HOME, major: v?.major ?? 1 }, file);
          return json({ ok: true, ...r, installed: true, pluginPath: file, line: v?.major ?? 1, ...(v ? {} : { note: "opencode was not found, installed the 1.x plugin" }) });
        } catch (err: any) {
          return json({ error: err?.message ?? String(err) }, 500);
        }
      }
      if (path === "/api/integrations/grok/hook" && (req.method === "POST" || req.method === "DELETE")) {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        const file = opts.grokHookFile ?? grokHookFile();
        try {
          if (req.method === "DELETE") return json({ ok: true, ...(await uninstallGrokHook(file)), installed: false, hookPath: file });
          const r = await installGrokHook(hookCommand("claude", { port: server.port as number, home: HOME }), file);
          return json({ ok: true, ...r, installed: true, hookPath: file });
        } catch (err: any) {
          return json({ error: err?.message ?? String(err) }, 500);
        }
      }

      if (path === "/api/integrations/claude/ask-hook" && (req.method === "POST" || req.method === "DELETE" || req.method === "PUT")) {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        const file = pathFor("claude");
        try {
          if (req.method === "PUT") {
            const b = await readBody(req);
            if (typeof b?.onlyWhenAway !== "boolean") return json({ error: "onlyWhenAway must be true or false" }, 400);
            return json({ ok: true, installed: await isAskHookInstalled(file), ...(await askSettings.set({ onlyWhenAway: b.onlyWhenAway })) });
          }
          const r = req.method === "POST" ? await installAskHook(file, askHookCommand({ port: server.port as number, home: HOME })) : await uninstallAskHook(file);
          return json({ ok: true, changed: r.changed, installed: req.method === "POST", settingsPath: file, ...(await askSettings.get()) });
        } catch (err: any) {
          return json({ error: err?.message ?? String(err) }, 500);
        }
      }

      const hookRoute = path.match(/^\/api\/integrations\/(claude|codex)\/hook$/);
      if (hookRoute && (req.method === "POST" || req.method === "DELETE")) {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        const tool = hookRoute[1] as HookTool;
        const file = pathFor(tool);
        try {
          const r = req.method === "POST" ? await installHook(file, hookCommand(tool, { port: server.port as number, home: HOME })) : await uninstallHook(file);
          return json({ ok: true, changed: r.changed, installed: req.method === "POST", settingsPath: file });
        } catch (err: any) {
          return json({ error: err?.message ?? String(err) }, 500);
        }
      }

      // ---- webhooks: Bearer key from the LAN, or the usual localhost rules ----
      const hookAuth = async (): Promise<Response | null> => {
        if (await webhookKey.check(req.headers.get("authorization"))) return guardPhone(server, req);
        if (isLocalPeer(server, req)) return guardLocal(server, req);
        return json({ error: "unauthorized: send Authorization: Bearer <webhook key>" }, 401);
      };
      const pushRoute = path.match(/^\/api\/push\/([^/]+)$/);
      if (pushRoute && req.method === "POST") {
        const denied = await hookAuth();
        if (denied) return denied;
        const key = decodeURIComponent(pushRoute[1]!);
        if (!PUSH_KEY_RE.test(key)) return json({ error: "invalid key" }, 400);
        const v = parsePushBody((await req.text()).slice(0, 16384), req.headers.get("content-type") ?? "");
        if (!v) return json({ error: "send a value as plain text or JSON {value, sub?, ttl?, items?}" }, 400);
        pushes.set(key, v.value, { sub: v.sub, ttl: v.ttl, items: v.items });
        return json({ ok: true });
      }
      if (path === "/api/notify" && req.method === "POST") {
        const denied = await hookAuth();
        if (denied) return denied;
        const b = await readBody(req);
        if (typeof b?.title !== "string" || !b.title.trim()) return json({ error: "title is required" }, 400);
        if (b.level !== undefined && !["info", "warn", "alert"].includes(b.level)) return json({ error: "level must be info, warn or alert" }, 400);
        const n = addNote({ title: b.title.trim(), body: typeof b.body === "string" ? b.body : undefined, level: b.level, ttl: Number(b.ttl) || undefined, source: "webhook" });
        return json({ ok: true, id: n.id });
      }
      const gotoRoute = path.match(/^\/api\/goto\/([^/]+)$/);
      if (gotoRoute && req.method === "POST") {
        const denied = await hookAuth();
        if (denied) return denied;
        const pageId = decodeURIComponent(gotoRoute[1]!);
        if (!layout.pages.some((p) => p.id === pageId)) return json({ error: "no such page" }, 404);
        const c = Number(url.searchParams.get("countdown") ?? 0);
        if (!Number.isFinite(c) || c < 0 || c > 60) return json({ error: "countdown must be 0-60" }, 400);
        const body = await readBody(req);
        const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 80) : "webhook";
        broadcast({ type: "goto", pageId, countdown: Math.round(c), reason, revert: false });
        return json({ ok: true });
      }
      if (path === "/api/webhooks" && req.method === "GET") {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        const key = await webhookKey.get();
        const info = await pairingInfo();
        return json({
          keyMasked: WebhookKey.mask(key),
          ...(url.searchParams.get("reveal") === "1" ? { key } : {}),
          examples: webhookExamples({ ip: info.lanIp, host: info.host, port: info.port, key: "<KEY>" }),
        });
      }
      if (path === "/api/webhooks/key/rotate" && req.method === "POST") {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        const key = await webhookKey.rotate();
        return json({ ok: true, key, keyMasked: WebhookKey.mask(key) });
      }
      if (path === "/api/notifications" && req.method === "GET") {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        return json(notes.list());
      }
      if (path === "/api/weather/geocode" && req.method === "GET") {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        try { return json(await weather.geocode(url.searchParams.get("q") ?? "")); }
        catch (err: any) { return json({ error: err?.message ?? String(err) }, 502); }
      }

      if (path.startsWith("/api/hass/")) {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        if (!hassClient) return json({ error: "Home Assistant client is not available" }, 501);
        const sub = path.slice("/api/hass/".length);
        try {
          if (sub === "config" && req.method === "GET") return json(await hassClient.status());
          if (sub === "config" && req.method === "PUT") {
            const b = await readBody(req);
            await hassClient.store.setUrl(b?.url);
            await hassClient.reconfigure();
            return json(await hassClient.status());
          }
          if (sub === "token" && req.method === "PUT") {
            const b = await readBody(req);
            await hassClient.store.setToken(b?.token);
            await hassClient.reconfigure();
            return json(await hassClient.status());
          }
          if (sub === "token" && req.method === "DELETE") {
            await hassClient.store.clearToken();
            await hassClient.reconfigure();
            return json(await hassClient.status());
          }
          if (sub === "test" && req.method === "POST") return json(await hassClient.test());
          if (req.method === "GET" && (sub === "entities" || sub === "areas" || sub === "services")) {
            if (!hassClient.connected()) return json({ error: t("Home Assistant is not connected") }, 503);
            return json(await (sub === "entities" ? hassClient.entities() : sub === "areas" ? hassClient.areas() : hassClient.services()));
          }
        } catch (err: any) {
          const msg = err?.message ?? String(err);
          return json({ error: msg }, /not valid|required|must|do not put/.test(msg) ? 400 : 502);
        }
        return json({ error: "not found" }, 404);
      }

      if (path === "/api/pairing" || path === "/api/pairing/regenerate") {
        const denied = guardLocal(server, req);
        if (denied) return denied;
        const regen = path.endsWith("/regenerate");
        if (regen ? req.method !== "POST" : req.method !== "GET") return json({ error: "method not allowed" }, 405);
        if (regen) pairing.regenerate();
        return json(await pairingInfo());
      }

      if (path === "/editor" || path === "/editor/") {
        return new Response(null, { status: 302, headers: { location: "/manage/" } });
      }

      if (req.method === "GET" || req.method === "HEAD") {
        const asset = resolveAsset(path);
        if (asset) {
          if (asset.localOnly) {
            const denied = guardLocal(server, req);
            if (denied) return denied;
          } else {
            const bad = await guardPhone(server, req);
            if (bad) return bad;
          }
          const headers: Record<string, string> = { "content-type": asset.file.type, "cache-control": asset.cache };
          // text assets go out gzipped (the deck JS is ~420 KB raw, ~130 KB gzipped: a big difference on an old phone)
          if (COMPRESSIBLE.test(asset.file.type)) {
            headers.vary = "accept-encoding";
            if (/\bgzip\b/.test(req.headers.get("accept-encoding") ?? "")) {
              let gz = gzCache.get(asset.file.path);
              if (!gz) {
                gz = Bun.gzipSync(new Uint8Array(await Bun.file(asset.file.path).arrayBuffer()));
                gzCache.set(asset.file.path, gz);
              }
              headers["content-encoding"] = "gzip";
              return new Response(req.method === "HEAD" ? null : (gz as unknown as BodyInit), { headers });
            }
          }
          return new Response(req.method === "HEAD" ? null : Bun.file(asset.file.path), { headers });
        }
      }
      return json({ error: "not found" }, 404);
    }),
    websocket: {
      // the layout message carries every icon (~200 KB of JSON); deflate shrinks it a lot on Wi-Fi to an old phone
      perMessageDeflate: true,
      async open(ws) {
        if (!ws.data.deviceId) {
          ws.close(4401, "invalid token");
          return;
        }
        try {
          await withDevicesLock(async () => {
            const devices = await loadDevices();
            const d = devices.find((x) => x.id === ws.data.deviceId);
            if (d) {
              const t = Date.now();
              d.lastSeen = new Date(t).toISOString();
              d.expiresAt = expiryFrom(t);
              await saveDevices(devices);
            }
          });
        } catch (e) { console.error("lastSeen", e); }
        sockets.add(ws);
        send(ws, { type: "hello", deviceId: ws.data.deviceId, build: DECK_BUILD, pages: layout.pages.map((p) => ({ id: p.id, name: p.name })) });
        send(ws, layoutMsg());
        send(ws, mediaMsg(tracker.current ?? null));
        send(ws, { type: "ai", ai: hub.snapshot() });
        for (const request of broker.list()) send(ws, { type: "permission", request });
        for (const request of questions.list()) send(ws, { type: "question", request });
        if (player.playing().length) send(ws, { type: "sounds-playing", ids: player.playing() });
        const pv = pushes.snapshot();
        if (Object.keys(pv).length) send(ws, { type: "pushed", values: Object.fromEntries(Object.entries(pv).map(([k, v]) => [k, { value: v.value, ...(v.sub ? { sub: v.sub } : {}), ...(v.items?.length ? { items: v.items } : {}), at: v.at }])) });
        send(ws, { type: "notifications", items: notes.list() });
        if (hassClient) send(ws, { type: "hass", entities: hassClient.snapshot(), connected: hassClient.connected() });
        if (themeOverride) send(ws, { type: "theme-override", mode: themeOverride });
        void pushWeather(ws);
        if (!weatherTimer) weatherTimer = setInterval(() => void pushWeather(), opts.weatherMs ?? 15 * 60_000);
        startAi();
        if (!mediaTimer) {
          startMediaLoop();
        }
      },
      async message(ws, raw) {
        let msg: any;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg?.type === "ping") return send(ws, { type: "pong" });
        const reqId = msg?.reqId;
        if (msg?.type === "media" || msg?.type === "volume") {
          const c = parseControl(msg);
          if ("error" in c) return send(ws, { type: "result", reqId, ok: false, error: c.error });
          try {
            if (c.kind === "media" && c.command === "resume") await deps.resumeMedia(lastMedia.last?.app);
            else if (c.kind === "media" && c.command === "open") await deps.openMediaApp(c.app);
            else if (c.kind === "media") await deps.runAction({ type: "media", command: c.command });
            else await deps.setVolume("level" in c ? { level: c.level } : { muted: c.muted });
            send(ws, { type: "result", reqId, ok: true });
            refreshSoon(c.kind);
          } catch (err: any) {
            send(ws, { type: "result", reqId, ok: false, error: err?.message ?? String(err) });
          }
          return;
        }
        if (msg?.type === "permission-answer") {
          const d = msg.decision;
          if (typeof msg.id !== "string" || (d !== "allow" && d !== "deny")) {
            return send(ws, { type: "result", reqId, ok: false, error: "invalid permission answer" });
          }
          const ok = broker.answer(msg.id, d); // a "scope" field from older clients is ignored
          return send(ws, ok ? { type: "result", reqId, ok: true } : { type: "result", reqId, ok: false, error: t("request already handled or expired") });
        }
        if (msg?.type === "question-answer") {
          if (typeof msg.id !== "string") return send(ws, { type: "result", reqId, ok: false, error: "invalid question answer" });
          if (msg.release === true) {
            return send(ws, questions.release(msg.id) ? { type: "result", reqId, ok: true } : { type: "result", reqId, ok: false, error: t("question already answered or expired") });
          }
          const r = questions.answer(msg.id, msg.answers, msg.other);
          return send(ws, r.ok ? { type: "result", reqId, ok: true } : { type: "result", reqId, ok: false, error: r.error });
        }
        if (msg?.type === "processes") {
          const r = parseProcessesRequest(msg);
          if ("error" in r) return send(ws, { type: "result", reqId, ok: false, error: r.error });
          try {
            send(ws, { type: "processes", reqId, sort: r.sort, processes: await deps.topProcesses(r.sort, r.limit) });
          } catch (err: any) {
            send(ws, { type: "result", reqId, ok: false, error: err?.message ?? String(err) });
          }
          return;
        }
        if (msg?.type === "hass-control") {
          // the target is ONLY the entity of that layout item; the phone cannot name another one
          rules.pressed();
          try {
            const item = layout.pages.find((p) => p.id === msg.pageId)?.items.find((i) => i.id === msg.itemId);
            const entityId = item?.kind === "widget" && item.widget === "entity" ? item.entity?.id : item?.kind === "button" && item.action?.type === "hass" ? item.action.entityId : undefined;
            if (!entityId) throw new Error(t("this tile is not linked to a Home Assistant device"));
            if (item?.kind === "widget" && item.entity?.readOnly) throw new Error(t("this tile only shows status"));
            const plan = planControl(entityId, hass.getState(entityId), msg.op, msg.value, { valueUnit: tempUnitOf(msg.unit), deviceUnit: hass.systemTempUnit?.(), related: hass.related?.(entityId) });
            if ("error" in plan) throw new Error(plan.error);
            await execute({ type: "hass", service: plan.service, entityId: plan.entityId ?? entityId, ...(plan.data ? { data: plan.data } : {}) });
            send(ws, { type: "result", reqId, ok: true });
          } catch (err: any) {
            send(ws, { type: "result", reqId, ok: false, error: err?.message ?? String(err) });
          }
          return;
        }
        if (msg?.type !== "press") return;
        const item = layout.pages.find((p) => p.id === msg.pageId)?.items.find((i) => i.id === msg.itemId);
        if (item?.kind === "widget" && item.widget === "entity" && item.entity) {
          rules.pressed();
          if (item.entity.readOnly) return send(ws, { type: "result", reqId, ok: false, error: t("this tile only shows status") });
          const p = entityPress(item.entity.id);
          if ("error" in p) return send(ws, { type: "result", reqId, ok: false, error: p.error });
          try {
            await execute({ type: "hass", service: p.service, entityId: p.entityId });
            return send(ws, { type: "result", reqId, ok: true });
          } catch (err: any) {
            return send(ws, { type: "result", reqId, ok: false, error: err?.message ?? String(err) });
          }
        }
        if (!item || item.kind !== "button" || !item.action) {
          return send(ws, { type: "result", reqId, ok: false, error: "no action for this item" });
        }
        rules.pressed();
        try {
          await execute(item.action, 0, ws);
          send(ws, { type: "result", reqId, ok: true });
        } catch (err: any) {
          send(ws, { type: "result", reqId, ok: false, error: err?.message ?? String(err) });
        }
      },
      close(ws) {
        sockets.delete(ws);
        if (sockets.size === 0 && mediaTimer) {
          stopMediaLoop();
        }
        stopAiIfIdle();
        if (sockets.size === 0 && weatherTimer) { clearInterval(weatherTimer); weatherTimer = undefined; }
      },
    },
  });

  return {
    server,
    port: server.port as number,
    get pin() { return pairing.pin; },
    pairing,
    stop() {
      stopped = true;
      void lastMedia.persist(true);
      stopMediaLoop();
      player.stopAll();
      stopCtl.abort();
      clearInterval(rulesTimer);
      if (weatherTimer) clearInterval(weatherTimer);
      pushes.close();
      unsubHass?.();
      hassClient?.stop();
      if (aiSessionsTimer) clearInterval(aiSessionsTimer);
      if (aiQuotaTimer) clearInterval(aiQuotaTimer);
      clearInterval(omniTimer);
      broker.clear();
      questions.clear();
      stopStats();
      for (const ws of sockets) ws.close();
      server.stop(true);
    },
  };
}
