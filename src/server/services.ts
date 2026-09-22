// The platform's managed services (services.clawnify.com), called with the
// org token Clawnify injects into every deployed app:
//   /media      — long source videos on Cloudflare Stream (any size ≤ 30 GB),
//                 their transcript, frames and playback
//   /video/edit — renders one clip's edit document to MP4, reading only the
//                 clip's seconds out of the source

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

export function renderEdit(cfg: ServicesConfig, edl: unknown, filename: string) {
  return call<{ url: string; duration: number; size: number }>(cfg, "/video/edit", {
    method: "POST",
    body: JSON.stringify({ edl, quality: "standard", filename }),
  });
}
