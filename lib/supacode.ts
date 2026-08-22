// Thin wrappers over the Supacode CLI.
//
// These need the Supacode app running — the CLI talks to /tmp/supacode-501/pid-*.
// If it is closed they fail; callers surface the error rather than guessing.

async function run(args: string[]): Promise<{ ok: boolean; out: string }> {
  const p = Bun.spawn(["supacode", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const ok = (await p.exited) === 0;
  return { ok, out: (ok ? out : err).trim() };
}

export function appRunning(): boolean {
  return Bun.spawnSync(["supacode", "socket"], { stdout: "pipe", stderr: "ignore" })
    .stdout.toString().trim().length > 0;
}

/** Start a Claude session in an existing worktree, without stealing focus. */
export function startClaude(worktreeId: string, title?: string) {
  return run([
    "tab", "new",
    "--worktree", worktreeId,
    "--input", "claude",
    ...(title ? ["--title", title] : []),
    "--background",
  ]);
}

export function newWorktree(o: {
  repo: string; branch: string; base?: string; fetch?: boolean;
}) {
  return run([
    "repo", "worktree-new",
    "--repo", o.repo,
    "--branch", o.branch,
    ...(o.base ? ["--base", o.base] : []),
    ...(o.fetch ? ["--fetch"] : []),
    "--background",
  ]);
}

/** Add a folder to Supacode as a project. */
export function openRepo(path: string) {
  return run(["repo", "open", path]);
}

/** New window (tab) in an existing worktree — works whether or not it already has one. */
export function newWindow(worktreeId: string, input = "claude", title?: string) {
  return run([
    "tab", "new",
    "--worktree", worktreeId,
    "--input", input,
    ...(title ? ["--title", title] : []),
    "--background",
  ]);
}

/** Close a tab. Quitting the shell inside a window leaves the tab in place. */
export function closeWindow(tabId: string, worktreeId?: string) {
  return run(["tab", "close", "--tab", tabId, ...(worktreeId ? ["--worktree", worktreeId] : []), "--background"]);
}

export async function repos(): Promise<{ id: string; name: string }[]> {
  const { out } = await run(["repo", "list"]);
  return out.split("\n").filter(Boolean).map((id) => ({
    id: id.trim(),
    name: decodeURIComponent(id.trim()).replace(/\/+$/, "").split("/").pop() ?? id,
  }));
}
