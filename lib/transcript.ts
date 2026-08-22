// Read a Claude Code session transcript into phone-renderable turns.
//
// Transcripts live at ~/.claude/projects/<slug>/<sessionId>.jsonl. We glob for
// the uuid rather than recomputing Claude Code's cwd->slug rule, which is one
// less thing to keep in sync.
//
// Caveat from the docs: the transcript is written asynchronously and can lag the
// live conversation by a beat. Accepted — see the plan's risk #6.

import { Glob } from "bun";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECTS = join(homedir(), ".claude", "projects");
const TAIL_BYTES = 512 * 1024;

export type Choice = { label: string; description?: string };
export type Question = { header?: string; question: string; options: Choice[]; multiSelect?: boolean };

export type Tool = { name: string; summary: string };

export type Turn = {
  role: "user" | "assistant";
  text: string;
  tools: Tool[];
  /** Set when a tool came back with is_error — the thing you'd otherwise open a terminal to find. */
  error: string | null;
  /** AskUserQuestion payload. v1 discarded tool_use.input, so questions were invisible. */
  questions: Question[] | null;
  toolUseId: string | null;
  ts: number;
  uuid: string;
};

const pathCache = new Map<string, string>();

export async function transcriptPath(sessionId: string): Promise<string | null> {
  const hit = pathCache.get(sessionId);
  if (hit) return hit;
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null; // untrusted input -> no glob injection
  for await (const f of new Glob(`*/${sessionId}.jsonl`).scan({ cwd: PROJECTS, absolute: true })) {
    pathCache.set(sessionId, f);
    return f;
  }
  return null;
}

/** What a tool call is actually doing, in one line. v3 kept only the name, which
 *  meant "Edit" told you nothing about which file. */
function summarise(name: string, input: any): string {
  if (!input) return "";
  const f = input.file_path ?? input.path ?? input.notebook_path;
  if (f) return String(f).split("/").slice(-2).join("/");
  if (name === "Bash") return String(input.description ?? input.command ?? "").slice(0, 70);
  if (input.pattern) return String(input.pattern).slice(0, 50);
  if (input.query) return String(input.query).slice(0, 50);
  if (input.url) return String(input.url).slice(0, 60);
  if (input.prompt) return String(input.prompt).slice(0, 60);
  return "";
}

/** Flatten a message's content blocks. Returns null for turns not worth showing. */
function toTurn(d: any): Turn | null {
  const m = d?.message;
  if (!m || (d.type !== "user" && d.type !== "assistant")) return null;

  const parts: string[] = [];
  const tools: Tool[] = [];
  let questions: Question[] | null = null;
  let toolUseId: string | null = null;
  const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? [];

  for (const b of blocks) {
    if (b.type === "text" && b.text?.trim()) parts.push(b.text);
    else if (b.type === "tool_use") {
      tools.push({ name: b.name, summary: summarise(b.name, b.input) });
      if (b.name === "AskUserQuestion" && Array.isArray(b.input?.questions)) {
        questions = b.input.questions;
        toolUseId = b.id ?? null;
      }
    } else if (b.type === "tool_result") {
      // Tool plumbing, except two things worth surfacing: the id that answers a
      // question, and a failure — otherwise you must open a terminal to find out
      // that anything went wrong.
      const body = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
      return b.tool_use_id || b.is_error
        ? {
            role: "user", text: "", tools: [], questions: null,
            error: b.is_error ? body.slice(0, 400) : null,
            toolUseId: b.tool_use_id ?? null,
            ts: Date.parse(d.timestamp ?? "") || 0, uuid: d.uuid ?? "",
          }
        : null;
    }
  }
  if (!parts.length && !tools.length) return null;

  return {
    role: d.type,
    text: parts.join("\n\n"),
    tools,
    error: null,
    questions,
    toolUseId,
    ts: Date.parse(d.timestamp ?? "") || 0,
    uuid: d.uuid ?? "",
  };
}

/** Last `n` renderable turns. Reads only the tail of the file. */
export async function readChat(sessionId: string, n = 40): Promise<Turn[]> {
  const path = await transcriptPath(sessionId);
  if (!path) return [];

  const file = Bun.file(path);
  const size = file.size;
  const text = await (size > TAIL_BYTES ? file.slice(size - TAIL_BYTES) : file).text();

  const lines = text.split("\n");
  if (size > TAIL_BYTES) lines.shift(); // first line is a partial record

  const turns: Turn[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const t = toTurn(JSON.parse(line));
      if (t) turns.push(t);
    } catch {
      /* truncated or malformed record */
    }
  }
  return turns.slice(-n);
}
