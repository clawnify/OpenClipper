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
import { api, clock, type Clip, type Run, type Source } from "./api";
import { StatusBadge } from "./sources";
import { btnGhost, btnIcon, btnPrimary, btnSecondary, card, Dialog, EmptyState, Kbd } from "./ui";

// Who the clips are for, when a run has no brief of its own. Set from the
// deploy answers (see agent.md).
const DEFAULT_BRIEF = "";
const DEFAULT_COUNT = 25;
const POLL_MS = 5000;
// A clip still "rendering" this long after its last update is orphaned — the
// server says the same, and offers it for retry rather than leaving it stuck.
const RENDER_STALE_MS = 12 * 60 * 1000;

function stale(clip: Clip): boolean {
  const updated = Date.parse(clip.updated_at.replace(" ", "T") + "Z");
  return !Number.isFinite(updated) || Date.now() - updated > RENDER_STALE_MS;
}

/** Rendering is server-side; this is how the page learns it finished. */
function working(clip: Clip): boolean {
  return (clip.status === "rendering" || clip.status === "analysing") && !stale(clip);
}
// Renders in flight at once. The render service works one clip at a time per
// workspace; two keeps the next clip's frame reading overlapped with it.
const RENDER_CONCURRENCY = 2;

interface Detail {
  source: Source;
  clips: Clip[];
  run: Run | null;
}

const PREP_COPY: Record<string, string> = {
  uploading: "Waiting for the upload to finish.",
  processing: "The video is being processed. Long videos take a few minutes.",
  preparing: "Transcribing the video and preparing it for cutting.",
};

export function SourcePage({ id, navigate }: { id: string; navigate: (to: string) => void }) {
  const [data, setData] = useState<Detail | null>(null);
  const [missing, setMissing] = useState(false);
  const [thumb, setThumb] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renderQueue, setRenderQueue] = useState<{ done: number; total: number } | null>(null);
  const [editing, setEditing] = useState<Clip | null>(null);

  const load = useCallback(
    () =>
      api
        .get<Detail>(`/api/sources/${id}`)
        .then(setData)
        .catch(() => setMissing(true)),
    [id],
  );

  useEffect(() => {
    setData(null);
    setMissing(false);
    load();
  }, [load]);

  // Poll while the media service is still working on the video, and while any
  // clip is rendering — those run on the server, so this page can be reopened
  // mid-render and still catch up.
  const status = data?.source.status;
  const anyWorking = !!data?.clips.some(working);
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

  const find = async (brief: string, maxClips: number) => {
    setFinding(true);
    setError(null);
    try {
      const out = await api.send<{ run: Run; clips: Clip[] }>("POST", `/api/sources/${id}/find`, {
        brief,
        max_clips: maxClips,
      });
      setData((d) => (d ? { ...d, run: out.run, clips: out.clips } : d));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFinding(false);
    }
  };

  // The render runs on the server and outlives this page; ask for it, then
  // watch the clip until it stops working.
  const renderOne = async (clip: Clip) => {
    replaceClip({ ...clip, status: "rendering", error: null, updated_at: new Date().toISOString() });
    try {
      await api.send<Clip>("POST", `/api/clips/${clip.id}/render`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // "already rendering" is not a failure — fall through to watching it.
      if (!/already rendering/i.test(message)) {
        replaceClip({ ...clip, status: "failed", error: message });
        return;
      }
    }
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      let fresh: Clip | undefined;
      try {
        const d = await api.get<Detail>(`/api/sources/${clip.source_id}`);
        fresh = d.clips.find((x) => x.id === clip.id);
      } catch {
        continue; // a blip in polling must not fail a render that is running
      }
      if (!fresh) return;
      replaceClip(fresh);
      if (!working(fresh)) return;
    }
  };

  const renderAll = async (clips: Clip[]) => {
    setRenderQueue({ done: 0, total: clips.length });
    const queue = [...clips];
    const worker = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        await renderOne(c);
        setRenderQueue((q) => (q ? { ...q, done: q.done + 1 } : q));
      }
    };
    await Promise.all(Array.from({ length: RENDER_CONCURRENCY }, worker));
    setRenderQueue(null);
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

  const primary =
    source.status !== "ready" || live.length === 0 || finding ? null : renderQueue ? (
      <button className={`${btnPrimary} shrink-0`} disabled>
        <Loader2 className="w-4 h-4 animate-spin" /> Rendering {renderQueue.done + 1} of {renderQueue.total}
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
              onFind={find}
            />
            {error && <p className="mt-3 text-body-sm text-danger">{error}</p>}

            {finding ? (
              <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
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
                          busy={!!renderQueue}
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
  onFind,
}: {
  run: Run | null;
  busy: boolean;
  hasClips: boolean;
  onFind: (brief: string, maxClips: number) => void;
}) {
  const [open, setOpen] = useState(!hasClips);
  const [brief, setBrief] = useState(run?.brief ?? DEFAULT_BRIEF);
  const [count, setCount] = useState(run?.max_clips ?? DEFAULT_COUNT);

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
        The whole transcript is read at once, so the picks are the strongest in the video — not just the first good
        ones. Each clip opens on its hook and ends on a finished thought.
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
            max={30}
            value={count}
            onChange={(e) => setCount(Math.max(1, Math.min(30, Number(e.target.value) || 1)))}
            className="mt-1 block w-20 h-9 px-2.5 rounded-sm bg-surface shadow-edge text-body-sm tabular-nums"
          />
        </label>
        <span className="pb-2 text-fine text-muted">clips — fewer if the video doesn't have that many good ones.</span>
        <div className="flex-1" />
        {hasClips && (
          <button className={btnGhost} onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </button>
        )}
        {/* The page's one primary action while no clips exist. */}
        <button className={hasClips ? btnSecondary : btnPrimary} onClick={() => onFind(brief, count)} disabled={busy}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {busy ? "Reading the transcript…" : hasClips ? "Replace unrendered clips" : "Find clips"}
        </button>
      </div>
      {hasClips && <p className="mt-2 text-fine text-muted">Rendered clips are kept; the rest are replaced.</p>}
    </section>
  );
}

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
  const working = (clip.status === "rendering" || clip.status === "analysing") && !stale;
  const orphaned = (clip.status === "rendering" || clip.status === "analysing") && stale;
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
              {clip.status === "analysing" ? "Reading the shots…" : "Rendering…"}
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
