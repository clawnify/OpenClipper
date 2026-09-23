// What we ask of the platform's video analysis (/video/analyze), and how we
// read the answers. The platform watches AND listens to the whole video, so a
// moment can be carried by a sound or a picture, not only by what is said.
// Which model does the watching is the platform's business; nothing here
// depends on it.
//
//   findRequest   — one pass over the whole video (plus its transcript): the
//     strongest self-contained moments, with how each stretch of each moment
//     is shot. Whole-video context is the point: "strongest" and "not a repeat
//     of another pick" can't be judged a chunk at a time.
//   layoutRequest — the same layout reading for one clip on its own, for clips
//     that predate it or were moved far by a trim.

import { stamp } from "./transcript";

/** How long the clips should run — the one control every clipping tool has. */
export const CLIP_LENGTHS = {
  short: { min: 15, max: 30, label: "under 30 seconds" },
  standard: { min: 30, max: 60, label: "30 to 60 seconds" },
  long: { min: 60, max: 90, label: "60 to 90 seconds" },
} as const;
export type ClipLength = keyof typeof CLIP_LENGTHS;

export interface AnalysisRequest {
  prompt: string;
  schema: Record<string, unknown>;
  thinking: "low" | "medium" | "high";
  max_output_tokens: number;
}

/** "1:25:20" / "25:20" / "1:25:20.5" → seconds. NaN when unreadable. */
export function parseClock(s: string): number {
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)\s*$/.exec(String(s));
  if (!m) return NaN;
  return (Number(m[1] ?? 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
}

const TIME = { type: "string", description: "position in the whole video, H:MM:SS (tenths allowed, e.g. 1:05:02.4)" };

const SEGMENTS = {
  type: "array",
  description:
    "how the moment is shot, stretch by stretch, covering it from start to end with no gaps; merge consecutive stretches of the same kind",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["from", "to", "layout", "subject_x"],
    properties: {
      from: TIME,
      to: TIME,
      layout: {
        type: "string",
        enum: ["speaker", "screen"],
        description:
          "speaker: a person fills most of the shot (a talking head, or a wide shot of someone at a desk or instrument). screen: mainly a screen recording, software, slides or a product close-up, even with a small camera box of the person in a corner",
      },
      subject_x: {
        type: "number",
        description:
          "speaker: where the person's FACE sits across the frame, 0.0 left edge to 1.0 right edge, two decimals (a centred face is 0.5). Only 0 or 1 if the face touches that edge. screen: 0.5",
      },
    },
  },
};

const FIND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["moments", "notes"],
  properties: {
    moments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "hook", "reason", "start", "end", "segments"],
        properties: {
          title: { type: "string", description: "on-screen title, at most 8 words, no hashtags or emoji" },
          hook: {
            type: "string",
            description:
              "the clip's first spoken line, verbatim; if it opens on a sound or a picture instead, describe that in [brackets]",
          },
          reason: { type: "string", description: "one sentence: why a viewer keeps watching — say if a sound or a picture carries it" },
          start: TIME,
          end: TIME,
          segments: SEGMENTS,
        },
      },
    },
    notes: { type: "string", description: "one short paragraph: what the video offered, and why fewer clips if so" },
  },
};

