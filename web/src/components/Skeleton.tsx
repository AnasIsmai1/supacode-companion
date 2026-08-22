import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading states, shaped like what is coming.
 *
 * Built on the shadcn/ui Skeleton primitive rather than a bespoke one, so it
 * matches the rest of components/ui and stays upgradeable.
 *
 * Two rules drive everything here: match the content's layout, and match its
 * dimensions. The old "Loading…" occupied a different amount of space than
 * whatever replaced it, so every load ended in a layout shift. Each set below
 * mirrors the real row's padding, min-height and columns, and nothing moves
 * when the data lands.
 *
 * `animate-pulse` comes from the primitive, and index.css already damps all
 * animation under prefers-reduced-motion, so a motion-sensitive user gets a
 * static block. The shape is the part carrying the meaning.
 */

/** One live region per list. A screen reader should hear this once, not per box. */
function Frame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/**
 * Widths vary per row on purpose.
 *
 * A column of identical bars reads as a barcode rather than as text that has
 * not arrived. Indexed rather than random, so the layout is stable across
 * re-renders.
 */
const TITLE = ["w-40", "w-52", "w-32", "w-56", "w-44"];
const PATH = ["w-48", "w-64", "w-36", "w-56"];
const LINE = ["w-full", "w-11/12", "w-4/5", "w-full", "w-3/4", "w-full", "w-2/3"];
const HUNK = ["w-2/3", "w-full", "w-5/6", "w-1/2", "w-full", "w-3/4"];

/** Matches FlatRow in Tree: icon, title, subtitle, right-aligned age. */
export function SessionRows({ n = 6 }: { n?: number }) {
  return (
    <Frame label="Loading sessions">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="flex min-h-11 items-center gap-3 border-b border-line px-4 py-2.5">
          <Skeleton className="size-4 shrink-0 rounded-full" />
          <span className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className={`h-3 ${TITLE[i % TITLE.length]}`} />
            <Skeleton className="h-2 w-24" />
          </span>
          <Skeleton className="h-2 w-8 shrink-0" />
        </div>
      ))}
    </Frame>
  );
}

/** Matches FileRow in Work: chevron, status glyph, path, +/- counts. */
export function FileRows({ n = 7 }: { n?: number }) {
  return (
    <Frame label="Loading changed files">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="flex min-h-11 items-center gap-2 border-b border-line px-4 py-2.5">
          <Skeleton className="size-3 shrink-0" />
          <Skeleton className="size-3.5 shrink-0" />
          <Skeleton className={`h-3 ${PATH[i % PATH.length]}`} />
          <Skeleton className="ml-auto h-2 w-10 shrink-0" />
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
        <div key={i} className="flex items-baseline gap-2 border-b border-line px-4 py-2">
          <Skeleton className="mt-1 size-1.5 shrink-0 rounded-full" />
          <span className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className={`h-3 ${TITLE[i % TITLE.length]}`} />
            <Skeleton className="h-2 w-28" />
          </span>
          <Skeleton className="h-2 w-8 shrink-0" />
        </div>
      ))}
    </Frame>
  );
}

/** Prose: ragged lines, with a wider gap and shorter bar where a heading sits. */
export function TextLines({ n = 10 }: { n?: number }) {
  return (
    <Frame label="Loading">
      <div className="space-y-2.5 py-1">
        {Array.from({ length: n }, (_, i) =>
          i % 5 === 0 ? (
            <Skeleton key={i} className="mt-3 h-4 w-1/3" />
          ) : (
            <Skeleton key={i} className={`h-3 ${LINE[i % LINE.length]}`} />
          ),
        )}
      </div>
    </Frame>
  );
}

/** A patch body: short and long lines, the way real hunks fall. */
export function PatchLines({ n = 8 }: { n?: number }) {
  return (
    <Frame label="Loading diff">
      <div className="space-y-2 px-4 py-3">
        {Array.from({ length: n }, (_, i) => (
          <Skeleton key={i} className={`h-2.5 ${HUNK[i % HUNK.length]}`} />
        ))}
      </div>
    </Frame>
  );
}

/** Route-level fallback, before a lazy view knows what shape it is. */
export function ViewSkeleton() {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <Skeleton className="size-5 shrink-0" />
        <span className="min-w-0 flex-1 space-y-1.5">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-2 w-20" />
        </span>
      </div>
      <SessionRows n={7} />
    </div>
  );
}
