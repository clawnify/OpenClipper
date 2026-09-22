import { describe, expect, it } from "vitest";
import { buildClipEdl, speakerCrop, wrap } from "./edl";
import { normalizeSegments } from "./layout";

const MEDIA = "0123456789abcdef0123456789abcdef";

describe("normalizeSegments", () => {
  it("covers the whole clip contiguously and merges same-kind neighbours", () => {
    const segs = normalizeSegments(
      [
        { from: 0.5, to: 10, layout: "speaker", subject_x: 0.52 },
        { from: 10, to: 20, layout: "speaker", subject_x: 0.55 },
        { from: 20, to: 44, layout: "screen" },
      ],
      45,
    );
    expect(segs).toEqual([
      { from: 0, to: 20, layout: "speaker", subject_x: 0.52 },
      { from: 20, to: 45, layout: "screen" },
    ]);
  });

  it("absorbs a sliver shorter than two seconds into its longer neighbour", () => {
    const segs = normalizeSegments(
      [
        { from: 0, to: 12, layout: "screen" },
        { from: 12, to: 13, layout: "speaker", subject_x: 0.5 },
        { from: 13, to: 30, layout: "screen" },
      ],
      30,
    );
    expect(segs).toEqual([{ from: 0, to: 30, layout: "screen" }]);
  });

  it("falls back to one screen segment (crops nothing away)", () => {
    expect(normalizeSegments([], 31.2)).toEqual([{ from: 0, to: 31.2, layout: "screen" }]);
    expect(normalizeSegments([{ from: 0, to: 5, layout: "nonsense" as never }], 5)).toEqual([
      { from: 0, to: 5, layout: "screen" },
    ]);
  });
});

describe("speakerCrop", () => {
  it("takes a 9:16 window of a 16:9 frame, centred on the subject and kept inside", () => {
    expect(speakerCrop(0.5, 1920, 1080)).toEqual({ x: 0.342, y: 0, width: 0.316, height: 1 });
    expect(speakerCrop(0.95, 1920, 1080)).toEqual({ x: 0.684, y: 0, width: 0.316, height: 1 });
    expect(speakerCrop(0.02, 1920, 1080)!.x).toBe(0);
  });
  it("leaves already-vertical sources to cover alone", () => {
    expect(speakerCrop(0.5, 1080, 1920)).toBeNull();
  });
});

describe("wrap", () => {
  it("wraps on words", () => {
    expect(wrap("The one knob that fixes a muddy low end", 24)).toEqual(["The one knob that fixes", "a muddy low end"]);
  });
});

describe("buildClipEdl", () => {
  const base = {
    mediaId: MEDIA,
    start: 5400,
    end: 5445,
    sourceWidth: 1920,
    sourceHeight: 1080,
    captions: [
      { from: 0, to: 1.2, text: "Here's the trick" },
      { from: 1.2, to: 2.4, text: "nobody tells you" },
    ],
    title: "The one knob that fixes a muddy low end",
  };

  it("switches layout at the cut: speaker crop, then blurred-backdrop screen", () => {
    const edl = buildClipEdl({
      ...base,
      segments: [
        { from: 0, to: 15, layout: "speaker", subject_x: 0.5 },
        { from: 15, to: 45, layout: "screen" },
      ],
    }) as any;
    expect(edl.output).toEqual({ width: 1080, height: 1920, fps: 30, background: "#000000" });
    expect(edl.main.elements).toEqual([
      { id: "seg0", type: "video", src: `media:${MEDIA}`, trimStart: 5400, duration: 15, fit: "cover", crop: { x: 0.342, y: 0, width: 0.316, height: 1 } },
      { id: "seg1", type: "video", src: `media:${MEDIA}`, trimStart: 5415, duration: 30, fit: "cover", blur: 40 },
    ]);
    const frames = edl.overlays.find((t: any) => t.id === "frames").elements;
    expect(frames).toEqual([
      { id: "frame1", type: "video", src: `media:${MEDIA}`, trimStart: 5415, duration: 30, startTime: 15, x: 0, y: 0.342, width: 1 },
    ]);
  });

  it("adds a wrapped title for the first seconds and timed captions", () => {
    const edl = buildClipEdl({ ...base, segments: [{ from: 0, to: 45, layout: "screen" }] }) as any;
    const text = edl.overlays.find((t: any) => t.id === "text").elements;
    expect(text.filter((e: any) => e.id.startsWith("title")).map((e: any) => e.text)).toEqual([
      "The one knob that fixes",
      "a muddy low end",
    ]);
    expect(text.find((e: any) => e.id === "cap1")).toMatchObject({ startTime: 1.2, duration: 1.2, y: 0.7 });
  });

  it("omits title and captions when switched off", () => {
    const edl = buildClipEdl({ ...base, captions: null, title: null, segments: [{ from: 0, to: 45, layout: "screen" }] }) as any;
    expect(edl.overlays.map((t: any) => t.id)).toEqual(["frames"]);
  });

  it("refuses a clip too dense for the service's element cap", () => {
    const captions = Array.from({ length: 120 }, (_, i) => ({ from: i * 0.3, to: i * 0.3 + 0.3, text: "word" }));
    expect(() => buildClipEdl({ ...base, captions, segments: [{ from: 0, to: 45, layout: "screen" }] })).toThrow(/too dense/);
  });
});

describe("normalizeSegments — face position", () => {
  it("treats a face reported at the very edge as unknown and centres it", () => {
    // Observed live: the model answered subject_x = 1 for a centred talking
    // head, which would have cropped the right-hand third of the frame.
    expect(normalizeSegments([{ from: 0, to: 30, layout: "speaker", subject_x: 1 }], 30)).toEqual([
      { from: 0, to: 30, layout: "speaker", subject_x: 0.5 },
    ]);
    expect(normalizeSegments([{ from: 0, to: 30, layout: "speaker", subject_x: 0 }], 30)[0].subject_x).toBe(0.5);
  });

  it("keeps a real off-centre face", () => {
    expect(normalizeSegments([{ from: 0, to: 30, layout: "speaker", subject_x: 0.72 }], 30)[0].subject_x).toBe(0.72);
  });
});
