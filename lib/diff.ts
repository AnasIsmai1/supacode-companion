// A structured diff of everything a session changed in its worktree.
//
// Ported from omg.dev (MIT, Copyright (c) 2026 Benny Kok),
// https://github.com/BennyKok/omg.dev — src/session-diff.ts.
//
// Two deliberate changes from upstream:
//   1. Containment. Upstream tests a WORKTREE_ROOT prefix; we resolve against
//      listWorktrees(), which is already the thing that decides what the phone
//      may see. The worktree list IS the allowlist.
//   2. Async. Upstream uses Bun.spawnSync throughout. See lib/sessions.ts: that
//      blocks Bun's event loop and every poll queues behind it.
//
// The diff is against the FORK POINT (merge-base with the default branch), not
// the working tree: everything this session changed on this branch, including
// commits Claude already made. Reviewing only uncommitted work would miss most
// of it. Upstream's note is kept — never `git fetch` on this path, it was the
// source of perceived slowness, and a fork point is a stable ancestor that does
// not move as the default branch advances.
//
// Self-check: bun lib/diff.ts

import { listWorktrees } from "./worktrees.ts";

export type DiffLineKind = "add" | "del" | "context" | "meta";
export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export type DiffLine = { kind: DiffLineKind; text: string; oldLine?: number; newLine?: number };
export type DiffHunk = { header: string; lines: DiffLine[] };

export type DiffFile = {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
  truncated?: boolean;
};

export type SessionDiff = {
  ok: boolean;
  branch: string | null;
  /** Short sha of the fork point. */
  base: string | null;
  files: DiffFile[];
  totals: { files: number; additions: number; deletions: number };
  truncated: boolean;
  baseWarning?: string;
  error?: string;
};

const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 2_000_000;
const MAX_UNTRACKED_BYTES = 200_000;

/** git's hash of the empty tree — a valid diff base when no branch ref exists. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

async function git(cwd: string, args: string[], timeoutMs = 10_000) {
  try {
    const p = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    const killer = setTimeout(() => p.kill(), timeoutMs);
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    const code = await p.exited;
    clearTimeout(killer);
    return { ok: code === 0, out, err };
  } catch {
    return { ok: false, out: "", err: "spawn failed" };
  }
}

/**
 * Resolve a worktree id or path from the client to an absolute path.
 *
 * Untrusted input at a trust boundary: it is only accepted if `listWorktrees()`
 * already knows about it, so nothing outside Supacode's own tree is reachable.
 */
export async function resolveWorktree(input: string | null): Promise<string | null> {
  if (!input) return null;
  const want = decodeURIComponent(input).replace(/\/+$/, "");
  const hit = (await listWorktrees()).find((w) => w.path === want || w.id === input);
  return hit?.path ?? null;
}

/** Parse unified `git diff` output into structured files and hunks. */
export function parseUnifiedDiff(patch: string): Map<string, DiffFile> {
  const byPath = new Map<string, DiffFile>();
  const lines = patch.split("\n");
  let cur: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const flush = () => {
    if (cur) byPath.set(cur.path, cur);
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      cur = { path: "", status: "modified", additions: 0, deletions: 0, binary: false, hunks: [] };
      hunk = null;
      // "diff --git a/x b/y" — the b/ path, refined by ---/+++ below.
      const m = line.match(/ b\/(.+)$/);
      if (m) cur.path = m[1];
      continue;
    }
    if (!cur) continue;

    if (line.startsWith("new file mode")) cur.status = "added";
    else if (line.startsWith("deleted file mode")) cur.status = "deleted";
    else if (line.startsWith("rename from ")) {
      cur.status = "renamed";
      cur.oldPath = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) {
      cur.status = "renamed";
      cur.path = line.slice("rename to ".length);
    } else if (line.startsWith("Binary files ")) {
      cur.binary = true;
    } else if (line.startsWith("--- ")) {
      const p = line.slice(4);
      if (p !== "/dev/null" && p.startsWith("a/")) cur.oldPath = cur.oldPath ?? p.slice(2);
    } else if (line.startsWith("+++ ")) {
      const p = line.slice(4);
      if (p !== "/dev/null" && p.startsWith("b/")) cur.path = p.slice(2);
    } else if (line.startsWith("@@")) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      hunk = { header: line, lines: [] };
      cur.hunks.push(hunk);
    } else if (hunk) {
      if (line.startsWith("+")) {
        cur.additions++;
        hunk.lines.push({ kind: "add", text: line.slice(1), newLine: newNo++ });
      } else if (line.startsWith("-")) {
        cur.deletions++;
        hunk.lines.push({ kind: "del", text: line.slice(1), oldLine: oldNo++ });
      } else if (line.startsWith("\\")) {
        // "\ No newline at end of file"
        hunk.lines.push({ kind: "meta", text: line.slice(1).trim() });
      } else {
        hunk.lines.push({
          kind: "context",
          text: line.startsWith(" ") ? line.slice(1) : line,
          oldLine: oldNo++,
          newLine: newNo++,
        });
      }
    }
  }
  flush();
  return byPath;
}

