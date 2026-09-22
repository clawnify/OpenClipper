// Google Drive links that anyone can open — the common case when a client
// sends footage: they share a folder or a file "with the link" instead of
// connecting an account. Nothing here is authenticated, because those URLs
// aren't: Drive serves both the folder's listing and the file's bytes to any
// caller, and the bytes come with range support, which is what the media
// service needs to pull a multi-gigabyte file itself.
//
// Pure string/HTML work; unit-tested in drive-link.test.ts.

export type DriveLink = { kind: "file" | "folder"; id: string };

const ID = "[A-Za-z0-9_-]{10,200}";
const PATTERNS: [RegExp, DriveLink["kind"]][] = [
  [new RegExp(`/folders/(${ID})`), "folder"],
  [new RegExp(`/file/d/(${ID})`), "file"],
  [new RegExp(`[?&]id=(${ID})`), "file"],
  [new RegExp(`/d/(${ID})`), "file"],
];

/** A Drive URL → what it points at. Null for anything that isn't Drive. */
export function parseDriveLink(input: string): DriveLink | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (!/(^|\.)google\.com$/.test(url.hostname) && !/(^|\.)googleusercontent\.com$/.test(url.hostname)) return null;
  const path = url.pathname + url.search;
  for (const [re, kind] of PATTERNS) {
    const m = path.match(re);
    if (m) return { kind, id: m[1] };
  }
  return null;
}

/**
 * The URL that serves a public file's own bytes. `confirm=t` is what skips
 * the virus-scan interstitial Drive shows for large files — without it, a
 * big video downloads as a few KB of HTML.
 */
export function directDownloadUrl(fileId: string): string {
  return `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
}

export interface DriveFolderEntry {
  id: string;
  name: string;
}

/** Drive's embeddable folder view, which is public HTML for a public folder. */
export function folderListingUrl(folderId: string): string {
  return `https://drive.google.com/embeddedfolderview?id=${folderId}#list`;
}

const ENTRY = new RegExp(`id="entry-(${ID})"[\\s\\S]*?flip-entry-title">([^<]+)<`, "g");

export function parseFolderListing(html: string): DriveFolderEntry[] {
  const out: DriveFolderEntry[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(ENTRY)) {
    const [, id, rawName] = m;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: decodeEntities(rawName).trim() });
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mpg|mpeg|mxf|flv|3gp|ts)$/i;

export function isVideoName(name: string): boolean {
  return VIDEO_EXT.test(name);
}

export interface LinkCheck {
  ok: boolean;
  /** Why not, in words a person can act on. */
  reason?: string;
  contentType?: string;
  size?: number;
}

/**
 * Confirm a link really serves video bytes before handing it to the media
 * service, which fetches it out of our sight. Two failures look identical
 * from the outside and both arrive as a "video" otherwise: a Drive quota
 * page ("too many users have viewed this file") and a sharing-permission
 * page — both are HTML with a 200.
 */
export function judgeLinkResponse(status: number, contentType: string | null, contentRange: string | null, contentLength: string | null): LinkCheck {
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (status === 403 || status === 401) {
    return { ok: false, reason: "that link isn't public — set it to “Anyone with the link”, or upload the file instead" };
  }
  if (status === 404) return { ok: false, reason: "there's no file at that link any more" };
  if (status >= 400) return { ok: false, reason: `the link answered ${status}` };
  if (type.startsWith("text/") || type === "application/json") {
    return {
      ok: false,
      reason:
        "that link returned a web page instead of a video. Google does this when a file has been downloaded too many times today, or when it isn't shared publicly — try again later, or upload the file instead",
    };
  }
  if (type && !type.startsWith("video/") && type !== "application/octet-stream" && type !== "binary/octet-stream") {
    return { ok: false, reason: `that link serves ${type}, not a video` };
  }
  // "bytes 0-1/7498432963" → the real length, which a ranged reply's own
  // Content-Length (2) never is.
  const total = contentRange?.match(/\/(\d+)\s*$/)?.[1];
  const size = total ? Number(total) : contentLength ? Number(contentLength) : undefined;
  return { ok: true, contentType: type || undefined, size };
}