export function findRequest(opts: {
  transcript: string;
  duration: number;
  brief: string;
  maxClips: number;
  clipLength: ClipLength;
  /** Stretches that already have a clip, or whose clip was dropped. */
  taken?: { start: number; end: number; title: string; dropped: boolean }[];
}): AnalysisRequest {
  const band = CLIP_LENGTHS[opts.clipLength];
  const taken = opts.taken ?? [];
  // Without this the model re-picks the strongest moments every time — which
  // already have clips — and spends its picks on duplicates we then drop.
  const takenText = taken.length
    ? `\nALREADY TAKEN — these stretches already have a clip, or the editor dropped the clip. Don't pick them again, or anything overlapping them; find other moments:\n${taken
        .map((t) => `- ${stamp(t.start)}–${stamp(t.end)} ${t.dropped ? "(dropped) " : ""}${t.title}`)
        .join("\n")}\n`
    : "";
  const transcript = opts.transcript.trim()
    ? `TRANSCRIPT — machine-made from the audio, so names and jargon may be misheard; trust what you hear and see for those. Each line is "[H:MM:SS.s] words", the time that line starts.\n${opts.transcript}`
    : "There is no transcript: the video has no speech (it may be silent, or music and sound only). Judge it by what you see and hear.";
  const prompt = `You are the best short-form video editor alive. Watch and listen to this whole video (${Math.round(opts.duration / 60)} minutes).

Find up to ${opts.maxClips} ${taken.length ? "new " : ""}moments to publish as standalone vertical clips (YouTube Shorts, Reels, TikTok). Aim to fill the list: a long video usually holds many — every distinct technique, sound, demo, before/after, tip or strong opinion is a candidate.

Judge with your eyes and ears, not only the words. A sound demo, a preset playing, a before/after you can HEAR, or something striking on screen can be the strongest moment even with little speech.

What makes a moment:
- It stands alone: a viewer who never saw the video understands it from its first second. No "as I said earlier", no dangling "this" or "that one" pointing at something outside the clip.
- It opens on a hook: a claim, a surprising result, a question, a before/after, a strong opinion, or a sound or picture that grabs. Start ON it — never on filler, greetings, "so", "um", or setup the hook doesn't need.
- It ends on a completed thought or a finished payoff — not mid-explanation, not mid-sound.
- ${band.min} to ${band.max} seconds long (${band.label}). A moment that genuinely needs a little longer to land its payoff may run a few seconds over; never pad one to reach the length.
- Moments never overlap, and never repeat the same point: if two moments teach or show the same thing, keep the stronger. Two different sounds, presets or techniques are different moments, even when the video presents them the same way.

Only stop short of ${opts.maxClips} when what's left would not work as a standalone clip — never pad the list with weak or repeated moments. Order the list strongest first.

Times: when a moment starts or ends on speech, use the transcript line's time so no word is cut; otherwise the time you see or hear it.

For each moment also say how it is shot, stretch by stretch (segments) — it will be re-framed from 16:9 to vertical 9:16: a person is cropped around their face; a screen is shown whole.
${opts.brief ? `\nThe brief — who the clips are for and what they're for:\n${opts.brief}\n` : ""}${takenText}
${transcript}`;
  // Generous on purpose: 25 moments with their segments are ~10k tokens plus
  // thinking, and a budget hit fails the whole find.
  return { prompt, schema: FIND_SCHEMA, thinking: "medium", max_output_tokens: 48_000 };
}

export interface FoundMoment {
  title: string;
  hook: string;
  reason: string;
  start: number;
  end: number;
  /** Seconds relative to the moment's start, as the model saw it. */
  segments: { from: number; to: number; layout: "speaker" | "screen"; subject_x: number }[];
}

interface RawSegment {
  from: string;
  to: string;
  layout: "speaker" | "screen";
  subject_x: number;
}

/** The analysis answer → moments in seconds. Unreadable entries are dropped. */
export function readFind(result: unknown, maxClips: number): { moments: FoundMoment[]; notes: string } {
  const r = (result ?? {}) as {
    moments?: { title?: string; hook?: string; reason?: string; start?: string; end?: string; segments?: RawSegment[] }[];
    notes?: string;
  };
  const moments: FoundMoment[] = [];
  for (const m of r.moments ?? []) {
    const start = parseClock(m.start ?? "");
    const end = parseClock(m.end ?? "");
    if (!m.title || !(end > start)) continue;
    moments.push({
      title: m.title,
      hook: m.hook ?? "",
      reason: m.reason ?? "",
      start,
      end,
      segments: relativeSegments(m.segments ?? [], start),
    });
  }
  return { moments: moments.slice(0, maxClips), notes: r.notes ?? "" };
}

function relativeSegments(raw: RawSegment[], origin: number): FoundMoment["segments"] {
  return raw
    .map((s) => ({
      from: parseClock(s.from) - origin,
      to: parseClock(s.to) - origin,
      layout: s.layout,
      subject_x: s.subject_x,
    }))
    .filter((s) => Number.isFinite(s.from) && Number.isFinite(s.to));
}

const LAYOUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["segments"],
  properties: { segments: SEGMENTS },
};

export function layoutRequest(): AnalysisRequest {
  const prompt = `This stretch of a 16:9 video will be re-framed to vertical 9:16. Split it into stretches by how it is shot, covering it from start to end with no gaps, and label each: "speaker" (a person fills most of the shot — we crop a narrow window around their face) or "screen" (mainly a screen recording, software, slides or a product close-up, even with a small camera box in a corner — we show the whole frame so nothing on screen is lost). When the shot changes, put the boundary where it changes.`;
  return { prompt, schema: LAYOUT_SCHEMA, thinking: "low", max_output_tokens: 6000 };
}

/** The layout answer → segments relative to `clipStart`. */
export function readLayout(result: unknown, clipStart: number): FoundMoment["segments"] {
  return relativeSegments(((result ?? {}) as { segments?: RawSegment[] }).segments ?? [], clipStart);
}
