// Live session events, pushed by hooks instead of pulled off the transcript.
//
// readState() and readChat() both re-read the transcript, which Claude Code
// writes asynchronously — a prompt typed on the Mac can sit invisible for a
// beat, and a tool that is still running has left no record at all. hooks/
// events.sh writes one JSONL line the instant each hook fires, so this is the
// only source that is current. Same tail-read as state.ts; watch eventsPath()
// with fs.watch to get a push instead of a poll.

import { homedir } from "node:os";
import { join } from "node:path";

export const EVENTS_DIR = join(homedir(), ".claude", "companion", "events");

const TAIL_BYTES = 128 * 1024;

export type EventKind = "prompt" | "pre" | "post" | "stop";

export type SessionEvent = {
  /** ms epoch, same units as the spool's `at`. */
  at: number;
  ev: EventKind;
  /** prompt: what the user submitted. stop: the turn's last assistant message. */
  text?: string;
  /** pre/post only. */
  tool?: string;
  /** File basename, bash description or pattern — the same token toolLabel() picks. */
  info?: string;
  /** tool_use_id, so a `pre` can be paired with its `post`. */
  id?: string;
  /** post only: tool duration. */
  ms?: number;
  /** post only: set from PostToolUseFailure. A successful PostToolUse has none. */
  error?: string;
  /** Set when the event came from inside a subagent. */
  agent?: string;
};

/** The file to fs.watch. May not exist yet — watch EVENTS_DIR for that case. */
export function eventsPath(sessionId: string): string {
  return join(EVENTS_DIR, `${sessionId}.jsonl`);
}

/** The last `limit` events for a session, oldest first. Empty if none yet. */
export async function readEvents(sessionId: string, limit = 50): Promise<SessionEvent[]> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return []; // untrusted input -> no path escape

  const file = Bun.file(eventsPath(sessionId));
  const size = file.size;
  if (!size) return [];

  const text = await (size > TAIL_BYTES ? file.slice(size - TAIL_BYTES) : file).text();
  const lines = text.split("\n");
  if (size > TAIL_BYTES) lines.shift(); // the slice cut a line in half

  const out: SessionEvent[] = [];
  for (const line of lines.slice(-limit - 8)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      // A torn line from a concurrent append parses as anything; require ours.
      if (typeof e?.at === "number" && typeof e?.ev === "string") out.push(e);
    } catch { continue; }
  }
  return out.slice(-limit);
}

/**
 * The tool that is running RIGHT NOW, if any.
 *
 * A `pre` with no matching `post` is a tool still in flight. This is the whole
 * reason the hook stream exists: readState() cannot see it, because Claude Code
 * does not flush the assistant message until the turn ends, so a four-minute
 * build is indistinguishable from a hang.
 */
export function liveTool(events: SessionEvent[]): { tool: string; info?: string; since: number } | null {
  const done = new Set<string>();
  for (const e of events) if (e.ev === "post" && e.id) done.add(e.id);

  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    // A turn that has ended cannot have a tool in flight, whatever came before.
    if (e.ev === "stop") return null;
    if (e.ev === "pre" && e.tool && !(e.id && done.has(e.id))) {
      return { tool: e.tool, info: e.info, since: e.at };
    }
  }
  return null;
}
