import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * shadcn/ui Skeleton.
 *
 * The canonical component, dropped in as-is so it stays recognisable and
 * upgradeable, with `bg-accent` swapped for this app's own raised surface
 * token — the accent here is a saturated blue and a screenful of it would read
 * as content rather than as absence.
 *
 * `animate-pulse` is a Tailwind built-in, which is the reason to prefer it over
 * a hand-rolled keyframe: it is already damped by the global
 * prefers-reduced-motion rule in index.css.
 *
 * Size it to the content it replaces. A generic block that does not match what
 * arrives is what makes a screen jump.
 */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="skeleton" className={cn("animate-pulse rounded-md bg-raised", className)} {...props} />;
}
