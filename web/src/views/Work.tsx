import { PatchDiff } from "@pierre/diffs/react";
import { ChevronDown, ChevronLeft, FileDiff, FilePlus, FileMinus, FileX, GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import { get, usePoll, type DiffFile, type SessionDiff } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Actions } from "@/views/work/Actions";
import { Runs } from "@/views/work/Runs";

/**
 * Everything a worktree has to say, independent of any Claude session.
 *
 * The session views (/s, /t) key on a session or a surface. Diff, runs and git
 * all belong to the WORKTREE, and they have to work when the session is busy,
 * modal, or dead — which is exactly when you want them.
 */

const ICON = {
  added: FilePlus,
  untracked: FilePlus,
  deleted: FileMinus,
  renamed: FileX,
  modified: FileDiff,
} as const;

/** One changed file: a row that expands into its patch, fetched on demand. */
function FileRow({ wt, file }: { wt: string; file: DiffFile }) {
  const [open, setOpen] = useState(false);
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const Icon = ICON[file.status];

  useEffect(() => {
    // Only the expanded file's patch is fetched — a 300-file change must not
    // parse 300 patches to paint a list.
    if (!open || patch || file.binary) return;
    let alive = true;
    get<{ patch: string }>(`/api/diff/file?wt=${encodeURIComponent(wt)}&path=${encodeURIComponent(file.path)}`)
      .then((d) => alive && setPatch(d.patch))
      .catch((e) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [open, patch, wt, file.path, file.binary]);

  return (
    <li className="border-b border-line">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex min-h-11 w-full min-w-0 cursor-pointer items-center gap-2 px-4 py-2.5 text-left
                   transition-colors duration-200 hover:bg-surface
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
      >
        <ChevronDown className={cn("size-3 shrink-0 text-faint transition-transform duration-200", !open && "-rotate-90")} aria-hidden />
        <Icon className="size-3.5 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1">
          {/* The basename is what you scan for; the directory is context. */}
          <span className="block truncate font-mono text-[13px]" dir="rtl">{file.path}</span>
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          {file.additions > 0 && <span className="text-success">+{file.additions}</span>}
          {file.additions > 0 && file.deletions > 0 && " "}
          {file.deletions > 0 && <span className="text-error">−{file.deletions}</span>}
          {file.binary && <span className="text-faint">bin</span>}
        </span>
      </button>

      {open && (
        <div className="overflow-x-auto border-t border-line bg-bg">
          {file.binary ? (
            <p className="px-4 py-3 text-xs text-muted">Binary file — nothing to show.</p>
          ) : error ? (
            <p className="px-4 py-3 text-xs text-error">{error}</p>
          ) : patch ? (
            <PatchDiff patch={patch} options={{ diffStyle: "unified" }} />
          ) : (
            <p className="px-4 py-3 text-xs text-muted">Loading…</p>
          )}
          {file.truncated && (
            <p className="px-4 py-2 text-[11px] text-warning">Truncated — this file is too large to show in full.</p>
          )}
        </div>
      )}
    </li>
  );
}

function Changes({ wt }: { wt: string }) {
  const { data, error } = usePoll<SessionDiff>(`/api/diff?wt=${encodeURIComponent(wt)}`, 8000);

  if (error && !data) return <p className="p-4 text-sm text-error">{error}</p>;
  if (!data) return <p className="p-4 text-sm text-muted">Loading…</p>;
  if (!data.ok) return <p className="p-4 text-sm text-error">{data.error ?? "could not read this worktree"}</p>;
  if (!data.files.length) return <p className="p-8 text-center text-sm text-muted">No changes on this branch.</p>;

  return (
    <>
      {data.baseWarning && (
        <p role="status" className="border-b border-line bg-warning/10 px-4 py-1.5 text-xs text-warning">
          {data.baseWarning}
        </p>
      )}
      <ul>
        {data.files.map((f) => <FileRow key={f.path} wt={wt} file={f} />)}
      </ul>
      {data.truncated && (
        <p className="px-4 py-3 text-xs text-warning">
          Only the first {data.files.length} files are shown.
        </p>
      )}
    </>
  );
}

type Tab = "changes" | "run" | "actions";

const TABS: { id: Tab; label: string }[] = [
  { id: "changes", label: "Changes" },
  { id: "run", label: "Run" },
  { id: "actions", label: "Actions" },
];

export function Work({ wt, onBack }: { wt: string; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>("changes");
  // Counts come from the cheap endpoint so the header paints before the file
  // list, and keeps updating while you sit on the Run tab.
  const { data: stat } = usePoll<{ files: number; additions: number; deletions: number }>(
    `/api/diff/stat?wt=${encodeURIComponent(wt)}`, 8000,
  );
  const { data: diff } = usePoll<SessionDiff>(`/api/diff?wt=${encodeURIComponent(wt)}`, 30_000);
  const name = decodeURIComponent(wt).replace(/\/+$/, "").split("/").pop();

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-1 border-b border-line bg-bg px-2 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <button
          onClick={onBack}
          aria-label="Back"
          className="cursor-pointer rounded-lg p-2 text-muted transition-colors duration-200 hover:bg-surface hover:text-fg
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ChevronLeft className="size-5" aria-hidden />
        </button>
        <span className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{name}</h1>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
            <GitBranch className="size-3 shrink-0" aria-hidden />
            <span className="truncate font-mono">{diff?.branch ?? "…"}</span>
          </span>
        </span>
        {stat && stat.files > 0 && (
          <span className="shrink-0 font-mono text-[11px] tabular-nums">
            <span className="text-success">+{stat.additions}</span>{" "}
            <span className="text-error">−{stat.deletions}</span>
          </span>
        )}
      </header>

      <nav className="flex border-b border-line" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "min-h-11 flex-1 cursor-pointer border-b-2 px-3 py-2 text-sm transition-colors duration-200",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset",
              tab === t.id ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            {t.label}
            {t.id === "changes" && stat && stat.files > 0 && (
              <span className="ml-1.5 tabular-nums text-faint">{stat.files}</span>
            )}
          </button>
        ))}
      </nav>

      <main className="flex-1 overflow-y-auto">
        {tab === "changes" && <Changes wt={wt} />}
        {tab === "run" && <Runs wt={wt} />}
        {tab === "actions" && <Actions wt={wt} branch={diff?.branch ?? null} dirty={(stat?.files ?? 0) > 0} />}
      </main>
    </div>
  );
}
