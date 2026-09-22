// The platform's managed services (services.clawnify.com), called with the
// org token Clawnify injects into every deployed app:
//   /media      — long source videos on Cloudflare Stream (any size ≤ 30 GB),
//                 their transcript, frames and playback
//   /video/edit — renders one clip's edit document to MP4, reading only the
//                 clip's seconds out of the source
//   /video/analyze — watches and listens to a video (or a stretch of it) and
//                 answers a prompt, as JSON when given a schema

const DEFAULT_SERVICES_URL = "https://services.clawnify.com";

export interface ServicesConfig {
  token: string;
  url?: string;
}

export class ServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function call<T>(cfg: ServicesConfig, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${cfg.url || DEFAULT_SERVICES_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const raw = await res.text();
  let json: (T & { error?: string; detail?: string }) | null = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    /* plain text */
  }
  if (!res.ok) {
    throw new ServiceError(
      json?.error ?? "service_error",
      json?.detail ?? (raw.trim().slice(0, 300) || `service returned ${res.status}`),
      res.status,
    );
  }
  return (json ?? (raw as unknown)) as T;
}

export interface MediaStatus {
  id: string;
  state: string;
  progress: number | null;
  error: string | null;
  ready: boolean;
  duration: number | null;
  width: number | null;
  height: number | null;
  download?: { status: string; percent: number } | null;
  captions?: { language: string; status: string }[];
  /** Whether /video/analyze can read this video yet. */
  analysis?: "none" | "preparing" | "ready" | "failed";
  /** Set by prepare for a video with no audio track: it gets no captions. */
  no_audio?: boolean;
}

export const media = {
  upload: (cfg: ServicesConfig, size: number, name: string) =>
    call<{ id: string; upload_url: string }>(cfg, "/media/uploads", {
      method: "POST",
      body: JSON.stringify({ size, name }),
    }),
  import: (cfg: ServicesConfig, url: string, name: string) =>
    call<MediaStatus>(cfg, "/media/import", { method: "POST", body: JSON.stringify({ url, name }) }),
  get: (cfg: ServicesConfig, id: string) => call<MediaStatus>(cfg, `/media/${id}`),
  prepare: (cfg: ServicesConfig, id: string, language: string) =>
    call<MediaStatus>(cfg, `/media/${id}/prepare`, { method: "POST", body: JSON.stringify({ captions: language }) }),
  captions: (cfg: ServicesConfig, id: string, language: string) =>
    call<string>(cfg, `/media/${id}/captions/${language}`),
  playback: (cfg: ServicesConfig, id: string) =>
    call<{ hls: string; thumbnail: string; download: string }>(cfg, `/media/${id}/playback`, { method: "POST" }),
  remove: (cfg: ServicesConfig, id: string) => call<null>(cfg, `/media/${id}`, { method: "DELETE" }),
};

/**
 * Start a render on the platform and return at once. The render runs in the
 * workspace's render container and outlives this request; its result is read
 * with renderStatus. Renders queue there one at a time.
 */
export function startRender(cfg: ServicesConfig, edl: unknown, filename: string) {
  return call<{ job_id: string; status: string }>(cfg, "/video/edit", {
    method: "POST",
    body: JSON.stringify({ edl, quality: "standard", filename, async: true }),
  });
}

export interface RenderStatus {
  status: "queued" | "running" | "done" | "failed";
  url?: string;
  size?: number;
  detail?: string;
}

export function renderStatus(cfg: ServicesConfig, jobId: string) {
  return call<RenderStatus>(cfg, `/video/edit/${jobId}`);
}

export interface AnalysisStatus {
  status: "queued" | "running" | "done" | "failed";
  result?: unknown;
  detail?: string;
}

/**
 * Ask the platform about a video — the whole of it, or `window` seconds of it.
 * Answers come back as a job: watching a long video takes minutes.
 */
export const analysis = {
  start: (
    cfg: ServicesConfig,
    body: {
      mediaId: string;
      prompt: string;
      schema: Record<string, unknown>;
      thinking: "low" | "medium" | "high";
      max_output_tokens: number;
      window?: { start: number; end: number };
    },
  ) =>
    call<{ job_id: string; status: string }>(cfg, "/video/analyze", {
      method: "POST",
      body: JSON.stringify({
        source: `media:${body.mediaId}`,
        prompt: body.prompt,
        schema: body.schema,
        thinking: body.thinking,
        max_output_tokens: body.max_output_tokens,
        window: body.window,
      }),
    }),
  status: (cfg: ServicesConfig, jobId: string) => call<AnalysisStatus>(cfg, `/video/analyze/${jobId}`),
};
