import { FileCode, Hash, Sparkles, Terminal } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { get } from "@/lib/api";
import { cn } from "@/lib/utils";

type Command = { name: string; source: "command" | "skill" | "plugin"; description: string };
export type Trigger = { kind: "slash" | "file"; query: string; start: number } | null;

const RECENTS_KEY = "companion:recent-commands";
const readRecents = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]"); } catch { return []; } };
export function noteRecent(name: string) {
  const next = [name, ...readRecents().filter((n) => n !== name)].slice(0, 12);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
}

/** What the caret is currently sitting in: a `/command` or an `@path`. */
export function detectTrigger(value: string, caret: number): Trigger {
  const before = value.slice(0, caret);
  const slash = /(^|\n)\/([\w:-]*)$/.exec(before);
  if (slash) return { kind: "slash", query: slash[2], start: caret - slash[2].length - 1 };
  const at = /(^|\s)@([\w./-]*)$/.exec(before);
  if (at) return { kind: "file", query: at[2], start: caret - at[2].length - 1 };
  return null;
}

const ICON = { command: Terminal, skill: Sparkles, plugin: Hash } as const;

export function Completions({
  trigger, sessionId, onPick,
}: { trigger: Trigger; sessionId: string; onPick: (text: string) => void }) {
  const [all, setAll] = useState<Command[] | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const recents = useMemo(() => readRecents(), [trigger?.kind]);

  // ~1,500 commands: fetched once, filtered locally. Never per keystroke.
  useEffect(() => {
    if (trigger?.kind !== "slash" || all) return;
    get<{ commands: Command[] }>("/api/commands").then((d) => setAll(d.commands)).catch(() => setAll([]));
  }, [trigger?.kind, all]);

  useEffect(() => {
    if (trigger?.kind !== "file") return;
    let alive = true;
    const t = setTimeout(() => {
      get<{ files: string[] }>(`/api/files/${sessionId}?q=${encodeURIComponent(trigger.query)}`)
        .then((d) => alive && setFiles(d.files))
        .catch(() => alive && setFiles([]));
    }, 120);
    return () => { alive = false; clearTimeout(t); };
  }, [trigger?.kind, trigger?.query, sessionId]);

  const items = useMemo(() => {
    if (!trigger) return [];
    if (trigger.kind === "file") return files.map((f) => ({ key: f, label: f, hint: "", icon: FileCode, recent: false }));
    const q = trigger.query.toLowerCase();
    const matched = (all ?? []).filter((c) => c.name.toLowerCase().includes(q));
    const rank = (c: Command) => (recents.includes(c.name) ? 0 : c.name.toLowerCase().startsWith(q) ? 1 : 2);
    return matched
      .sort((a, b) => rank(a) - rank(b) || a.name.length - b.name.length)
      .slice(0, 40)
      .map((c) => ({ key: c.name, label: `/${c.name}`, hint: c.description, icon: ICON[c.source], recent: recents.includes(c.name) }));
  }, [trigger, all, files, recents]);

  if (!trigger || items.length === 0) return null;

  return (
    <div className="max-h-[45vh] overflow-y-auto border-t border-line bg-bg" role="listbox" aria-label="Completions">
      {items.map((it) => (
        <button
          key={it.key}
          role="option"
          aria-selected={false}
          onClick={() => onPick(trigger.kind === "file" ? `@${it.key}` : `/${it.key}`)}
          className="flex min-h-11 w-full min-w-0 cursor-pointer items-center gap-3 border-b border-line/60 px-4 py-2.5
                     text-left transition-colors duration-200 hover:bg-surface"
        >
          <it.icon className={cn("size-4 shrink-0", it.recent ? "text-accent" : "text-muted")} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-[13px]">{it.label}</span>
            {it.hint && <span className="block truncate text-xs text-muted">{it.hint}</span>}
          </span>
          {it.recent && <span className="shrink-0 text-[10px] uppercase tracking-wider text-accent">recent</span>}
        </button>
      ))}
    </div>
  );
}
