// Session state, read from the transcript instead of scraped off the TUI.
//
// Claude Code writes permission mode, editor mode, title, queued messages, the
// model and full token usage as first-class JSONL records. v3 scraped the
// statusline for the mode at 576ms a call, polled every 6s, for a fact that was
// already on disk. This reads the same tail readChat() already reads.

import { transcriptPath } from "./transcript.ts";

const TAIL_BYTES = 512 * 1024;

export type Usage = { used: number; max: number; percent: number };

export type SessionState = {
  permissionMode: string | null;
  editorMode: string | null;
  title: string | null;
  model: string | null;
  /** Set when the last two assistant turns used different models. */
  modelChangedFrom: string | null;
  usage: Usage | null;
  queued: string[];
  /** Timestamp of the most recent assistant activity, for elapsed-time display. */
  lastActivity: number | null;
  lastTool: string | null;
  /** What you typed before, newest first — Claude Code's own prompt history. */
  prompts: string[];
};

const EMPTY: SessionState = {
  permissionMode: null, editorMode: null, title: null, model: null,
  modelChangedFrom: null, usage: null, queued: [], lastActivity: null, lastTool: null, prompts: [],
};

/** Context limit by model. Claude Code shows "375k/1m (37%)" against this. */
function limitFor(model: string | null): number {
  if (!model) return 1_000_000;
  if (model.includes("haiku")) return 200_000;
  return 1_000_000;
}

/** One tool_use block reduced to something readable in a status line. */
function toolLabel(name: string, input: any): string {
  const f = input?.file_path ?? input?.path ?? input?.notebook_path;
  if (f) return `${name} ${String(f).split("/").pop()}`;
  if (name === "Bash" && input?.description) return String(input.description).slice(0, 48);
  if (input?.pattern) return `${name} ${String(input.pattern).slice(0, 32)}`;
  return name;
}

export async function readState(sessionId: string): Promise<SessionState> {
  const path = await transcriptPath(sessionId);
  if (!path) return EMPTY;

  const file = Bun.file(path);
  const size = file.size;
  const text = await (size > TAIL_BYTES ? file.slice(size - TAIL_BYTES) : file).text();
  const lines = text.split("\n");
  if (size > TAIL_BYTES) lines.shift();

  const s: SessionState = { ...EMPTY, queued: [], prompts: [] };
  // `last-prompt` is Claude Code's own record of what the user typed. Unlike the
  // raw user turns it excludes injected task notifications and tool results.
  const queue = new Map<string, string>();
  const models: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }

    switch (d.type) {
      case "permission-mode": s.permissionMode = d.permissionMode ?? null; continue;
      case "mode": s.editorMode = d.mode ?? null; continue;
      case "ai-title": s.title = d.aiTitle ?? s.title; continue;
      case "agent-name": s.title = d.agentName ?? s.title; continue;
      case "queue-operation":
        // add/remove pairs; whatever is left unremoved is still queued.
        if (d.operation === "remove") queue.delete(d.content);
        else if (d.content) queue.set(d.content, d.content);
        continue;
    }

    if (d.type !== "assistant") continue;
    const m = d.message ?? {};
    if (m.model) models.push(m.model);
    if (m.usage) {
      const u = m.usage;
      const used = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      const max = limitFor(m.model ?? s.model);
      s.usage = { used, max, percent: Math.round((used / max) * 100) };
    }
    const ts = Date.parse(d.timestamp ?? "");
    if (ts) s.lastActivity = ts;
    for (const b of m.content ?? []) {
      if (b?.type === "tool_use") s.lastTool = toolLabel(b.name, b.input);
    }
  }

  s.model = models.at(-1) ?? null;
  const prev = [...models].reverse().find((x) => x !== s.model) ?? null;
  // Only a genuine switch, not just any earlier model in the tail.
  s.modelChangedFrom = prev && models.at(-2) && models.at(-2) !== s.model ? models.at(-2)! : null;
  s.queued = [...queue.values()];
  s.prompts = await readPrompts(sessionId);
  return s;
}


/**
 * Prompt history, read separately from the hot path.
 *
 * The 512KB tail readState uses only reaches the last few prompts, but history
 * changes only when you send something — so it gets a wider read and a longer
 * cache instead of making every 3s poll parse megabytes.
 */
const HISTORY_BYTES = 8 * 1024 * 1024;
const HISTORY_TTL_MS = 60_000;
const historyCache = new Map<string, { at: number; value: string[] }>();

export async function readPrompts(sessionId: string): Promise<string[]> {
  const hit = historyCache.get(sessionId);
  if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return hit.value;

  const path = await transcriptPath(sessionId);
  if (!path) return [];
  const file = Bun.file(path);
  const size = file.size;
  const text = await (size > HISTORY_BYTES ? file.slice(size - HISTORY_BYTES) : file).text();

  const found: string[] = [];
  for (const line of text.split("\n")) {
    // Cheap pre-filter: parsing every line of a multi-megabyte transcript is the
    // expensive part, and only one record type matters here.
    if (!line.includes('"last-prompt"')) continue;
    try {
      const d = JSON.parse(line);
      const v = String(d.lastPrompt ?? "").trim();
      if (v) found.push(v);
    } catch { /* truncated first line */ }
  }

  const seen = new Set<string>();
  const value = found.reverse().filter((v) => !seen.has(v) && seen.add(v)).slice(0, 25);
  historyCache.set(sessionId, { at: Date.now(), value });
  return value;
}
