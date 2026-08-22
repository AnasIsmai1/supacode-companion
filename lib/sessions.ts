// Live Claude Code sessions, joined to the zmx session that owns them.
//
// Data source is ~/.claude/sessions/<pid>.json — an internal Claude Code file,
// not a public API. Everything that reads it lives in this module so a Claude
// Code update breaks one file. See the plan's risk #1.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ZMX } from "./zmx.ts";

const SESSIONS_DIR = join(homedir(), ".claude", "sessions");
export const SPOOL_DIR = join(homedir(), ".claude", "companion", "spool");

export type Ask = { message: string; type: string; at: number };

export type Session = {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  status: "idle" | "busy" | "shell";
  zmx: string | null; // owning zmx session name, null if not under one
  updatedAt: number;
  ask: Ask | null;
};

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

    out.push({
      pid: d.pid,
      sessionId: d.sessionId,
      cwd: d.cwd,
      name: d.name ?? d.sessionId.slice(0, 8),
      status: d.status ?? "idle",
      zmx: ownerZmx(d.pid, par, zmx),
      updatedAt: d.updatedAt ?? d.startedAt ?? 0,
      ask: readAsk(d.sessionId),
    });
  }
  return out;
}
