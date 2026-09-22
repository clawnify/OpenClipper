// The two model calls, both on the org's own OpenRouter key:
//
//   selectMoments — reads the WHOLE timed transcript at once (a 2-hour video is
//     ~40k tokens; the model's window is 1M) and picks the strongest
//     self-contained moments. Whole-video context is the point: "strongest"
//     and "not a repeat of another pick" can't be judged a chunk at a time.
//   readLayout    — looks at frames sampled through one clip and says, for each
//     stretch, whether a person fills the shot or a screen does.

export const MODEL = "google/gemini-3.8-flash";

export interface Moment {
  title: string;
  hook: string;
  reason: string;
  start: number;
  end: number;
}

export interface MomentPick {
  moments: Moment[];
  notes: string;
}

const MOMENTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["moments", "notes"],
  properties: {
    moments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "hook", "reason", "start", "end"],
        properties: {
          title: { type: "string", description: "on-screen title, at most 8 words, no hashtags or emoji" },
          hook: { type: "string", description: "the clip's first spoken line, verbatim from the transcript" },
          reason: { type: "string", description: "one sentence: why a viewer keeps watching" },
          start: { type: "number", description: "seconds — the timestamp of the cue the clip opens on" },
          end: { type: "number", description: "seconds — the timestamp of the last cue's END (the next cue's start)" },
        },
      },
    },
    notes: { type: "string", description: "one short paragraph: what the video offered, and why fewer clips if so" },
  },
};

// Gemini 3.x thinks before it answers, and thinking tokens come out of the
// same max_tokens budget as the answer. Set the effort per job and leave
// headroom, or a long transcript can spend the budget thinking and return a
// truncated (unparseable) answer. OpenRouter lists `reasoning` and
// `structured_outputs` as supported for this model; completions cap at 65,536.
async function callModel(
  key: string,
  content: unknown[],
  schema: { name: string; schema: unknown },
  opts: { maxTokens: number; effort: "low" | "medium" | "high" },
): Promise<unknown> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "X-Title": "OpenClipper",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content }],
      max_tokens: opts.maxTokens,
      reasoning: { effort: opts.effort },
      temperature: 0.3,
      response_format: { type: "json_schema", json_schema: { name: schema.name, strict: true, schema: schema.schema } },
    }),
  });
  if (!res.ok) throw new Error(`model call failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { choices?: { finish_reason?: string; message?: { content?: string } }[] };
  const choice = body.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new Error("the model ran out of room before finishing its answer — ask for fewer clips and try again");
  }
  const text = choice?.message?.content ?? "";
  try {
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new Error("the model returned an unreadable answer — try again");
  }
}

export async function selectMoments(opts: {
  key: string;
  transcript: string;
  duration: number;
  brief: string;
  maxClips: number;
}): Promise<MomentPick> {
  const prompt = `You are the best short-form video editor alive. Below is the full timed transcript of a long video (${Math.round(opts.duration / 60)} minutes). Each line is "[timestamp] words" — the timestamp is when that line starts.

Pick up to ${opts.maxClips} moments to publish as standalone vertical clips (YouTube Shorts, Reels, TikTok).

What makes a moment:
- It stands alone: a viewer who never saw the video understands it from its first second. No "as I said earlier", no dangling "this" or "that one" pointing at something outside the clip.
- It opens on a hook: a claim, a surprising result, a question, a before/after, a strong opinion. Start ON that line — never on filler, greetings, "so", "um", or setup the hook doesn't need.
- It ends on a completed thought — the payoff, the result, the punchline — not mid-explanation.
- 20 to 60 seconds long. 30–45 is the sweet spot.
- Moments never overlap, and never repeat the same idea: if two moments teach the same thing, keep the stronger.

Quality over count: return FEWER than ${opts.maxClips} if the video doesn't have that many strong moments. Padding the list with weak clips is the worst outcome. Order the list strongest first.

Timestamps: "start" must be the timestamp of the line the clip opens on; "end" must be the timestamp where the clip's last line ends (the start of the following line). Use seconds.
${opts.brief ? `\nThe brief — who the clips are for and what they're for:\n${opts.brief}\n` : ""}
TRANSCRIPT
${opts.transcript}`;

  const out = (await callModel(
    opts.key,
    [{ type: "text", text: prompt }],
    { name: "moments", schema: MOMENTS_SCHEMA },
    // Picking the strongest moments across hours of speech is the judgment
    // call the whole app rests on — worth medium effort.
    { maxTokens: 32000, effort: "medium" },
  )) as MomentPick;
  const moments = (out.moments ?? []).filter(
    (m) => Number.isFinite(m.start) && Number.isFinite(m.end) && m.end > m.start && m.title,
  );
  return { moments: moments.slice(0, opts.maxClips), notes: out.notes ?? "" };
}

export interface LayoutRead {
  segments: { from: number; to: number; layout: "speaker" | "screen"; subject_x: number }[];
}

const LAYOUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["segments"],
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["from", "to", "layout", "subject_x"],
        properties: {
          from: { type: "number" },
          to: { type: "number" },
          layout: { type: "string", enum: ["speaker", "screen"] },
          subject_x: { type: "number", description: "speaker: horizontal centre of the person's face, 0 = left edge, 1 = right edge. screen: 0.5" },
        },
      },
    },
  },
};

/**
 * Frames are sampled every few seconds through the clip; `frames[i].t` is
 * seconds from the clip start. The answer is a list of stretches — cut
 * points land between frames.
 */
export async function readLayout(opts: {
  key: string;
  frames: { t: number; url: string }[];
  duration: number;
}): Promise<LayoutRead> {
  const intro = `These are frames from a ${opts.duration.toFixed(1)}-second clip of a 16:9 video that will be re-framed to vertical 9:16. Each frame is labelled with its time in seconds from the clip start.

Split the clip into stretches and label each:
- "speaker": a person fills most of the shot (a talking head, or a wide shot of someone at a desk or instrument). We will crop a narrow vertical window around them — give subject_x, the horizontal centre of their face.
- "screen": the shot is mainly a screen recording, software, slides or a product close-up — even if a small camera box of the person sits in a corner. We will show the whole frame so nothing on screen is lost. subject_x = 0.5.

Stretches must cover 0 to ${opts.duration.toFixed(1)} with no gaps. When the shot changes between two frames, put the boundary halfway between them. Merge consecutive frames with the same layout into one stretch.`;

  const content: unknown[] = [{ type: "text", text: intro }];
  for (const f of opts.frames) {
    content.push({ type: "text", text: `t=${f.t.toFixed(1)}s` });
    content.push({ type: "image_url", image_url: { url: f.url } });
  }
  return (await callModel(opts.key, content, { name: "layout", schema: LAYOUT_SCHEMA }, { maxTokens: 6000, effort: "low" })) as LayoutRead;
}
