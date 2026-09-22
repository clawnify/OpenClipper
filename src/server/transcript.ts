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
export function stamp(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(1).padStart(4, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
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
 * Snap a proposed window to speech boundaries: start where the first spoken
 * cue at/after `start` begins, end where the cue covering `end` finishes — so
 * a clip never opens or closes mid-word. Returns null when the window holds
 * no speech.
 */
export function snapWindow(cues: Cue[], w: Window, duration: number): Window | null {
  // First cue whose speech reaches past the proposed start (tolerate the
  // model citing a time a hair inside the cue).
  const first = cues.findIndex((c) => c.end > w.start + 0.05);
  if (first < 0) return null;
  // Last cue that starts before the proposed end.
  let last = -1;
  for (let i = cues.length - 1; i >= first; i--) {
    if (cues[i].start < w.end - 0.05) {
      last = i;
      break;
    }
  }
  if (last < first) return null;

  const prevEnd = first > 0 ? cues[first - 1].end : 0;
  const nextStart = last + 1 < cues.length ? cues[last + 1].start : duration;
  const start = Math.max(prevEnd, cues[first].start - LEAD_IN, 0);
  const end = Math.min(nextStart, cues[last].end + TAIL_OUT, duration);
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
