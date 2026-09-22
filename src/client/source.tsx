import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Download,
  Film,
  Loader2,
  Pencil,
  RotateCcw,
  Scissors,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import { api, ApiError, clock, type Clip, type ClipLength, type Run, type Source } from "./api";
import { StatusBadge } from "./sources";
import { btnGhost, btnIcon, btnPrimary, btnSecondary, card, Dialog, EmptyState, Kbd } from "./ui";

// Who the clips are for, when a run has no brief of its own. Set from the
// deploy answers (see agent.md).
const DEFAULT_BRIEF = "";
// Same ceiling and default as the server: about one clip per three minutes
// of video, never fewer than 3.
const MAX_CLIPS = 50;
function defaultCount(duration: number | null): number {
  return Math.min(MAX_CLIPS, Math.max(3, Math.round((duration ?? 0) / 180)));
}
const POLL_MS = 5000;
// Reading a clip's shots happens inside the render request. One still
// "analysing" this long after its last update lost that request — the server
// says the same, and lets it be rendered again.
const ANALYSE_STALE_MS = 12 * 60 * 1000;

function stale(clip: Clip): boolean {
  if (clip.status !== "analysing") return false;
  // The server sends SQLite UTC ("YYYY-MM-DD HH:MM:SS", no zone); an
  // optimistic local update sends ISO. Read both as UTC.
  const at = clip.updated_at.includes("T") ? clip.updated_at : clip.updated_at.replace(" ", "T") + "Z";
  const updated = Date.parse(at);
  return !Number.isFinite(updated) || Date.now() - updated > ANALYSE_STALE_MS;
}

/**
 * Renders run on the platform, queued one at a time in the workspace's render
 * container — a clip can wait its turn for a while, and the server is the one
 * that knows when it's done. This is only whether to keep asking.
 */
function working(clip: Clip): boolean {
  return clip.status === "rendering" || clip.status === "saving" || (clip.status === "analysing" && !stale(clip));
}
// Render requests sent at once. Each answers as soon as its clip is queued
// (after reading the clip's shots), so this only bounds the shot-reading calls.
const SUBMIT_CONCURRENCY = 3;

interface Detail {
  source: Source;
  clips: Clip[];
  run: Run | null;
}

const PREP_COPY: Record<string, string> = {
  uploading: "Waiting for the upload to finish.",
  processing: "The video is being processed. Long videos take a few minutes.",
  preparing: "Transcribing the video and getting it ready to be watched. A long video takes 10–25 minutes.",
};

