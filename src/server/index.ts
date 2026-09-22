import { Hono } from "hono";
import { initDB, query, get, run } from "./db";
import { media, renderEdit, ServiceError, type MediaStatus, type ServicesConfig } from "./services";
import { MODEL, readLayout, selectMoments } from "./ai";
import { captionChunks, parseVtt, snapWindow, transcriptForModel, type Cue } from "./transcript";
import { normalizeSegments, type LayoutSegment } from "./layout";
import { buildClipEdl } from "./edl";
import {
  directDownloadUrl,
  folderListingUrl,
  isVideoName,
  judgeLinkResponse,
  parseDriveLink,
  parseFolderListing,
} from "./drive-link";

type Bindings = {
  DB: D1Database;
  // Rendered clips.
  UPLOADS: R2Bucket;
  // Injected into every deployed app; authorizes the platform's managed services.
  CLAWNIFY_TOKEN?: string;
  // Local dev override (defaults to https://services.clawnify.com).
  SERVICES_URL?: string;
  // The org's OpenRouter key — moment selection and layout reading.
  OPENROUTER_API_KEY?: string;
};

type C = { Bindings: Bindings };
const app = new Hono<C>();

const MAX_CLIPS = 30;
// Shorter than this is a quote card, longer stops being a short.
const MIN_CLIP = 12;
const MAX_CLIP = 75;
// Frames sampled through a clip to read its layout.
const FRAME_STEP = 2;

app.use("/api/*", async (c, next) => {
  initDB(c.env);
  await next();
});

app.onError((err, c) => {
  if (err instanceof ServiceError) {
    return c.json({ error: err.code, detail: err.message }, err.status >= 500 ? 502 : (err.status as 400));
  }
  console.error(err);
  return c.json({ error: "internal_error", detail: err.message || String(err) }, 500);
});

function services(env: Bindings): ServicesConfig {
  if (!env.CLAWNIFY_TOKEN) {
    throw new ServiceError("not_configured", "this app has no Clawnify token — deploy it through Clawnify to use the media service", 503);
  }
  return { token: env.CLAWNIFY_TOKEN, url: env.SERVICES_URL };
}

function modelKey(env: Bindings): string {
  if (!env.OPENROUTER_API_KEY) {
    throw new ServiceError("not_configured", "no OpenRouter key — add one in the dashboard's API Keys settings", 503);
  }
  return env.OPENROUTER_API_KEY;
}

// ── Rows ─────────────────────────────────────────────────────────────

interface Source {
  id: string;
  name: string;
  media_id: string;
  status: "uploading" | "processing" | "preparing" | "ready" | "failed";
  progress: number | null;
  error: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  language: string;
  transcript: string | null;
  created_at: string;
  updated_at: string;
}

