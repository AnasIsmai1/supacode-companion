import { ArrowUp, History, Paperclip } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Completions, detectTrigger, noteRecent, type Trigger } from "@/components/Completions";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";

const MIN_ROWS = 1;
const MAX_FRACTION = 0.35;

/**
 * WhatsApp-style growing composer.
 *
 * Two bugs this replaces, both measured via CDP against the live app:
 *   1. height was set imperatively on input and never reset, so the box stayed
 *      tall after sending (inlineHeight 155px with an empty textarea).
 *   2. auto-grow set height = scrollHeight, but under `box-sizing: border-box`
 *      clientHeight then came out 2px short, leaving content permanently taller
 *      than the box — a scrollbar that could never clear.
 *
 * Fix: drive the resize from the value (so clearing resets it) and add the
 * border delta back, so the content actually fits.
 */
export function Composer({
  value, onChange, onSend, onAttach, sessionId, history = [], disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onAttach: (files: FileList | null) => void;
  sessionId: string;
  /** Previous prompts, newest first. */
  history?: string[];
  disabled?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [trigger, setTrigger] = useState<Trigger>(null);
  const [showHistory, setShowHistory] = useState(false);
  // -1 means "not browsing"; the draft is kept so ArrowDown can restore it.
  const [histIdx, setHistIdx] = useState(-1);
  const draft = useRef("");

  const recall = (delta: number) => {
    if (!history.length) return;
    const next = Math.min(history.length - 1, Math.max(-1, histIdx + delta));
    if (next === histIdx) return;
    if (histIdx === -1) draft.current = value;
    setHistIdx(next);
    onChange(next === -1 ? draft.current : history[next]);
  };

  const syncTrigger = useCallback(() => {
    const el = ref.current;
    setTrigger(el ? detectTrigger(el.value, el.selectionStart ?? el.value.length) : null);
  }, []);

  /** Replace the `/frag` or `@frag` under the caret with the chosen item. */
  const pick = (text: string) => {
    const el = ref.current;
    if (!el || !trigger) return;
    const caret = el.selectionStart ?? value.length;
    const next = `${value.slice(0, trigger.start)}${text} ${value.slice(caret)}`;
    if (trigger.kind === "slash") noteRecent(text.replace(/^\//, ""));
    onChange(next);
    setTrigger(null);
    requestAnimationFrame(() => {
      el.focus();
      const pos = trigger.start + text.length + 1;
      el.setSelectionRange(pos, pos);
    });
  };

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    // With no explicit height there is no scrollbar, so this is the border only.
    const border = el.offsetHeight - el.clientHeight;
    const max = window.innerHeight * MAX_FRACTION;
    el.style.height = `${Math.min(el.scrollHeight + border, max)}px`;
    el.style.overflowY = el.scrollHeight + border > max ? "auto" : "hidden";
  }, []);

  // Keyed off the value, so clearing the text shrinks the box back to one row.
  useLayoutEffect(resize, [value, resize]);
  useEffect(() => {
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [resize]);

  const canSend = Boolean(value.trim()) && !disabled;

  return (
    <>
      <Completions trigger={trigger} sessionId={sessionId} onPick={pick} />
    <footer className="flex items-end gap-2 border-t border-line px-2 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
      <input
        ref={fileRef}
        id="attach"
        type="file"
        multiple
        hidden
        onChange={(e) => { onAttach(e.target.files); if (fileRef.current) fileRef.current.value = ""; }}
      />
      <Button variant="outline" size="icon" asChild>
        <label htmlFor="attach" aria-label="Attach a file"><Paperclip className="size-4" aria-hidden /></label>
      </Button>

      {/* A phone keyboard has no arrow keys, so history needs a tap target too. */}
      {history.length > 0 && (
        <Button variant="outline" size="icon" onClick={() => setShowHistory(true)} aria-label="Previous prompts">
          <History className="size-4" aria-hidden />
        </Button>
      )}

      <Sheet open={showHistory} onOpenChange={setShowHistory} title="Previous prompts">
        <ul className="flex flex-col gap-1">
          {history.map((h, i) => (
            <li key={i}>
              <button
                onClick={() => { draft.current = value; setHistIdx(i); onChange(h); setShowHistory(false); ref.current?.focus(); }}
                className="w-full cursor-pointer rounded-lg border border-line bg-surface px-3 py-2.5 text-left
                           text-[13px] transition-colors duration-200 hover:bg-raised
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="line-clamp-3 whitespace-pre-wrap break-words">{h}</span>
              </button>
            </li>
          ))}
        </ul>
      </Sheet>

      <label htmlFor="composer" className="sr-only">Message</label>
      <textarea
        ref={ref}
        id="composer"
        rows={MIN_ROWS}
        value={value}
        onChange={(e) => { onChange(e.target.value); syncTrigger(); setHistIdx(-1); }}
        onPaste={(e) => {
          // Screenshots are the common case on a phone; route them through the
          // same upload path as the attach button rather than pasting a blob URL.
          const files = [...(e.clipboardData?.files ?? [])];
          if (!files.length) return;
          e.preventDefault();
          const dt = new DataTransfer();
          for (const f of files) dt.items.add(f);
          onAttach(dt.files);
        }}
        onKeyDown={(e) => {
          // A completion list is open: Enter picks nothing yet, so let it through
          // as a newline rather than sending a half-typed "/comm".
          if (e.key === "Enter" && !e.shiftKey && !trigger) {
            e.preventDefault();
            if (canSend) onSend();
            setHistIdx(-1);
            return;
          }
          // Arrows recall previous prompts, but only when they are not doing
          // something more useful: moving inside a draft, or picking a completion.
          if (trigger || e.shiftKey) return;
          const el = e.currentTarget;
          const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
          if (e.key === "ArrowUp" && (histIdx > -1 || atStart || !value)) {
            e.preventDefault();
            recall(1);
          } else if (e.key === "ArrowDown" && histIdx > -1) {
            e.preventDefault();
            recall(-1);
          }
        }}
        onKeyUp={syncTrigger}
        enterKeyHint="send"
        onClick={syncTrigger}
        onBlur={() => setTimeout(() => setTrigger(null), 150)}
        placeholder="Message…"
        className="flex-1 resize-none overflow-y-hidden rounded-lg border border-line bg-surface px-3 py-2.5
                   text-[15px] leading-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />

      <Button size="icon" onClick={onSend} disabled={!canSend} aria-label="Send message">
        <ArrowUp className="size-5" aria-hidden />
      </Button>
    </footer>
    </>
  );
}
