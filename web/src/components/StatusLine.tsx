import { AlertCircle, Check, CircleDot, Loader2, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export type State = {
  mode: string | null;
  model: string | null;
  modelChangedFrom: string | null;
  usage: { used: number; max: number; percent: number } | null;
  lastActivity: number | null;
  lastTool: string | null;
  prompts: string[];
  queued: string[];
};

const SHORT: Record<string, string> = {
  "claude-opus-5": "Opus 5",
  "claude-sonnet-5": "Sonnet 5",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
};
const modelName = (m: string | null) => (m ? SHORT[m] ?? m.replace(/^claude-/, "") : "—");

const elapsed = (from: number) => {
  const s = Math.max(0, (Date.now() - from) / 1000);
  return s < 60 ? `${s | 0}s` : s < 3600 ? `${(s / 60) | 0}m ${(s % 60) | 0}s` : `${(s / 3600) | 0}h`;
};

/**
 * One line, five facts. Every value comes from the transcript — no zmx spawn, so
 * this costs nothing to keep current. Deliberately does not grow into a dashboard.
 */
export function StatusLine({
  state, status, waiting, onInterrupt,
}: { state: State | null; status: string | null; waiting: boolean; onInterrupt?: () => void }) {
  const [, tick] = useState(0);
  const working = status === "busy";

  // Local ticker so elapsed time advances without polling the server.
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [working]);

  if (!state) return null;

  const Icon = waiting ? AlertCircle : working ? Loader2 : status === "shell" ? CircleDot : Check;
  const tone = waiting ? "text-warning" : working ? "text-accent" : "text-faint";
  const label = waiting
    ? "waiting on you"
    : working
      ? `${state.lastTool ?? "working"}${state.lastActivity ? ` · ${elapsed(state.lastActivity)}` : ""}`
      : "idle";

  return (
    <div className="flex items-center gap-2 border-b border-line bg-surface/60 px-4 py-1.5 text-xs">
      <Icon className={cn("size-3.5 shrink-0", tone, working && "animate-spin")} aria-hidden />
      <span className={cn("min-w-0 flex-1 truncate", waiting ? "text-warning" : "text-muted")}>{label}</span>

      {/* You could not stop a running turn from the phone at all before this. */}
      {working && onInterrupt && (
        <button
          onClick={onInterrupt}
          aria-label="Interrupt this turn"
          title="Interrupt — Claude keeps the work done so far"
          className="flex shrink-0 cursor-pointer items-center gap-1 rounded border border-line px-1.5 py-0.5
                     text-faint transition-colors duration-200 hover:border-error hover:text-error
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Square className="size-2.5 fill-current" aria-hidden /> stop
        </button>
      )}

      {state.queued.length > 0 && (
        <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-faint" title="messages queued behind this turn">
          {state.queued.length} queued
        </span>
      )}

      <span
        className={cn("shrink-0 font-mono", state.modelChangedFrom ? "text-info" : "text-faint")}
        title={state.modelChangedFrom ? `switched from ${modelName(state.modelChangedFrom)}` : undefined}
      >
        {modelName(state.model)}
      </span>

      {state.mode && <span className="shrink-0 text-faint">{state.mode}</span>}

      {state.usage && (
        <span className="shrink-0 font-mono tabular-nums text-faint" title={`${state.usage.used.toLocaleString()} tokens`}>
          {state.usage.percent}%
        </span>
      )}
    </div>
  );
}