interface Clip {
  id: string;
  source_id: string;
  run_id: string | null;
  rank: number;
  title: string;
  hook: string;
  reason: string;
  start_s: number;
  end_s: number;
  layout: string | null;
  captions: number;
  show_title: number;
  status: "proposed" | "analysing" | "rendering" | "rendered" | "failed" | "rejected";
  error: string | null;
  output_key: string | null;
  output_size: number | null;
  rendered_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Run {
  id: string;
  source_id: string;
  brief: string;
  max_clips: number;
  model: string;
  notes: string | null;
  created_at: string;
}

/** A source for the client — the transcript stays server-side (it's large). */
function publicSource(s: Source) {
  const { transcript, ...rest } = s;
  return { ...rest, has_transcript: !!transcript };
}

function publicClip(c: Clip) {
  return {
    ...c,
    layout: c.layout ? (JSON.parse(c.layout) as LayoutSegment[]) : null,
    captions: !!c.captions,
    show_title: !!c.show_title,
    file_url: c.output_key ? `/api/clips/${c.id}/file` : null,
  };
}

// ── Sources ──────────────────────────────────────────────────────────

app.get("/api/sources", async (c) => {
  const rows = await query<Source & { clip_count: number; rendered_count: number }>(
    `SELECT s.*,
       (SELECT COUNT(*) FROM clips k WHERE k.source_id = s.id AND k.status != 'rejected') AS clip_count,
       (SELECT COUNT(*) FROM clips k WHERE k.source_id = s.id AND k.status = 'rendered') AS rendered_count
     FROM sources s ORDER BY s.created_at DESC`,
  );
  return c.json(rows.map((r) => ({ ...publicSource(r), clip_count: r.clip_count, rendered_count: r.rendered_count })));
});

// Start a browser upload: the media service hands back a one-time resumable
// (tus) URL, and the file goes from the browser straight to it.
app.post("/api/sources/upload", async (c) => {
  const b = await c.req.json<{ name?: string; size?: number; language?: string }>().catch(() => ({}) as never);
  if (!b.size || !b.name) return c.json({ error: "invalid_request", detail: "name and size are required" }, 400);
  const up = await media.upload(services(c.env), b.size, b.name);
  const row = await insertSource(b.name, up.id, b.language);
  return c.json({ source: publicSource(row), upload_url: up.upload_url }, 201);
});

// List a public Google Drive folder, so a link a client shared is a list to
// pick from rather than something to copy file ids out of. Unauthenticated on
// purpose: the folder is public, and asking the org to connect Drive to read a
// link anyone can open would be friction for nothing.
app.get("/api/drive/folder", async (c) => {
  const link = parseDriveLink(c.req.query("url") ?? "");
  if (link?.kind !== "folder") {
    return c.json({ error: "invalid_request", detail: "that isn't a Google Drive folder link" }, 400);
  }
  const res = await fetch(folderListingUrl(link.id), { headers: { "User-Agent": "OpenClipper" } });
  if (!res.ok) {
    return c.json({ error: "folder_unreadable", detail: "couldn't open that folder — is it shared with anyone who has the link?" }, 422);
  }
  const files = parseFolderListing(await res.text());
  if (files.length === 0) {
    return c.json({ error: "folder_unreadable", detail: "that folder is empty, or it isn't shared with anyone who has the link" }, 422);
  }
  return c.json({ files: files.map((f) => ({ ...f, video: isVideoName(f.name) })) });
});

// Import from a link: the media service pulls the file itself (any size).
// A Google Drive link is resolved to the URL that serves the file's own bytes,
// and checked before it goes any further — Drive answers a file that is over
// its download quota, or not public, with an HTML page and a 200, which would
// otherwise import as a few KB of "video".
app.post("/api/sources/import", async (c) => {
  const b = await c.req.json<{ url?: string; name?: string; language?: string }>().catch(() => ({}) as never);
  if (!b.url) return c.json({ error: "invalid_request", detail: "a link to the video file is required" }, 400);
  const link = parseDriveLink(b.url);
  if (link?.kind === "folder") {
    return c.json({ error: "invalid_request", detail: "that's a folder — open it to pick a video" }, 400);
  }
  const url = link ? directDownloadUrl(link.id) : b.url;

  const probe = await fetch(url, { headers: { Range: "bytes=0-1" }, redirect: "follow" }).catch(() => null);
  if (!probe) return c.json({ error: "invalid_request", detail: "that link could not be reached" }, 422);
  const verdict = judgeLinkResponse(
    probe.status,
    probe.headers.get("content-type"),
    probe.headers.get("content-range"),
    probe.headers.get("content-length"),
  );
  await probe.body?.cancel();
  if (!verdict.ok) return c.json({ error: "invalid_request", detail: verdict.reason ?? "that link isn't a video" }, 422);

  const fromHeader = probe.headers.get("content-disposition")?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1];
  const name =
    b.name?.trim() ||
    (fromHeader ? decodeURIComponent(fromHeader).replace(/\.[^.]+$/, "") : "") ||
    decodeURIComponent(new URL(url).pathname.split("/").pop() || "") ||
    "Imported video";
  const m = await media.import(services(c.env), url, name);
  const row = await insertSource(name, m.id, b.language, "processing");
  return c.json({ source: publicSource(row) }, 201);
});

