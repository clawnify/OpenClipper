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
    expect(stamp(65.43)).toBe("0:01:05.4");
    expect(stamp(3723.5)).toBe("1:02:03.5");
    expect(stamp(59.96)).toBe("0:01:00.0");
    expect(transcriptForModel(parseVtt(VTT)).split("\n")[2]).toBe("[0:00:05.0] Now we open the filter section");
  });
});

describe("snapWindow", () => {
  const cues = parseVtt(VTT);
  it("moves a cut that lands mid-word out to the cue's edge", () => {
    // Model cites 1.0 → 6.0: starts inside cue 1, ends inside cue 3.
    const w = snapWindow(cues, { start: 1.0, end: 6.0 }, 4000);
    // start = cue 1's start; end = cue 3's end + tail (no next cue until 3723.5)
    expect(w).toEqual({ start: 0, end: 8.35 });
  });

  it("leaves a cut in silence where it is, so sound around the speech stays", () => {
    // 4.0 → 4.9 is the gap between cue 2 and cue 3 — a sound demo, say.
    const w = snapWindow(cues, { start: 4.0, end: 4.9 }, 4000);
    // lead-in back to 3.88 (cue 2's end), tail stops at cue 3's first word
    expect(w).toEqual({ start: 3.88, end: 5 });
  });

  it("never shrinks a long window to the few words inside it", () => {
    // Mostly silence after cue 3: the window keeps its full length.
    const w = snapWindow(cues, { start: 4.5, end: 60 }, 4000);
    expect(w).toEqual({ start: 4.38, end: 60.35 });
  });

  it("never pads into the neighbouring cue's speech", () => {
    const w = snapWindow(cues, { start: 1.6, end: 3.5 }, 4000);
    // 1.6 is inside cue 2 → its start 1.56 (cue 1 ends there — no lead-in room)
    expect(w).toEqual({ start: 1.56, end: 4.23 });
  });

  it("clamps to the video, and rejects an empty window", () => {
    expect(snapWindow(cues, { start: 3723.5, end: 3724.9 }, 3725.1)?.end).toBe(3725.1);
    expect(snapWindow(cues, { start: 5000, end: 5100 }, 4000)).toBeNull();
  });

  it("works with no transcript at all (a silent video)", () => {
    expect(snapWindow([], { start: 10, end: 40 }, 100)).toEqual({ start: 9.88, end: 40.35 });
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
