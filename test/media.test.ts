import { describe, expect, test } from "bun:test";
import { WIN, MODE600, MODE644 } from "./_os";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAST_ARTWORK_MAX, LastMediaStore, MediaTracker, parseControl, parseMacTrackOutput, parseNowPlayingJson, appFromBundle, parsePlayerctl, resumeScript, type RawMedia } from "../src/media";
import { netRate, parseNetstat, parseProcNetDev } from "../src/stats";
import { buildMacMediaFallback, buildVolumeCommand, parseMacVolumeSettings, parsePactlVolume } from "../src/actions";

const US = "\u001f";

describe("parseMacTrackOutput", () => {
  test("Music: seconds, locale decimal comma", () => {
    const out = ["Music", "playing", "Song", "Artist", "Album", "95,5", "282,4"].join(US) + "\n\n";
    expect(parseMacTrackOutput(out)).toEqual({ app: "Music", title: "Song", artist: "Artist", album: "Album", playing: true, position: 95.5, duration: 282.4 });
  });
  test("Spotify duration is ms; playing app wins over paused", () => {
    const out = [
      ["Spotify", "paused", "P", "X", "", "3.0", "180000"].join(US),
      ["Music", "playing", "Q", "Y", "", "1", "60"].join(US),
    ].join("\n");
    expect(parseMacTrackOutput(out)?.app).toBe("Music");
    expect(parseMacTrackOutput(out.split("\n")[0]!)?.duration).toBe(180);
  });
  test("empty / stopped output is null", () => {
    expect(parseMacTrackOutput("")).toBeNull();
    expect(parseMacTrackOutput("\n\n")).toBeNull();
  });
});

describe("parseNowPlayingJson", () => {
  test("YouTube Music PWA is mapped by bundle id", () => {
    const media = parseNowPlayingJson({
      title: "what if we?", artist: "Emi Choi", album: "", duration: 208,
      elapsedTime: 3.1, playbackRate: 1,
      clientBundleIdentifier: "com.brave.Browser.app.cinhimbnkkaeohfgghhklpknlkffjgod",
    });
    expect(media).toEqual({ app: "YouTube Music", title: "what if we?", artist: "Emi Choi", album: "", playing: true, position: 3.1, duration: 208 });
  });
  test("paused player and missing metadata", () => {
    expect(parseNowPlayingJson({ title: "T", artist: "", playbackRate: 0, clientBundleIdentifier: "com.apple.Music" })).toMatchObject({ app: "Music", playing: false });
    expect(parseNowPlayingJson({ title: null, artist: null })).toBeNull();
    expect(parseNowPlayingJson(null)).toBeNull();
  });
  test("unknown bundle falls back to a readable name", () => {
    expect(appFromBundle("com.example.Player")).toBe("Player");
    expect(appFromBundle(null)).toBe("Now Playing");
  });
});

describe("parsePlayerctl", () => {
  test("microseconds and art url", () => {
    const line = ["spotify", "Playing", "T", "A", "Al", "5000000", "200000000", "https://x/y.jpg"].join(US);
    expect(parsePlayerctl(line)).toEqual({ app: "spotify", title: "T", artist: "A", album: "Al", playing: true, position: 5, duration: 200, artworkUrl: "https://x/y.jpg" });
  });
  test("no player", () => expect(parsePlayerctl("")).toBeNull());
});

describe("parseControl", () => {
  test("media", () => {
    expect(parseControl({ type: "media", command: "next" })).toEqual({ kind: "media", command: "next" });
    expect("error" in parseControl({ type: "media", command: "stop" })).toBe(true);
    expect("error" in parseControl({ type: "media" })).toBe(true);
  });
  test("volume", () => {
    expect(parseControl({ type: "volume", level: 0 })).toEqual({ kind: "volume", level: 0 });
    expect(parseControl({ type: "volume", level: 100 })).toEqual({ kind: "volume", level: 100 });
    expect(parseControl({ type: "volume", muted: false })).toEqual({ kind: "volume", muted: false });
    for (const bad of [{ level: -1 }, { level: 101 }, { level: 2.5 }, { level: "3" }, { level: NaN }, { muted: 1 }, {}, { level: 1, muted: true }]) {
      expect("error" in parseControl({ type: "volume", ...bad })).toBe(true);
    }
  });
});

