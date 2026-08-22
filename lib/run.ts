// Running a command in a worktree, and reading back what it printed.
//
// This does NOT supervise a process. `zmx run <name> -d` creates a detached PTY
// session and runs the command in it, so zmx owns the lifetime: a build survives
// the companion restarting, a phone locking, and the Supacode app being closed.
// Verified — `zmx run` on a name that does not exist yet prints
// `session "<name>" created`, so no `supacode tab new` is involved and the app
// is not required.
//
// zmx appends `; echo ZMX_TASK_COMPLETED:$?` to every run, which is where the
// exit code comes from. No parsing of test output, no per-tool adapters.
//
// Self-check: bun lib/run.ts

import { existsSync } from "node:fs";
import { zmx, ZMX } from "./zmx.ts";
import { buildRunPush, readConfig, send } from "./notify.ts";

/** Single-quote for bash. Worktree paths contain spaces ("Nuclear Codes"). */
export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The runner session for a worktree.
 *
 * One per worktree, reused. zmx runs commands sequentially within a session, so
 * a second tap queues behind the first instead of interleaving — which is the
 * behaviour we want and did not have to write.
 */
export function runnerName(wt: string): string {
  return `companion-run-${Bun.hash(wt).toString(36)}`;
}

export type RunState = {
  session: string;
  /** False before anything has ever been run here. */
  exists: boolean;
  running: boolean;
  /** Exit code of the last finished command, null while one is in flight. */
  exitCode: number | null;
  screen: string;
  hash: string;
};

const COMPLETED = /ZMX_TASK_COMPLETED:(\d+)/g;
/** The literal `$?` is the echoed command line; a digit is the actual result. */
const PENDING = "ZMX_TASK_COMPLETED:$?";

/**
 * Split "a command is running" from "it finished" using only the screen.
 *
 * Every run echoes `...; echo ZMX_TASK_COMPLETED:$?` and later prints
 * `ZMX_TASK_COMPLETED:<code>`. So the last echo sitting *after* the last result
 * means the command in flight has not reported yet.
 */
export function parseRunState(screen: string): { running: boolean; exitCode: number | null } {
  const lastEcho = screen.lastIndexOf(PENDING);
  let lastResult = -1;
  let code: number | null = null;
  for (const m of screen.matchAll(COMPLETED)) {
    lastResult = m.index ?? -1;
    code = Number(m[1]);
  }
  if (lastEcho < 0) return { running: false, exitCode: code };
  return lastResult > lastEcho ? { running: false, exitCode: code } : { running: true, exitCode: null };
}

async function sessionExists(name: string): Promise<boolean> {
  const { out } = await zmx(["ls", "--short"]);
  return out.split("\n").some((l) => l.trim() === name);
}

/** Start a command. Returns immediately; poll runState() for the outcome. */
export async function startRun(wt: string, command: string): Promise<{ ok: boolean; session: string; error?: string }> {
  const session = runnerName(wt);
  if (!existsSync(wt)) return { ok: false, session, error: "worktree is gone" };
  if (!command.trim()) return { ok: false, session, error: "empty command" };

  // zmx shell-quotes EVERY argv element before handing them to bash. So the
  // whole thing has to arrive as one element or `&&` becomes a literal word and
  // a pre-quoted path becomes a filename with quotes in it (both observed).
  // `bash -c <one string>` is the shape that survives that, spaces included.
  // `cd` as well as spawning with cwd: the cwd only applies when zmx CREATES the
  // session, and the session outlives any single run.
  const p = Bun.spawn([ZMX, "run", session, "-d", "bash", "-c", `cd ${q(wt)} && ${command}`], {
    cwd: wt,
    stdout: "pipe",
    stderr: "pipe",
  });
  const killer = setTimeout(() => p.kill(), 10_000);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(killer);

  if (code !== 0) return { ok: false, session, error: (err || out).trim() || "zmx run failed" };
  watchRun(wt, command, Date.now());
  return { ok: true, session };
}

/**
 * Push a notification when a detached run finishes.
 *
 * `zmx wait` exists for exactly this: it blocks until the session's task
 * completes. So no polling loop and no timer — one process parked on the thing
 * it is waiting for, and it costs nothing while idle.
 *
 * Fire and forget. A failure to notify must never affect the run itself, which
 * is already detached and none of our business once started.
 */
function watchRun(wt: string, command: string, startedAt: number): void {
  void (async () => {
    try {
      const p = Bun.spawn([ZMX, "wait", runnerName(wt)], { stdout: "ignore", stderr: "ignore" });
      // A run that outlives this is a run nobody is waiting on a push for.
      const killer = setTimeout(() => p.kill(), WATCH_MAX_MS);
      await p.exited;
      clearTimeout(killer);

      const st = await runState(wt);
      if (st.running || st.exitCode === null) return; // killed, or superseded by a newer run
      const push = buildRunPush(await readConfig(), {
        worktree: wt,
        command,
        exitCode: st.exitCode,
        seconds: Math.round((Date.now() - startedAt) / 1000),
      });
      if (push) await send(push);
    } catch {
      /* notifying is best effort; the run is what matters */
    }
  })();
}

