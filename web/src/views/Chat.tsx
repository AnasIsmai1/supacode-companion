import { AlertCircle, ArrowUp, Bot, ChevronDown, Check, ChevronLeft, FileDiff, ListChecks, ListTodo, MessageSquare, MoreVertical, SquareTerminal, Trash2, Wifi, WifiOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Composer } from "@/components/Composer";
import { AsciiPreview } from "@/components/AsciiPreview";
import { Markdown } from "@/components/Markdown";
import { ModeSelect } from "@/components/ModeSelect";
import { StatusLine, type Live, type State } from "@/components/StatusLine";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { get, post, useTurns, type Agent, type Pending, type TaskList, type Turn, type Win } from "@/lib/api";
import { ago, cn } from "@/lib/utils";

/**
 * A question or permission prompt.
 *
 * Mirrors how you answer in Claude Code itself: pick an option, attach a note to
 * that option with `n`, or ignore the options entirely and reply in words. The
 * note is sent as a follow-up message rather than a keystroke annotation —
 * emulating the dialog's own key would be one more piece of TUI guesswork, and
 * Claude reads "2" then the reasoning just as well.
 *
 * Previews stay collapsed, one open at a time, in a fixed-height box, so option
 * positions never move while you compare them.
 */
function PromptCard({
  pending, onAnswer, onReply, onHighlight,
}: {
  pending: NonNullable<Pending>;
  onAnswer: (key: string, note?: string) => void;
  onReply: (text: string) => void;
  onHighlight?: (key: string) => Promise<void>;
}) {
  const [openPreview, setOpenPreview] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [reply, setReply] = useState("");
  const [loadingPreview, setLoadingPreview] = useState(false);

  const live = pending.kind === "live-question";
  const isQuestion = pending.kind === "question" || live;

  const title = live
    ? pending.question
    : pending.kind === "question"
      ? pending.questions[0]?.question
      : pending.title;

  const options = live
    ? pending.options.map((o) => ({
        key: o.key,
        label: o.label,
        description: undefined as string | undefined,
        // The screen only renders the highlighted option's box, so a preview is
        // only available for that one until we move the highlight.
        preview: o.key === pending.highlighted ? pending.preview ?? undefined : undefined,
        hidden: o.key === pending.highlighted ? pending.previewHidden ?? 0 : 0,
        canPreview: true,
      }))
    : pending.kind === "question"
      ? pending.questions[0]?.options.map((o, i) => ({
          key: String(i + 1), label: o.label, description: o.description, preview: o.preview, hidden: 0, canPreview: Boolean(o.preview),
        }))
      : pending.options.map((o) => ({
          key: o.key, label: o.label, description: undefined as string | undefined,
          preview: undefined as string | undefined, hidden: 0, canPreview: false,
        }));

  const showPreview = async (key: string) => {
    if (openPreview === key) return setOpenPreview(null);
    setOpenPreview(key);
    // For a live dialog, fetching another option's preview means moving the
    // highlight there first. Arrow keys only — this must never select anything.
    if (live && key !== pending.highlighted && onHighlight) {
      setLoadingPreview(true);
      try { await onHighlight(key); } finally { setLoadingPreview(false); }
    }
  };

  const submitNote = (key: string) => {
    onAnswer(key, note.trim() || undefined);
    setNote("");
    setNoteFor(null);
  };

  return (
    <section className="mx-4 my-3 rounded-xl border border-warning/40 bg-warning/5 p-4">
      <p className="mb-1 text-xs font-medium uppercase tracking-wider text-warning">
        {isQuestion ? "Claude is asking" : "Needs your approval"}
      </p>
      <p className="mb-3 text-sm">{title}</p>

      <div className="flex flex-col gap-2">
        {options?.map((o) => (
          <div key={o.key} className="overflow-hidden rounded-lg border border-line bg-surface">
            <div className="flex min-w-0 items-stretch">
              <button
                onClick={() => onAnswer(o.key)}
                title={`sends "${o.key}"`}
                className="flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 px-3 py-3 text-left
                           transition-colors duration-200 hover:bg-raised
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
              >
                <span className="text-sm font-medium">{o.label}</span>
                {o.description && (
                // Claude sometimes puts a diagram in the description rather than
                // the preview; as wrapped prose that renders as broken box glyphs.
                isArt(o.description)
                  ? <AsciiPreview text={o.description} className="mt-1 w-full font-mono text-muted" />
                  : <span className="text-xs text-muted">{o.description}</span>
              )}
              </button>
              <button
                onClick={() => { setNoteFor(noteFor === o.key ? null : o.key); setNote(""); }}
                aria-label={`Add a note to "${o.label}"`}
                aria-expanded={noteFor === o.key}
                className={cn(
                  "w-11 shrink-0 cursor-pointer border-l border-line font-mono text-xs transition-colors duration-200",
                  noteFor === o.key ? "bg-raised text-accent" : "text-faint hover:bg-raised hover:text-fg",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset",
                )}
              >
                n
              </button>
            </div>

            {noteFor === o.key && (
              <div className="border-t border-line bg-bg p-2">
                <label htmlFor={`note-${o.key}`} className="sr-only">Note for {o.label}</label>
                <textarea
                  id={`note-${o.key}`}
                  autoFocus
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitNote(o.key); } }}
                  placeholder="why this one, or what to change…"
                  className="w-full resize-none rounded border border-line bg-surface px-2 py-1.5 text-[13px]
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                />
                <div className="mt-1.5 flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setNoteFor(null)}>cancel</Button>
                  <Button size="sm" onClick={() => submitNote(o.key)}>pick with note</Button>
                </div>
              </div>
            )}

            {o.canPreview && (
              <>
                <button
                  onClick={() => showPreview(o.key)}
                  aria-expanded={openPreview === o.key}
                  className="flex w-full cursor-pointer items-center gap-1.5 border-t border-line px-3 py-2
                             text-[11px] text-faint transition-colors duration-200 hover:text-muted
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
                >
                  <ChevronDown className={cn("size-3 transition-transform duration-200", openPreview === o.key && "rotate-180")} aria-hidden />
                  {openPreview === o.key ? "hide preview" : "preview"}
                  {loadingPreview && openPreview === o.key && <span className="ml-1 text-faint">loading…</span>}
                </button>
                {openPreview === o.key && o.hidden > 0 && (
                  // Claude Code truncates a preview to fit the terminal height and
                  // does not render the rest anywhere, so there is nothing to scrape.
                  <p className="border-t border-line bg-bg px-3 py-2 text-[11px] text-warning">
                    {o.hidden} more lines — the terminal truncated this preview to fit.
                    A taller window on the Mac shows more.
                  </p>
                )}
                {openPreview === o.key && o.preview && (
                  // Scales to fit width so diagrams are never clipped; height is
                  // capped and scrolls, because vertical scrolling is natural and
                  // horizontal scrolling on a diagram is not.
                  <div className="max-h-72 overflow-y-auto overflow-x-hidden border-t border-line bg-bg px-3 py-2">
                    <AsciiPreview text={o.preview} className="font-mono text-muted" />
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      {/* The dialog lists "Chat about this" as its own row, so mirror it here as a
          real action rather than only a labelled text box. */}
      <div className="mt-3 border-t border-line pt-3">
        {isQuestion && (pending as any).canChat !== false && (
          <button
            onClick={() => document.getElementById("prompt-reply")?.focus()}
            className="mb-2 flex w-full min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-line
                       bg-surface px-3 py-2.5 text-left text-sm transition-colors duration-200 hover:bg-raised
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <MessageSquare className="size-4 shrink-0 text-faint" aria-hidden />
            <span className="font-medium">Chat about this</span>
            <span className="ml-auto text-xs text-faint">answer in words</span>
          </button>
        )}
        <label htmlFor="prompt-reply" className="mb-1.5 block text-[11px] uppercase tracking-wider text-faint">
          {pending.kind === "live-question" && !(pending as any).canChat
            ? "reply (this dialog has no chat option)"
            : "chat about this instead"}
        </label>
        <div className="flex gap-2">
          <textarea
            id="prompt-reply"
            rows={1}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && reply.trim()) { e.preventDefault(); onReply(reply.trim()); setReply(""); }
            }}
            placeholder="none of these — say what you want instead…"
            className="min-h-11 flex-1 resize-none rounded-lg border border-line bg-surface px-3 py-2.5 text-[13px]
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
          <Button
            size="icon"
            disabled={!reply.trim()}
            aria-label="Send reply"
            onClick={() => { onReply(reply.trim()); setReply(""); }}
          >
            <ArrowUp className="size-5" aria-hidden />
          </Button>
        </div>
      </div>
    </section>
  );
}

function TurnView({ t }: { t: Turn }) {
  // A failed tool is the thing you'd otherwise open a terminal to discover.
  if (t.error) {
    return (
      <article className="border-b border-line bg-error/5 px-4 py-3">
        <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-error">
          <AlertCircle className="size-3" aria-hidden /> failed
        </p>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-snug text-error/90">{t.error}</pre>
      </article>
    );
  }

  if (!t.text && !t.tools.length) return null;
  return (
    <article className={cn("border-b border-line px-4 py-3", t.role === "user" && "bg-surface/50")}>
      <p className={cn("mb-1.5 text-[11px] font-medium uppercase tracking-wider", t.role === "user" ? "text-accent" : "text-muted")}>
        {t.role}
      </p>
      {t.text && <Markdown>{t.text}</Markdown>}
      {t.tools.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {t.tools.map((tool, i) => (
            <li key={i} className="flex min-w-0 items-baseline gap-2 font-mono text-[11px]">
              <span className="shrink-0 rounded border border-line px-1.5 py-0.5 text-muted">{tool.name}</span>
              {tool.summary && <span className="min-w-0 flex-1 truncate text-faint">{tool.summary}</span>}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/**
 * Claude's own task list.
 *
 * Not what tool just ran, but what Claude thinks it is working through. One
 * real session here had 83 of them, so completed work is folded away by default
 * and only what is in flight or still to come is shown up front.
 */
function TaskStrip({ list }: { list: TaskList }) {
  const { total, done, active } = list.counts;
  // With nothing left open, hiding the completed list leaves an empty box that
  // says "everything is done" and shows none of it. Finished work IS the answer
  // in that case, so show it.
  const [open, setOpen] = useState(true);
  const [showDone, setShowDone] = useState(total > 0 && done === total);
  if (!total) return null;
  const visible = showDone ? list.tasks : list.tasks.filter((t) => t.status !== "completed");
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <div className="shrink-0 border-b border-line bg-surface/40">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex min-h-9 w-full min-w-0 cursor-pointer items-center gap-2 px-4 py-1.5 text-left
                   transition-colors duration-200 hover:bg-raised
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
      >
        <ChevronDown className={cn("size-3 shrink-0 text-faint transition-transform duration-200", !open && "-rotate-90")} aria-hidden />
        <ListChecks className="size-3.5 shrink-0 text-faint" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[11px] uppercase tracking-wider text-faint">
          tasks <span className="tabular-nums">{done}/{total}</span>
          {active > 0 && <span className="ml-1 text-accent">· {active} in progress</span>}
        </span>
        {/* A bar rather than a number: on a phone the shape is read faster. */}
        <span className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-line" aria-label={`${pct}% done`}>
          <span className="block h-full rounded-full bg-success transition-all duration-500" style={{ width: `${pct}%` }} />
        </span>
      </button>

      {open && (
        <>
          <ul className="pb-1">
            {visible.map((t) => (
              <li key={t.id} className="flex min-w-0 items-start gap-2 px-4 py-1">
                <span className="mt-1 shrink-0" aria-hidden>
                  {t.status === "completed" ? (
                    <Check className="size-3 text-success" />
                  ) : t.status === "in_progress" ? (
                    <span className="block size-1.5 animate-pulse rounded-full bg-accent" />
                  ) : (
                    <span className="block size-1.5 rounded-full border border-faint" />
                  )}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 text-[12px] leading-snug",
                    t.status === "completed" ? "text-faint line-through" : t.status === "in_progress" ? "text-fg" : "text-muted",
                  )}
                >
                  {t.status === "in_progress" && t.activeForm ? t.activeForm : t.subject}
                </span>
              </li>
            ))}
            {!visible.length && (
              <li className="px-4 py-1 text-[12px] text-faint">Everything here is done.</li>
            )}
          </ul>
          {done > 0 && (
            <button
              onClick={() => setShowDone(!showDone)}
              className="w-full cursor-pointer px-4 pb-1.5 text-left text-[11px] text-faint hover:text-muted
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
            >
              {showDone ? "hide" : "show"} {done} done
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Subagents running under this session.
 *
 * A session with three Tasks in flight otherwise reports only "busy", which tells
 * you nothing about what is actually happening or how much of it there is.
 */
function AgentStrip({ agents }: { agents: Agent[] }) {
  const [open, setOpen] = useState(true);
  if (!agents.length) return null;
  const running = agents.filter((a) => a.active).length;

  return (
    <div className="border-b border-line bg-surface/40">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex min-h-9 w-full cursor-pointer items-center gap-2 px-4 py-1.5 text-left
                   transition-colors duration-200 hover:bg-raised
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
      >
        <ChevronDown className={cn("size-3 shrink-0 text-faint transition-transform duration-200", !open && "-rotate-90")} aria-hidden />
        <Bot className="size-3.5 shrink-0 text-faint" aria-hidden />
        <span className="flex-1 text-[11px] uppercase tracking-wider text-faint">
          agents <span className="tabular-nums">{running > 0 ? `${running} running` : `${agents.length} done`}</span>
        </span>
      </button>

      {open && (
        <ul className="pb-1">
          {agents.map((a) => (
            <li key={a.id} className="flex min-w-0 items-center gap-2 px-4 py-1.5">
              <span
                className={cn("size-1.5 shrink-0 rounded-full", a.active ? "animate-pulse bg-success" : "bg-faint")}
                aria-label={a.active ? "running" : "finished"}
              />
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate text-[12px]", a.active ? "text-fg" : "text-muted")}>{a.task}</span>
                <span className="block truncate font-mono text-[10px] text-faint">
                  {a.tools} tools{a.lastTool ? ` · ${a.lastTool}` : ""}
                </span>
              </span>
              <span className="shrink-0 text-[10px] tabular-nums text-faint">{ago(a.updatedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Box glyphs or several lines mean it is a drawing, not a sentence. */
const isArt = (v: string) => /[│┃─━┌┐└┘├┤┬┴┼╭╮╰╯╔╗╚╝║═]/.test(v) || v.split("\n").length > 2;

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