async function insertSource(name: string, mediaId: string, language = "en", status = "uploading"): Promise<Source> {
  await run("INSERT INTO sources (name, media_id, status, language) VALUES (?, ?, ?, ?)", [
    name.slice(0, 200),
    mediaId,
    status,
    /^[a-z]{2}$/.test(language) ? language : "en",
  ]);
  return (await get<Source>("SELECT * FROM sources WHERE media_id = ?", [mediaId]))!;
}

// Read a source, advancing it through the media service's processing on the
// way: processing → (download + captions) preparing → ready. Polled by the UI.
app.get("/api/sources/:id", async (c) => {
  let source = await get<Source>("SELECT * FROM sources WHERE id = ?", [c.req.param("id")]);
  if (!source) return c.json({ error: "not_found" }, 404);
  if (source.status !== "ready" && source.status !== "failed") {
    source = await advance(c.env, source);
  }
  const [clips, runRow] = await Promise.all([
    query<Clip>("SELECT * FROM clips WHERE source_id = ? ORDER BY status = 'rejected', rank, start_s", [source.id]),
    get<Run>("SELECT * FROM runs WHERE source_id = ? ORDER BY created_at DESC LIMIT 1", [source.id]),
  ]);
  return c.json({ source: publicSource(source), clips: clips.map(publicClip), run: runRow ?? null });
});

async function advance(env: Bindings, source: Source): Promise<Source> {
  const cfg = services(env);
  let m: MediaStatus;
  try {
    m = await media.get(cfg, source.media_id);
  } catch (err) {
    if (err instanceof ServiceError && err.status === 404) {
      return setSource(source.id, { status: "failed", error: "the video is gone from the media service" });
    }
    throw err;
  }
  const facts = { duration: m.duration, width: m.width, height: m.height };

  if (m.state === "error") {
    return setSource(source.id, { status: "failed", error: m.error || "the video could not be processed", ...facts });
  }
  if (!m.ready) {
    // "pendingupload" while the browser is still sending bytes.
    const status = m.state === "pendingupload" ? "uploading" : "processing";
    return setSource(source.id, { status, progress: m.progress, ...facts });
  }

  const captions = m.captions?.find((x) => x.language === source.language);
  if (!m.download || !captions) {
    const p = await media.prepare(cfg, source.media_id, source.language);
    return setSource(source.id, { status: "preparing", progress: p.download?.percent ?? null, ...facts });
  }
  if (m.download.status === "error" || captions.status === "error") {
    return setSource(source.id, { status: "failed", error: "preparing the video failed — delete it and upload again", ...facts });
  }
  if (m.download.status !== "ready" || captions.status !== "ready") {
    return setSource(source.id, { status: "preparing", progress: m.download.percent ?? null, ...facts });
  }
  const vtt = await media.captions(cfg, source.media_id, source.language);
  return setSource(source.id, { status: "ready", progress: null, error: null, transcript: vtt, ...facts });
}

async function setSource(id: string, patch: Partial<Source>): Promise<Source> {
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  if (keys.length) {
    await run(
      `UPDATE sources SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`,
      [...keys.map((k) => (patch as Record<string, unknown>)[k] as string | number | null), id],
    );
  }
  return (await get<Source>("SELECT * FROM sources WHERE id = ?", [id]))!;
}

app.patch("/api/sources/:id", async (c) => {
  const b = await c.req.json<{ name?: string }>().catch(() => ({}) as never);
  const source = await get<Source>("SELECT * FROM sources WHERE id = ?", [c.req.param("id")]);
  if (!source) return c.json({ error: "not_found" }, 404);
  if (b.name?.trim()) await setSource(source.id, { name: b.name.trim().slice(0, 200) });
  return c.json(publicSource((await get<Source>("SELECT * FROM sources WHERE id = ?", [source.id]))!));
});

