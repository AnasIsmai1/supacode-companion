// All Supacode worktrees, whether or not a Claude session is running in them.
//
// The worktree SET comes from `supacode worktree list`, which needs the Supacode
// app running. If it is closed we fall back to ~/.supacode/sidebar.json on disk.
// Branch and last-commit age come from git, not from `supacode worktree status`
// — git is faster, works with the app closed, and gives us the commit time too.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SIDEBAR = join(homedir(), ".supacode", "sidebar.json");

export type Worktree = {
  id: string; // percent-encoded, as supacode wants it back
  path: string; // decoded, trailing slash stripped
  repo: string; // display name of the parent repo
  branch: string | null;
  lastCommit: number | null; // unix seconds
  dirty: boolean;
};

async function run(cmd: string[], cwd?: string): Promise<string> {
  try {
    const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "ignore" });
    // `supacode` waits up to 180s by default; never let one wedge a request.
    const killer = setTimeout(() => p.kill(), 10_000);
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    clearTimeout(killer);
    return code === 0 ? out : "";
  } catch {
    return "";
  }
}

const strip = (p: string) => p.replace(/\/+$/, "");

/** Worktree ids from the Supacode app, or from its on-disk sidebar if closed. */
async function worktreeIds(): Promise<string[]> {
  const live = (await run(["supacode", "worktree", "list"]))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (live.length) return live;

  if (!existsSync(SIDEBAR)) return [];
  try {
    // sections is a flat alternating list: path, {buckets…}, path, {buckets…}
    const raw = JSON.parse(readFileSync(SIDEBAR, "utf8"));
    const paths = new Set<string>();
    const walk = (v: any) => {
      if (typeof v === "string" && v.startsWith("/")) paths.add(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(raw.sections);
    return [...paths].map(encodeURIComponent);
  } catch {
    return [];
  }
}

/** Repo display name.
 *
 *  Supacode worktrees are SIBLINGS of the repo, not children:
 *  `.../sledge/sledge-ai.SLEDGE-1288` belongs to `.../sledge/sledge-ai`.
 *  So resolve in that order — exact, then sibling, then containing prefix —
 *  otherwise the registered parent `.../ms/` swallows 23 of 46 worktrees.
 */
export function repoOf(path: string, repoPaths: string[]): string {
  const name = (p: string) => p.split("/").pop() || p;

  if (repoPaths.includes(path)) return name(path);

  const dir = path.slice(0, path.lastIndexOf("/"));
  const base = name(path);
  const dot = base.indexOf(".");
  if (dot > 0) {
    const sibling = `${dir}/${base.slice(0, dot)}`;
    if (repoPaths.includes(sibling)) return name(sibling);
  }

  for (const r of repoPaths) {
    if (path.startsWith(r + "/")) return name(r);
  }
  return dot > 0 ? base.slice(0, dot) : base;
}

const TTL_MS = 20_000;
let cache: { at: number; value: Worktree[] } | null = null;
let inflight: Promise<Worktree[]> | null = null;

/** Cached view. Worktrees change on the order of minutes; scanning costs ~4s. */
export async function listWorktrees(force = false): Promise<Worktree[]> {
  const fresh = cache && Date.now() - cache.at < TTL_MS;
  if (!force && fresh) return cache!.value;
  // Stale-while-revalidate: a poll never waits on a rescan once we have data.
  if (!inflight) inflight = refresh();
  return cache && !force ? cache.value : inflight;
}

function refresh(): Promise<Worktree[]> {
  return scanWorktrees()
    .then((v) => { cache = { at: Date.now(), value: v }; return v; })
    .catch((e) => { if (cache) return cache.value; throw e; })
    .finally(() => { inflight = null; });
}

async function scanWorktrees(): Promise<Worktree[]> {
  const ids = await worktreeIds();
  const repoPaths = [
    ...new Set(
      (await run(["supacode", "repo", "list"]))
        .split("\n")
        .map((l) => strip(decodeURIComponent(l.trim())))
        .filter(Boolean),
    ),
  ].sort((a, b) => b.length - a.length);

  return (
    await Promise.all(
      ids.map(async (id): Promise<Worktree | null> => {
        const path = strip(decodeURIComponent(id));
        if (!existsSync(path)) return null;
        const [branch, sha, ts, status] = await Promise.all([
          run(["git", "-C", path, "branch", "--show-current"]),
          run(["git", "-C", path, "rev-parse", "--short", "HEAD"]),
          run(["git", "-C", path, "log", "-1", "--format=%ct"]),
          run(["git", "-C", path, "status", "--porcelain"]),
        ]);
        // --show-current is empty on a detached HEAD; fall back to the short sha.
        const head = branch.trim() || (sha.trim() ? `@${sha.trim()}` : "");
        return {
          id,
          path,
          repo: repoOf(path, repoPaths),
          branch: head || null,
          lastCommit: Number(ts.trim()) || null,
          dirty: status.trim().length > 0,
        };
      }),
    )
  ).filter((w): w is Worktree => w !== null);
}
