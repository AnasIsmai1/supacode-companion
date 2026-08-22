// Subagents of a session.
//
// Each Task the session launches gets its own transcript at
//   ~/.claude/projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl
// which carries the task prompt it was given and every tool it has run. Without
// this the UI shows a session as simply "busy" while three agents work under it,
// with no way to see what they are doing.

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { transcriptPath } from "./transcript.ts";

const TAIL_BYTES = 256 * 1024;
/** Nothing written for this long means it is almost certainly finished. */
const ACTIVE_WINDOW_MS = 45_000;

export type Agent = {
  id: string;
  task: string;
  tools: number;
  lastTool: string | null;
  updatedAt: number;
  active: boolean;
};

function summarise(name: string, input: any): string {
  if (!input) return name;
  const f = input.file_path ?? input.path;
  if (f) return `${name} ${String(f).split("/").pop()}`;
  if (name === "Bash" && input.description) return String(input.description).slice(0, 60);
  return name;
}

function readAgent(file: string): Agent | null {
  const id = file.split("/").pop()?.replace(/^agent-|\.jsonl$/g, "") ?? "";
  if (!id) return null;

  const f = Bun.file(file);
  const size = f.size;
  // Only the head carries the task prompt, so read that separately from the tail.
  let task = "";
  let tools = 0;
  let lastTool: string | null = null;

  const text = readFileSync(file, "utf8");
  const lines = text.length > TAIL_BYTES ? text.slice(0, 40_000).split("\n").concat(text.slice(-TAIL_BYTES).split("\n")) : text.split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    const m = d.message ?? {};
    if (!task && d.type === "user") {
      const c = m.content;
      const t = typeof c === "string" ? c : (c ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join(" ");
      // The prompt opens with the role sentence; the next line is the real subject.
      const first = String(t).split("\n").find((l) => l.trim().length > 12)?.trim() ?? "";
      // Prompts open with "You are <doing X> in <path>" — keep the doing part.
      task = first.replace(/^You are\s+/i, "").replace(/\s+in\s+\/[^\s]*.*$/, "").slice(0, 80);
    }
    for (const b of m.content ?? []) {
      if (b?.type === "tool_use") { tools++; lastTool = summarise(b.name, b.input); }
    }
  }

  const updatedAt = statSync(file).mtimeMs;
  return { id, task, tools, lastTool, updatedAt, active: Date.now() - updatedAt < ACTIVE_WINDOW_MS };
}

export async function agentsFor(sessionId: string): Promise<Agent[]> {
  const t = await transcriptPath(sessionId);
  if (!t) return [];
  // <project>/<sessionId>.jsonl  ->  <project>/<sessionId>/subagents/
  const dir = join(dirname(t), sessionId, "subagents");
  if (!existsSync(dir)) return [];

  const out: Agent[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) continue;
    try {
      const a = readAgent(join(dir, name));
      if (a) out.push(a);
    } catch { /* mid-write */ }
  }
  // Running first, then most recently active.
  return out.sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt - a.updatedAt);
}
