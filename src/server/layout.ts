// How each stretch of a clip is laid out on a 9:16 canvas. Long-form videos
// change layout as they go (a talking-head intro, then the screen with a small
// camera box, then a wide studio shot), so a clip carries segments, and the
// layout switches at the cut. Pure — unit-tested in edl.test.ts.

export type LayoutKind =
  /** A person fills the shot: crop a vertical window around them. */
  | "speaker"
  /** A screen, slides or a composite: show the whole 16:9 frame, centred over
   *  a blurred copy of itself. */
  | "screen";

export interface LayoutSegment {
  /** Seconds relative to the clip start. */
  from: number;
  to: number;
  layout: LayoutKind;
  /** speaker only: horizontal centre of the subject, 0..1 of the frame. */
  subject_x?: number;
}

// Shorter than this and a switch reads as a glitch, not a cut.
const MIN_SEGMENT = 2;
// A face centre reported hard against an edge is the model saturating, not a
// person standing at the frame's border: every real shot has the face inboard
// of this. Treated as "don't know" — centre the crop instead of cropping the
// wrong third of the frame.
const EDGE = 0.02;

/**
 * Turn whatever the model returned into a clean cover of [0, duration]:
 * sorted, contiguous, no slivers, neighbours of the same kind merged.
 * Falls back to one "screen" segment — the layout that never crops anything
 * away — when nothing usable came back.
 */
export function normalizeSegments(raw: LayoutSegment[], duration: number): LayoutSegment[] {
  const valid = raw
    .filter((s) => (s.layout === "speaker" || s.layout === "screen") && Number.isFinite(s.from) && Number.isFinite(s.to))
    .map((s) => ({
      ...s,
      from: clamp(s.from, 0, duration),
      to: clamp(s.to, 0, duration),
      subject_x: s.layout === "speaker" ? faceCentre(s.subject_x) : undefined,
    }))
    .filter((s) => s.to - s.from > 0.01)
    .sort((a, b) => a.from - b.from);

  if (valid.length === 0) return [{ from: 0, to: round(duration), layout: "screen" }];

  // Contiguous: each segment starts where the previous one ended.
  const joined: LayoutSegment[] = [];
  for (const s of valid) {
    const prev = joined[joined.length - 1];
    if (!prev) {
      joined.push({ ...s, from: 0 });
      continue;
    }
    if (s.to <= prev.to) continue; // swallowed
    joined.push({ ...s, from: prev.to });
  }
  joined[joined.length - 1].to = duration;

  // Absorb slivers into the longer neighbour, then merge same-kind neighbours.
  let segs = joined;
  for (let pass = 0; pass < segs.length; pass++) {
    const i = segs.findIndex((s) => s.to - s.from < MIN_SEGMENT);
    if (i < 0 || segs.length === 1) break;
    const left = segs[i - 1];
    const right = segs[i + 1];
    const into = !left ? right : !right ? left : left.to - left.from >= right.to - right.from ? left : right;
    if (into === left) left.to = segs[i].to;
    else right.from = segs[i].from;
    segs = segs.filter((_, k) => k !== i);
  }
  const merged: LayoutSegment[] = [];
  for (const s of segs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.layout === s.layout && (s.layout === "screen" || Math.abs((prev.subject_x ?? 0.5) - (s.subject_x ?? 0.5)) < 0.08)) {
      prev.to = s.to;
    } else {
      merged.push({ ...s });
    }
  }
  return merged.map((s) => ({
    from: round(s.from),
    to: round(s.to),
    layout: s.layout,
    ...(s.layout === "speaker" ? { subject_x: round(s.subject_x ?? 0.5) } : {}),
  }));
}

function faceCentre(x: number | undefined): number {
  if (x === undefined || !Number.isFinite(x)) return 0.5;
  if (x <= EDGE || x >= 1 - EDGE) return 0.5;
  return clamp(x, 0, 1);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