/** Resolve git's rename notation ("old => new", "dir/{old => new}/x") to the new path. */
export function renameTarget(p: string): string {
  if (p.includes("{")) return p.replace(/\{[^}]*? => ([^}]*?)\}/g, "$1").replace(/\/{2,}/g, "/");
  const i = p.indexOf(" => ");
  return i >= 0 ? p.slice(i + 4) : p;
}

const statusFromLetter = (l: string): DiffFileStatus =>
  l.startsWith("A") ? "added" : l.startsWith("D") ? "deleted" : l.startsWith("R") ? "renamed" : "modified";

/**
 * The fork point to diff against.
 *
 * Upstream hardcodes origin/main. Not every repo has it — these worktrees sit on
 * whatever the repo uses — so try the plausible refs in order and fall back to
 * the empty tree, which renders the branch as entirely new rather than erroring.
 */
async function forkBase(wt: string): Promise<{ base: string; warning?: string }> {
  const head = await git(wt, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  const candidates = [
    head.ok ? head.out.trim().replace("refs/remotes/", "") : "",
    "origin/main",
    "origin/master",
    "main",
    "master",
  ].filter(Boolean);

  for (const ref of candidates) {
    if (!(await git(wt, ["rev-parse", "--verify", "--quiet", ref])).ok) continue;
    const mb = await git(wt, ["merge-base", ref, "HEAD"]);
    if (mb.ok && mb.out.trim()) return { base: mb.out.trim() };
  }
  return { base: EMPTY_TREE, warning: "no default branch found locally — showing the whole branch" };
}

/**
 * Untracked files as summary rows.
 *
 * Upstream shells out to `git diff --numstat --no-index` once per file. On a
 * worktree with 172 untracked files that was 172 sequential spawns and 4.6s —
 * twenty times over budget. An untracked file is entirely new, so its additions
 * ARE its line count and its deletions are always zero: read the file instead.
 * Same numbers, no subprocess.
 */
async function untrackedFiles(wt: string, seen: Set<string>): Promise<DiffFile[]> {
  const r = await git(wt, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!r.ok) return [];
  const paths = r.out.split("\0").map((p) => p.trim()).filter(Boolean).filter((p) => !seen.has(p));

  const read = async (path: string): Promise<DiffFile> => {
    const row: DiffFile = { path, status: "untracked", additions: 0, deletions: 0, binary: false, hunks: [] };
    try {
      const file = Bun.file(`${wt}/${path}`);
      if (file.size > MAX_UNTRACKED_BYTES) {
        row.truncated = true;
        return row;
      }
      const buf = new Uint8Array(await file.arrayBuffer());
      // git's own heuristic: a NUL byte in the head means binary.
      if (buf.subarray(0, 8000).includes(0)) {
        row.binary = true;
        return row;
      }
      const text = new TextDecoder().decode(buf);
      if (!text) return row;
      // A trailing newline terminates the last line, it does not start a new one.
      row.additions = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    } catch {
      /* vanished or unreadable between ls-files and here */
    }
    return row;
  };

  // Bounded: a worktree with thousands of untracked files must not open them all.
  const out: DiffFile[] = [];
  for (let i = 0; i < paths.length; i += 32) {
    out.push(...(await Promise.all(paths.slice(i, i + 32).map(read))));
  }
  return out;
}

const empty = (over: Partial<SessionDiff> = {}): SessionDiff => ({
  ok: true, branch: null, base: null, files: [],
  totals: { files: 0, additions: 0, deletions: 0 }, truncated: false, ...over,
});

/**
 * File list with per-file counts and NO patch bodies.
 *
 * The viewer renders this immediately and lazy-loads each file's patch on
 * expand — on a phone, parsing every hunk of a 40-file change up front is the
 * difference between instant and a spinner.
 */
export async function diffSummary(wt: string): Promise<SessionDiff> {
  const head = await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!head.ok) return empty({ ok: false, error: "not a git checkout" });

  const { base, warning } = await forkBase(wt);

  const counts = new Map<string, { a: number; d: number; bin: boolean }>();
  const numstat = await git(wt, ["diff", "--numstat", "-M", base]);
  if (numstat.ok) {
    for (const line of numstat.out.split("\n")) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
      if (!m) continue;
      const path = m[3].includes("=>") ? renameTarget(m[3]) : m[3];
      counts.set(path, { a: m[1] === "-" ? 0 : Number(m[1]), d: m[2] === "-" ? 0 : Number(m[2]), bin: m[1] === "-" });
    }
  }

  const files: DiffFile[] = [];
  const nameStatus = await git(wt, ["diff", "--name-status", "-M", base]);
  if (nameStatus.ok) {
    for (const line of nameStatus.out.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      const status = statusFromLetter(parts[0]);
      const oldPath = status === "renamed" ? parts[1] : undefined;
      const path = status === "renamed" ? parts[2] : parts[1];
      if (!path) continue;
      const c = counts.get(path);
      files.push({ path, oldPath, status, additions: c?.a ?? 0, deletions: c?.d ?? 0, binary: c?.bin ?? false, hunks: [] });
    }
  }

  files.push(...(await untrackedFiles(wt, new Set(files.map((f) => f.path)))));
  files.sort((a, b) => a.path.localeCompare(b.path));

  const totals = files.reduce(
    (acc, f) => ({ files: acc.files + 1, additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { files: 0, additions: 0, deletions: 0 },
  );

  return {
    ok: true,
    branch: head.out.trim() || null,
    base: base.slice(0, 12),
    files: files.slice(0, MAX_FILES),
    totals,
    truncated: files.length > MAX_FILES,
    baseWarning: warning,
  };
}

/**
 * Counts only — cheap enough to fold into the tree poll.
 *
 * Uses the same two sources and the same -M flag as diffSummary. They must not
 * drift: a "+978" badge that opens a view reading "+11183" is worse than no badge.
 */
export async function diffStat(wt: string): Promise<{ files: number; additions: number; deletions: number }> {
  const { base } = await forkBase(wt);
  let files = 0;
  let additions = 0;
  let deletions = 0;
  const tracked = new Set<string>();

  const numstat = await git(wt, ["diff", "--numstat", "-M", base]);
  if (numstat.ok) {
    for (const line of numstat.out.split("\n")) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
      if (!m) continue;
      tracked.add(m[3].includes("=>") ? renameTarget(m[3]) : m[3]);
      files++;
      additions += m[1] === "-" ? 0 : Number(m[1]);
      deletions += m[2] === "-" ? 0 : Number(m[2]);
    }
  }

  for (const f of await untrackedFiles(wt, tracked)) {
    files++;
    additions += f.additions;
  }
  return { files, additions, deletions };
}