app.delete("/api/sources/:id", async (c) => {
  const source = await get<Source>("SELECT * FROM sources WHERE id = ?", [c.req.param("id")]);
  if (!source) return c.json({ error: "not_found" }, 404);
  const outputs = await query<{ output_key: string }>(
    "SELECT output_key FROM clips WHERE source_id = ? AND output_key IS NOT NULL",
    [source.id],
  );
  await Promise.all(outputs.map((o) => c.env.UPLOADS.delete(o.output_key)));
  await media.remove(services(c.env), source.media_id).catch((err) => {
    // Already gone is fine; anything else must not orphan billable footage.
    if (!(err instanceof ServiceError && err.status === 404)) throw err;
  });
  await run("DELETE FROM clips WHERE source_id = ?", [source.id]);
  await run("DELETE FROM runs WHERE source_id = ?", [source.id]);
  await run("DELETE FROM sources WHERE id = ?", [source.id]);
  return c.body(null, 204);
});

// Signed playback + frame URLs for the review UI.
app.get("/api/sources/:id/playback", async (c) => {
  const source = await get<Source>("SELECT * FROM sources WHERE id = ?", [c.req.param("id")]);
  if (!source) return c.json({ error: "not_found" }, 404);
  return c.json(await media.playback(services(c.env), source.media_id));
});

// ── Finding clips ────────────────────────────────────────────────────

// One pass of the model over the whole transcript. Replaces the clips from
// earlier passes that were never rendered; rendered clips are kept.
app.post("/api/sources/:id/find", async (c) => {
  const b = await c.req.json<{ brief?: string; max_clips?: number }>().catch(() => ({}) as never);
  const source = await get<Source>("SELECT * FROM sources WHERE id = ?", [c.req.param("id")]);
  if (!source) return c.json({ error: "not_found" }, 404);
  if (source.status !== "ready" || !source.transcript || !source.duration) {
    return c.json({ error: "not_ready", detail: "the video is still being prepared" }, 409);
  }
  const cues = parseVtt(source.transcript);
  if (cues.length === 0) {
    return c.json({ error: "no_speech", detail: "no speech was found in this video, so there's nothing to cut on" }, 422);
  }
  const maxClips = Math.min(MAX_CLIPS, Math.max(1, Math.round(b.max_clips ?? 25)));
  const brief = (b.brief ?? "").trim().slice(0, 2000);

  const pick = await selectMoments({
    key: modelKey(c.env),
    transcript: transcriptForModel(cues),
    duration: source.duration,
    brief,
    maxClips,
  });

  const rendered = await query<Clip>("SELECT * FROM clips WHERE source_id = ? AND status = 'rendered'", [source.id]);
  const windows = snapMoments(cues, pick.moments, source.duration, rendered);

  await run("INSERT INTO runs (source_id, brief, max_clips, model, notes) VALUES (?, ?, ?, ?, ?)", [
    source.id,
    brief,
    maxClips,
    MODEL,
    pick.notes,
  ]);
  const runRow = (await get<Run>("SELECT * FROM runs WHERE source_id = ? ORDER BY rowid DESC LIMIT 1", [source.id]))!;
  await run("DELETE FROM clips WHERE source_id = ? AND status != 'rendered'", [source.id]);
  for (const [i, w] of windows.entries()) {
    await run(
      "INSERT INTO clips (source_id, run_id, rank, title, hook, reason, start_s, end_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [source.id, runRow.id, i + 1, w.title.slice(0, 120), w.hook.slice(0, 400), w.reason.slice(0, 400), w.start, w.end],
    );
  }
  const clips = await query<Clip>("SELECT * FROM clips WHERE source_id = ? ORDER BY rank, start_s", [source.id]);
  return c.json({ run: runRow, clips: clips.map(publicClip) }, 201);
});

