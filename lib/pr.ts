// The pull request for a worktree's branch.
//
// Everything Claude does eventually has to land, and the landing happens on
// GitHub. Supacode's own sidebar shows PR state, checks and merge readiness per
// worktree; this is the same information on a phone, plus the two things you
// actually want to do with it: read the review and answer it.
//
// All of it goes through `gh`, which is already authenticated and already used
// by lib/git.ts for `pr create`. No token handling here, and no GitHub API
// client to keep current.
//
// Self-check: bun lib/pr.ts

import { existsSync } from "node:fs";

/** One gh call is ~1s against the network, so the whole view is cached. */
const TTL_MS = 30_000;
/**
 * Failures expire faster than successes.
 *
 * A wrong gh account, a dropped network or an unauthenticated shell all land
 * here, and holding that answer for the full TTL means fixing the cause and
 * still being told it is broken for another half minute. A success is stable;
 * a failure is usually something you are actively fixing.
 */
const ERROR_TTL_MS = 5_000;
const cache = new Map<string, { at: number; value: Result }>();

/**
 * "No PR" and "you cannot see this repo" are different answers.
 *
 * gh is authenticated as ONE account at a time. With a personal account active,
 * every work repo returns a resolution failure, which collapsed into a blank
 * "no pull request" and looked like the feature was broken. Observed directly:
 * `Could not resolve to a Repository with the name Sledge-AI/sledge-ai` while
 * signed in as a personal account.
 */
export type Result = { pr: PullRequest | null; error?: string };

export type CheckState = "pass" | "fail" | "pending" | "none";

export type Check = { name: string; state: CheckState; url: string | null };

export type Comment = {
  author: string;
  body: string;
  at: number;
  /** Set for review comments, which hang off a file rather than the PR. */
  path?: string;
  line?: number;
  /** "COMMENTED" | "APPROVED" | "CHANGES_REQUESTED" for review bodies. */
  state?: string;
};

export type PullRequest = {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  branch: string;
  base: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** GitHub's own verdict: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null. */
  reviewDecision: string | null;
  /** MERGEABLE, CONFLICTING, UNKNOWN. */
  mergeable: string;
  checks: Check[];
  checkState: CheckState;
  comments: Comment[];
};

async function gh(cwd: string, args: string[], timeoutMs = 30_000): Promise<{ ok: boolean; out: string; err: string }> {
  if (!existsSync(cwd)) return { ok: false, out: "", err: "worktree is gone" };
  try {
    const p = Bun.spawn(["gh", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" },
    });
    const killer = setTimeout(() => p.kill(), timeoutMs);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    clearTimeout(killer);
    return { ok: code === 0, out, err: err.trim() };
  } catch {
    return { ok: false, out: "", err: "gh is not installed" };
  }
}

/**
 * Roll many check runs into one word.
 *
 * A single failure outranks any number of passes: the only thing you want to
 * know on a phone is whether it is safe to merge, and one red check means no.
 * Pending outranks pass for the same reason.
 */
export function rollUp(checks: Check[]): CheckState {
  if (!checks.length) return "none";
  if (checks.some((c) => c.state === "fail")) return "fail";
  if (checks.some((c) => c.state === "pending")) return "pending";
  return "pass";
}

/** gh reports conclusion and status separately, and only one of them is set. */
export function checkState(conclusion: string | null | undefined, status: string | null | undefined): CheckState {
  const c = (conclusion ?? "").toUpperCase();
  if (c === "SUCCESS" || c === "NEUTRAL" || c === "SKIPPED") return "pass";
  if (c === "FAILURE" || c === "TIMED_OUT" || c === "CANCELLED" || c === "ACTION_REQUIRED" || c === "STARTUP_FAILURE") return "fail";
  const s = (status ?? "").toUpperCase();
  if (s === "COMPLETED") return "pass"; // completed with no conclusion recorded
  return s ? "pending" : "none";
}

const ts = (v: unknown) => (typeof v === "string" ? Date.parse(v) || 0 : 0);

