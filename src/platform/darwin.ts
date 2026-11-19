import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommand, buildMacMediaFallback, buildVolumeCommand, parseMacVolumeSettings } from "../actions";
import { MAC_SCRIPT_LINES, NOW_PLAYING_PROPS, RAW_ELAPSED_KEY, parseMacTrackOutput, parseNowPlayingJson, resumeScript, MEDIA_APPS, type MediaApp, type RawMedia } from "../media";
import { parseNetstat } from "../stats";
import { parsePs, topProcessesFrom } from "../processes";
import { parseAfinfo } from "../sounds";
import { t } from "../i18n";
import { runCapture } from "./exec";
import type { Platform, SecretStore } from "./types";

type Runner = (argv: string[], timeoutMs?: number) => Promise<string>;

const YT_MUSIC_BUNDLE = "com.brave.Browser.app.cinhimbnkkaeohfgghhklpknlkffjgod";

/** launchd may start the agent without /opt/homebrew/bin in PATH, so keep an absolute fallback. */
function nowPlayingBin(): string | null {
  const found = Bun.which("nowplaying-cli");
  if (found) return found;
  for (const p of ["/opt/homebrew/bin/nowplaying-cli", "/usr/local/bin/nowplaying-cli"]) {
    if (existsSync(p)) return p;
  }
  return null;
}

interface PositionAnchor {
  key: string;
  base: number;
  at: number;
  playing: boolean;
}
let positionAnchor: PositionAnchor | null = null;
const ANCHOR_AGE_MS = 30_000;

const trackKey = (m: RawMedia) => `${m.app}|${m.title}|${m.artist}`;

