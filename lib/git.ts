// Git operations that WRITE. Read-only lives in lib/diff.ts, deliberately in a
// separate file so it stays obviously read-only.
//
// Five operations, not fifteen. Everything here is reachable from a phone on the
// tailnet with no authentication, so the surface is kept to what actually closes
// the loop: land the work, or undo it.
//
// Rules that are not negotiable:
//   - never force-push
//   - restore is per-file; only discardAll touches the whole tree
//   - commit subjects are capped at 50 chars, and Claude is never a co-author
//
// Self-check: bun lib/git.ts

import { existsSync } from "node:fs";

export type GitResult = { ok: boolean; out: string; error?: string };

/** Longest commit subject we will write. */
export const SUBJECT_MAX = 50;

async function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<GitResult> {
  if (!existsSync(cwd)) return { ok: false, out: "", error: "worktree is gone" };
  try {
    const p = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      // Never let a credential or passphrase prompt wedge a request from a phone.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    const killer = setTimeout(() => p.kill(), timeoutMs);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    clearTimeout(killer);
    return code === 0
      ? { ok: true, out: out.trim() }
      : { ok: false, out: out.trim(), error: (err.trim() || out.trim() || `git exited ${code}`).slice(0, 500) };
  } catch {
    return { ok: false, out: "", error: "could not run git" };
  }
}

/**
 * Trim a commit message to house style.
 *
 * Subject capped at 50 (global rule), body preserved. Any Claude co-author
 * trailer is stripped rather than rejected — the message may have come from
 * Claude itself, and silently correct beats failing the commit.
 */
export function cleanMessage(raw: string): string {
  const lines = String(raw ?? "").replace(/\r/g, "").split("\n");
  const subject = (lines.shift() ?? "").trim().slice(0, SUBJECT_MAX);
  const body = lines
    .filter((l) => !/^\s*co-authored-by:.*(claude|anthropic)/i.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return body ? `${subject}\n\n${body}` : subject;
}

/** A path the client asked us to touch, or null if it tries to leave the worktree. */
export function safeRelPath(path: string): string | null {
  const p = String(path ?? "").trim();
  if (!p || p.startsWith("/") || p.startsWith("-") || p.split("/").includes("..")) return null;
  return p;
}

export type Status = {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  clean: boolean;
};

/** Branch, upstream and counts — everything the Actions tab needs to decide what to offer. */
export async function status(wt: string): Promise<Status> {
  const r = await git(wt, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]);
  const s: Status = {
    branch: null, upstream: null, ahead: 0, behind: 0,
    staged: 0, unstaged: 0, untracked: 0, clean: true,
  };
  if (!r.ok) return s;

  for (const line of r.out.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const v = line.slice("# branch.head ".length).trim();
      s.branch = v === "(detached)" ? null : v;
    } else if (line.startsWith("# branch.upstream ")) {
      s.upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) { s.ahead = Number(m[1]); s.behind = Number(m[2]); }
    } else if (line.startsWith("? ")) {
      s.untracked++;
    } else if (/^[12u] /.test(line)) {
      // porcelain=v2 XY field: first char is the index, second the worktree.
      const xy = line.split(" ")[1] ?? "..";
      if (xy[0] !== ".") s.staged++;
      if (xy[1] !== ".") s.unstaged++;
    }
  }
  s.clean = s.staged === 0 && s.unstaged === 0 && s.untracked === 0;
  return s;
}

/** Stage everything and commit. Returns the short sha. */
export async function commit(wt: string, message: string): Promise<GitResult> {
  const msg = cleanMessage(message);
  if (!msg) return { ok: false, out: "", error: "empty commit message" };

  const add = await git(wt, ["add", "-A"]);
  if (!add.ok) return add;

  const c = await git(wt, ["commit", "-m", msg]);
  if (!c.ok) {
    // "nothing to commit" is a state, not a failure the user needs a stack for.
    if (/nothing to commit|no changes added/i.test(c.out + (c.error ?? ""))) {
      return { ok: false, out: "", error: "nothing to commit" };
    }
    return c;
  }
  const sha = await git(wt, ["rev-parse", "--short", "HEAD"]);
  return { ok: true, out: sha.out };
}