describe("MediaTracker", () => {
  const base: RawMedia = { app: "Music", title: "T", artist: "A", album: "Al", playing: true, position: 10, duration: 200 };
  function make(seq: Array<RawMedia | null>) {
    let t = 0;
    let i = 0;
    const artCalls: string[] = [];
    const tracker = new MediaTracker({
      read: async () => seq[Math.min(i++, seq.length - 1)]!,
      artwork: async (r) => { artCalls.push(r.title); return `data:${r.title}`; },
      now: () => t,
    });
    return { tracker, artCalls, advance: (ms: number) => { t += ms; } };
  }

  test("first poll publishes with artwork; position drift is not a change", async () => {
    const { tracker, advance } = make([base, { ...base, position: 11.5 }, { ...base, position: 13 }]);
    const a = await tracker.poll();
    expect(a).toMatchObject({ changed: true, trackChanged: true });
    expect(a.media?.artwork).toBe("data:T");
    advance(1500);
    expect((await tracker.poll()).changed).toBe(false);
    advance(1500);
    expect((await tracker.poll()).changed).toBe(false);
  });

  test("play/pause, seek and new track are changes; artwork cached per track", async () => {
    const { tracker, artCalls, advance } = make([
      base,
      { ...base, playing: false },
      { ...base, playing: false },
      { ...base, playing: false, position: 90 },
      { ...base, title: "T2", position: 0 },
      { ...base, title: "T", position: 0 },
    ]);
    await tracker.poll();
    advance(1500);
    expect(await tracker.poll()).toMatchObject({ changed: true, trackChanged: false });
    advance(1500);
    expect((await tracker.poll()).changed).toBe(false);
    advance(1500);
    expect(await tracker.poll()).toMatchObject({ changed: true, trackChanged: false }); // seek
    advance(1500);
    expect(await tracker.poll()).toMatchObject({ changed: true, trackChanged: true });
    advance(1500);
    await tracker.poll();
    expect(artCalls).toEqual(["T", "T2", "T"]); // one fetch per track change, none on pause/seek
  });

  test("brief empty artwork keeps the cover on the same title and retries until it returns", async () => {
    let t = 0;
    let polls = 0;
    let calls = 0;
    const tracker = new MediaTracker({
      read: async () => { polls++; return { ...base, artist: polls < 3 ? "Wrong" : "Right" }; },
      artwork: async () => { calls++; return calls === 2 ? undefined : calls === 3 ? "data:cover2" : "data:cover"; },
      now: () => t,
    });
    const first = await tracker.poll();
    expect(first.media?.artwork).toBe("data:cover");
    t += 1000;
    expect((await tracker.poll()).media?.artwork).toBe("data:cover");
    t += 1000;
    const flicker = await tracker.poll();
    expect(flicker.trackChanged).toBe(true);
    expect(flicker.media?.artwork).toBe("data:cover"); // old cover kept while metadata settles
    t += 5000;
    const retried = await tracker.poll();
    expect(retried.artworkChanged).toBe(true);
    expect(retried.media?.artwork).toBe("data:cover2");
    expect(calls).toBe(3);
  });

  test("nothing playing: null once, then unchanged", async () => {
    const { tracker } = make([base, null, null]);
    await tracker.poll();
    expect(await tracker.poll()).toMatchObject({ changed: true, media: null });
    expect((await tracker.poll()).changed).toBe(false);
  });

  test("reader errors count as nothing playing; null first poll is published", async () => {
    const tracker = new MediaTracker({ read: async () => { throw new Error("x"); }, artwork: async () => undefined });
    expect((await tracker.poll()).changed).toBe(true);
    expect(tracker.current).toBeNull();
  });
});

