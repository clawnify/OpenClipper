// A clip → the edit document the platform's video service renders
// (services.clawnify.com/video/edit, EDL v1). Pure — unit-tested in
// edl.test.ts. The source is referenced as `media:<id>`: the service reads
// only this clip's seconds out of the long video, by range.

import type { CaptionChunk } from "./transcript";
import type { LayoutSegment } from "./layout";

export const CANVAS = { width: 1080, height: 1920, fps: 30 } as const;
// The service's per-edit element cap (main + overlays + audio).
const MAX_ELEMENTS = 100;

const CAPTION = { y: 0.7, fontSize: 60, background: "#000000B3" } as const;
const TITLE = { y: 0.1, fontSize: 56, background: "#000000B3", seconds: 3.5, maxChars: 24, lineGap: 0.045 } as const;
// Blurred-copy background behind a letterboxed frame.
const BACKDROP_BLUR = 40;

export interface ClipSpec {
  mediaId: string;
  /** Window on the source, seconds. */
  start: number;
  end: number;
  /** Source frame size — decides the crop for speaker shots. */
  sourceWidth: number;
  sourceHeight: number;
  segments: LayoutSegment[];
  captions: CaptionChunk[] | null;
  title: string | null;
}

type Json = Record<string, unknown>;

/** Word-wrap to lines of at most `max` characters (drawtext doesn't wrap). */
export function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && next.length > max) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The vertical window for a speaker shot: full source height, 9:16 wide,
 * centred on the subject and kept inside the frame. Null when the source is
 * already vertical enough that "cover" alone frames it.
 */
export function speakerCrop(subjectX: number, sourceWidth: number, sourceHeight: number) {
  const width = (CANVAS.width / CANVAS.height) / (sourceWidth / sourceHeight);
  if (width >= 0.999) return null;
  const x = Math.min(1 - width, Math.max(0, subjectX - width / 2));
  return { x: round(x), y: 0, width: round(width), height: 1 };
}

export function buildClipEdl(spec: ClipSpec): Json {
  const src = `media:${spec.mediaId}`;
  const duration = round(spec.end - spec.start);
  const main: Json[] = [];
  const frames: Json[] = [];
  // Where the letterboxed 16:9 frame sits: vertically centred.
  const frameH = CANVAS.width * (spec.sourceHeight / spec.sourceWidth);
  const frameY = round((CANVAS.height - frameH) / 2 / CANVAS.height);

  spec.segments.forEach((seg, i) => {
    const len = round(seg.to - seg.from);
    const trimStart = round(spec.start + seg.from);
    if (seg.layout === "speaker") {
      const crop = speakerCrop(seg.subject_x ?? 0.5, spec.sourceWidth, spec.sourceHeight);
      main.push({ id: `seg${i}`, type: "video", src, trimStart, duration: len, fit: "cover", ...(crop ? { crop } : {}) });
    } else {
      // Background: the same seconds, filling the canvas, blurred. It carries
      // the audio; the sharp frame on top is picture only.
      main.push({ id: `seg${i}`, type: "video", src, trimStart, duration: len, fit: "cover", blur: BACKDROP_BLUR });
      frames.push({ id: `frame${i}`, type: "video", src, trimStart, duration: len, startTime: round(seg.from), x: 0, y: frameY, width: 1 });
    }
  });

  const text: Json[] = [];
  if (spec.title) {
    const lines = wrap(spec.title, TITLE.maxChars).slice(0, 3);
    lines.forEach((line, i) =>
      text.push({
        id: `title${i}`,
        type: "text",
        text: line,
        startTime: 0,
        duration: Math.min(TITLE.seconds, duration),
        x: 0.5,
        y: round(TITLE.y + i * TITLE.lineGap),
        fontSize: TITLE.fontSize,
        align: "center",
        color: "#FFFFFF",
        background: TITLE.background,
      }),
    );
  }
  for (const [i, c] of (spec.captions ?? []).entries()) {
    if (c.from >= duration - 0.05) continue;
    text.push({
      id: `cap${i}`,
      type: "text",
      text: c.text,
      startTime: c.from,
      duration: round(Math.min(c.to, duration) - c.from),
      x: 0.5,
      y: CAPTION.y,
      fontSize: CAPTION.fontSize,
      align: "center",
      color: "#FFFFFF",
      background: CAPTION.background,
    });
  }

  const total = main.length + frames.length + text.length;
  if (total > MAX_ELEMENTS) {
    throw new Error(`clip is too dense to render (${total} elements, max ${MAX_ELEMENTS}) — shorten it`);
  }

  return {
    version: 1,
    output: { ...CANVAS, background: "#000000" },
    main: { elements: main },
    overlays: [
      ...(frames.length ? [{ id: "frames", elements: frames }] : []),
      ...(text.length ? [{ id: "text", elements: text }] : []),
    ],
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
