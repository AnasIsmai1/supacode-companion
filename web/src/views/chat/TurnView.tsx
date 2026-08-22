import { AlertCircle } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { type Turn } from "@/lib/api";
import { cn } from "@/lib/utils";

export function TurnView({ t }: { t: Turn }) {
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
