import { Loader2 } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * shadcn/ui Spinner.
 *
 * For content whose shape cannot be guessed. A skeleton is a promise about the
 * layout that is coming, so it only works where that layout is predictable: a
 * list of rows, a table, a paragraph. A conversation is none of those. Its
 * turns vary from one line to a screenful, and a skeleton shaped like the wrong
 * thing is worse than an honest "working on it".
 */
export function Spinner({ className, ...props }: React.ComponentProps<typeof Loader2>) {
  return <Loader2 role="status" aria-label="Loading" className={cn("size-4 animate-spin", className)} {...props} />;
}
