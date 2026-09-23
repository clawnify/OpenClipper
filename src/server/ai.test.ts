import { describe, expect, it } from "vitest";
import { findRequest, parseClock, readFind, readLayout } from "./ai";
import { stamp } from "./transcript";

describe("parseClock", () => {
  it("reads H:MM:SS, MM:SS and tenths, and round-trips the transcript stamp", () => {
    expect(parseClock("1:25:20")).toBe(5120);
    expect(parseClock("25:20")).toBe(1520);
    expect(parseClock("0:17:18.5")).toBe(1038.5);
    for (const s of [0, 65.4, 3723.5, 8341.9]) expect(parseClock(stamp(s))).toBeCloseTo(s, 5);
  });
  it("is NaN for anything else", () => {
    expect(parseClock("soon")).toBeNaN();
    expect(parseClock("")).toBeNaN();
  });
});

describe("readFind", () => {
  it("converts times to seconds and segments to moment-relative, dropping unreadable moments", () => {
    const out = readFind(
      {
        moments: [
          {
            title: "Wild sci-fi FX",
            hook: "[glitchy laser sweeps]",
            reason: "the sound carries it",
            start: "1:25:20",
            end: "1:26:05",
            segments: [
              { from: "1:25:20", to: "1:25:40", layout: "screen", subject_x: 0.5 },
              { from: "1:25:40", to: "1:26:05", layout: "speaker", subject_x: 0.42 },
            ],
          },
          { title: "broken", start: "later", end: "1:00" },
          { title: "backwards", start: "0:10:00", end: "0:09:00" },
        ],
        notes: "n",
      },
      10,
    );
    expect(out.moments).toHaveLength(1);
    expect(out.moments[0]).toMatchObject({ start: 5120, end: 5165 });
    expect(out.moments[0].segments).toEqual([
      { from: 0, to: 20, layout: "screen", subject_x: 0.5 },
      { from: 20, to: 45, layout: "speaker", subject_x: 0.42 },
    ]);
  });
  it("caps at the requested count", () => {
    const m = { title: "t", start: "0:00:00", end: "0:00:30", segments: [] };
    expect(readFind({ moments: [m, m, m] }, 2).moments).toHaveLength(2);
  });
});

describe("readLayout", () => {
  it("makes segments relative to the clip start", () => {
    expect(readLayout({ segments: [{ from: "0:17:20", to: "0:17:50", layout: "screen", subject_x: 0.5 }] }, 1040)).toEqual([
      { from: 0, to: 30, layout: "screen", subject_x: 0.5 },
    ]);
  });
});

describe("findRequest", () => {
  it("asks the model to judge silent videos by picture and sound", () => {
    const r = findRequest({ transcript: "", duration: 600, brief: "", maxClips: 3, clipLength: "short" });
    expect(r.prompt).toMatch(/no transcript/);
    expect(r.prompt).toMatch(/15 to 30 seconds/);
  });
});

describe("findRequest — finding more", () => {
  it("tells the model which stretches are taken, dropped ones included, and asks for new ones", () => {
    const r = findRequest({
      transcript: "[0:00:01.0] hi",
      duration: 600,
      brief: "",
      maxClips: 5,
      clipLength: "standard",
      taken: [
        { start: 186, end: 244, title: "Acid harmonics", dropped: false },
        { start: 300, end: 330, title: "Weak one", dropped: true },
      ],
    });
    expect(r.prompt).toContain("Find up to 5 new moments");
    expect(r.prompt).toContain("- 0:03:06.0–0:04:04.0 Acid harmonics");
    expect(r.prompt).toContain("- 0:05:00.0–0:05:30.0 (dropped) Weak one");
  });
  it("says nothing about taken stretches on a first find", () => {
    const r = findRequest({ transcript: "", duration: 600, brief: "", maxClips: 5, clipLength: "standard" });
    expect(r.prompt).not.toContain("ALREADY TAKEN");
    expect(r.prompt).toContain("Find up to 5 moments");
  });
});
