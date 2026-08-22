import { ChevronDown, Loader2 } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * What a still-running command is printing.
 *
 * The transcript only gains a tool's output once the process exits, so between
 * the chip appearing and the result landing there is nothing to render and a
 * four-minute build reads as a hang. These lines come off the live screen
 * instead (lib/running.ts), which is why they arrive as an already-rendered
 * fixed-width block rather than as a string to format.
 *
 * It sits inline in a conversation, so it stays quiet: no border of its own, no
 * colour, and a capped height that scrolls internally — output arriving must
 * never move the messages around it.
 */
export function RunningTool({
  name, summary, lines, defaultOpen = true, className,
}: {
  name: string;
  summary?: string | null;
  lines: string[];
  defaultOpen?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLPreElement>(null);
  const [open, setOpen] = useState(defaultOpen);

  // Pinned to the bottom: the newest line is the only one worth reading, and
  // doing it before paint means it never flashes at the old offset.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  if (!lines.length) return null;

  return (
    <div className={cn("min-w-0 rounded bg-surface/60 font-mono text-[11px]", className)}>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex min-h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 px-1.5 py-1 text-left
                   transition-colors duration-200 hover:bg-raised
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
      >
        <ChevronDown
          className={cn("size-3 shrink-0 text-faint transition-transform duration-200", !open && "-rotate-90")}
          aria-hidden
        />
        <Loader2 className="size-3 shrink-0 animate-spin text-muted" aria-hidden />
        <span className="shrink-0 text-muted">{name}</span>
        {summary && <span className="min-w-0 flex-1 truncate text-faint">{summary}</span>}
      </button>

      {open && (
        <pre
          ref={ref}
          role="log"
          /* Announcing every line of a build log would make the page unusable. */
          aria-live="off"
          aria-label={`Live output from ${name}`}
          tabIndex={0}
          className="m-0 max-h-40 overflow-auto whitespace-pre px-2 pb-1.5 leading-snug text-muted
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
        >
          {lines.join("\n")}
        </pre>
      )}
    </div>
  );
}
