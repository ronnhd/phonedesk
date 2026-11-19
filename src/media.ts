import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { platform } from "./platform";
import { HOME } from "./config";
import { t } from "./i18n";

export interface Media {
  app: string;
  title: string;
  artist: string;
  album: string;
  playing: boolean;
  position: number; // seconds
  duration: number; // seconds
  artwork?: string; // data:image/jpeg;base64,... (<= 300px)
}

/** What a platform reader returns: Media without artwork, plus where artwork can be found. */
export interface RawMedia extends Omit<Media, "artwork"> {
  artworkUrl?: string;
}

export const US = "\u001f";

// ---------- control message validation ----------

export const MEDIA_APPS = ["Music", "Spotify"] as const;
export type MediaApp = (typeof MEDIA_APPS)[number];

export type ControlMessage =
  | { kind: "media"; command: "playpause" | "next" | "previous" }
  | { kind: "media"; command: "resume" }
  | { kind: "media"; command: "open"; app: MediaApp }
  | { kind: "volume"; level: number }
  | { kind: "volume"; muted: boolean };

/** Strict validation of client {type:"media"|"volume"} messages. Returns an error string for anything off. */
export function parseControl(msg: any): ControlMessage | { error: string } {
  if (msg?.type === "media") {
    if (msg.command === "playpause" || msg.command === "next" || msg.command === "previous" || msg.command === "resume") {
      return { kind: "media", command: msg.command };
    }
    if (msg.command === "open") {
      return MEDIA_APPS.includes(msg.app) ? { kind: "media", command: "open", app: msg.app } : { error: "open needs app Music or Spotify" };
    }
    return { error: "invalid media command" };
  }
  if (msg?.type === "volume") {
    const hasLevel = "level" in msg;
    const hasMuted = "muted" in msg;
    if (hasLevel === hasMuted) return { error: "volume needs exactly one of level or muted" };
    if (hasLevel) {
      const level = msg.level;
      if (typeof level !== "number" || !Number.isInteger(level) || level < 0 || level > 100) {
        return { error: "volume level must be an integer 0-100" };
      }
      return { kind: "volume", level };
    }
    if (typeof msg.muted !== "boolean") return { error: "muted must be a boolean" };
    return { kind: "volume", muted: msg.muted };
  }
  return { error: "unknown control message" };
}

// ---------- parsers ----------

