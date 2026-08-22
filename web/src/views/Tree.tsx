import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronRight, CircleDot, Circle, FileDiff, FolderPlus, ListTodo, Plus, Search, Terminal, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { usePoll, type Project, type Win, type Worktree } from "@/lib/api";
import { Disconnected } from "@/components/Disconnected";
import { ago, cn } from "@/lib/utils";
import { SessionRows } from "@/components/Skeleton";

function WindowRow({ w, onOpen }: { w: Win; onOpen: (w: Win) => void }) {
  const attention = Boolean(w.ask);
  const live = Boolean(w.sessionId);
  const Icon = attention ? TriangleAlert : !live ? Terminal : w.status === "busy" ? CircleDot : Circle;

  return (
    <button
      onClick={() => onOpen(w)}
      // Shell windows have no Claude session but still have a terminal.
      className={cn(
        "flex w-full min-w-0 cursor-pointer items-center gap-3 py-2.5 pl-10 pr-4 min-h-11 text-left transition-colors duration-200 hover:bg-surface",
        !live && "opacity-60",
      )}
    >
      <Icon
        className={cn(
          "size-4 shrink-0",
          attention ? "text-warning" : w.status === "busy" ? "animate-pulse text-success" : "text-muted",
        )}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[13px]">{w.title}</span>
        {attention && <span className="block truncate text-xs text-warning">{w.ask!.message}</span>}
      </span>
      <span className="shrink-0 text-xs tabular-nums text-muted">{live ? ago(w.updatedAt) : "shell"}</span>
    </button>
  );
}

