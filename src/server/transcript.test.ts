import { describe, expect, it } from "vitest";
import { captionChunks, parseVtt, snapWindow, stamp, transcriptForModel } from "./transcript";

const VTT = `WEBVTT

1
00:00:00.000 --> 00:00:01.560
This is an example of

2
00:00:01.560 --> 00:00:03.880
a WebVTT caption response.

3
00:00:05.000 --> 00:00:08.000
Now we open the <b>filter</b> section

4
01:02:03.500 --> 01:02:05.000
and hour one still parses.
`;

describe("parseVtt", () => {
  it("reads cues, hour timestamps and strips tags", () => {
    const cues = parseVtt(VTT);
    expect(cues).toHaveLength(4);
    expect(cues[0]).toEqual({ start: 0, end: 1.56, text: "This is an example of" });
    expect(cues[2].text).toBe("Now we open the filter section");
    expect(cues[3].start).toBeCloseTo(3723.5);
  });

  it("skips malformed blocks", () => {
    expect(parseVtt("WEBVTT\n\nnot a cue\n\n00:00:02.000 --> 00:00:01.000\nbackwards")).toEqual([]);
  });
});

describe("stamp / transcriptForModel", () => {
  it("formats minutes and hours", () => {
    expect(stamp(65.43)).toBe("1:05.4");
    expect(stamp(3723.5)).toBe("1:02:03.5");
    expect(transcriptForModel(parseVtt(VTT)).split("\n")[2]).toBe("[0:05.0] Now we open the filter section");
  });
});

describe("snapWindow", () => {
  const cues = parseVtt(VTT);
  it("starts on the first spoken cue and ends after the last, inside the silence", () => {
    // Model cites 1.0 → 6.0: starts mid-cue 1, ends mid-cue 3.
    const w = snapWindow(cues, { start: 1.0, end: 6.0 }, 4000);
    expect(w).toEqual({ start: 0, end: 8.35 });
  });

  it("never pads into the neighbouring cue's speech", () => {
    const w = snapWindow(cues, { start: 1.6, end: 3.5 }, 4000);
    // starts where cue 2 starts (cue 1 ends at 1.56 — no lead-in room), ends +0.35
    expect(w).toEqual({ start: 1.56, end: 4.23 });
  });

  it("returns null for a window with no speech", () => {
    expect(snapWindow(cues, { start: 4.0, end: 4.9 }, 4000)).toBeNull();
    expect(snapWindow(cues, { start: 5000, end: 5100 }, 6000)).toBeNull();
  });

  it("clamps to the video's end", () => {
    const w = snapWindow(cues, { start: 3723.5, end: 3724.9 }, 3725.1);
    expect(w?.end).toBe(3725.1);
  });
});

describe("captionChunks", () => {
  const cues = parseVtt(VTT);
  it("regroups words into one-line chunks timed by share of characters", () => {
    const chunks = captionChunks(cues, { start: 5, end: 8 }, 16);
    expect(chunks.map((c) => c.text)).toEqual(["Now we open the", "filter section"]);
    expect(chunks[0].from).toBe(0);
    expect(chunks[1].to).toBe(3);
    expect(chunks[0].to).toBeCloseTo(chunks[1].from);
  });

  it("times chunks relative to the clip and trims at its edges", () => {
    const chunks = captionChunks(cues, { start: 1.0, end: 2.5 });
    expect(chunks[0]).toMatchObject({ from: 0, text: "This is an example of" });
    expect(chunks.at(-1)!.to).toBe(1.5);
  });
});
