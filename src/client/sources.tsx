import { useEffect, useRef, useState } from "react";
import { Upload as UploadIcon, Link2, Loader2, Plus, Scissors, Trash2, Film } from "lucide-react";
import * as tus from "tus-js-client";
import { api, bytes, clock, LANGUAGES, type Source } from "./api";
import { btnGhost, btnIcon, btnPrimary, ConfirmDialog, Dialog, EmptyState, Kbd } from "./ui";

const STATUS: Record<Source["status"], { label: string; tone: string }> = {
  uploading: { label: "Uploading", tone: "bg-info-tint text-info border-info/30" },
  processing: { label: "Processing", tone: "bg-info-tint text-info border-info/30" },
  preparing: { label: "Transcribing", tone: "bg-info-tint text-info border-info/30" },
  ready: { label: "Ready", tone: "bg-success-tint text-success border-success/30" },
  failed: { label: "Failed", tone: "bg-danger-tint text-danger border-danger/30" },
};

export function StatusBadge({ status }: { status: Source["status"] }) {
  const s = STATUS[status];
  return (
    <span className={`inline-flex items-center h-5 px-2 rounded-full border text-fine ${s.tone}`}>{s.label}</span>
  );
}

export function SourcesHome({ navigate }: { navigate: (to: string) => void }) {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDel, setConfirmDel] = useState<Source | null>(null);

  const load = () => api.get<Source[]>("/api/sources").then(setSources).catch(() => setSources([]));
  useEffect(() => {
    load();
  }, []);

  const remove = async (s: Source) => {
    setConfirmDel(null);
    await api.send("DELETE", `/api/sources/${s.id}`);
    setSources((cur) => cur?.filter((x) => x.id !== s.id) ?? null);
  };

  const addButton = (
    <button onClick={() => setAdding(true)} className={`${btnPrimary} shrink-0`}>
      <Plus className="w-4 h-4" /> Add video
    </button>
  );

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-heading-1">
              Videos
              {sources && sources.length > 0 && (
                <span className="ml-2 text-data text-muted tabular-nums">{sources.length}</span>
              )}
            </h1>
            <p className="text-body-sm text-muted mt-0.5">
              Add a long video — a podcast, tutorial or talk, hours long if you like — and OpenClipper finds the
              moments worth posting and cuts them into captioned vertical clips.
            </p>
          </div>
          {sources && sources.length > 0 && addButton}
        </div>

        {sources === null ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-12 rounded-sm bg-surface-sunken animate-pulse" />
            ))}
          </div>
        ) : sources.length === 0 ? (
          <EmptyState
            icon={<Scissors className="w-8 h-8" />}
            title="No videos yet"
            body="Upload a long video (up to 30 GB) or paste a link to one. You'll get clips back in a few minutes."
            action={addButton}
          />
        ) : (
          // The list sits on the page, rules reaching both edges — never in a card.
          <div className="-mx-6 overflow-x-auto">
            <table className="w-full text-body-sm">
              <thead>
                <tr className="border-y border-border bg-surface-sunken text-left text-label text-muted">
                  <th className="pl-6 pr-3 py-2 font-medium">Video</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium text-right">Length</th>
                  <th className="px-3 py-2 font-medium text-right">Clips</th>
                  <th className="pl-3 pr-6 py-2" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.id} className="border-b border-border hover:bg-surface-sunken">
                    <td className="pl-6 pr-3 py-2.5">
                      <button onClick={() => navigate(`/videos/${s.id}`)} className="flex items-center gap-2 text-left font-medium hover:underline">
                        <Film className="w-4 h-4 text-faint shrink-0" />
                        <span className="truncate max-w-md">{s.name}</span>
                      </button>
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted">{s.duration ? clock(s.duration) : "—"}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {s.clip_count ? (
                        <>
                          {s.rendered_count}
                          <span className="text-muted"> / {s.clip_count}</span>
                        </>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="pl-3 pr-6 py-2.5 text-right">
                      <button
                        onClick={() => setConfirmDel(s)}
                        className={`${btnIcon} hover:text-danger`}
                        aria-label={`Delete ${s.name}`}
                        title="Delete video"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {adding && <AddVideoDialog onClose={() => setAdding(false)} onAdded={(s) => navigate(`/videos/${s.id}`)} />}
        {confirmDel && (
          <ConfirmDialog
            title={`Delete “${confirmDel.name}”?`}
            body="The video and every clip cut from it are deleted. Downloaded clips on your computer are not affected."
            onConfirm={() => remove(confirmDel)}
            onClose={() => setConfirmDel(null)}
          />
        )}
      </div>
    </main>
  );
}

function AddVideoDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (s: Source) => void }) {
  const [mode, setMode] = useState<"file" | "link">("file");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [language, setLanguage] = useState("en");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const upload = useRef<tus.Upload | null>(null);
  const busy = progress !== null;

  useEffect(
    () => () => {
      upload.current?.abort().catch(() => {});
    },
    [],
  );

  const start = async () => {
    setError(null);
    try {
      if (mode === "link") {
        setProgress(0);
        const { source } = await api.send<{ source: Source }>("POST", "/api/sources/import", { url, name, language });
        onAdded(source);
        return;
      }
      if (!file) return;
      setProgress(0);
      const { source, upload_url } = await api.send<{ source: Source; upload_url: string }>("POST", "/api/sources/upload", {
        name: name.trim() || file.name.replace(/\.[^.]+$/, ""),
        size: file.size,
        language,
      });
      // Straight from this browser to the media service — resumable, so a
      // dropped connection picks up where it left off instead of restarting.
      await new Promise<void>((resolve, reject) => {
        upload.current = new tus.Upload(file, {
          uploadUrl: upload_url,
          chunkSize: 50 * 1024 * 1024,
          retryDelays: [0, 2000, 5000, 10000, 20000, 30000],
          onProgress: (sent, total) => setProgress(total ? sent / total : 0),
          onSuccess: () => resolve(),
          onError: (err) => reject(err),
        });
        upload.current.start();
      });
      onAdded(source);
    } catch (err) {
      setProgress(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const canStart = mode === "file" ? !!file : /^https:\/\/\S+$/.test(url.trim());

  return (
    <Dialog
      title="Add a video"
      icon={<Film className="w-4 h-4" />}
      description="Long is fine — up to 30 GB and 4 hours. The clips are cut on the server; your file never has to fit in the browser."
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button className={btnGhost} onClick={onClose} disabled={busy}>
            Cancel <Kbd>esc</Kbd>
          </button>
          <button className={btnPrimary} onClick={start} disabled={!canStart || busy} data-autofocus>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : mode === "file" ? <UploadIcon className="w-4 h-4" /> : <Link2 className="w-4 h-4" />}
            {busy && mode === "file" ? `Uploading ${Math.round((progress ?? 0) * 100)}%` : mode === "file" ? "Upload" : "Import"}
          </button>
        </>
      }
    >
      <div className="mt-4 space-y-4">
        {/* Segmented control: the active segment is raised, never filled. */}
        <div role="tablist" className="inline-flex p-0.5 rounded-sm bg-surface-sunken">
          {(["file", "link"] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              disabled={busy}
              onClick={() => setMode(m)}
              className={`h-7 px-3 rounded-xs text-label ${mode === m ? "bg-surface shadow-raised text-foreground" : "text-muted hover:text-foreground"}`}
            >
              {m === "file" ? "Upload a file" : "From a link"}
            </button>
          ))}
        </div>

        {mode === "file" ? (
          <label className="block">
            <span className="text-micro uppercase text-muted">Video file</span>
            <input
              type="file"
              accept="video/*,.mkv,.mxf"
              disabled={busy}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="mt-1 block w-full text-body-sm file:mr-3 file:h-7 file:px-2 file:rounded-sm file:border-0 file:bg-surface-sunken file:text-foreground"
            />
            {file && <span className="mt-1 block text-fine text-muted">{bytes(file.size)}</span>}
          </label>
        ) : (
          <label className="block">
            <span className="text-micro uppercase text-muted">Direct link to the video file</span>
            <input
              type="url"
              value={url}
              disabled={busy}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…/episode-12.mp4"
              className="mt-1 block w-full h-9 px-2.5 rounded-sm bg-surface shadow-edge text-body-sm"
            />
            <span className="mt-1 block text-fine text-muted">A link that downloads the file itself, not a page that plays it.</span>
          </label>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
          <label className="block">
            <span className="text-micro uppercase text-muted">Name</span>
            <input
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              placeholder={file?.name.replace(/\.[^.]+$/, "") ?? "Episode 12"}
              className="mt-1 block w-full h-9 px-2.5 rounded-sm bg-surface shadow-edge text-body-sm"
            />
          </label>
          <label className="block">
            <span className="text-micro uppercase text-muted">Spoken language</span>
            <select
              value={language}
              disabled={busy}
              onChange={(e) => setLanguage(e.target.value)}
              className="mt-1 block h-9 px-2 rounded-sm bg-surface shadow-edge text-body-sm"
            >
              {LANGUAGES.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {busy && mode === "file" && (
          <div className="h-1.5 rounded-full bg-surface-sunken overflow-hidden" aria-hidden>
            <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
          </div>
        )}
        {busy && mode === "file" && (
          <p className="text-fine text-muted">Keep this tab open until the upload finishes. Processing continues after you leave.</p>
        )}
        {error && <p className="text-body-sm text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
