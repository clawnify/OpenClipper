// The timed transcript: parsing the media service's WebVTT, snapping cut
// points to where speech actually starts and stops, and chunking speech into
// on-screen captions. Pure — unit-tested in transcript.test.ts.

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** "01:02:03.450" | "02:03.450" → seconds. */
function parseTime(t: string): number {
  const parts = t.trim().split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = vtt.replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const [a, b] = lines[i].split("-->");
    const start = parseTime(a);
    const end = parseTime(b.trim().split(/\s+/)[0]);
    const text = lines
      .slice(i + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) continue;
    cues.push({ start, end, text });
  }
  return cues.sort((x, y) => x.start - y.start);
}

/** "[1:02:03.4] text" — how the model reads the transcript (and cites times). */
/** Always H:MM:SS.s — the one time format the transcript and the answers share. */
export function stamp(seconds: number): string {
  // Round to tenths first, so 59.96 reads 0:01:00.0, not 0:00:60.0.
  const t = Math.round(Math.max(0, seconds) * 10) / 10;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = (t % 60).toFixed(1).padStart(4, "0");
  return `${h}:${String(m).padStart(2, "0")}:${sec}`;
}

export function transcriptForModel(cues: Cue[]): string {
  return cues.map((c) => `[${stamp(c.start)}] ${c.text}`).join("\n");
}

export interface Window {
  start: number;
  end: number;
}

// Breathing room around the words, kept inside the silence between cues.
const LEAD_IN = 0.12;
const TAIL_OUT = 0.35;

/**
 * Keep a proposed window from opening or closing mid-word. A cut point that
 * lands inside a spoken cue moves out to that cue's edge; one that lands in
 * silence stays where it is. The window is never shrunk to the speech inside
 * it: a moment can be a sound demo with a single line of talk, and that sound
 * is the clip. A little breathing room is added, but never into a
 * neighbouring cue's words. Null only for an empty window.
 */
export function snapWindow(cues: Cue[], w: Window, duration: number): Window | null {
  let start = Math.max(0, w.start);
  let end = Math.min(duration, w.end);
  if (!(end > start)) return null;

  // Tolerate the model citing a time a hair inside a cue's edge.
  const atStart = cues.find((c) => c.start < start - 0.05 && c.end > start + 0.05);
  if (atStart) start = atStart.start;
  const atEnd = cues.find((c) => c.start < end - 0.05 && c.end > end + 0.05);
  if (atEnd) end = atEnd.end;

  // Breathing room, kept inside the silence around the window.
  let prevEnd = 0;
  let nextStart = duration;
  for (const c of cues) {
    if (c.end <= start + 0.05) prevEnd = Math.max(prevEnd, c.end);
    if (c.start >= end - 0.05) nextStart = Math.min(nextStart, c.start);
  }
  start = Math.max(prevEnd, start - LEAD_IN, 0);
  end = Math.min(nextStart, end + TAIL_OUT, duration);
  return { start: round(start), end: round(end) };
}

export interface CaptionChunk {
  /** Seconds relative to the clip start. */
  from: number;
  to: number;
  text: string;
}

/**
 * On-screen captions for a clip window: each cue's words regrouped into
 * chunks of at most `maxChars` (one line at caption size on a 1080-wide
 * frame), timed in proportion to their share of the cue's characters.
 */
export function captionChunks(cues: Cue[], w: Window, maxChars = 22): CaptionChunk[] {
  const out: CaptionChunk[] = [];
  for (const cue of cues) {
    if (cue.end <= w.start || cue.start >= w.end) continue;
    const words = cue.text.split(" ").filter(Boolean);
    const groups: string[] = [];
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (line && next.length > maxChars) {
        groups.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) groups.push(line);

    const total = groups.reduce((n, g) => n + g.length, 0) || 1;
    let t = cue.start;
    for (const g of groups) {
      const span = ((cue.end - cue.start) * g.length) / total;
      const from = Math.max(t, w.start) - w.start;
      const to = Math.min(t + span, w.end) - w.start;
      if (to - from >= 0.2) out.push({ from: round(from), to: round(to), text: g });
      t += span;
    }
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