function WorktreeNode({
  wt, onOpen, onNewWindow, onWork,
}: { wt: Worktree; onOpen: (w: Win) => void; onNewWindow: (wt: Worktree) => void; onWork: (wt: Worktree) => void }) {
  const live = wt.windows.filter((w) => w.sessionId).length;
  const [open, setOpen] = useState(wt.attention > 0 || live > 0);

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <div className="flex min-w-0 items-center">
        <Collapsible.Trigger className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 py-2 pl-6 pr-2 text-left transition-colors duration-200 hover:bg-surface">
          <ChevronRight className={cn("size-4 shrink-0 text-muted transition-transform duration-200", open && "rotate-90")} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{wt.path.split("/").pop()}</span>
            <span className="block truncate font-mono text-xs text-muted">
              {wt.branch ?? "no branch"}{wt.dirty ? " · dirty" : ""}
            </span>
          </span>
          {!open && live > 0 && <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-xs text-muted">{live}</span>}
          {wt.attention > 0 && <span className="size-2 shrink-0 rounded-full bg-warning" aria-label="needs attention" />}
        </Collapsible.Trigger>
        {/* Diff, runs and git belong to the worktree, not to any one session —
            and have to work when every session in it is busy or dead. */}
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Changes in ${wt.path.split("/").pop()}`}
          onClick={() => onWork(wt)}
        >
          <FileDiff className={cn("size-4", wt.dirty && "text-warning")} aria-hidden />
        </Button>
        <Button variant="ghost" size="icon" aria-label={`New window in ${wt.path.split("/").pop()}`} onClick={() => onNewWindow(wt)}>
          <Plus className="size-4" aria-hidden />
        </Button>
      </div>
      <Collapsible.Content>
        {wt.windows.map((w) => <WindowRow key={w.surfaceId} w={w} onOpen={onOpen} />)}
        {wt.windows.length === 0 && <p className="py-2 pl-10 text-xs text-muted">no windows open</p>}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

type Flat = { w: Win; project: string; worktree: string; branch: string | null };

/** Every live window, flattened out of the project tree. */
function flatten(projects: Project[]): Flat[] {
  const out: Flat[] = [];
  for (const p of projects)
    for (const wt of p.worktrees)
      for (const w of wt.windows)
        if (w.sessionId) out.push({ w, project: p.name, worktree: wt.path.split("/").pop() ?? "", branch: wt.branch });
  return out;
}

function FlatRow({ row, onOpen }: { row: Flat; onOpen: (w: Win) => void }) {
  const attention = Boolean(row.w.ask);
  const Icon = attention ? TriangleAlert : row.w.status === "busy" ? CircleDot : Circle;
  return (
    <button
      onClick={() => onOpen(row.w)}
      className="flex w-full min-w-0 cursor-pointer items-center gap-3 border-b border-line px-4 py-2.5 min-h-11
                 text-left transition-colors duration-200 hover:bg-surface
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
    >
      <Icon
        className={cn("size-4 shrink-0", attention ? "text-warning" : row.w.status === "busy" ? "animate-pulse text-success" : "text-faint")}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[13px]">{row.w.title}</span>
        <span className="block truncate text-xs text-muted">
          {[row.project, row.branch].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span
        className={cn("shrink-0 text-xs tabular-nums", row.w.stuck ? "text-warning" : "text-faint")}
        title={row.w.stuck ? "busy, but nothing written for this long" : undefined}
      >
        {row.w.stuck ? `quiet ${ago(row.w.updatedAt)}` : ago(row.w.updatedAt)}
      </span>
    </button>
  );
}

function Section({ title, rows, onOpen }: { title: string; rows: Flat[]; onOpen: (w: Win) => void }) {
  if (!rows.length) return null;
  return (
    <>
      <h2 className="border-b border-line bg-surface/40 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">
        {title} <span className="tabular-nums">{rows.length}</span>
      </h2>
      {rows.map((r) => <FlatRow key={r.w.surfaceId} row={r} onOpen={onOpen} />)}
    </>
  );
}

export function Tree({
  onOpen, onNewWindow, onBrowse, onWork, onTodo,
}: {
  onOpen: (w: Win) => void;
  onNewWindow: (wt: Worktree) => void;
  onBrowse: () => void;
  onWork: (wt: Worktree) => void;
  onTodo: () => void;
}) {
  const { data, error } = usePoll<{ projects: Project[]; live: number }>("/api/tree", 3000);
  const [q, setQ] = useState("");

  const flat = useMemo(() => flatten(data?.projects ?? []), [data]);
  const query = q.trim().toLowerCase();
  const matches = (r: Flat) =>
    !query ||
    [r.w.title, r.project, r.worktree, r.branch].some((v) => (v ?? "").toLowerCase().includes(query));

  const hits = flat.filter(matches);
  const needsYou = hits.filter((r) => r.w.ask);
  // Quiet-but-busy first: "busy" alone never tells you where something wedged.
  const working = hits
    .filter((r) => !r.w.ask && r.w.status === "busy")
    .sort((a, b) => (b.w.stuck ?? 0) - (a.w.stuck ?? 0));
  const recent = hits
    .filter((r) => !r.w.ask && r.w.status !== "busy")
    .sort((a, b) => b.w.updatedAt - a.w.updatedAt)
    .slice(0, 5);

  // Never loaded and erroring means the server is unreachable, not slow.
  if (error && !data) return <Disconnected detail={error} />;
  if (!data) return <SessionRows n={7} />;

  return (
    <>
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-bg px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <h1 className="flex-1 text-lg font-semibold">Supacode</h1>
        <span className="text-xs tabular-nums text-muted">{data.live} live</span>
        <Button variant="ghost" size="icon" aria-label="Backlog" onClick={onTodo}>
          <ListTodo className="size-5" aria-hidden />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Add project from disk" onClick={onBrowse}>
          <FolderPlus className="size-5" aria-hidden />
        </Button>
      </header>

      {error && (
        <p role="status" className="border-b border-line bg-warning/10 px-4 py-1.5 text-xs text-warning">
          Reconnecting — showing the last known state.
        </p>
      )}

      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <Search className="size-4 shrink-0 text-faint" aria-hidden />
        <label htmlFor="session-search" className="sr-only">Search sessions</label>
        <input
          id="session-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search sessions, projects, branches…"
          className="min-w-0 flex-1 bg-transparent py-1 text-sm placeholder:text-faint focus-visible:outline-none"
        />
        {q && (
          <button onClick={() => setQ("")} aria-label="Clear search" className="cursor-pointer p-1 text-faint hover:text-fg">
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>

      {/* The point of this screen: what needs me, and what is running. */}
      <Section title="Needs you" rows={needsYou} onOpen={onOpen} />
      <Section title="Working" rows={working} onOpen={onOpen} />
      <Section title="Recent" rows={recent} onOpen={onOpen} />

      {query && hits.length === 0 && (
        <p className="px-4 py-8 text-center text-sm text-muted">No sessions match “{q}”.</p>
      )}

      {!query && (
        <>
          <h2 className="border-b border-line bg-surface/40 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">
            All projects <span className="tabular-nums">{data.projects.length}</span>
          </h2>
          {data.projects.map((p) => <ProjectNode key={p.name} p={p} onOpen={onOpen} onNewWindow={onNewWindow} onWork={onWork} />)}
        </>
      )}
    </>
  );
}

function ProjectNode({
  p, onOpen, onNewWindow, onWork,
}: { p: Project; onOpen: (w: Win) => void; onNewWindow: (wt: Worktree) => void; onWork: (wt: Worktree) => void }) {
  // Collapsed unless something in it is running or waiting on you.
  // Collapsed by default: live work is surfaced by the sections above, so the
  // tree is for browsing, not for hunting.
  const [open, setOpen] = useState(false);

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="border-b border-line">
      <Collapsible.Trigger className="flex min-h-11 w-full min-w-0 cursor-pointer items-center gap-2 px-4 py-3 text-left transition-colors duration-200 hover:bg-surface">
        <ChevronRight className={cn("size-4 shrink-0 text-muted transition-transform duration-200", open && "rotate-90")} aria-hidden />
        <span className="flex-1 truncate font-semibold">{p.name}</span>
        {p.live > 0 && <span className="rounded-full bg-surface px-2 py-0.5 text-xs tabular-nums text-muted">{p.live}</span>}
        {p.attention > 0 && <span className="size-2 rounded-full bg-warning" aria-label="needs attention" />}
      </Collapsible.Trigger>
      <Collapsible.Content className="pb-1">
        {p.worktrees.map((wt) => <WorktreeNode key={wt.id} wt={wt} onOpen={onOpen} onNewWindow={onNewWindow} onWork={onWork} />)}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