/** Parse `gh pr view --json` into our shape. Split out so a fixture can drive it. */
export function parsePR(raw: any): PullRequest | null {
  if (!raw || typeof raw.number !== "number") return null;

  const checks: Check[] = (raw.statusCheckRollup ?? [])
    .map((c: any) => ({
      name: String(c.name ?? c.context ?? "check"),
      state: checkState(c.conclusion ?? c.state, c.status),
      url: c.detailsUrl ?? c.targetUrl ?? null,
    }))
    .slice(0, 30);

  const comments: Comment[] = [];
  for (const c of raw.comments ?? []) {
    if (!String(c.body ?? "").trim()) continue;
    comments.push({ author: c.author?.login ?? "?", body: String(c.body), at: ts(c.createdAt) });
  }
  for (const r of raw.reviews ?? []) {
    // A review with no body is just a verdict; its state still matters.
    if (!String(r.body ?? "").trim() && r.state === "COMMENTED") continue;
    comments.push({
      author: r.author?.login ?? "?",
      body: String(r.body ?? ""),
      at: ts(r.submittedAt),
      state: r.state,
    });
  }
  comments.sort((a, b) => a.at - b.at);

  return {
    number: raw.number,
    title: String(raw.title ?? ""),
    url: String(raw.url ?? ""),
    state: String(raw.state ?? "OPEN"),
    isDraft: Boolean(raw.isDraft),
    branch: String(raw.headRefName ?? ""),
    base: String(raw.baseRefName ?? ""),
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    changedFiles: raw.changedFiles ?? 0,
    reviewDecision: raw.reviewDecision || null,
    mergeable: String(raw.mergeable ?? "UNKNOWN"),
    checks,
    checkState: rollUp(checks),
    comments,
  };
}

const FIELDS = [
  "number", "title", "url", "state", "isDraft", "headRefName", "baseRefName",
  "additions", "deletions", "changedFiles", "reviewDecision", "mergeable",
  "statusCheckRollup", "comments", "reviews",
].join(",");

/** Tell a missing PR apart from a repo this account cannot see. */
export function classify(err: string): string | null {
  if (/no pull requests found|no open pull requests/i.test(err)) return null;
  if (/could not resolve to a repository|not found/i.test(err)) return "not authorized for this repository";
  if (/no git remote|not a git repository/i.test(err)) return null;
  if (/gh auth login|authentication/i.test(err)) return "gh is not authenticated";
  if (/gh is not installed/i.test(err)) return "gh is not installed";
  return err.split("\n")[0].slice(0, 160) || null;
}

/** The PR for this worktree's branch. */
export async function view(wt: string, force = false): Promise<Result> {
  const hit = cache.get(wt);
  const ttl = hit?.value.error ? ERROR_TTL_MS : TTL_MS;
  if (!force && hit && Date.now() - hit.at < ttl) return hit.value;

  const r = await gh(wt, ["pr", "view", "--json", FIELDS]);
  let value: Result;
  if (r.ok) {
    value = { pr: parsePR(JSON.parse(r.out || "null")) };
  } else {
    const error = classify(r.err);
    value = error ? { pr: null, error } : { pr: null };
  }
  cache.set(wt, { at: Date.now(), value });
  return value;
}

/** Post a comment on the PR. The reply half of reading a review on a phone. */
export async function comment(wt: string, body: string): Promise<{ ok: boolean; out: string; error?: string }> {
  if (!body.trim()) return { ok: false, out: "", error: "empty comment" };
  const r = await gh(wt, ["pr", "comment", "--body", body]);
  cache.delete(wt);
  return r.ok ? { ok: true, out: r.out.trim() } : { ok: false, out: "", error: r.err || "gh pr comment failed" };
}

export type MergeMethod = "merge" | "squash" | "rebase";

/**
 * Merge the PR.
 *
 * The most consequential thing reachable from the phone, so it refuses rather
 * than forces: no admin override, and a PR that GitHub reports as unmergeable
 * or failing is stopped here before `gh` is even called. Deleting the branch is
 * left to whatever the repository already does on merge.
 */
export async function merge(
  wt: string,
  method: MergeMethod = "squash",
  opts: { allowFailingChecks?: boolean } = {},
): Promise<{ ok: boolean; out: string; error?: string }> {
  const { pr, error } = await view(wt, true);
  if (error) return { ok: false, out: "", error };
  if (!pr) return { ok: false, out: "", error: "no pull request for this branch" };
  if (pr.state !== "OPEN") return { ok: false, out: "", error: `pull request is ${pr.state.toLowerCase()}` };
  if (pr.isDraft) return { ok: false, out: "", error: "pull request is a draft" };
  if (pr.mergeable === "CONFLICTING") return { ok: false, out: "", error: "branch has conflicts" };
  if (pr.checkState === "fail" && !opts.allowFailingChecks) {
    return { ok: false, out: "", error: "checks are failing" };
  }
  if (pr.checkState === "pending" && !opts.allowFailingChecks) {
    return { ok: false, out: "", error: "checks are still running" };
  }

  const r = await gh(wt, ["pr", "merge", `--${method}`], 120_000);
  cache.delete(wt);
  return r.ok ? { ok: true, out: `merged #${pr.number}` } : { ok: false, out: "", error: r.err || "gh pr merge failed" };
}