export function SourcePage({ id, navigate }: { id: string; navigate: (to: string) => void }) {
  const [data, setData] = useState<Detail | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  // Sending the find request; after that the run's own status says it's on.
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [editing, setEditing] = useState<Clip | null>(null);

  const load = useCallback(
    () =>
      api
        .get<Detail>(`/api/sources/${id}`)
        .then((d) => {
          setData(d);
          setLoadError(null);
        })
        .catch((err) => {
          // Only a 404 means the video is gone. Anything else is shown as
          // itself; while polling, the last good state stays on screen.
          if (err instanceof ApiError && err.status === 404) setMissing(true);
          else setLoadError(err instanceof Error ? err.message : String(err));
        }),
    [id],
  );

  useEffect(() => {
    setData(null);
    setMissing(false);
    setLoadError(null);
    load();
  }, [load]);

  // Poll while the media service is still working on the video, and while any
  // clip is rendering — those run on the server, so this page can be reopened
  // mid-render and still catch up.
  const status = data?.source.status;
  // A message about the last state ("getting this video ready…") is stale
  // once the video moves on.
  useEffect(() => setError(null), [status]);
  const finding = starting || data?.run?.status === "finding";
  const anyWorking = !!data?.clips.some(working) || data?.run?.status === "finding";
  useEffect(() => {
    const preparing = status && status !== "ready" && status !== "failed";
    if (!preparing && !anyWorking) return;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [status, anyWorking, load]);

  useEffect(() => {
    if (status !== "ready") return;
    api
      .get<{ thumbnail: string }>(`/api/sources/${id}/playback`)
      .then((p) => setThumb(p.thumbnail))
      .catch(() => {});
  }, [status, id]);

  const replaceClip = (c: Clip) =>
    setData((d) => (d ? { ...d, clips: d.clips.map((x) => (x.id === c.id ? c : x)) } : d));

  // Finding runs on the platform (minutes for a long video): the request only
  // starts it, and the poll above follows the run until its clips arrive.
  const find = async (brief: string, maxClips: number, clipLength: ClipLength) => {
    setStarting(true);
    setError(null);
    try {
      const out = await api.send<{ run: Run }>("POST", `/api/sources/${id}/find`, {
        brief,
        max_clips: maxClips,
        clip_length: clipLength,
      });
      setData((d) => (d ? { ...d, run: out.run } : d));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // e.g. the video went back to preparing — show that.
      load();
    } finally {
      setStarting(false);
    }
  };

  // Starting a render answers once the clip is queued; the page poll above
  // follows it from there, so a reload loses nothing.
  const renderOne = async (clip: Clip) => {
    replaceClip({ ...clip, status: "analysing", error: null, updated_at: new Date().toISOString() });
    try {
      replaceClip(await api.send<Clip>("POST", `/api/clips/${clip.id}/render`));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // "already rendering" is not a failure — the poll reports the end.
      if (!/already rendering/i.test(message)) replaceClip({ ...clip, status: "failed", error: message });
      else load();
    }
  };

  const renderAll = async (clips: Clip[]) => {
    setSubmitting(true);
    const queue = [...clips];
    const worker = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) await renderOne(c);
    };
    await Promise.all(Array.from({ length: SUBMIT_CONCURRENCY }, worker));
    setSubmitting(false);
  };

  const patch = async (clip: Clip, body: Record<string, unknown>) => {
    replaceClip(await api.send<Clip>("PATCH", `/api/clips/${clip.id}`, body));
  };

  if (missing) {
    return (
      <main className="flex-1 overflow-y-auto">
        <EmptyState
          icon={<Film className="w-8 h-8" />}
          title="This video isn't here"
          body="It may have been deleted."
          action={
            <button className={btnSecondary} onClick={() => navigate("/")}>
              Back to videos
            </button>
          }
        />
      </main>
    );
  }
  if (!data && loadError) {
    return (
      <main className="flex-1 overflow-y-auto">
        <EmptyState
          icon={<X className="w-8 h-8" />}
          title="This video couldn't be loaded"
          body={loadError}
          action={
            <button className={btnSecondary} onClick={load}>
              Try again
            </button>
          }
        />
      </main>
    );
  }
  if (!data) {
    return (
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-6 py-8 space-y-4">
          <div className="h-7 w-72 rounded-full bg-surface-sunken animate-pulse" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-64 rounded-md bg-surface-sunken animate-pulse" />
            ))}
          </div>
        </div>
      </main>
    );
  }

  const { source, clips, run } = data;
  const live = clips.filter((c) => c.status !== "rejected");
  const dropped = clips.filter((c) => c.status === "rejected");
  const toRender = live.filter((c) => c.status === "proposed" || c.status === "failed");
  const rendered = live.filter((c) => c.status === "rendered");
  const inProgress = live.filter(working);

  const primary =
    source.status !== "ready" || live.length === 0 || finding ? null : submitting || inProgress.length > 0 ? (
      <button className={`${btnPrimary} shrink-0`} disabled>
        <Loader2 className="w-4 h-4 animate-spin" /> Rendering {inProgress.length}{" "}
        {inProgress.length === 1 ? "clip" : "clips"}
      </button>
    ) : toRender.length > 0 ? (
      <button className={`${btnPrimary} shrink-0`} onClick={() => renderAll(toRender)}>
        <Film className="w-4 h-4" /> Render {toRender.length} {toRender.length === 1 ? "clip" : "clips"}
      </button>
    ) : rendered.length > 0 ? (
      <button className={`${btnPrimary} shrink-0`} onClick={() => downloadAll(rendered)}>
        <Download className="w-4 h-4" /> Download all {rendered.length}
      </button>
    ) : null;

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div className="min-w-0">
            <h1 className="text-heading-1 truncate">{source.name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-body-sm text-muted">
              <StatusBadge status={source.status} />
              {source.duration && <span className="tabular-nums">{clock(source.duration)} long</span>}
              {source.width && source.height && (
                <span className="tabular-nums">
                  {source.width}×{source.height}
                </span>
              )}
              {live.length > 0 && (
                <span className="tabular-nums">
                  {rendered.length} of {live.length} clips rendered
                </span>
              )}
            </div>
          </div>
          {primary}
        </div>

        {source.status === "failed" ? (
          <EmptyState
            icon={<X className="w-8 h-8" />}
            title="This video couldn't be processed"
            body={source.error ?? "Delete it and add it again, or try a different file."}
          />
        ) : source.status !== "ready" ? (
          <PrepPanel source={source} />
        ) : (
          <>
            <FindPanel
              key={run?.id ?? "first"}
              run={run}
              busy={finding}
              hasClips={clips.length > 0}
              duration={source.duration}
              onFind={find}
            />
            {error && <p className="mt-3 text-body-sm text-danger">{error}</p>}
            {!error && run?.status === "failed" && run.error && (
              <p className="mt-3 text-body-sm text-danger">{run.error}</p>
            )}

            {finding ? (
              <>
                <p className="mt-6 text-body-sm text-muted max-w-2xl">
                  Watching and listening to the whole video. A long video takes a few minutes — you can leave this page
                  and come back.
                </p>
                <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="flex gap-3 rounded-md bg-surface-sunken/60 p-0 overflow-hidden">
                      <div className="w-36 sm:w-40 aspect-[9/16] bg-surface-sunken animate-pulse" />
                      <div className="flex-1 p-3 space-y-2">
                        <div className="h-2.5 w-1/3 rounded-full bg-surface-sunken animate-pulse" />
                        <div className="h-3.5 w-3/4 rounded-full bg-surface-sunken animate-pulse" />
                        <div className="h-3 w-2/3 rounded-full bg-surface-sunken animate-pulse" />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                {run?.notes && live.length > 0 && (
                  <section className="mt-6">
                    <div className="text-micro uppercase text-muted">What the editor found</div>
                    <p className="mt-1 text-body-sm text-muted max-w-3xl">{run.notes}</p>
                  </section>
                )}
                {live.length > 0 && (
                  <section className="mt-6">
                    <div className="text-micro uppercase text-muted mb-3">Clips · strongest first</div>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      {live.map((c) => (
                        <ClipCard
                          key={c.id}
                          clip={c}
                          thumb={thumb}
                          busy={submitting}
                          stale={stale(c)}
                          onRender={() => renderOne(c)}
                          onEdit={() => setEditing(c)}
                          onDrop={() => patch(c, { rejected: true })}
                        />
                      ))}
                    </div>
                  </section>
                )}
                {run && live.length === 0 && clips.length === 0 && (
                  <EmptyState
                    icon={<Scissors className="w-8 h-8" />}
                    title="No strong moments found"
                    body={run.notes || "Try a brief that says who the clips are for, or ask for fewer clips."}
                  />
                )}
                {dropped.length > 0 && (
                  <section className="mt-8">
                    <div className="text-micro uppercase text-muted mb-2">Dropped</div>
                    <ul className="divide-y divide-border border-y border-border">
                      {dropped.map((c) => (
                        <li key={c.id} className="flex items-center gap-3 py-2 text-body-sm">
                          <span className="tabular-nums text-muted w-28 shrink-0">
                            {clock(c.start_s)} · {Math.round(c.end_s - c.start_s)}s
                          </span>
                          <span className="truncate flex-1">{c.title}</span>
                          <button className={btnGhost} onClick={() => patch(c, { rejected: false })}>
                            <Undo2 className="w-4 h-4" /> Restore
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            )}
          </>
        )}

        {editing && (
          <EditClipDialog
            clip={editing}
            duration={source.duration ?? Infinity}
            onClose={() => setEditing(null)}
            onSave={async (body) => {
              await patch(editing, body);
              setEditing(null);
            }}
          />
        )}
      </div>
    </main>
  );
}

function PrepPanel({ source }: { source: Source }) {
  const pct = source.progress !== null && source.progress !== undefined ? Math.round(source.progress) : null;
  return (
    <section className={`${card} p-5`}>
      <div className="text-micro uppercase text-muted">Getting the video ready</div>
      <div className="mt-2 flex items-center gap-2 text-body">
        <Loader2 className="w-4 h-4 animate-spin text-muted" />
        {PREP_COPY[source.status] ?? "Working on it."}
      </div>
      {pct !== null && (
        <div className="mt-3 h-1.5 rounded-full bg-surface-sunken overflow-hidden" aria-label={`${pct}%`}>
          <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
        </div>
      )}
      <p className="mt-3 text-fine text-muted">You can leave this page — it keeps going, and this page updates when you come back.</p>
    </section>
  );
}

function FindPanel({
  run,
  busy,
  hasClips,
  duration,
  onFind,
}: {
  run: Run | null;
  busy: boolean;
  hasClips: boolean;
  duration: number | null;
  onFind: (brief: string, maxClips: number, clipLength: ClipLength) => void;
}) {
  const [open, setOpen] = useState(!hasClips);
  const [brief, setBrief] = useState(run?.brief ?? DEFAULT_BRIEF);
  const [count, setCount] = useState(run?.max_clips ?? defaultCount(duration));
  const [length, setLength] = useState<ClipLength>(run?.clip_length ?? "standard");

  if (!open) {
    return (
      <button className={btnSecondary} onClick={() => setOpen(true)} disabled={busy}>
        <RotateCcw className="w-4 h-4" /> Find clips again
      </button>
    );
  }
  return (
    <section className={`${card} p-5`}>
      <div className="text-micro uppercase text-muted">Find the clips</div>
      <p className="mt-1 text-body-sm text-muted max-w-2xl">
        The whole video is watched and listened to at once, so the picks are the strongest in it — not just the first
        good ones, and not only what is said: a sound or a picture can carry a clip. Each clip opens on its hook and
        ends on a finished payoff.
      </p>
      <label className="block mt-4">
        <span className="text-label">Who are the clips for? (optional)</span>
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={3}
          placeholder="e.g. Music producers on YouTube Shorts. Favour quick wins with a sound they can hear change; skip the product pitch."
          className="mt-1 block w-full px-2.5 py-2 rounded-sm bg-surface shadow-edge text-body-sm"
        />
      </label>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-label">At most</span>
          <input
            type="number"
            min={1}
            max={MAX_CLIPS}
            value={count}
            onChange={(e) => setCount(Math.max(1, Math.min(MAX_CLIPS, Number(e.target.value) || 1)))}
            className="mt-1 block w-20 h-9 px-2.5 rounded-sm bg-surface shadow-edge text-body-sm tabular-nums"
          />
        </label>
        <span className="pb-2 text-fine text-muted">clips — only the strong ones, so often fewer.</span>
        <div className="block">
          <span className="text-label" id="clip-length">Length</span>
          <div role="radiogroup" aria-labelledby="clip-length" className="mt-1 flex h-9 rounded-sm bg-surface-sunken p-0.5">
            {LENGTHS.map(([value, label]) => (
              <button
                key={value}
                role="radio"
                aria-checked={length === value}
                onClick={() => setLength(value)}
                className={`px-2.5 rounded-xs text-body-sm ${length === value ? "bg-surface shadow-edge" : "text-muted"}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1" />
        {hasClips && (
          <button className={btnGhost} onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </button>
        )}
        {/* The page's one primary action while no clips exist. */}
        <button className={hasClips ? btnSecondary : btnPrimary} onClick={() => onFind(brief, count, length)} disabled={busy}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {busy ? "Watching the video…" : hasClips ? "Replace unrendered clips" : "Find clips"}
        </button>
      </div>
      {hasClips && <p className="mt-2 text-fine text-muted">Rendered clips are kept; the rest are replaced.</p>}
    </section>
  );
}

const LENGTHS: [ClipLength, string][] = [
  ["short", "Under 30s"],
  ["standard", "30–60s"],
  ["long", "60–90s"],
];

const LAYOUT_LABEL = { speaker: "Speaker", screen: "Screen" } as const;

function ClipCard({
  clip,
  thumb,
  busy,
  stale,
  onRender,
  onEdit,
  onDrop,
}: {
  clip: Clip;
  thumb: string | null;
  busy: boolean;
  stale: boolean;
  onRender: () => void;
  onEdit: () => void;
  onDrop: () => void;
}) {
  const len = Math.round(clip.end_s - clip.start_s);
  const working = (clip.status === "rendering" || clip.status === "saving" || clip.status === "analysing") && !stale;
  const orphaned = stale;
  const frame = thumb ? thumb.replace("{time}", String(Math.floor(clip.start_s + 1))) : null;
  const layouts = useMemo(() => [...new Set((clip.layout ?? []).map((s) => s.layout))], [clip.layout]);

  return (
    <article className={`${card} overflow-hidden flex`}>
      {/* The preview keeps its 9:16 shape at a fixed width, so a run of 25
          clips reviews as a dense list, not a wall of tall frames. */}
      <div className="relative w-36 sm:w-40 shrink-0 aspect-[9/16] bg-foreground overflow-hidden">
        {clip.status === "rendered" && clip.file_url ? (
          <video src={clip.file_url} controls preload="metadata" playsInline className="absolute inset-0 w-full h-full object-contain" />
        ) : frame ? (
          // A preview of the vertical frame: the shot, over a blurred copy.
          <>
            <img src={frame} alt="" aria-hidden className="absolute inset-0 w-full h-full object-cover blur-xl scale-110 opacity-70" />
            <img src={frame} alt={`Frame from ${clock(clip.start_s)}`} className="absolute inset-0 w-full h-full object-contain" />
          </>
        ) : null}
        {working && (
          <div className="absolute inset-0 grid place-items-center bg-foreground/50 text-on-primary">
            <span className="flex items-center gap-2 text-label">
              <Loader2 className="w-4 h-4 animate-spin" />
              {clip.status === "analysing" ? "Reading the shots…" : clip.status === "saving" ? "Saving…" : "Rendering…"}
            </span>
          </div>
        )}
        <span className="absolute left-2 top-2 rounded-xs bg-surface px-1.5 text-fine tabular-nums shadow-edge">#{clip.rank}</span>
      </div>

      <div className="p-3 flex-1 min-w-0 flex flex-col gap-1.5">
        <div className="text-fine text-muted tabular-nums">
          {clock(clip.start_s)} → {clock(clip.end_s)} · {len}s
        </div>
        <h3 className="text-heading-3 leading-snug">{clip.title}</h3>
        {clip.hook && <p className="text-body-sm text-muted line-clamp-3">“{clip.hook}”</p>}
        <div className="flex flex-wrap gap-1 mt-0.5">
          {layouts.map((l) => (
            <span key={l} className="rounded-xs border border-border bg-surface-sunken px-1.5 text-fine">
              {LAYOUT_LABEL[l]}
            </span>
          ))}
          {!clip.captions && <span className="rounded-xs border border-border bg-surface-sunken px-1.5 text-fine">No captions</span>}
          {clip.status === "rendered" && (
            <span className="inline-flex items-center gap-1 h-5 px-2 rounded-full border text-fine bg-success-tint text-success border-success/30">
              <Check className="w-3 h-3" /> Rendered
            </span>
          )}
        </div>
        {clip.status === "failed" && clip.error && <p className="text-fine text-danger">{clip.error}</p>}
        {orphaned && <p className="text-fine text-muted">This render stopped before it finished. Render it again.</p>}

        <div className="mt-auto pt-2 flex items-center gap-1">
          {clip.status === "rendered" && clip.file_url ? (
            <a className={btnSecondary} href={`${clip.file_url}?download=1`} download>
              <Download className="w-4 h-4" /> Download
            </a>
          ) : (
            <button className={btnSecondary} onClick={onRender} disabled={working || busy}>
              <Film className="w-4 h-4" /> {clip.status === "failed" || orphaned ? "Retry" : "Render"}
            </button>
          )}
          <div className="flex-1" />
          <button className={btnIcon} onClick={onEdit} disabled={working} aria-label={`Edit ${clip.title}`} title="Trim or retitle">
            <Pencil className="w-4 h-4" />
          </button>
          <button className={`${btnIcon} hover:text-danger`} onClick={onDrop} disabled={working} aria-label={`Drop ${clip.title}`} title="Drop this clip">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </article>
  );
}

function EditClipDialog({
  clip,
  duration,
  onClose,
  onSave,
}: {
  clip: Clip;
  duration: number;
  onClose: () => void;
  onSave: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [title, setTitle] = useState(clip.title);
  const [start, setStart] = useState(clip.start_s);
  const [end, setEnd] = useState(clip.end_s);
  const [captions, setCaptions] = useState(clip.captions);
  const [showTitle, setShowTitle] = useState(clip.show_title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = useRef(false);

  const nudge = (which: "start" | "end", by: number) => {
    if (which === "start") setStart((s) => Math.min(end - 3, Math.max(0, Math.round((s + by) * 10) / 10)));
    else setEnd((e) => Math.max(start + 3, Math.min(duration, Math.round((e + by) * 10) / 10)));
  };

  const save = async () => {
    if (saved.current) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { title, captions, show_title: showTitle };
      if (start !== clip.start_s || end !== clip.end_s) Object.assign(body, { start_s: start, end_s: end });
      saved.current = true;
      await onSave(body);
    } catch (err) {
      saved.current = false;
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const Nudges = ({ which }: { which: "start" | "end" }) => (
    <div className="flex items-center gap-1">
      {[-2, -0.5, 0.5, 2].map((by) => (
        <button key={by} className={`${btnGhost} tabular-nums`} onClick={() => nudge(which, by)} aria-label={`${which} ${by > 0 ? "later" : "earlier"} by ${Math.abs(by)} seconds`}>
          {by > 0 ? "+" : "−"}
          {Math.abs(by)}s
        </button>
      ))}
    </div>
  );

  return (
    <Dialog
      title="Edit clip"
      icon={<Pencil className="w-4 h-4" />}
      description={clip.status === "rendered" ? "Saving a change marks the clip for re-rendering." : undefined}
      onClose={onClose}
      footer={
        <>
          <button className={btnGhost} onClick={onClose}>
            Cancel <Kbd>esc</Kbd>
          </button>
          <button className={btnPrimary} onClick={save} disabled={saving || !title.trim()} data-autofocus>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save
          </button>
        </>
      }
    >
      <div className="mt-4 space-y-4">
        <label className="block">
          <span className="text-micro uppercase text-muted">Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} className="mt-1 block w-full h-9 px-2.5 rounded-sm bg-surface shadow-edge text-body-sm" />
        </label>
        <div>
          <div className="text-micro uppercase text-muted">Starts at</div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="text-data tabular-nums">{preciseClock(start)}</span>
            <Nudges which="start" />
          </div>
        </div>
        <div>
          <div className="text-micro uppercase text-muted">Ends at</div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="text-data tabular-nums">{preciseClock(end)}</span>
            <Nudges which="end" />
          </div>
          <div className="mt-1 text-fine text-muted tabular-nums">{Math.round(end - start)} seconds</div>
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-body-sm">
            <input type="checkbox" checked={captions} onChange={(e) => setCaptions(e.target.checked)} /> Burn in captions
          </label>
          <label className="flex items-center gap-2 text-body-sm">
            <input type="checkbox" checked={showTitle} onChange={(e) => setShowTitle(e.target.checked)} /> Show the title for the first seconds
          </label>
        </div>
        {error && <p className="text-body-sm text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

/** 3220.66 → "53:40.7" — tenths, for trimming (floor the whole seconds so .6 never rolls a second up). */
function preciseClock(s: number): string {
  const tenths = Math.round(s * 10);
  return `${clock(Math.floor(tenths / 10))}.${tenths % 10}`;
}

/** One download per clip, spaced so the browser doesn't drop any. */
async function downloadAll(clips: Clip[]) {
  for (const c of clips) {
    if (!c.file_url) continue;
    const a = document.createElement("a");
    a.href = `${c.file_url}?download=1`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    await new Promise((r) => setTimeout(r, 600));
  }
}
