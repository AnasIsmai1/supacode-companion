// Live Claude Code sessions, joined to the zmx session that owns them.
//
// Data source is ~/.claude/sessions/<pid>.json — an internal Claude Code file,
// not a public API. Everything that reads it lives in this module so a Claude
// Code update breaks one file. See the plan's risk #1.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ZMX } from "./zmx.ts";

const SESSIONS_DIR = join(homedir(), ".claude", "sessions");
export const SPOOL_DIR = join(homedir(), ".claude", "companion", "spool");
const EVENTS_DIR = join(homedir(), ".claude", "companion", "events");

export type Ask = { message: string; type: string; at: number };

export type Session = {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  status: "idle" | "busy" | "shell";
  zmx: string | null; // owning zmx session name, null if not under one
  updatedAt: number;
  /** When the status last changed — how long it has been busy. */
  statusUpdatedAt: number;
  ask: Ask | null;
  /** ms it has been busy with nothing written, or null. See stuckFor(). */
  stuck: number | null;
};

/**
 * How long a session has been busy without doing anything, or null.
 *
 * "Busy" alone tells you nothing, and that is the one thing a status field
 * cannot say. Found immediately on switching this on: two sessions had been
 * reporting `busy` for 37 and 18 hours.
 *
 * `updatedAt` alone is the wrong clock. It moves at turn boundaries, so a
 * genuinely healthy session running a long turn looks identical to a wedged one
 * — verified against this very session, which read 5 minutes quiet while
 * actively running tools. hooks/events.sh appends on EVERY PreToolUse and
 * PostToolUse, so the events file's mtime is the real heartbeat. Fall back to
 * updatedAt only when no events file exists yet.
 *
 * Deliberately a duration, not a boolean: the caller picks the threshold, and
 * the UI can show "37h" rather than a binary that hides how bad it is.
 */
export function stuckFor(
  status: string,
  updatedAt: number,
  lastActivity = 0,
  now = Date.now(),
): number | null {
  if (status !== "busy") return null;
  // With a heartbeat we know each tool call; without one, all we have is the
  // turn boundary, which cannot tell a long turn from a wedge. So the blind
  // path gets a far higher bar rather than crying wolf at every long build.
  const beat = lastActivity || updatedAt;
  if (!beat) return null;
  const bar = lastActivity ? STUCK_MS : STUCK_BLIND_MS;
  const quiet = now - beat;
  return quiet >= bar ? quiet : null;
}

/** mtime of the hook event stream — a heartbeat per tool call, not per turn. */
function heartbeat(sessionId: string): number {
  try {
    return statSync(join(EVENTS_DIR, `${sessionId}.jsonl`)).mtimeMs;
  } catch {
    return 0; // no events yet; caller falls back to updatedAt
  }
}

/** Below this, a quiet busy session is just a normal tool call. */
export const STUCK_MS = 4 * 60_000;

/**
 * The bar when there is no heartbeat to go on.
 *
 * Claude Code caches hooks at session start, so a session running since before
 * hooks/events.sh was registered will never produce events. For those, all we
 * have is `updatedAt` — the turn boundary — and a 30-minute turn is plausible
 * while a 30-minute silence with no turn end is not. Sessions started after
 * registration get the accurate 4-minute bar automatically.
 */
export const STUCK_BLIND_MS = 30 * 60_000;

/** Strip ANSI escapes and control chars. Moved from bin/sup. */
export function clean(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b[()][AB0]/g, "");
}

/** Parse one `zmx ls` line: tab-separated k=v pairs. Moved from bin/sup. */
export function field(key: string, line: string): string | null {
  for (const part of line.replace(/^[→\s]*/, "").split("\t")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === key) return part.slice(i + 1);
  }
  return null;
}

// Async on purpose: spawnSync blocks Bun's event loop, and `zmx ls` across ~30
// sessions costs over a second — long enough for polls to queue behind it.
async function sh(cmd: string[]): Promise<string> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    const killer = setTimeout(() => p.kill(), 10_000);
    const out = await new Response(p.stdout).text();
    await p.exited;
    clearTimeout(killer);
    return out;
  } catch {
    return "";
  }
}

/** zmx shell pid -> session name. */
async function zmxByPid(): Promise<Map<number, string>> {
  const m = new Map<number, string>();
  for (const line of (await sh([ZMX, "ls"])).split("\n")) {
    const name = field("name", line);
    const pid = field("pid", line);
    if (name && pid) m.set(Number(pid), name);
  }
  return m;
}

/** pid -> ppid, for the whole process table. */
async function parentMap(): Promise<Map<number, number>> {
  const m = new Map<number, number>();
  for (const line of (await sh(["ps", "-eo", "pid,ppid"])).split("\n").slice(1)) {
    const [pid, ppid] = line.trim().split(/\s+/);
    if (pid && ppid) m.set(Number(pid), Number(ppid));
  }
  return m;
}

/** Walk up the process tree until we hit a pid that owns a zmx session. */
function ownerZmx(pid: number, par: Map<number, number>, zmx: Map<number, string>): string | null {
  let p: number | undefined = pid;
  for (let hops = 0; p && p !== 1 && hops < 20; hops++) {
    const name = zmx.get(p);
    if (name) return name;
    p = par.get(p);
  }
  return null;
}

function readAsk(sessionId: string): Ask | null {
  const f = join(SPOOL_DIR, `${sessionId}.json`);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8")) as Ask;
  } catch {
    return null;
  }
}

const TTL_MS = 3_000;
let cache: { at: number; value: Session[] } | null = null;
let inflight: Promise<Session[]> | null = null;

/** Cached briefly so a 3s UI poll never queues behind the previous scan. */
export async function listSessions(force = false): Promise<Session[]> {
  const fresh = cache && Date.now() - cache.at < TTL_MS;
  if (!force && fresh) return cache!.value;
  // Stale-while-revalidate: a poll never waits on a rescan once we have data.
  const run = (inflight ??= refresh());
  return cache && !force ? cache.value : run;
}

function refresh(): Promise<Session[]> {
  return scanSessions()
    .then((v) => { cache = { at: Date.now(), value: v }; return v; })
    .catch((e) => { if (cache) return cache.value; throw e; })
    .finally(() => { inflight = null; });
}

async function scanSessions(): Promise<Session[]> {
  if (!existsSync(SESSIONS_DIR)) return [];
  const [par, zmx] = await Promise.all([parentMap(), zmxByPid()]);
  const out: Session[] = [];

  for (const f of readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith(".json")) continue;
    let d: any;
    try {
      d = JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf8"));
    } catch {
      continue;
    }
    if (d.kind === "bg") continue; // background agents have no zmx session
    if (!par.has(d.pid)) continue; // stale record, process is gone

    const status = d.status ?? "idle";
    const updatedAt = d.updatedAt ?? d.startedAt ?? 0;
    out.push({
      pid: d.pid,
      sessionId: d.sessionId,
      cwd: d.cwd,
      name: d.name ?? d.sessionId.slice(0, 8),
      status,
      zmx: ownerZmx(d.pid, par, zmx),
      updatedAt,
      statusUpdatedAt: d.statusUpdatedAt ?? updatedAt,
      ask: readAsk(d.sessionId),
      stuck: stuckFor(status, updatedAt, heartbeat(d.sessionId)),
    });
  }
  return out;
}