const num = (v: string | undefined): number => {
  const n = Number((v ?? "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * Parses the AppleScript output of MAC_SCRIPT: one line per running app,
 * `app<US>state<US>title<US>artist<US>album<US>position<US>duration`.
 * Spotify reports duration in ms, Music in seconds. Picks a playing app first, else the first paused one.
 */
export function parseMacTrackOutput(output: string): RawMedia | null {
  const found: RawMedia[] = [];
  for (const line of output.split(/\r?\n/)) {
    const f = line.split(US);
    if (f.length < 7) continue;
    const [app, state, title, artist, album, position, duration] = f as [string, string, string, string, string, string, string];
    if (!title && !artist) continue;
    found.push({
      app,
      title,
      artist,
      album,
      playing: state.trim() === "playing",
      position: num(position),
      duration: app === "Spotify" ? num(duration) / 1000 : num(duration),
    });
  }
  return found.find((m) => m.playing) ?? found[0] ?? null;
}

/** Properties requested from `nowplaying-cli get --json` for media reading. */
export const NOW_PLAYING_PROPS = ["title", "artist", "album", "duration", "playbackRate", "clientBundleIdentifier"] as const;

/** get-raw uses full MediaRemote keys; the `elapsedTime` alias of `get` reports 0 in nowplaying-cli 2.1.0. */
export const RAW_ELAPSED_KEY = "kMRMediaRemoteNowPlayingInfoElapsedTime";

/** Maps a MediaRemote client bundle id to the name PhoneDesk shows on the tile. */
export function appFromBundle(bundle: unknown): string {
  const id = typeof bundle === "string" ? bundle : "";
  if (id === "com.apple.Music") return "Music";
  if (id === "com.spotify.client") return "Spotify";
  if (/youtube.*music|cinhimbnkkaeohfgghhklpknlkffjgod/i.test(id)) return "YouTube Music";
  const last = id.split(".").pop();
  return last ? last.replace(/[_-]+/g, " ") : "Now Playing";
}

/** Parses the JSON object from `nowplaying-cli get --json ...NOW_PLAYING_PROPS`. */
export function parseNowPlayingJson(value: unknown): RawMedia | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const title = typeof v.title === "string" ? v.title : "";
  const artist = typeof v.artist === "string" ? v.artist : "";
  if (!title && !artist) return null;
  const n = (x: unknown) => {
    const d = typeof x === "number" ? x : Number(x ?? 0);
    return Number.isFinite(d) && d >= 0 ? d : 0;
  };
  return {
    app: appFromBundle(v.clientBundleIdentifier),
    title,
    artist,
    album: typeof v.album === "string" ? v.album : "",
    playing: n(v.playbackRate) > 0,
    position: n(v.elapsedTime),
    duration: n(v.duration),
  };
}

/** Parses `playerctl metadata --format` output (see LINUX_FORMAT). Position and length are microseconds. */
export function parsePlayerctl(output: string): RawMedia | null {
  const line = output.split(/\r?\n/).find((l) => l.includes(US));
  if (!line) return null;
  const [app = "", status = "", title = "", artist = "", album = "", position = "", length = "", art = ""] = line.split(US);
  if (!title && !artist) return null;
  return {
    app: app || "Player",
    title,
    artist,
    album,
    playing: status.trim() === "Playing",
    position: num(position) / 1e6,
    duration: num(length) / 1e6,
    artworkUrl: art.trim() || undefined,
  };
}

// ---------- macOS reader ----------

function appBlock(app: "Spotify" | "Music"): string[] {
  return [
    `if application "${app}" is running then`,
    `try`,
    `tell application "${app}"`,
    `set pstate to player state as text`,
    `if pstate is not "stopped" then`,
    `set res to res & "${app}" & US & pstate & US & (name of current track) & US & (artist of current track) & US & (album of current track) & US & (player position) & US & (duration of current track) & linefeed`,
    `end if`,
    `end tell`,
    `end try`,
    `end if`,
  ];
}

/** Only touches Spotify/Music that are already running (`is running` never launches an app). */
export const MAC_SCRIPT_LINES = [
  `set US to ASCII character 31`,
  `set res to ""`,
  ...appBlock("Spotify"),
  ...appBlock("Music"),
  `return res`,
];

/** Current media on this OS, or null when nothing is playing/open. Never throws. */
export async function readMedia(): Promise<RawMedia | null> {
  try {
    return await platform.readMedia();
  } catch {
    // treat a failing player as "nothing playing"
    return null;
  }
}

// ---------- artwork ----------

/** Artwork as a data URL (macOS: resized to max 300px with sips; Windows: from the media session). Undefined when unavailable. */
export async function fetchArtwork(raw: RawMedia): Promise<string | undefined> {
  try {
    return await platform.fetchArtwork(raw);
  } catch {
    return undefined;
  }
}

// ---------- diff / cache ----------

export interface TrackerDeps {
  read: () => Promise<RawMedia | null>;
  artwork: (raw: RawMedia) => Promise<string | undefined>;
  now?: () => number;
}

export interface PollResult {
  changed: boolean;
  media: Media | null;
  /** True when the track (app/title/artist) differs from the previous published media: the message should carry artwork. */
  trackChanged: boolean;
  /** True when the cached cover appeared or changed for the same track. */
  artworkChanged: boolean;
}

/** While a playing track has less than this many seconds left, the agent polls every NEAR_END_MS. */
export const NEAR_END_S = 15;
export const NEAR_END_MS = 300;

/** A seek or stall bigger than this (s) versus the extrapolated position counts as a change. */
export const SEEK_TOLERANCE = 3;

/**
 * Polls a media reader and decides what is worth pushing. Position drift while playing is not a change
 * (the client extrapolates); play/pause, a new track, metadata changes and seeks are.
 * Artwork is resolved once per app+title+artist and cached.
 */
export class MediaTracker {
  /** Last published media. `undefined` until the first poll. */
  current: Media | null | undefined;
  /** Latest reading (fresh position, artwork), published or not. Null when nothing is playing. */
  seen: Media | null = null;
  private publishedAt = 0;
  private artKey = "";
  private art: string | undefined;
  private artRetryAt = 0;
  private artRetryUntil = 0;
  private artPending = false;
  private now: () => number;

  constructor(private deps: TrackerDeps) {
    this.now = deps.now ?? Date.now;
  }

  private key(m: { app: string; title: string; artist: string }): string {
    return `${m.app}|${m.title}|${m.artist}`;
  }

  async poll(): Promise<PollResult> {
    const raw = await this.deps.read().catch(() => null);
    const prev = this.current;
    if (!raw) {
      this.seen = null;
      this.current = null;
      this.artKey = "";
      this.art = undefined;
      this.artRetryAt = 0;
      this.artRetryUntil = 0;
      this.artPending = false;
      return { changed: prev !== null, media: null, trackChanged: prev !== null && prev !== undefined, artworkChanged: !!prev?.artwork };
    }

    const k = this.key(raw);
    const now = this.now();
    if (k !== this.artKey) {
      const oldKey = this.artKey;
      const oldArt = this.art;
      this.artKey = k;
      this.art = await this.deps.artwork(raw).catch(() => undefined);
      if (this.art) {
        this.artRetryAt = 0;
        this.artRetryUntil = 0;
        this.artPending = false;
      } else {
        // nowplaying-cli can briefly return empty artwork while metadata settles.
        // Keep the old cover for the same app+title and try again for up to 60 s.
        const sameTitle = oldKey && oldArt && oldKey.split("|").slice(0, 2).join("|") === k.split("|").slice(0, 2).join("|");
        if (sameTitle) this.art = oldArt;
        this.artPending = true;
        this.artRetryAt = now + 5_000;
        this.artRetryUntil = now + 60_000;
      }
    } else if (this.artPending && now >= this.artRetryAt && now < this.artRetryUntil) {
      const fetched = await this.deps.artwork(raw).catch(() => undefined);
      if (fetched) {
        this.art = fetched;
        this.artPending = false;
        this.artRetryAt = 0;
        this.artRetryUntil = 0;
      } else {
        this.artRetryAt = now + 5_000;
      }
    }
    const { artworkUrl: _u, ...rest } = raw;
    const media: Media = this.art ? { ...rest, artwork: this.art } : rest;
    this.seen = media;

    let changed = true;
    let trackChanged = true;
    const artworkChanged = !prev ? !!media.artwork : prev.artwork !== media.artwork;
    if (prev) {
      trackChanged = this.key(prev) !== k;
      const expected = prev.playing ? prev.position + (now - this.publishedAt) / 1000 : prev.position;
      changed =
        trackChanged ||
        prev.album !== media.album ||
        prev.playing !== media.playing ||
        Math.abs(prev.duration - media.duration) > 1 ||
        Math.abs(media.position - expected) > SEEK_TOLERANCE ||
        artworkChanged;
    }
    if (changed) {
      this.current = media;
      this.publishedAt = now;
    }
    return { changed, media: changed ? media : (this.current as Media), trackChanged, artworkChanged };
  }
}

// ---------- last media (the "nothing playing" screen) ----------

export const LAST_ARTWORK_MAX = 200 * 1024;

export interface LastMedia {
  app: string;
  title: string;
  artist: string;
  album?: string;
  artwork?: string;
  duration: number;
  /** Position (s) when playback stopped. */
  position: number;
  /** When it was last seen (ms). */
  at: number;
}

export const lastMediaPath = () => join(HOME, "last-media.json");

const isLast = (v: any): v is LastMedia =>
  v && typeof v === "object" && typeof v.app === "string" && typeof v.title === "string" && typeof v.artist === "string" &&
  typeof v.duration === "number" && typeof v.position === "number" && typeof v.at === "number";

/** Remembers the last non-null media in memory and ~/.phonedesk/last-media.json (0600; artwork only under 200 KB). */
export class LastMediaStore {
  last: LastMedia | null = null;
  private dirty = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private file = lastMediaPath(), private now: () => number = Date.now) {}

  async load(): Promise<void> {
    try {
      const v = JSON.parse(await readFile(this.file, "utf8"));
      if (isLast(v)) this.last = v;
    } catch {
      /* none yet */
    }
  }

  /** Cheap, in memory. Call on every poll with the newest reading. */
  remember(m: Media): void {
    const keepArt = m.artwork ?? (this.last && this.last.app === m.app && this.last.title === m.title && this.last.artist === m.artist ? this.last.artwork : undefined);
    const artwork = keepArt && keepArt.length <= LAST_ARTWORK_MAX ? keepArt : undefined;
    const next: LastMedia = {
      app: m.app, title: m.title, artist: m.artist, ...(m.album ? { album: m.album } : {}),
      ...(artwork ? { artwork } : {}), duration: m.duration, position: m.position, at: this.now(),
    };
    const prev = this.last;
    if (!prev || prev.app !== next.app || prev.title !== next.title || prev.artist !== next.artist || prev.album !== next.album || prev.artwork !== next.artwork || prev.duration !== next.duration) this.dirty = true;
    this.last = next;
  }

  /** Writes when something worth keeping changed, or when forced (playback stopped, shutdown). */
  persist(force = false): Promise<void> {
    if (!this.last || (!this.dirty && !force)) return this.chain.then(() => {});
    const snapshot = JSON.stringify(this.last);
    this.dirty = false;
    this.chain = this.chain.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, snapshot + "\n", { mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, this.file);
      } catch {
        /* best effort */
      }
    });
    return this.chain.then(() => {});
  }
}

// ---------- user-initiated launch / resume ----------

const asApp = (name: string | undefined): MediaApp => (MEDIA_APPS as readonly string[]).includes(name ?? "") ? (name as MediaApp) : "Music";

/** AppleScript lines for `resume`. Pure, so tests check them without running anything. */
export function resumeScript(running: Record<MediaApp, boolean>, lastApp?: string): { app: MediaApp; launches: boolean; lines: string[] } {
  const pick = running.Spotify ? "Spotify" : running.Music ? "Music" : null;
  const app: MediaApp = pick ?? asApp(lastApp);
  return { app, launches: pick === null, lines: [`tell application "${app}" to play`] };
}

/**
 * The one place PhoneDesk may launch a player, and only because the user asked: plays Spotify/Music when one is running,
 * otherwise launches the app of the last track and plays. Polling never launches.
 */
export const resumeMedia = (lastApp?: string): Promise<void> => platform.resumeMedia(lastApp);

/** Launches/activates a player without playing. */
export const openMediaApp = (app: MediaApp): Promise<void> => platform.openMediaApp(app);
