import { ChevronLeft, ChevronRight, Folder, GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { get, post } from "@/lib/api";

type Entry = { name: string; path: string; git: boolean; registered: boolean };
type Dir = { path: string; parent: string | null; display: string; entries: Entry[] };

/** Pick a folder on the Mac and hand it to `supacode repo open`. */
export function Browse({ onDone }: { onDone: () => void }) {
  const [dir, setDir] = useState<Dir | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    get<Dir>(`/api/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`)
      .then((d) => alive && setDir(d))
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [path]);

  const open = async () => {
    if (!dir) return;
    setBusy(true);
    setError(null);
    try {
      await post("/api/repo-open", { path: dir.path });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 flex items-center gap-1 border-b border-line px-2 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <Button
          variant="ghost"
          size="icon"
          aria-label={dir?.parent ? "Up one folder" : "Back"}
          onClick={() => (dir?.parent ? setPath(dir.parent) : onDone())}
        >
          <ChevronLeft className="size-5" aria-hidden />
        </Button>
        <h1 className="min-w-0 flex-1 truncate font-mono text-sm">{dir?.display ?? "…"}</h1>
      </header>

      <main className="flex-1 overflow-y-auto">
        {error && <p role="alert" className="px-4 py-3 text-sm text-error">{error}</p>}
        {dir?.entries.map((e) => (
          <button
            key={e.path}
            onClick={() => setPath(e.path)}
            className="flex min-h-11 w-full cursor-pointer items-center gap-3 border-b border-line px-4 py-3
                       text-left transition-colors duration-200 hover:bg-surface"
          >
            <Folder className="size-4 shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-sm">{e.name}</span>
            {e.git && <GitBranch className="size-3.5 shrink-0 text-muted" aria-label="git repository" />}
            {e.registered && <span className="shrink-0 text-xs text-muted">open</span>}
            <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
          </button>
        ))}
        {dir && dir.entries.length === 0 && <p className="px-4 py-6 text-sm text-muted">No sub-folders here.</p>}
      </main>

      <footer className="border-t border-line px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <Button className="w-full" onClick={open} disabled={busy || !dir}>
          {busy ? "Opening…" : `Open “${dir?.path.split("/").pop() ?? ""}” as project`}
        </Button>
      </footer>
    </div>
  );
}
