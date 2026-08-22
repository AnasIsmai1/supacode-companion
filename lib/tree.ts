// Project -> Worktree -> Window, the shape Supacode itself shows.

import { listSessions, type Session } from "./sessions.ts";
import { listWorktrees, type Worktree as WT } from "./worktrees.ts";
import { windowsByWorktree, type Window as LayoutWindow } from "./layout.ts";
import { isUrgent } from "./notify.ts";

export type Win = LayoutWindow & {
  /** present only when a live Claude session backs this window */
  sessionId: string | null;
  status: Session["status"] | null;
  ask: Session["ask"];
  updatedAt: number;
};

export type Worktree = Omit<WT, "repo"> & { windows: Win[]; attention: number };
export type Project = { name: string; worktrees: Worktree[]; attention: number; live: number };

const RANK = { ask: 0, busy: 1, idle: 2, shell: 3, none: 4 } as const;
// An idle_prompt only means you have not typed lately. Ranking it as
// attention put 17 of 21 sessions in "Needs you", which is the same as none.
const needsYou = (w: Win) => Boolean(w.ask && isUrgent(w.ask.type));
const winRank = (w: Win) => (needsYou(w) ? RANK.ask : w.status ? RANK[w.status] ?? RANK.none : RANK.none);

export async function tree(): Promise<{ projects: Project[]; live: number; at: number }> {
  const [sessions, worktrees] = await Promise.all([listSessions(), listWorktrees()]);
  const layout = windowsByWorktree();
  const byPid = new Map(sessions.map((s) => [s.pid, s]));

  const byProject = new Map<string, Worktree[]>();

  for (const wt of worktrees) {
    const windows: Win[] = (layout.get(wt.path) ?? []).map((w) => {
      const s = w.pid != null ? byPid.get(w.pid) : undefined;
      return {
        ...w,
        sessionId: s?.sessionId ?? null,
        status: s?.status ?? null,
        ask: s?.ask ?? null,
        updatedAt: s?.updatedAt ?? 0,
      };
    });
    windows.sort((a, b) => a.index - b.index);

    const entry: Worktree = {
      ...wt,
      windows,
      attention: windows.filter(needsYou).length,
    };
    delete (entry as any).repo;

    const list = byProject.get(wt.repo) ?? [];
    list.push(entry);
    byProject.set(wt.repo, list);
  }

  const projects: Project[] = [...byProject]
    .map(([name, wts]) => {
      // worktrees with something to look at first, then most recently touched
      wts.sort(
        (a, b) =>
          b.attention - a.attention ||
          b.windows.filter((w) => w.sessionId).length - a.windows.filter((w) => w.sessionId).length ||
          (b.lastCommit ?? 0) - (a.lastCommit ?? 0),
      );
      for (const wt of wts) wt.windows.sort((a, b) => winRank(a) - winRank(b) || a.index - b.index);
      return {
        name,
        worktrees: wts,
        attention: wts.reduce((n, w) => n + w.attention, 0),
        live: wts.reduce((n, w) => n + w.windows.filter((x) => x.sessionId).length, 0),
      };
    })
    .sort((a, b) => b.attention - a.attention || b.live - a.live || a.name.localeCompare(b.name));

  return { projects, live: sessions.length, at: Date.now() };
}