describe("net parsers", () => {
  const NETSTAT = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                       4757854     0 31062088386  4757854     0 31062088386     0
lo0        16384 127           127.0.0.1        4757854     - 31062088386  4757854     - 31062088386     -
en0        1500  <Link#14>   a4:83:e7:11:22:33  9000     0     5000000     8000     0     2000000     0
en0        1500  192.168.1     192.168.1.20     9000     -     5000000     8000     -     2000000     -
utun3      1380  <Link#20>                          10     0        1000       10     0        1000     0
`;
  test("parseNetstat takes Link rows only, including rows without an address", () => {
    expect(parseNetstat(NETSTAT)).toEqual({
      lo0: { rx: 31062088386, tx: 31062088386 },
      en0: { rx: 5000000, tx: 2000000 },
      utun3: { rx: 1000, tx: 1000 },
    });
    expect(parseNetstat("garbage")).toEqual({});
  });
  test("parseProcNetDev", () => {
    const out = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
  eth0: 5000 50 0 0 0 0 0 0 7000 70 0 0 0 0 0 0
`;
    expect(parseProcNetDev(out)).toEqual({ lo: { rx: 1000, tx: 1000 }, eth0: { rx: 5000, tx: 7000 } });
  });
  test("netRate ignores loopback/virtual, resets and new interfaces", () => {
    const prev = { lo0: { rx: 0, tx: 0 }, en0: { rx: 1000, tx: 1000 }, utun3: { rx: 0, tx: 0 } };
    const cur = { lo0: { rx: 99999, tx: 99999 }, en0: { rx: 5000, tx: 3000 }, utun3: { rx: 500, tx: 500 }, en1: { rx: 1e9, tx: 1e9 } };
    expect(netRate(prev, cur, 2)).toEqual({ rx: 2000, tx: 1000 });
    expect(netRate({ en0: { rx: 9, tx: 9 } }, { en0: { rx: 1, tx: 1 } }, 1)).toEqual({ rx: 0, tx: 0 });
    expect(netRate(prev, cur, 0)).toEqual({ rx: 0, tx: 0 });
  });
});

describe("volume", () => {
  test("parseMacVolumeSettings", () => {
    expect(parseMacVolumeSettings("output volume:55, input volume:75, alert volume:100, output muted:false")).toEqual({ level: 55, muted: false });
    expect(parseMacVolumeSettings("output volume:0, input volume:75, alert volume:100, output muted:true")).toEqual({ level: 0, muted: true });
    expect(parseMacVolumeSettings("output volume:missing value, input volume:75, alert volume:100, output muted:missing value")).toBeNull();
  });
  test("parsePactlVolume", () => {
    expect(parsePactlVolume("Volume: front-left: 42000 /  64% / -11.9 dB,   front-right: 42000 /  64%", "Mute: no")).toEqual({ level: 64, muted: false });
    expect(parsePactlVolume("", "")).toBeNull();
  });
  test("buildVolumeCommand", () => {
    expect(buildVolumeCommand({ level: 40 }, "darwin")).toEqual(["osascript", "-e", "set volume output volume 40"]);
    expect(buildVolumeCommand({ muted: true }, "darwin")).toEqual(["osascript", "-e", "set volume output muted true"]);
    expect(buildVolumeCommand({ level: 7 }, "linux")).toEqual(["pactl", "set-sink-volume", "@DEFAULT_SINK@", "7%"]);
    expect(buildVolumeCommand({ muted: false }, "linux")).toEqual(["pactl", "set-sink-mute", "@DEFAULT_SINK@", "0"]);
    expect(() => buildVolumeCommand({ level: 101 }, "darwin")).toThrow();
    expect(() => buildVolumeCommand({ level: 1.5 }, "linux")).toThrow();
    expect(() => buildVolumeCommand({ muted: true }, "win32")).toThrow();
  });
  test("mac media fallback never launches an app", () => {
    const script = buildMacMediaFallback("next").join("\n");
    expect(script).toContain('application "Spotify" is running');
    expect(script).toContain('application "Music" is running');
    expect(script).toContain("next track");
  });
});