/** get-raw is the only reliable source of elapsed time; the `elapsedTime` alias returns 0. */
async function readRawPosition(bin: string): Promise<number | null> {
  try {
    const out = await runCapture([bin, "get-raw"], 5000);
    const raw = JSON.parse(out) as Record<string, unknown>;
    const value = Number(raw[RAW_ELAPSED_KEY]);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/** Reads MediaRemote through nowplaying-cli. Covers players beyond Apple Music and Spotify. */
async function readNowPlaying(): Promise<RawMedia | null> {
  const bin = nowPlayingBin();
  if (!bin) return null;
  try {
    const out = await runCapture([bin, "get", "--json", ...NOW_PLAYING_PROPS], 4000);
    const media = parseNowPlayingJson(JSON.parse(out));
    if (!media) {
      positionAnchor = null;
      return null;
    }
    const key = trackKey(media);
    const now = Date.now();
    const stale = !positionAnchor || positionAnchor.key !== key || now - positionAnchor.at > ANCHOR_AGE_MS || positionAnchor.playing !== media.playing;
    if (stale) {
      const base = (await readRawPosition(bin)) ?? positionAnchor?.base ?? 0;
      positionAnchor = { key, base, at: now, playing: media.playing };
    }
    const a = positionAnchor!;
    const elapsed = media.playing ? (now - a.at) / 1000 : 0;
    media.position = Math.max(0, Math.min(media.duration || Infinity, a.base + elapsed));
    return media;
  } catch {
    return null;
  }
}

/** Artwork from MediaRemote as a data URL, or undefined when the player has none. */
async function nowPlayingArtwork(): Promise<string | undefined> {
  const bin = nowPlayingBin();
  if (!bin) return undefined;
  try {
    const out = await runCapture([bin, "get", "artworkData", "--json"], 5000);
    const value = JSON.parse(out) as Record<string, unknown>;
    const raw = typeof value.artworkData === "string" ? value.artworkData.replace(/\s/g, "") : "";
    if (!raw || raw.length > 900_000) return undefined;
    const mime = raw.startsWith("iVBOR") ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${raw}`;
  } catch {
    return undefined;
  }
}

/** macOS Keychain through `security` (generic passwords). `run` is injectable for tests. */
export function keychainStore(run: Runner = (argv, ms) => runCapture(argv, ms ?? 5000)): SecretStore {
  return {
    async get(service, account) {
      try {
        const v = (await run(["security", "find-generic-password", "-s", service, "-a", account, "-w"])).trim();
        return v || undefined;
      } catch { return undefined; }
    },
    async set(service, account, value) {
      try { await run(["security", "add-generic-password", "-U", "-s", service, "-a", account, "-w", value]); return true; } catch { return false; }
    },
    async remove(service, account) {
      try { await run(["security", "delete-generic-password", "-s", service, "-a", account]); } catch { /* none stored */ }
    },
  };
}

/** Seconds since the last input (HIDIdleTime from ioreg), or null. */
export async function macIdleSeconds(run: (argv: string[]) => Promise<string> = (a) => runCapture(a, 3000)): Promise<number | null> {
  try {
    const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(await run(["ioreg", "-c", "IOHIDSystem"]));
    return m ? Number(m[1]) / 1e9 : null;
  } catch {
    return null;
  }
}

async function macMemUsed(): Promise<number | undefined> {
  try {
    const proc = Bun.spawn(["vm_stat"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const { parseVmStat } = await import("../stats");
    return parseVmStat(text);
  } catch {
    return undefined;
  }
}

async function readMac(): Promise<RawMedia | null> {
  const fromRemote = await readNowPlaying();
  if (fromRemote) return fromRemote;
  const out = await runCapture(["osascript", ...MAC_SCRIPT_LINES.flatMap((l) => ["-e", l])], 4000);
  const media = parseMacTrackOutput(out);
  if (media?.app === "Spotify") {
    const url = (await runCapture(["osascript", "-e", `tell application "Spotify" to artwork url of current track`], 3000).catch(() => "")).trim();
    if (url) media.artworkUrl = url;
  }
  return media;
}

async function sipsToJpegDataUrl(input: string, dir: string): Promise<string> {
  const out = join(dir, "art.jpg");
  await runCapture(["sips", "-Z", "300", "-s", "format", "jpeg", input, "--out", out], 5000);
  return `data:image/jpeg;base64,${Buffer.from(await readFile(out)).toString("base64")}`;
}

/** Artwork as a data URL, resized to max 300px with sips. Undefined when unavailable. */
async function macArtwork(raw: RawMedia): Promise<string | undefined> {
  const remote = await nowPlayingArtwork();
  if (remote) return remote;
  const dir = await mkdtemp(join(tmpdir(), "pd-art-"));
  try {
    const src = join(dir, "src");
    if (raw.app === "Spotify" && raw.artworkUrl) {
      const res = await fetch(raw.artworkUrl, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return undefined;
      await writeFile(src, new Uint8Array(await res.arrayBuffer()));
    } else if (raw.app === "Music") {
      await runCapture(
        [
          "osascript",
          "-e", `set f to POSIX file "${src}"`,
          "-e", `tell application "Music" to set d to (raw data of artwork 1 of current track)`,
          "-e", `set fh to open for access f with write permission`,
          "-e", `try`,
          "-e", `set eof fh to 0`,
          "-e", `write d to fh`,
          "-e", `end try`,
          "-e", `close access fh`,
        ],
        6000,
      );
    } else {
      return undefined;
    }
    return await sipsToJpegDataUrl(src, dir);
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function isRunning(app: MediaApp): Promise<boolean> {
  const out = await runCapture(["osascript", "-e", `application "${app}" is running`], 3000).catch(() => "false");
  return out.trim() === "true";
}

export function createDarwin(): Platform {
  return {
    id: "darwin",
    label: "macOS",
    keyNames: { cmd: "Cmd", alt: "Option", ctrl: "Control" },

    async runAction(a) {
      if (a.type === "media") {
        const bin = nowPlayingBin();
        if (bin) return void (await runCapture([bin, a.command === "playpause" ? "togglePlayPause" : a.command]));
        return void (await runCapture(buildMacMediaFallback(a.command)));
      }
      await runCapture(buildCommand(a, "darwin"));
    },

    async readVolume() {
      try { return parseMacVolumeSettings(await runCapture(["osascript", "-e", "get volume settings"], 3000)); } catch { return null; }
    },
    async setVolume(v) { await runCapture(buildVolumeCommand(v, "darwin")); },

    readMedia: readMac,
    fetchArtwork: macArtwork,
    async resumeMedia(lastApp) {
      if (lastApp === "YouTube Music") {
        const bin = nowPlayingBin();
        if (!bin) {
          await runCapture(["open", "-b", YT_MUSIC_BUNDLE], 15000);
          return;
        }
        await runCapture([bin, "play"], 5000).catch(() => {});
        await runCapture(["open", "-b", YT_MUSIC_BUNDLE], 15000);
        return;
      }
      const plan = resumeScript({ Spotify: await isRunning("Spotify"), Music: await isRunning("Music") }, lastApp);
      await runCapture(["osascript", ...plan.lines.flatMap((l) => ["-e", l])], plan.launches ? 15000 : 5000);
    },
    async openMediaApp(app) {
      if (!(MEDIA_APPS as readonly string[]).includes(app)) throw new Error(t("Opening the music app is not supported on this operating system"));
      await runCapture(["osascript", "-e", `tell application "${app}" to activate`], 15000);
    },

    async netCounters() {
      try { return parseNetstat(await runCapture(["netstat", "-ibn"], 3000)); } catch { return undefined; }
    },
    memUsed: macMemUsed,
    async topProcesses(sort, limit) {
      return topProcessesFrom(parsePs(await runCapture(["ps", "-Ao", "pid,pcpu,rss,comm"], 5000)), sort, limit);
    },
    async lanName() {
      try { return (await runCapture(["scutil", "--get", "LocalHostName"], 2000)).trim(); } catch { return undefined; }
    },

    apps: null, // macOS apps are read from the .app bundles by icons.ts (Info.plist + sips)
    soundCommand: (path, volume) => ["afplay", "-v", String(Math.round(volume) / 100), path],
    async soundDuration(path) {
      try { return parseAfinfo(await runCapture(["afinfo", path], 5000)); } catch { return undefined; }
    },

    secrets: keychainStore(),
    async claudeCredentials() {
      try { return (await runCapture(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], 8000)).trim() || null; } catch { return null; }
    },
    loadKind: "loadavg",
    idleSeconds: () => macIdleSeconds(),

    openExternal: async (url) => void (await runCapture(["open", url], 5000)),
    hookPath: (p) => p,
    dispose: () => {},
  };
}
