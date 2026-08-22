import { AlertCircle, ArrowUp, Bot, ChevronDown, Check, ChevronLeft, FileDiff, ListChecks, ListTodo, MessageSquare, MoreVertical, SquareTerminal, Trash2, Wifi, WifiOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Composer } from "@/components/Composer";
import { AgentStrip } from "@/views/chat/AgentStrip";
import { PromptCard } from "@/views/chat/PromptCard";
import { TaskStrip } from "@/views/chat/TaskStrip";
import { TurnView } from "@/views/chat/TurnView";
import { AsciiPreview } from "@/components/AsciiPreview";
import { Markdown } from "@/components/Markdown";
import { ModeSelect } from "@/components/ModeSelect";
import { StatusLine, type Live, type State } from "@/components/StatusLine";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { get, post, useTurns, type Agent, type Pending, type TaskList, type Turn, type Win } from "@/lib/api";
import { ago, cn } from "@/lib/utils";






/** How long an echo may keep saying "sending…" after the server confirmed it. */
const GRACE_MS = 8000;

/** Locally-echoed message, shown until the transcript catches up. */
type Echo = { id: number; text: string; failed: boolean; confirmed: boolean; queued?: boolean };

export function Chat({ sessionId, onBack, onTerminal, onWork, onTodo }: {
  sessionId: string;
  onBack: () => void;
  onTerminal: (surfaceId: string, title: string) => void;
  onWork: (worktreeId: string) => void;
  onTodo: () => void;
}) {
  const { turns, connected } = useTurns(sessionId);
  const [meta, setMeta] = useState<{
    session: (Win & { title?: string; worktree?: string; surfaceId?: string }) | null;
    state: State | null;
    agents: Agent[];
    pending: Pending;
    live: Live;
    tasks: TaskList | null;
  } | null>(null);
  const [text, setText] = useState("");
  const [echoes, setEchoes] = useState<Echo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [menu, setMenu] = useState(false);
  const [closing, setClosing] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // A share-sheet handoff leaves the file refs and text here; consume once.
  useEffect(() => {
    const handoff = sessionStorage.getItem(`share:${sessionId}`);
    if (!handoff) return;
    sessionStorage.removeItem(`share:${sessionId}`);
    setText((prev) => `${handoff} ${prev}`.trim());
  }, [sessionId]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const d = await get<any>(`/api/session/${sessionId}`);
        if (alive) setMeta({ session: d.session, state: d.state, agents: d.agents ?? [], pending: d.pending, live: d.live ?? null, tasks: d.tasks ?? null });
      } catch { /* header only */ }
    };
    tick();
    const t = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [sessionId]);

  /**
   * Retire an echo once the real turn shows up.
   *
   * Exact string equality was wrong: the transcript can store the message with
   * different whitespace, and any mismatch left the bubble reading "sending…"
   * forever on a message that had already landed. So match on a normalised
   * prefix, and give up on the comparison entirely once the send has been
   * confirmed by the server and a grace period has passed.
   */
  const live = useMemo(() => {
    const norm = (v: string) => v.trim().replace(/\s+/g, " ").slice(0, 60);
    const sent = new Set(turns.filter((t) => t.role === "user" && t.text).map((t) => norm(t.text)));
    const now = Date.now();
    return echoes.filter((e) => {
      if (e.failed) return true;                       // stays until the user sees it
      if (sent.has(norm(e.text))) return false;        // the real turn arrived
      return !(e.confirmed && now - e.id > GRACE_MS);  // server confirmed it; stop claiming otherwise
    });
  }, [turns, echoes]);

  useEffect(() => {
    if (live.length !== echoes.length) setEchoes(live);
  }, [live, echoes.length]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [turns.length, live.length, meta?.pending]);

  const send = () => {
    const body = text.trim();
    if (!body || sending) return; // explicit guard: a fast double-tap sent twice
    const id = Date.now();
    setText("");
    setSending(true);
    setEchoes((prev) => [...prev, { id, text: body, failed: false, confirmed: false }]);
    setError(null);
    post(`/api/send/${sessionId}`, { text: body })
      .then((r) => {
        // /api/send verifies the message actually left the input box, so an ok
        // here means it really landed — in the turn, or in Claude's queue.
        const queued = Boolean((r as { queued?: boolean })?.queued);
        setEchoes((prev) => prev.map((x) => (x.id === id ? { ...x, confirmed: true, queued } : x)));
      })
      .catch((e) => {
        // An echo that lied is worse than no echo — mark it, don't leave it looking sent.
        setEchoes((prev) => prev.map((x) => (x.id === id ? { ...x, failed: true } : x)));
        setError((e as Error).message);
      })
      .finally(() => setSending(false));
  };

  const attach = async (files: FileList | null) => {
    if (!files?.length) return;
    const fd = new FormData();
    for (const f of files) fd.append("file", f);
    try {
      const r = await fetch(`/api/upload/${sessionId}`, { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setText((prev) => `${d.saved.map((f: any) => `@${f.rel}`).join(" ")} ${prev}`.trim());
      setError(null);
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <header className="shrink-0 flex w-full min-w-0 items-center gap-0.5 overflow-hidden border-b border-line bg-bg px-1 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to sessions">
          <ChevronLeft className="size-5" aria-hidden />
        </Button>
        <span className="min-w-0 flex-1">
          <h1 className="truncate font-mono text-sm">{meta?.session?.title ?? "session"}</h1>
          {meta?.session?.worktree && (
            <span className="block truncate text-xs text-muted">{meta.session.worktree.split("/").pop()}</span>
          )}
        </span>
        <ModeSelect sessionId={sessionId} mode={meta?.state?.mode ?? null} onError={setError} />
        <span title={connected ? "Live" : "Reconnecting…"} className="px-1">
          {connected
            ? <Wifi className="size-4 text-success" aria-label="Live" />
            : <WifiOff className="size-4 animate-pulse text-warning" aria-label="Reconnecting" />}
        </span>
        <Button variant="ghost" size="icon" onClick={() => setMenu(true)} aria-label="Window actions">
          <MoreVertical className="size-5" aria-hidden />
        </Button>
      </header>

      {/* One menu on the view you are in, rather than a cross on every row. */}
      <Sheet open={menu} onOpenChange={setMenu} title={meta?.session?.title ?? "Window"}>
        <p className="mb-4 break-words font-mono text-xs text-muted">{meta?.session?.worktree}</p>

        <Button
          variant="outline"
          className="mb-2 w-full"
          disabled={!(meta?.session as any)?.worktreeId}
          onClick={() => {
            const id = (meta?.session as any)?.worktreeId;
            setMenu(false);
            if (id) onWork(id);
          }}
        >
          <FileDiff className="size-4" aria-hidden />
          Review changes
        </Button>

        <Button
          variant="outline"
          className="mb-2 w-full"
          disabled={!meta?.session?.surfaceId}
          onClick={() => {
            const id = meta?.session?.surfaceId;
            setMenu(false);
            if (id) onTerminal(id, meta?.session?.title ?? "terminal");
          }}
        >
          <SquareTerminal className="size-4" aria-hidden />
          Open terminal
        </Button>

        <Button variant="outline" className="mb-4 w-full" onClick={() => { setMenu(false); onTodo(); }}>
          <ListTodo className="size-4" aria-hidden />
          Backlog
        </Button>

        <Button
          variant="danger"
          className="w-full"
          disabled={closing || !(meta?.session as any)?.tabId}
          onClick={async () => {
            setClosing(true);
            try {
              await post("/api/window/close", {
                tab: (meta?.session as any)?.tabId,
                worktree: (meta?.session as any)?.worktreeId,
              });
              setMenu(false);
              onBack();
            } catch (e) { setError((e as Error).message); } finally { setClosing(false); }
          }}
        >
          <Trash2 className="size-4" aria-hidden />
          {closing ? "closing…" : "Close this window"}
        </Button>
        <p className="mt-3 text-xs text-muted">
          Quitting the shell inside a window leaves the tab open — this removes it from Supacode.
        </p>
      </Sheet>

      <StatusLine
        state={meta?.state ?? null}
        status={meta?.session?.status ?? null}
        waiting={Boolean(meta?.pending)}
        live={meta?.live ?? null}
        onInterrupt={() => post(`/api/interrupt/${sessionId}`).catch((e) => setError((e as Error).message))}
      />

      {meta?.tasks && <TaskStrip list={meta.tasks} />}

      <AgentStrip agents={meta?.agents ?? []} />

      {/* Claude Code queues a message typed while it works; these were invisible. */}
      {(meta?.state?.queued.length ?? 0) > 0 && (
        <ul className="border-b border-line bg-surface/40 px-4 py-2">
          <li className="mb-1 text-[11px] uppercase tracking-wider text-faint">
            queued <span className="tabular-nums">{meta!.state!.queued.length}</span>
          </li>
          {meta!.state!.queued.map((q, i) => (
            <li key={i} className="truncate py-0.5 text-[13px] text-muted">· {q}</li>
          ))}
        </ul>
      )}

      <main className="flex-1 overflow-y-auto overflow-x-hidden">
        {turns.map((t, i) => <TurnView key={t.uuid || i} t={t} />)}

        {live.map((e) => (
          <article key={e.id} className={cn("border-b border-line bg-surface/50 px-4 py-3", e.failed && "opacity-60")}>
            <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-accent">
              user
              {e.failed
                ? <span className="flex items-center gap-1 text-error"><AlertCircle className="size-3" aria-hidden /> not sent</span>
                : e.confirmed
                  ? <span className="text-faint">{e.queued ? "queued" : "sent"}</span>
                  : <span className="text-muted">sending…</span>}
            </p>
            <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">{e.text}</p>
          </article>
        ))}

        {meta?.pending && (
          <PromptCard
            pending={meta.pending}
            onAnswer={async (key, note) => {
              try {
                await post(`/api/answer/${sessionId}`, { key });
                // The note follows the selection so Claude reads choice then reasoning.
                if (note) await post(`/api/send/${sessionId}`, { text: note });
                setError(null);
              } catch (e) { setError((e as Error).message); }
            }}
            onHighlight={async (key) => {
              const r = await post<any>(`/api/highlight/${sessionId}`, { key });
              if (r?.pending) setMeta((m) => (m ? { ...m, pending: r.pending } : m));
            }}
            onReply={(text) => {
              const id = Date.now();
              setEchoes((prev) => [...prev, { id, text, failed: false, confirmed: false }]);
              // A live dialog is modal: plain text typed while it is open goes
              // nowhere, so route through its own "Chat about this" row.
              const live = meta.pending?.kind === "live-question" && meta.pending.canChat;
              const path = live ? `/api/chat-about/${sessionId}` : `/api/send/${sessionId}`;
              post(path, { text })
                .then(() => setEchoes((prev) => prev.map((x) => (x.id === id ? { ...x, confirmed: true } : x))))
                .catch((e) => {
                  setEchoes((prev) => prev.map((x) => (x.id === id ? { ...x, failed: true } : x)));
                  setError((e as Error).message);
                });
            }}
          />
        )}
        <div ref={endRef} />
      </main>

      {error && <p role="alert" className="bg-error/10 px-4 py-2 text-sm text-error">{error}</p>}

      <Composer
        value={text}
        onChange={setText}
        onSend={send}
        onAttach={attach}
        sessionId={sessionId}
        history={meta?.state?.prompts ?? []}
        disabled={sending}
      />
    </div>
  );
}