/** One file's raw unified patch, loaded when the user expands it. */
export async function filePatch(
  wt: string,
  path: string,
): Promise<{ path: string; patch: string; binary: boolean; truncated: boolean } | null> {
  // Untrusted input: only paths inside the worktree, never absolute, never "..".
  if (!path || path.startsWith("/") || path.split("/").includes("..")) return null;

  const { base } = await forkBase(wt);
  let out = (await git(wt, ["diff", "--no-color", "-M", base, "--", path])).out;
  if (!out.trim()) {
    // Not in the tracked diff — try it as an untracked file.
    out = (await git(wt, ["diff", "--no-color", "--no-index", "--", "/dev/null", path])).out;
    if (out.length > MAX_UNTRACKED_BYTES) out = out.slice(0, MAX_UNTRACKED_BYTES);
  }
  if (!out.trim()) return null;

  let truncated = false;
  if (out.length > MAX_TOTAL_BYTES) {
    out = out.slice(0, MAX_TOTAL_BYTES);
    truncated = true;
  }
  const binary = /^Binary files /m.test(out) || out.includes("\nGIT binary patch\n");
  return { path, patch: out, binary, truncated };
}

if (import.meta.main) {
  const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;

  // --- parseUnifiedDiff ---
  const patch = [
    "diff --git a/lib/a.ts b/lib/a.ts",
    "index 111..222 100644",
    "--- a/lib/a.ts",
    "+++ b/lib/a.ts",
    "@@ -1,3 +1,4 @@",
    " const x = 1;",
    "-const y = 2;",
    "+const y = 3;",
    "+const z = 4;",
    "\\ No newline at end of file",
  ].join("\n");
  const f = parseUnifiedDiff(patch).get("lib/a.ts")!;
  assert.equal(f.status, "modified");
  assert.equal(f.additions, 2);
  assert.equal(f.deletions, 1);
  assert.equal(f.hunks.length, 1);
  // Line numbers must track independently, or the gutter is wrong from hunk 2 on.
  assert.deepEqual(f.hunks[0].lines.map((l) => l.kind), ["context", "del", "add", "add", "meta"]);
  assert.equal(f.hunks[0].lines[0].oldLine, 1);
  assert.equal(f.hunks[0].lines[1].oldLine, 2);
  assert.equal(f.hunks[0].lines[2].newLine, 2);

  // A new file, so there is no a/ side.
  const added = parseUnifiedDiff(
    ["diff --git a/new.ts b/new.ts", "new file mode 100644", "--- /dev/null", "+++ b/new.ts", "@@ -0,0 +1 @@", "+hello"].join("\n"),
  ).get("new.ts")!;
  assert.equal(added.status, "added");
  assert.equal(added.additions, 1);

  // A rename: the path must be the NEW one, or the viewer opens a file that is gone.
  const renamed = parseUnifiedDiff(
    ["diff --git a/old.ts b/new.ts", "similarity index 98%", "rename from old.ts", "rename to new.ts"].join("\n"),
  ).get("new.ts")!;
  assert.equal(renamed.status, "renamed");
  assert.equal(renamed.oldPath, "old.ts");

  const bin = parseUnifiedDiff(
    ["diff --git a/i.png b/i.png", "Binary files a/i.png and b/i.png differ"].join("\n"),
  ).get("i.png")!;
  assert.equal(bin.binary, true);

  // --- renameTarget: both notations git emits in --numstat ---
  assert.equal(renameTarget("old.ts => new.ts"), "new.ts");
  assert.equal(renameTarget("lib/{old => new}/x.ts"), "lib/new/x.ts");
  assert.equal(renameTarget("plain.ts"), "plain.ts");

  // --- filePatch path containment ---
  assert.equal(await filePatch("/tmp", "/etc/passwd"), null);
  assert.equal(await filePatch("/tmp", "../../etc/passwd"), null);
  assert.equal(await filePatch("/tmp", ""), null);

  // --- end to end against a throwaway repo ---
  const tmp = `/tmp/companion-diff-selfcheck-${process.pid}`;
  const sh = async (cmd: string[]) => {
    const p = Bun.spawn(cmd, { cwd: tmp, stdout: "ignore", stderr: "ignore" });
    await p.exited;
  };
  await Bun.spawn(["mkdir", "-p", tmp]).exited;
  await sh(["git", "init", "-q", "-b", "main"]);
  await sh(["git", "config", "user.email", "t@t"]);
  await sh(["git", "config", "user.name", "t"]);
  await Bun.write(`${tmp}/kept.txt`, "one\ntwo\n");
  await sh(["git", "add", "-A"]);
  await sh(["git", "commit", "-qm", "base"]);
  await sh(["git", "checkout", "-qb", "work"]);
  await Bun.write(`${tmp}/kept.txt`, "one\ntwo\nthree\n");
  await Bun.write(`${tmp}/fresh.txt`, "new file\n");
  await sh(["git", "add", "kept.txt"]);
  await sh(["git", "commit", "-qm", "committed work"]);
  await Bun.write(`${tmp}/kept.txt`, "one\ntwo\nthree\nfour\n");

  const s = await diffSummary(tmp);
  assert.equal(s.ok, true);
  assert.equal(s.branch, "work");
  const paths = s.files.map((x) => x.path).sort();
  // Committed work AND uncommitted work AND the untracked file: the fork-point
  // diff is the whole branch, which is the point of using merge-base.
  assert.deepEqual(paths, ["fresh.txt", "kept.txt"]);
  assert.equal(s.files.find((x) => x.path === "fresh.txt")!.status, "untracked");
  assert.equal(s.files.find((x) => x.path === "kept.txt")!.additions, 2);

  // The invariant that matters: the badge and the view it opens must agree.
  // They drifted once (+978 vs +11183) because only one counted untracked files.
  const stat = await diffStat(tmp);
  assert.deepEqual(stat, s.totals, "diffStat must match diffSummary totals");
  assert.equal(stat.files, 2);
  assert.equal(stat.additions, 3); // kept.txt +2 tracked, fresh.txt +1 untracked

  // Binary untracked files report as binary with no line count.
  await Bun.write(`${tmp}/blob.bin`, new Uint8Array([1, 2, 0, 3, 4]));
  const withBin = await diffSummary(tmp);
  const blob = withBin.files.find((x) => x.path === "blob.bin")!;
  assert.equal(blob.binary, true);
  assert.equal(blob.additions, 0);

  const one = await filePatch(tmp, "kept.txt");
  assert.ok(one?.patch.includes("+three"));
  assert.ok(one?.patch.includes("+four"));
  assert.equal(one?.binary, false);

  // Untracked files have no tracked patch; they must still resolve.
  const untracked = await filePatch(tmp, "fresh.txt");
  assert.ok(untracked?.patch.includes("+new file"));

  await Bun.spawn(["rm", "-rf", tmp]).exited;
  console.log("ok");
}
