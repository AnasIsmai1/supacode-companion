import { ChevronLeft, RefreshCw } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { usePoll } from "@/lib/api";
import { TextLines } from "@/components/Skeleton";

/**
 * The backlog, read only.
 *
 * TODO.md stays the source of truth and stays editable on the Mac, in the repo,
 * next to the code it describes. This is here so the list is legible from a
 * phone, which is the only thing that was actually missing. Nothing here writes,
 * so there is no item state to store and nothing to keep in sync.
 */
export function Todo({ onBack }: { onBack: () => void }) {
  const { data, error } = usePoll<{ markdown: string }>("/api/todo", 30_000);

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
        <h1 className="flex-1 text-sm font-semibold">Backlog</h1>
        <RefreshCw className="size-3.5 text-faint" aria-label="Refreshes every 30 seconds" />
      </header>

      <main className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-3">
        {error && !data && <p className="text-sm text-error">{error}</p>}
        {!data && !error && <TextLines />}
        {data && <Markdown>{data.markdown}</Markdown>}
      </main>

      <p className="border-t border-line px-4 py-2 text-[11px] text-faint">
        Read only. Edit TODO.md in the repo.
      </p>
    </div>
  );
}
