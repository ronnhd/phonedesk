import { describe, expect, test } from "bun:test";
import { mediaWithPreviousArtwork } from "../web/deck/src/media-merge";

const track = (artwork?: string) => ({
  app: "YouTube Music",
  title: "Infatuated",
  artist: "Rangga Jones",
  album: "",
  playing: true,
  position: 12,
  duration: 200,
  artwork,
});

describe("deck media artwork", () => {
  test("keeps the previous cover when a position update omits it", () => {
    expect(mediaWithPreviousArtwork(track("data:old"), track())).toMatchObject({ artwork: "data:old" });
  });

  test("drops the old cover when the track changes", () => {
    expect(mediaWithPreviousArtwork(track("data:old"), { ...track(), title: "Other" })).toMatchObject({ artwork: undefined });
  });

  test("a new cover from the agent wins", () => {
    expect(mediaWithPreviousArtwork(track("data:old"), track("data:new"))).toMatchObject({ artwork: "data:new" });
  });
});
