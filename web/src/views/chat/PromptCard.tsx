import { ArrowUp, ChevronDown, MessageSquare } from "lucide-react";
import { useState } from "react";
import { AsciiPreview } from "@/components/AsciiPreview";
import { Button } from "@/components/ui/button";
import { type Pending } from "@/lib/api";
import { cn } from "@/lib/utils";
import { isArt } from "@/views/chat/art";

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
export function PromptCard({
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