describe("resume/open commands", () => {
  test("parseControl accepts resume and open Music|Spotify only", () => {
    expect(parseControl({ type: "media", command: "resume" })).toEqual({ kind: "media", command: "resume" });
    expect(parseControl({ type: "media", command: "open", app: "Spotify" })).toEqual({ kind: "media", command: "open", app: "Spotify" });
    for (const bad of [{ command: "open" }, { command: "open", app: "Safari" }, { command: "open", app: "Music; rm" }, { command: "open", app: 1 }]) {
      expect("error" in parseControl({ type: "media", ...bad })).toBe(true);
    }
  });
  test("resumeScript: a running player plays, otherwise the last app (default Music) is launched", () => {
    expect(resumeScript({ Spotify: true, Music: true }, "Music")).toMatchObject({ app: "Spotify", launches: false, lines: ['tell application "Spotify" to play'] });
    expect(resumeScript({ Spotify: false, Music: true })).toMatchObject({ app: "Music", launches: false });
    expect(resumeScript({ Spotify: false, Music: false }, "Spotify")).toMatchObject({ app: "Spotify", launches: true });
    expect(resumeScript({ Spotify: false, Music: false })).toMatchObject({ app: "Music", launches: true });
    expect(resumeScript({ Spotify: false, Music: false }, "Evil\" & do shell script")).toMatchObject({ app: "Music" }); // never interpolates unknown names
  });
});

describe("LastMediaStore", () => {
  const file = () => join(mkdtempSync(join(tmpdir(), "pd-last-")), "sub", "last-media.json");
  const m = (over: any = {}) => ({ app: "Music", title: "T", artist: "A", album: "Al", playing: true, position: 5, duration: 200, ...over });

  test("remembers, persists 0600, survives a restart, carries artwork forward on the same track", async () => {
    const f = file();
    let t = 1000;
    const a = new LastMediaStore(f, () => t);
    await a.load();
    expect(a.last).toBeNull();
    a.remember(m({ artwork: "data:image/jpeg;base64,AAAA" }));
    t = 2000;
    a.remember(m({ position: 42 })); // later poll without artwork: same track keeps it
    await a.persist(true);
    expect(statSync(f).mode & 0o777).toBe(MODE600);
    const b = new LastMediaStore(f);
    await b.load();
    expect(b.last).toEqual({ app: "Music", title: "T", artist: "A", album: "Al", artwork: "data:image/jpeg;base64,AAAA", duration: 200, position: 42, at: 2000 });
    a.remember(m({ title: "Other" })); // new track without artwork: no stale cover
    expect(a.last!.artwork).toBeUndefined();
    expect(a.last!.title).toBe("Other");
  });

  test("artwork over 200 KB is dropped; broken files are ignored; nothing is written before the first track", async () => {
    const f = file();
    const s = new LastMediaStore(f);
    await s.persist(true);
    expect(() => readFileSync(f)).toThrow();
    s.remember(m({ artwork: "x".repeat(LAST_ARTWORK_MAX + 1) }));
    expect(s.last!.artwork).toBeUndefined();
    await s.persist();
    expect(JSON.parse(readFileSync(f, "utf8")).artwork).toBeUndefined();
    writeFileSync(f, "{ nope");
    const r = new LastMediaStore(f);
    await r.load();
    expect(r.last).toBeNull();
  });

  test("persist writes only when something worth keeping changed (position drift alone is not)", async () => {
    const f = file();
    const s = new LastMediaStore(f);
    s.remember(m());
    await s.persist();
    const before = readFileSync(f, "utf8");
    s.remember(m({ position: 99 }));
    await s.persist();
    expect(readFileSync(f, "utf8")).toBe(before);
    await s.persist(true);
    expect(JSON.parse(readFileSync(f, "utf8")).position).toBe(99);
  });

  test("tracker.seen keeps the freshest position even when it is not published", async () => {
    let pos = 10;
    const tr = new MediaTracker({ read: async () => ({ app: "Music", title: "T", artist: "A", album: "", playing: true, position: pos, duration: 100 }), artwork: async () => undefined });
    await tr.poll();
    pos = 11;
    await tr.poll();
    expect(tr.current!.position).toBe(10);
    expect(tr.seen!.position).toBe(11);
  });
});