/** Model moments → speech-snapped, length-checked, non-overlapping windows. */
function snapMoments(
  cues: Cue[],
  moments: { title: string; hook: string; reason: string; start: number; end: number }[],
  duration: number,
  keep: Clip[],
) {
  const taken: { start: number; end: number }[] = keep.map((k) => ({ start: k.start_s, end: k.end_s }));
  const out: { title: string; hook: string; reason: string; start: number; end: number }[] = [];
  for (const m of moments) {
    const w = snapWindow(cues, { start: m.start, end: m.end }, duration);
    if (!w) continue;
    const len = w.end - w.start;
    if (len < MIN_CLIP || len > MAX_CLIP) continue;
    if (taken.some((t) => w.start < t.end - 1 && w.end > t.start + 1)) continue;
    taken.push(w);
    out.push({ ...m, ...w });
  }
  return out;
}

// ── Clips ────────────────────────────────────────────────────────────

async function loadClip(id: string) {
  const clip = await get<Clip>("SELECT * FROM clips WHERE id = ?", [id]);
  if (!clip) return null;
  const source = (await get<Source>("SELECT * FROM sources WHERE id = ?", [clip.source_id]))!;
  return { clip, source };
}

async function setClip(id: string, patch: Partial<Clip>): Promise<Clip> {
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  if (keys.length) {
    await run(
      `UPDATE clips SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`,
      [...keys.map((k) => (patch as Record<string, unknown>)[k] as string | number | null), id],
    );
  }
  return (await get<Clip>("SELECT * FROM clips WHERE id = ?", [id]))!;
}

// Edit a clip: trim, retitle, toggle captions/title, drop or restore it.
app.patch("/api/clips/:id", async (c) => {
  const found = await loadClip(c.req.param("id"));
  if (!found) return c.json({ error: "not_found" }, 404);
  const { clip, source } = found;
  const b = await c.req
    .json<{ start_s?: number; end_s?: number; title?: string; captions?: boolean; show_title?: boolean; rejected?: boolean }>()
    .catch(() => ({}) as never);

  const patch: Partial<Clip> = {};
  if (b.start_s !== undefined || b.end_s !== undefined) {
    const start = Math.max(0, b.start_s ?? clip.start_s);
    const end = Math.min(source.duration ?? Infinity, b.end_s ?? clip.end_s);
    if (!(end - start >= MIN_CLIP / 2 && end - start <= MAX_CLIP)) {
      return c.json({ error: "invalid_request", detail: `a clip runs ${MIN_CLIP / 2}–${MAX_CLIP} seconds` }, 422);
    }
    patch.start_s = Math.round(start * 1000) / 1000;
    patch.end_s = Math.round(end * 1000) / 1000;
    // The window moved: its layout stretches no longer line up.
    patch.layout = null;
  }
  if (b.title !== undefined && b.title.trim()) patch.title = b.title.trim().slice(0, 120);
  if (b.captions !== undefined) patch.captions = b.captions ? 1 : 0;
  if (b.show_title !== undefined) patch.show_title = b.show_title ? 1 : 0;
  if (b.rejected !== undefined) patch.status = b.rejected ? "rejected" : clip.output_key ? "rendered" : "proposed";
  // Anything that changes the picture makes the rendered file stale.
  const staleRender =
    clip.status === "rendered" &&
    (patch.start_s !== undefined || patch.title !== undefined || patch.captions !== undefined || patch.show_title !== undefined);
  if (staleRender) patch.status = "proposed";

  return c.json(publicClip(await setClip(clip.id, patch)));
});

// Read how each stretch of the clip is shot (a person, or a screen), from
// frames sampled through it.
app.post("/api/clips/:id/analyze", async (c) => {
  const found = await loadClip(c.req.param("id"));
  if (!found) return c.json({ error: "not_found" }, 404);
  const clip = await analyzeClip(c.env, found.clip, found.source);
  return c.json(publicClip(clip));
});

