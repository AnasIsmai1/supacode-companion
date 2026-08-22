import { ChevronLeft, Circle, CircleDot, Paperclip, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Disconnected } from "@/components/Disconnected";
import { get, post, usePoll, type Project, type Win } from "@/lib/api";
import { ago, cn } from "@/lib/utils";
import { SessionRows } from "@/components/Skeleton";

/**
 * Where the Android share sheet lands.
 *
 * The server has always accepted /share-target, stashed the files and redirected
 * here — but this route did not exist, so the redirect fell through to the tree
 * and the stash expired unused ten minutes later. The whole feature was one
 * screen short.
 */

type Stash = { text: string; files: { name: string; size: number }[] };

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export function Share({ id, onOpen, onBack }: {
  id: string;
  onOpen: (sessionId: string) => void;
  onBack: () => void;
}) {
  const [stash, setStash] = useState<Stash | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const { data: tree } = usePoll<{ projects: Project[] }>("/api/tree", 10_000);

  useEffect(() => {
    get<Stash>(`/api/share/${id}`)
      .then(setStash)
      .catch((e) => setError((e as Error).message));
  }, [id]);

  const live: { w: Win; where: string }[] = [];
  for (const p of tree?.projects ?? []) {
    for (const wt of p.worktrees) {
      for (const w of wt.windows) {
        if (w.sessionId) live.push({ w, where: `${p.name} · ${wt.branch ?? ""}` });
      }
    }
  }
  live.sort((a, b) => b.w.updatedAt - a.w.updatedAt);

  const send = async (sessionId: string) => {
    setSaving(sessionId);
    setError(null);
    try {
      const r = await post<{ saved: { rel: string }[]; text: string }>(`/api/share/${id}`, { sessionId });
      // Hand off to the chat with the paths already written, the way an upload
      // from inside the composer does.
      const refs = r.saved.map((f) => `@${f.rel}`).join(" ");
      sessionStorage.setItem(`share:${sessionId}`, [refs, r.text].filter(Boolean).join(" ").trim());
      onOpen(sessionId);
    } catch (e) {
      setError((e as Error).message);
      setSaving(null);
    }
  };

  if (error && !stash) return <Disconnected detail={error} />;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <header className="shrink-0 flex items-center gap-1 border-b border-line bg-bg px-2 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <button
          onClick={onBack}
          aria-label="Back"
          className="cursor-pointer rounded-lg p-2 text-muted transition-colors duration-200 hover:bg-surface hover:text-fg
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ChevronLeft className="size-5" aria-hidden />
        </button>
        <h1 className="flex-1 text-sm font-semibold">Send to a session</h1>
      </header>

      {stash && (
        <section className="border-b border-line bg-surface/40 px-4 py-3">
          {stash.files.map((f) => (
            <p key={f.name} className="flex min-w-0 items-center gap-2 py-0.5 text-[13px]">
              <Paperclip className="size-3.5 shrink-0 text-faint" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-mono">{f.name}</span>
              <span className="shrink-0 text-xs tabular-nums text-faint">{kb(f.size)}</span>
            </p>
          ))}
          {stash.text && <p className="mt-1 break-words text-[13px] text-muted">{stash.text}</p>}
          {!stash.files.length && !stash.text && (
            <p className="text-sm text-muted">Nothing was shared.</p>
          )}
        </section>
      )}

      {error && <p role="alert" className="bg-error/10 px-4 py-2 text-sm text-error">{error}</p>}

      <main className="flex-1 overflow-y-auto overflow-x-hidden">
        {!tree ? (
          <SessionRows n={5} />
        ) : !live.length ? (
          <p className="p-8 text-center text-sm text-muted">No live sessions to send to.</p>
        ) : (
          live.map(({ w, where }) => {
            const Icon = w.ask ? TriangleAlert : w.status === "busy" ? CircleDot : Circle;
            return (
              <button
                key={w.surfaceId}
                onClick={() => send(w.sessionId!)}
                disabled={saving !== null}
                className="flex min-h-11 w-full min-w-0 cursor-pointer items-center gap-3 border-b border-line px-4 py-2.5
                           text-left transition-colors duration-200 hover:bg-surface disabled:opacity-50
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
              >
                <Icon
                  className={cn("size-4 shrink-0", w.ask ? "text-warning" : w.status === "busy" ? "text-success" : "text-faint")}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[13px]">{w.title}</span>
                  <span className="block truncate text-xs text-muted">{where}</span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-faint">
                  {saving === w.sessionId ? "saving…" : ago(w.updatedAt)}
                </span>
              </button>
            );
          })
        )}
      </main>
    </div>
  );
}
