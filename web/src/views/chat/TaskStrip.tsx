import { Check, ChevronDown, ListChecks } from "lucide-react";
import { useState } from "react";
import { type TaskList } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Claude's own task list.
 *
 * Not what tool just ran, but what Claude thinks it is working through. One
 * real session here had 83 of them, so completed work is folded away by default
 * and only what is in flight or still to come is shown up front.
 */
export function TaskStrip({ list }: { list: TaskList }) {
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
