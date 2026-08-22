// Supacode's own window layout — the source of truth for naming and grouping.
//
// ~/.supacode/layouts.json is keyed by worktree path and holds the tab titles you
// see in the Supacode UI, plus each agent's pid. Joining on that pid resolves a
// window to its Claude session with no process-tree walking: 18/18 vs 17/18 for
// the ppid walk this replaces.
//
// It is internal app state, not a public API. All parsing lives here so a schema
// change breaks one file. See the plan's risk #1.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LAYOUTS = join(homedir(), ".supacode", "layouts.json");

export type Window = {
  tabId: string;
  title: string;
  surfaceId: string;
  /** zmx session name for this surface — the write target. */
  zmx: string;
  /** "claude" when an agent is attached, null for plain shells / $EDITOR tabs. */
  agent: string | null;
  pid: number | null;
  index: number;
};

/** Every leaf surface under a layout node. Splits nest; a leaf is the base case. */
function* leaves(node: unknown): Generator<any> {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, any>;
  if (n.leaf?._0) {
    yield n.leaf._0;
    return;
  }
  for (const v of Object.values(n)) {
    if (Array.isArray(v)) for (const x of v) yield* leaves(x);
    else if (v && typeof v === "object") yield* leaves(v);
  }
}

const strip = (p: string) => p.replace(/\/+$/, "");

/** worktree path (no trailing slash) -> its windows, in Supacode's tab order. */
export function windowsByWorktree(): Map<string, Window[]> {
  const out = new Map<string, Window[]>();
  if (!existsSync(LAYOUTS)) return out;

  let raw: Record<string, any>;
  try {
    raw = JSON.parse(readFileSync(LAYOUTS, "utf8"));
  } catch {
    return out; // app mid-write; caller falls back
  }

  for (const [worktree, entry] of Object.entries(raw)) {
    const windows: Window[] = [];
    const tabs = Array.isArray(entry?.tabs) ? entry.tabs : [];

    tabs.forEach((tab: any, index: number) => {
      for (const leaf of leaves(tab?.layout)) {
        const surfaceId: string = leaf?.id ?? "";
        if (!surfaceId) continue;
        const agent = (leaf.agents ?? [])[0];
        windows.push({
          tabId: tab?.id ?? surfaceId,
          title: String(tab?.title ?? "").trim() || "untitled",
          surfaceId,
          // zmx names the session after the surface, lowercased.
          zmx: `supa-${surfaceId.toLowerCase()}`,
          agent: agent?.agent ?? null,
          pid: agent?.pids?.[0] ?? null,
          index,
        });
      }
    });

    if (windows.length) out.set(strip(worktree), windows);
  }
  return out;
}

/** claude pid -> its window, for joining against ~/.claude/sessions/<pid>.json. */
export function windowByPid(): Map<number, { worktree: string; window: Window }> {
  const m = new Map<number, { worktree: string; window: Window }>();
  for (const [worktree, windows] of windowsByWorktree()) {
    for (const window of windows) {
      if (window.pid != null) m.set(window.pid, { worktree, window });
    }
  }
  return m;
}
