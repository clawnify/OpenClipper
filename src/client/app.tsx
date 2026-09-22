import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Scissors } from "lucide-react";
import { AppNav, embedded, reportLocation } from "@clawnify/app/client";
import { SourcesHome } from "./sources";
import { SourcePage } from "./source";
import { api, type Source } from "./api";
import { btnGhost } from "./ui";

// Minimal history router: `/` = your videos, `/videos/<id>` = one video's clips.
function useRouter() {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    if (to === window.location.pathname) return;
    window.history.pushState(null, "", to);
    setPath(to);
  }, []);
  return { path, navigate };
}

/** Inside the Clawnify dashboard, videos are listed in the dashboard sidebar. */
function HostNav({ active, path, navigate }: { active: string; path: string; navigate: (to: string) => void }) {
  const [sources, setSources] = useState<Source[]>([]);
  useEffect(() => {
    api.get<Source[]>("/api/sources").then(setSources).catch(() => {});
    reportLocation(window.location.pathname + window.location.search);
  }, [path]);
  return (
    <AppNav
      title="Clipper"
      icon="scissors"
      active={active || "home"}
      groups={[
        { items: [{ id: "home", label: "Videos", icon: "video", href: "/", home: true }] },
        {
          label: "Videos",
          items: sources.map((s) => ({ id: `videos/${s.id}`, label: s.name, icon: "camera", href: `/videos/${s.id}` })),
        },
      ]}
      onNavigate={(item) => item.href && navigate(item.href)}
    />
  );
}

export function App() {
  const { path, navigate } = useRouter();
  const id = decodeURIComponent(path.replace(/^\/+|\/+$/g, ""));
  const sourceId = id.startsWith("videos/") ? id.slice(7) : null;

  return (
    <div className="h-dvh flex flex-col text-foreground">
      {embedded && <HostNav active={id} path={path} navigate={navigate} />}
      {!embedded && (
        <header className="flex items-center gap-2 px-5 h-14 border-b border-border bg-surface shrink-0">
          {sourceId && (
            <button onClick={() => navigate("/")} className={`${btnGhost} -ml-2`}>
              <ArrowLeft className="w-4 h-4" /> Videos
            </button>
          )}
          <span className="grid place-items-center w-7 h-7 rounded-sm bg-accent text-on-accent shrink-0">
            <Scissors className="w-4 h-4" />
          </span>
          <span className="text-heading-3">OpenClipper</span>
          <span className="text-fine text-faint hidden sm:inline">long videos in, vertical clips out</span>
        </header>
      )}
      {sourceId ? <SourcePage id={sourceId} navigate={navigate} /> : <SourcesHome navigate={navigate} />}
    </div>
  );
}
