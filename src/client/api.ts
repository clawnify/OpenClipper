// Typed fetch helpers and the shapes the server returns.

export interface Source {
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
  has_transcript: boolean;
  created_at: string;
  clip_count?: number;
  rendered_count?: number;
}

export interface LayoutSegment {
  from: number;
  to: number;
  layout: "speaker" | "screen";
  subject_x?: number;
}

export interface Clip {
  id: string;
  source_id: string;
  rank: number;
  title: string;
  hook: string;
  reason: string;
  start_s: number;
  end_s: number;
  layout: LayoutSegment[] | null;
  captions: boolean;
  show_title: boolean;
  status: "proposed" | "analysing" | "rendering" | "rendered" | "failed" | "rejected";
  error: string | null;
  file_url: string | null;
  output_size: number | null;
  /** SQLite UTC, "YYYY-MM-DD HH:MM:SS" — how a stalled render is spotted. */
  updated_at: string;
}

export interface Run {
  id: string;
  brief: string;
  max_clips: number;
  model: string;
  notes: string | null;
  created_at: string;
}

export class ApiError extends Error {}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 204) return null as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError((body as { detail?: string; error?: string })?.detail ?? (body as { error?: string })?.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  get: <T>(path: string) => fetch(path).then((r) => handle<T>(r)),
  send: <T>(method: string, path: string, body?: unknown) =>
    fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => handle<T>(r)),
};

/** 5415.3 → "1:30:15" ; 42.7 → "0:42" */
export function clock(s: number): string {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function bytes(n: number | null | undefined): string {
  if (!n) return "";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export const LANGUAGES: [string, string][] = [
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["pt", "Portuguese"],
  ["nl", "Dutch"],
  ["pl", "Polish"],
  ["cs", "Czech"],
  ["ru", "Russian"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
];