/** Two hours: past this, a push about a build you started is just noise. */
const WATCH_MAX_MS = 2 * 60 * 60_000;

/** The runner's current screen plus whether anything is still going. */
export async function runState(wt: string): Promise<RunState> {
  const session = runnerName(wt);
  const base = { session, exists: false, running: false, exitCode: null, screen: "", hash: "0" };
  if (!(await sessionExists(session))) return base;

  const { ok, out } = await zmx(["history", session, "--vt"]);
  if (!ok) return { ...base, exists: true };
  return { session, exists: true, ...parseRunState(out), screen: out, hash: Bun.hash(out).toString(36) };
}

/** Stop whatever is running: ^C into the runner's PTY. */
export async function stopRun(wt: string): Promise<boolean> {
  return (await zmx(["send", runnerName(wt), "\x03"])).ok;
}

/**
 * The worktree's own npm scripts, offered as one-tap presets.
 *
 * Typing `bun run build` on a phone keyboard is the kind of friction that sends
 * you back to the Mac, which is the thing this is for.
 */
export async function scripts(wt: string): Promise<{ name: string; command: string }[]> {
  const pkg = Bun.file(`${wt}/package.json`);
  if (!(await pkg.exists())) return [];
  try {
    const d = (await pkg.json()) as { scripts?: Record<string, string> };
    const runner = existsSync(`${wt}/bun.lock`) || existsSync(`${wt}/bun.lockb`) ? "bun run" : "npm run";
    return Object.entries(d.scripts ?? {})
      .filter(([name]) => /^[\w:-]+$/.test(name))
      .slice(0, 12)
      .map(([name]) => ({ name, command: `${runner} ${name}` }));
  } catch {
    return [];
  }
}

if (import.meta.main) {
  const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;

  // --- shell quoting: the whole point is paths like "Nuclear Codes" ---
  assert.equal(q("/a/b c"), "'/a/b c'");
  // The POSIX idiom: close the quote, escape one quote, reopen. Not a backslash.
  assert.equal(q("it's"), `'it'\\''s'`);
  assert.equal(
    Bun.spawnSync(["bash", "-c", `printf %s ${q("it's a b")}`]).stdout.toString(),
    "it's a b",
    "quoting must survive an actual bash round trip",
  );

  // --- runner naming is stable per worktree, distinct across worktrees ---
  assert.equal(runnerName("/a/b"), runnerName("/a/b"));
  assert.notEqual(runnerName("/a/b"), runnerName("/a/c"));
  assert.ok(/^companion-run-[a-z0-9]+$/.test(runnerName("/a/b")));

  // --- run state, off the real screen shape zmx produces ---
  const finished = [
    "~/wt $ cd '/wt' && bun test; echo ZMX_TASK_COMPLETED:$?",
    "12 pass",
    "ZMX_TASK_COMPLETED:0",
    "~/wt $ ",
  ].join("\n");
  assert.deepEqual(parseRunState(finished), { running: false, exitCode: 0 });

  const failed = finished.replace("ZMX_TASK_COMPLETED:0", "ZMX_TASK_COMPLETED:1");
  assert.deepEqual(parseRunState(failed), { running: false, exitCode: 1 });

  // Mid-run: the echo is there, the result is not yet.
  const running = ["~/wt $ cd '/wt' && bun test; echo ZMX_TASK_COMPLETED:$?", "running…"].join("\n");
  assert.deepEqual(parseRunState(running), { running: true, exitCode: null });

  // A second run after a finished one: the new echo is below the old result.
  const second = [finished, "~/wt $ cd '/wt' && bun run build; echo ZMX_TASK_COMPLETED:$?", "building…"].join("\n");
  assert.deepEqual(parseRunState(second), { running: true, exitCode: null });

  // Fresh shell, nothing ever run.
  assert.deepEqual(parseRunState("~/wt $ "), { running: false, exitCode: null });

  // --- scripts(), against this repo ---
  const { fileURLToPath } = await import("node:url");
  const s = await scripts(fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, ""));
  assert.ok(s.some((x) => x.name === "check"), "should find this repo's own scripts");
  assert.ok(s.every((x) => x.command.startsWith("bun run ")), "bun.lock present -> bun run");

  assert.deepEqual(await scripts("/definitely/not/here"), []);

  // --- end to end: create a runner, run something, read the exit code ---
  const tmp = `/tmp/companion-run-selfcheck-${process.pid}`;
  await Bun.spawn(["mkdir", "-p", tmp]).exited;
  const started = await startRun(tmp, "bash -c 'echo SELFCHECK-OK; exit 3'");
  assert.equal(started.ok, true, started.error ?? "startRun failed");

  let state = await runState(tmp);
  for (let i = 0; i < 40 && (state.running || state.exitCode === null); i++) {
    await Bun.sleep(150);
    state = await runState(tmp);
  }
  assert.equal(state.exists, true);
  assert.equal(state.running, false);
  assert.equal(state.exitCode, 3, "a failing command must report its real code");
  assert.ok(state.screen.includes("SELFCHECK-OK"));

  await zmx(["kill", started.session, "--force"]);
  await Bun.spawn(["rm", "-rf", tmp]).exited;
  console.log("ok");
}
