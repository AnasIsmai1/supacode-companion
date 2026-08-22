import { cn } from "@/lib/utils";

/**
 * Placeholders shaped like the thing that is coming.
 *
 * Every loading state here used to be the word "Loading…" in the top left,
 * which tells you nothing is broken and nothing else. Worse, it occupies a
 * different amount of space than the content it precedes, so the screen jumps
 * the moment data lands.
 *
 * So each skeleton mirrors the real row's metrics: same padding, same min
 * height, same columns. Nothing moves when the data replaces it.
 *
 * The sweep is a translated gradient rather than an animated width, so it stays
 * on the compositor. index.css already kills animation globally under
 * prefers-reduced-motion, which leaves a static grey block: still correctly
 * shaped, just not moving.
 */

/** One grey block. Widths vary so a list does not look like a barcode. */
export function Bar({ w = "w-24", className, style }: { w?: string; className?: string; style?: React.CSSProperties }) {
  return <span className={cn("skeleton block h-3 rounded", w, className)} style={style} aria-hidden />;
}

/**
 * Staggered so the list reads as filling downward rather than blinking at once.
 *
 * A custom property, not animationDelay: the sweep runs on ::after, which an
 * inline style cannot reach. This cascades to every .skeleton inside the row.
 */
const delay = (i: number) => ({ "--skeleton-delay": `${i * 90}ms` }) as React.CSSProperties;

function Frame({ label, children }: { label: string; children: React.ReactNode }) {
  // One live region for the whole list: a screen reader should hear "loading",
  // not eleven anonymous boxes.
  return (
    <div role="status" aria-busy="true" aria-label={label} className="animate-[fade-in_200ms_ease-out]">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** Matches FlatRow in Tree: icon, two lines, right-aligned age. */
export function SessionRows({ n = 6 }: { n?: number }) {
  return (
    <Frame label="Loading sessions">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="flex min-h-11 items-center gap-3 border-b border-line px-4 py-2.5" style={delay(i)}>
          <span className="skeleton size-4 shrink-0 rounded-full" aria-hidden />
          <span className="min-w-0 flex-1 space-y-1.5">
            <Bar w={i % 3 === 0 ? "w-40" : i % 3 === 1 ? "w-52" : "w-32"} />
            <Bar w="w-24" className="h-2" />
          </span>
          <Bar w="w-8" className="h-2 shrink-0" />
        </div>
      ))}
    </Frame>
  );
}

/** Matches FileRow in Work: chevron, glyph, path, +/- counts. */
export function FileRows({ n = 7 }: { n?: number }) {
  return (
    <Frame label="Loading changed files">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="flex min-h-11 items-center gap-2 border-b border-line px-4 py-2.5" style={delay(i)}>
          <span className="skeleton size-3 shrink-0 rounded" aria-hidden />
          <span className="skeleton size-3.5 shrink-0 rounded" aria-hidden />
          <Bar w={["w-48", "w-64", "w-36", "w-56"][i % 4]} className="flex-1" />
          <Bar w="w-10" className="h-2 shrink-0" />
        </div>
      ))}
    </Frame>
  );
}

/** Matches History: status dot, subject, sha line, age. */
export function CommitRows({ n = 8 }: { n?: number }) {
  return (
    <Frame label="Loading history">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="flex items-baseline gap-2 border-b border-line px-4 py-2" style={delay(i)}>
          <span className="skeleton mt-1 size-1.5 shrink-0 rounded-full" aria-hidden />
          <span className="min-w-0 flex-1 space-y-1.5">
            <Bar w={["w-56", "w-44", "w-64", "w-40"][i % 4]} />
            <Bar w="w-28" className="h-2" />
          </span>
          <Bar w="w-8" className="h-2 shrink-0" />
        </div>
      ))}
    </Frame>
  );
}

/** Prose: ragged line lengths, with the odd gap where a heading sits. */
export function TextLines({ n = 10 }: { n?: number }) {
  const widths = ["w-full", "w-11/12", "w-4/5", "w-full", "w-3/4", "w-full", "w-2/3"];
  return (
    <Frame label="Loading">
      <div className="space-y-2.5 py-1">
        {Array.from({ length: n }, (_, i) => (
          <div key={i} style={delay(i)} className={i % 5 === 0 ? "pt-3" : undefined}>
            <Bar w={i % 5 === 0 ? "w-1/3" : widths[i % widths.length]} className={i % 5 === 0 ? "h-4" : undefined} />
          </div>
        ))}
      </div>
    </Frame>
  );
}

/** A patch: monospace-ish block, some lines short like real diff hunks. */
export function PatchLines({ n = 8 }: { n?: number }) {
  const widths = ["w-2/3", "w-full", "w-5/6", "w-1/2", "w-full", "w-3/4"];
  return (
    <Frame label="Loading diff">
      <div className="space-y-2 px-4 py-3">
        {Array.from({ length: n }, (_, i) => (
          <Bar key={i} w={widths[i % widths.length]} className="h-2.5" style={delay(i)} />
        ))}
      </div>
    </Frame>
  );
}

/** The route-level fallback, before a view knows what shape it is. */
export function ViewSkeleton() {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <span className="skeleton size-5 shrink-0 rounded" aria-hidden />
        <span className="min-w-0 flex-1 space-y-1.5">
          <Bar w="w-32" />
          <Bar w="w-20" className="h-2" />
        </span>
      </div>
      <SessionRows n={7} />
    </div>
  );
}