if (import.meta.main) {
  const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;

  // --- checkState: gh sets conclusion OR status, never reliably both ---
  assert.equal(checkState("SUCCESS", "COMPLETED"), "pass");
  assert.equal(checkState("SKIPPED", "COMPLETED"), "pass", "a skipped check is not a failure");
  assert.equal(checkState("NEUTRAL", "COMPLETED"), "pass");
  assert.equal(checkState("FAILURE", "COMPLETED"), "fail");
  assert.equal(checkState("TIMED_OUT", "COMPLETED"), "fail");
  assert.equal(checkState("CANCELLED", "COMPLETED"), "fail");
  assert.equal(checkState(null, "IN_PROGRESS"), "pending");
  assert.equal(checkState(null, "QUEUED"), "pending");
  assert.equal(checkState(null, null), "none");
  assert.equal(checkState("", "COMPLETED"), "pass", "completed with no conclusion");

  // --- rollUp: one red outranks any number of greens ---
  const c = (state: CheckState, name = "x"): Check => ({ name, state, url: null });
  assert.equal(rollUp([]), "none");
  assert.equal(rollUp([c("pass"), c("pass")]), "pass");
  assert.equal(rollUp([c("pass"), c("fail"), c("pending")]), "fail", "any failure means do not merge");
  assert.equal(rollUp([c("pass"), c("pending")]), "pending", "pending outranks pass");

  // --- parsePR against the shape gh actually returns ---
  const raw = {
    number: 42,
    title: "Fix the login redirect",
    url: "https://github.com/o/r/pull/42",
    state: "OPEN",
    isDraft: false,
    headRefName: "fix-login",
    baseRefName: "main",
    additions: 120,
    deletions: 8,
    changedFiles: 3,
    reviewDecision: "CHANGES_REQUESTED",
    mergeable: "MERGEABLE",
    statusCheckRollup: [
      { name: "build", conclusion: "SUCCESS", status: "COMPLETED", detailsUrl: "https://ci/1" },
      { name: "test", conclusion: "FAILURE", status: "COMPLETED", detailsUrl: "https://ci/2" },
    ],
    comments: [
      { author: { login: "alice" }, body: "this needs a test", createdAt: "2026-08-22T09:00:00Z" },
      { author: { login: "bob" }, body: "   ", createdAt: "2026-08-22T09:30:00Z" },
    ],
    reviews: [
      { author: { login: "carol" }, body: "see inline", state: "CHANGES_REQUESTED", submittedAt: "2026-08-22T08:00:00Z" },
      { author: { login: "dave" }, body: "", state: "APPROVED", submittedAt: "2026-08-22T10:00:00Z" },
      { author: { login: "erin" }, body: "", state: "COMMENTED", submittedAt: "2026-08-22T11:00:00Z" },
    ],
  };
  const pr = parsePR(raw)!;
  assert.equal(pr.number, 42);
  assert.equal(pr.checkState, "fail", "one failing check sinks the rollup");
  assert.equal(pr.checks.length, 2);
  assert.equal(pr.reviewDecision, "CHANGES_REQUESTED");

  // Empty bodies are dropped, but an empty APPROVED review still carries a verdict.
  const authors = pr.comments.map((x) => x.author);
  assert.deepEqual(authors, ["carol", "alice", "dave"], "sorted oldest first, blanks dropped, verdicts kept");
  assert.equal(pr.comments.find((x) => x.author === "dave")!.state, "APPROVED");

  assert.equal(parsePR(null), null);
  assert.equal(parsePR({}), null, "no number means gh found no PR");

  // --- merge refuses rather than forces ---
  const tmp = `/tmp/companion-pr-selfcheck-${process.pid}`;
  await Bun.spawn(["mkdir", "-p", tmp]).exited;
  // No git remote, so gh cannot find a PR. Must fail cleanly, not hang or throw.
  const m = await merge(tmp);
  assert.equal(m.ok, false);
  assert.equal(m.error, "no pull request for this branch");
  assert.deepEqual(await view(tmp, true), { pr: null });

  // --- classify: a blank answer must not hide an auth failure ---
  assert.equal(classify("no pull requests found for branch \"x\""), null, "genuinely no PR");
  assert.equal(
    classify("GraphQL: Could not resolve to a Repository with the name 'Sledge-AI/sledge-ai'. (repository)"),
    "not authorized for this repository",
    "wrong gh account reads as unauthorized, not as an empty result",
  );
  assert.equal(classify("gh is not installed"), "gh is not installed");
  assert.equal(classify("fatal: not a git repository"), null);

  // A failure must not be held as long as a success: you are usually mid-fix.
  assert.ok(ERROR_TTL_MS < TTL_MS, "errors expire sooner than results");
  assert.equal((await comment(tmp, "  ")).error, "empty comment");
  await Bun.spawn(["rm", "-rf", tmp]).exited;

  console.log("ok");
}
