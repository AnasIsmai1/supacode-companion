import { useEffect, useRef, useState } from "react";

export type Win = {
  tabId: string; title: string; surfaceId: string; zmx: string;
  agent: string | null; pid: number | null; index: number;
  sessionId: string | null; status: "idle" | "busy" | "shell" | null;
  ask: { message: string; type: string; at: number } | null; updatedAt: number;
  stuck: number | null;
};
export type Worktree = { id: string; path: string; branch: string | null; dirty: boolean; lastCommit: number | null; windows: Win[]; attention: number };
export type Project = { name: string; worktrees: Worktree[]; attention: number; live: number };
export type Choice = { label: string; description?: string; preview?: string };
export type Question = { header?: string; question: string; options: Choice[] };
export type LiveOption = { key: string; label: string };
export type Pending =
  | { kind: "question"; questions: Question[]; toolUseId: string }
  | { kind: "live-question"; question: string; options: LiveOption[]; preview: string | null; previewHidden?: number; highlighted: string | null; canChat?: boolean; chatFocused?: boolean; tabs?: string[]; activeTab?: number | null; tabCount?: number }
  | { kind: "permission"; title: string; options: { key: string; label: string }[] }
  | null;
export type Tool = { name: string; summary: string };
export type TaskStatus = "pending" | "in_progress" | "completed";
export type Task = { id: string; subject: string; description: string; activeForm: string; status: TaskStatus };
export type TaskList = { tasks: Task[]; counts: { total: number; done: number; active: number } };
export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";
export type DiffFile = {
  path: string; oldPath?: string; status: DiffFileStatus;
  additions: number; deletions: number; binary: boolean; truncated?: boolean;
};
export type SessionDiff = {
  ok: boolean; branch: string | null; base: string | null; files: DiffFile[];
  totals: { files: number; additions: number; deletions: number };
  truncated: boolean; baseWarning?: string; error?: string;
};
export type Agent = { id: string; task: string; tools: number; lastTool: string | null; updatedAt: number; active: boolean };
export type Turn = { role: "user" | "assistant"; text: string; tools: Tool[]; error: string | null; questions: Question[] | null; toolUseId: string | null; ts: number; uuid: string };

export async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as any).error ?? `HTTP ${r.status}`);
  return d as T;
}

export async function post<T = unknown>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as any).error ?? `HTTP ${r.status}`);
  return d as T;
}

/** Poll a JSON endpoint on an interval, pausing while the tab is hidden. */
export function usePoll<T>(path: string, ms: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      try { const d = await get<T>(path); if (alive) { setData(d); setError(null); } }
      catch (e) { if (alive) setError((e as Error).message); }
    };
    tick();
    const t = setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    return () => { alive = false; clearInterval(t); document.removeEventListener("visibilitychange", tick); };
  }, [path, ms]);
  return { data, error };
}

/**
 * Transcript stream with reconnect. v1 opened a socket once and never recovered,
 * so a phone lost it on the first screen-sleep and the chat silently froze —
 * which read as "streaming doesn't work at all".
 */
export function useTurns(sessionId: string) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [connected, setConnected] = useState(false);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    seen.current = new Set();
    setTurns([]);
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout>;
    let closed = false;
    let backoff = 500;

    const merge = (incoming: Turn[]) =>
      setTurns((prev) => {
        const add = incoming.filter((t) => {
          const k = t.uuid || `${t.ts}:${t.text.slice(0, 40)}`;
          if (seen.current.has(k)) return false;
          seen.current.add(k);
          return t.text || t.tools.length || t.questions;
        });
        return add.length ? [...prev, ...add] : prev;
      });

    const open = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws/chat/${sessionId}`);
      ws.onopen = () => { setConnected(true); backoff = 500; };
      ws.onmessage = (e) => merge(JSON.parse(e.data).turns ?? []);
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        retry = setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 15_000);
      };
      ws.onerror = () => ws?.close();
    };

    open();
    // A phone suspends the socket on lock; reconnect as soon as we're visible again.
    const wake = () => { if (!document.hidden && ws?.readyState !== WebSocket.OPEN) { clearTimeout(retry); backoff = 500; open(); } };
    document.addEventListener("visibilitychange", wake);

    return () => { closed = true; clearTimeout(retry); document.removeEventListener("visibilitychange", wake); ws?.close(); };
  }, [sessionId]);

  return { turns, connected };
}
