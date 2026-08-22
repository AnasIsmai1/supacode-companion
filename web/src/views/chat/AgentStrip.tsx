import { Bot, ChevronDown } from "lucide-react";
import { useState } from "react";
import { type Agent } from "@/lib/api";
import { ago, cn } from "@/lib/utils";

/**
 * Subagents running under this session.
 *
 * A session with three Tasks in flight otherwise reports only "busy", which tells
 * you nothing about what is actually happening or how much of it there is.
 */
export function AgentStrip({ agents }: { agents: Agent[] }) {
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