async function analyzeClip(env: Bindings, clip: Clip, source: Source): Promise<Clip> {
  const duration = clip.end_s - clip.start_s;
  const { thumbnail } = await media.playback(services(env), source.media_id);
  const frames: { t: number; url: string }[] = [];
  for (let t = 0.5; t < duration; t += FRAME_STEP) {
    // Stream thumbnails take whole seconds.
    const at = Math.floor(clip.start_s + t);
    frames.push({ t: at - clip.start_s, url: thumbnail.replace("{time}", String(at)) });
  }
  const prev = clip.status;
  await setClip(clip.id, { status: "analysing", error: null });
  try {
    const read = await readLayout({ key: modelKey(env), frames, duration });
    const segments = normalizeSegments(read.segments ?? [], Math.round(duration * 1000) / 1000);
    return await setClip(clip.id, { layout: JSON.stringify(segments), status: prev === "analysing" ? "proposed" : prev });
  } catch (err) {
    await setClip(clip.id, { status: prev === "analysing" ? "proposed" : prev });
    throw err;
  }
}

// Render one clip to a vertical MP4 and keep it in this app's storage.
app.post("/api/clips/:id/render", async (c) => {
  const found = await loadClip(c.req.param("id"));
  if (!found) return c.json({ error: "not_found" }, 404);
  let { clip } = found;
  const { source } = found;
  if (clip.status === "rejected") return c.json({ error: "invalid_request", detail: "restore the clip first" }, 409);
  if (!source.transcript || !source.width || !source.height) {
    return c.json({ error: "not_ready", detail: "the video is still being prepared" }, 409);
  }
  if (!clip.layout) clip = await analyzeClip(c.env, clip, source);

  const window = { start: clip.start_s, end: clip.end_s };
  const edl = buildClipEdl({
    mediaId: source.media_id,
    ...window,
    sourceWidth: source.width,
    sourceHeight: source.height,
    segments: JSON.parse(clip.layout!) as LayoutSegment[],
    captions: clip.captions ? captionChunks(parseVtt(source.transcript), window) : null,
    title: clip.show_title ? clip.title : null,
  });

  await setClip(clip.id, { status: "rendering", error: null });
  try {
    const out = await renderEdit(services(c.env), edl, `${slug(clip.title)}.mp4`);
    // The service's link expires; the clip should not.
    const res = await fetch(out.url);
    if (!res.ok || !res.body) throw new Error(`could not fetch the rendered clip (${res.status})`);
    const size = Number(res.headers.get("content-length") ?? out.size);
    const key = `clips/${clip.id}-${Date.now()}.mp4`;
    const fixed = new FixedLengthStream(size);
    const pipe = res.body.pipeTo(fixed.writable);
    await c.env.UPLOADS.put(key, fixed.readable, { httpMetadata: { contentType: "video/mp4" } });
    await pipe;
    if (clip.output_key) await c.env.UPLOADS.delete(clip.output_key);
    const done = await setClip(clip.id, {
      status: "rendered",
      output_key: key,
      output_size: size,
      rendered_at: new Date().toISOString(),
    });
    return c.json(publicClip(done));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await setClip(clip.id, { status: "failed", error: detail.slice(0, 500) });
    throw err;
  }
});

// The rendered MP4 — inline for the player (range-capable), or ?download=1.
app.get("/api/clips/:id/file", async (c) => {
  const clip = await get<Clip>("SELECT * FROM clips WHERE id = ?", [c.req.param("id")]);
  if (!clip?.output_key) return c.json({ error: "not_found" }, 404);
  const range = c.req.header("Range");
  const m = range?.match(/^bytes=(\d+)-(\d*)$/);
  const obj = m
    ? await c.env.UPLOADS.get(clip.output_key, {
        range: { offset: Number(m[1]), ...(m[2] ? { length: Number(m[2]) - Number(m[1]) + 1 } : {}) },
      })
    : await c.env.UPLOADS.get(clip.output_key);
  if (!obj) return c.json({ error: "not_found" }, 404);
  const headers = new Headers({ "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" });
  if (c.req.query("download")) headers.set("Content-Disposition", `attachment; filename="${slug(clip.title)}.mp4"`);
  if (m && "range" in obj && obj.range && "offset" in obj.range) {
    const offset = obj.range.offset ?? 0;
    const length = obj.range.length ?? obj.size - offset;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set("Content-Length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  return new Response(obj.body, { headers });
});

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "clip";
}

export default app;