/**
 * Push the current branch. Sets upstream on first push. Never forces.
 *
 * A phone is the worst place to discover you have rewritten someone's history,
 * so --force is not reachable from here at all.
 */
export async function push(wt: string): Promise<GitResult> {
  const st = await status(wt);
  if (!st.branch) return { ok: false, out: "", error: "detached HEAD — nothing to push" };
  return st.upstream
    ? git(wt, ["push"], 120_000)
    : git(wt, ["push", "-u", "origin", st.branch], 120_000);
}

/** Open a PR with gh. Pushes first if the branch has no upstream. */
export async function createPR(wt: string, title: string, body: string): Promise<GitResult> {
  const st = await status(wt);
  if (!st.branch) return { ok: false, out: "", error: "detached HEAD — nothing to open a PR for" };
  if (!st.upstream || st.ahead > 0) {
    const p = await push(wt);
    if (!p.ok) return p;
  }

  const subject = title.trim().slice(0, 120) || st.branch;
  try {
    const p = Bun.spawn(
      ["gh", "pr", "create", "--title", subject, "--body", body ?? "", "--head", st.branch],
      { cwd: wt, stdout: "pipe", stderr: "pipe", env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
    );
    const killer = setTimeout(() => p.kill(), 60_000);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    clearTimeout(killer);
    if (code === 0) return { ok: true, out: out.trim() };
    const detail = (err.trim() || out.trim()).slice(0, 500);
    // The common case by far, and the one where the useful answer is the URL.
    if (/already exists/i.test(detail)) {
      const view = await ghPrUrl(wt, st.branch);
      return view ? { ok: true, out: view } : { ok: false, out: "", error: detail };
    }
    return { ok: false, out: "", error: detail };
  } catch {
    return { ok: false, out: "", error: "gh is not installed" };
  }
}

async function ghPrUrl(wt: string, branch: string): Promise<string | null> {
  try {
    const p = Bun.spawn(["gh", "pr", "view", branch, "--json", "url", "--jq", ".url"], {
      cwd: wt, stdout: "pipe", stderr: "ignore", env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out.trim() || null : null;
  } catch {
    return null;
  }
}

/** Throw away changes to ONE file, tracked or not. */
export async function restoreFile(wt: string, path: string): Promise<GitResult> {
  const rel = safeRelPath(path);
  if (!rel) return { ok: false, out: "", error: "bad path" };

  // An untracked file has nothing to restore to; removing it is the equivalent.
  const tracked = await git(wt, ["ls-files", "--error-unmatch", "--", rel]);
  if (!tracked.ok) {
    const rm = await git(wt, ["clean", "-f", "--", rel]);
    return rm.ok ? { ok: true, out: `removed ${rel}` } : rm;
  }
  const r = await git(wt, ["restore", "--staged", "--worktree", "--", rel]);
  return r.ok ? { ok: true, out: `restored ${rel}` } : r;
}

/**
 * Throw away every uncommitted change in the worktree.
 *
 * The only whole-tree destructive operation here. Committed work is untouched —
 * this resets to HEAD, it does not rewind the branch — so the blast radius is
 * bounded to what was never committed. The UI gates it behind a typed confirm.
 */
export async function discardAll(wt: string): Promise<GitResult> {
  const reset = await git(wt, ["reset", "--hard", "HEAD"]);
  if (!reset.ok) return reset;
  const clean = await git(wt, ["clean", "-fd"]);
  return clean.ok ? { ok: true, out: "discarded all uncommitted changes" } : clean;
}

if (import.meta.main) {
  const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;

  // --- cleanMessage ---
  assert.equal(cleanMessage("short subject"), "short subject");
  assert.equal(cleanMessage("x".repeat(80)).length, SUBJECT_MAX, "subject is capped at 50");
  assert.equal(cleanMessage("subject\n\nbody line"), "subject\n\nbody line");
  assert.equal(
    cleanMessage("subject\n\nbody\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>"),
    "subject\n\nbody",
    "the Claude co-author trailer is stripped, not rejected",
  );
  assert.equal(cleanMessage("  \n\n"), "");

  // --- safeRelPath: untrusted input from a phone ---
  assert.equal(safeRelPath("lib/a.ts"), "lib/a.ts");
  assert.equal(safeRelPath("/etc/passwd"), null);
  assert.equal(safeRelPath("../../etc/passwd"), null);
  assert.equal(safeRelPath("a/../../b"), null);
  assert.equal(safeRelPath("--upload-pack=evil"), null, "a path must never be read as a flag");
  assert.equal(safeRelPath(""), null);

  // --- against a throwaway repo ---
  const tmp = `/tmp/companion-git-selfcheck-${process.pid}`;
  const sh = async (cmd: string[]) => { await Bun.spawn(cmd, { cwd: tmp, stdout: "ignore", stderr: "ignore" }).exited; };
  await Bun.spawn(["mkdir", "-p", tmp]).exited;
  await sh(["git", "init", "-q", "-b", "main"]);
  await sh(["git", "config", "user.email", "t@t"]);
  await sh(["git", "config", "user.name", "t"]);
  await Bun.write(`${tmp}/a.txt`, "one\n");
  await sh(["git", "add", "-A"]);
  await sh(["git", "commit", "-qm", "base"]);

  let st = await status(tmp);
  assert.equal(st.branch, "main");
  assert.equal(st.clean, true);
  assert.equal(st.upstream, null);

  await Bun.write(`${tmp}/a.txt`, "one\ntwo\n");
  await Bun.write(`${tmp}/new.txt`, "fresh\n");
  st = await status(tmp);
  assert.equal(st.clean, false);
  assert.equal(st.unstaged, 1);
  assert.equal(st.untracked, 1);

  // restoreFile: tracked file reverts, untracked file is removed.
  assert.equal((await restoreFile(tmp, "a.txt")).ok, true);
  assert.equal(await Bun.file(`${tmp}/a.txt`).text(), "one\n");
  assert.equal((await restoreFile(tmp, "new.txt")).ok, true);
  assert.equal(existsSync(`${tmp}/new.txt`), false);
  assert.equal((await restoreFile(tmp, "../escape")).ok, false);

  // commit
  assert.equal((await commit(tmp, "nothing here")).error, "nothing to commit");
  await Bun.write(`${tmp}/b.txt`, "two\n");
  const c = await commit(tmp, "x".repeat(90));
  assert.equal(c.ok, true);
  assert.ok(/^[0-9a-f]{7,}$/.test(c.out), "commit returns a short sha");
  const subject = await Bun.spawn(["git", "-C", tmp, "log", "-1", "--format=%s"], { stdout: "pipe" });
  assert.equal((await new Response(subject.stdout).text()).trim().length, SUBJECT_MAX);

  // push with no remote fails cleanly rather than hanging on credentials.
  const p = await push(tmp);
  assert.equal(p.ok, false);
  assert.ok(p.error);

  // discardAll drops uncommitted work and keeps commits.
  await Bun.write(`${tmp}/c.txt`, "three\n");
  await Bun.write(`${tmp}/b.txt`, "changed\n");
  assert.equal((await discardAll(tmp)).ok, true);
  assert.equal(existsSync(`${tmp}/c.txt`), false);
  assert.equal(await Bun.file(`${tmp}/b.txt`).text(), "two\n");
  assert.equal((await status(tmp)).clean, true);

  await Bun.spawn(["rm", "-rf", tmp]).exited;
  console.log("ok");
}
