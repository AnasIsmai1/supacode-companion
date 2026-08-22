import { ArrowUp, GitCommit, GitPullRequest, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { post, usePoll } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Matches SUBJECT_MAX in lib/git.ts — the server truncates, this just warns first. */
const SUBJECT_MAX = 50;

type Status = {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  clean: boolean;
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-xs text-muted">{label}</span>
      <span className="min-w-0 truncate font-mono text-xs">{value}</span>
    </div>
  );
}

/**
 * Land the work, or throw it away.
 *
 * These are the only operations here that change your repository, so the set is
 * deliberately small and force-push is not reachable at all.
 */
export function Actions({ wt, branch, dirty }: { wt: string; branch: string | null; dirty: boolean }) {
  const q = encodeURIComponent(wt);
  const { data: st } = usePoll<Status>(`/api/git/status?wt=${q}`, 8000);

  const [message, setMessage] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const call = async (what: string, path: string, body?: unknown) => {
    setBusy(what);
    setError(null);
    setNote(null);
    try {
      const r = await post<{ out?: string }>(`${path}?wt=${q}`, body);
      setNote(r.out || `${what} ok`);
      if (what === "commit") setMessage("");
      if (what === "discard") setConfirm("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const subjectLen = message.split("\n")[0].length;
  const over = subjectLen > SUBJECT_MAX;

  return (
    <div className="flex flex-col gap-4 p-4">
      <section className="rounded-xl border border-line bg-surface p-3">
        <Row label="branch" value={st?.branch ?? branch ?? "—"} />
        <Row label="upstream" value={st?.upstream ?? "not pushed yet"} />
        <Row label="ahead / behind" value={`${st?.ahead ?? 0} / ${st?.behind ?? 0}`} />
        <Row
          label="uncommitted"
          value={st ? (st.clean ? "clean" : `${st.staged + st.unstaged} changed, ${st.untracked} new`) : "…"}
        />
      </section>

      {error && <p role="alert" className="rounded-lg bg-error/10 px-3 py-2 text-sm text-error">{error}</p>}
      {note && <p role="status" className="break-all rounded-lg bg-success/10 px-3 py-2 text-sm text-success">{note}</p>}

      <section>
        <label htmlFor="commit-msg" className="mb-1.5 flex items-baseline justify-between text-[11px] uppercase tracking-wider text-faint">
          commit message
          {/* The 50-char subject rule, shown before you hit send rather than
              silently truncated after. */}
          <span className={cn("tabular-nums", over ? "text-error" : "text-faint")}>{subjectLen}/{SUBJECT_MAX}</span>
        </label>
        <textarea
          id="commit-msg"
          rows={3}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={"subject line\n\noptional body"}
          className="w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-[13px]
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        {over && <p className="mt-1 text-[11px] text-error">The subject will be cut to {SUBJECT_MAX} characters.</p>}
        <Button
          className="mt-2 w-full"
          disabled={!message.trim() || busy !== null || (st ? st.clean : false)}
          onClick={() => call("commit", "/api/git/commit", { message })}
        >
          <GitCommit className="size-4" aria-hidden />
          {busy === "commit" ? "committing…" : st?.clean ? "nothing to commit" : "Commit everything"}
        </Button>
      </section>

      <section>
        <Button
          variant="outline"
          className="w-full"
          disabled={busy !== null || !st?.branch}
          onClick={() => call("push", "/api/git/push")}
        >
          <ArrowUp className="size-4" aria-hidden />
          {busy === "push"
            ? "pushing…"
            : st?.upstream
              ? `Push${st.ahead ? ` (${st.ahead})` : ""}`
              : "Push and set upstream"}
        </Button>
      </section>

      <section className="rounded-xl border border-line p-3">
        <p className="mb-2 text-[11px] uppercase tracking-wider text-faint">pull request</p>
        <input
          value={prTitle}
          onChange={(e) => setPrTitle(e.target.value)}
          placeholder={st?.branch ?? "title"}
          aria-label="Pull request title"
          className="mb-2 min-h-11 w-full rounded-lg border border-line bg-surface px-3 text-[13px]
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <textarea
          rows={2}
          value={prBody}
          onChange={(e) => setPrBody(e.target.value)}
          placeholder="body (optional)"
          aria-label="Pull request body"
          className="w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-[13px]
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <Button
          variant="outline"
          className="mt-2 w-full"
          disabled={busy !== null || !st?.branch}
          onClick={() => call("pr", "/api/git/pr", { title: prTitle, body: prBody })}
        >
          <GitPullRequest className="size-4" aria-hidden />
          {busy === "pr" ? "opening…" : "Open pull request"}
        </Button>
        <p className="mt-2 text-[11px] text-faint">Pushes first if the branch is ahead.</p>
      </section>

      <section className="rounded-xl border border-error/40 bg-error/5 p-3">
        <p className="mb-1 text-[11px] uppercase tracking-wider text-error">danger</p>
        <p className="mb-2 text-xs text-muted">
          Throws away every uncommitted change here. Commits are untouched.
        </p>
        <label htmlFor="discard-confirm" className="sr-only">Type discard to confirm</label>
        <input
          id="discard-confirm"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="type: discard"
          autoCapitalize="off"
          autoCorrect="off"
          className="mb-2 min-h-11 w-full rounded-lg border border-line bg-surface px-3 font-mono text-[13px]
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <Button
          variant="danger"
          className="w-full"
          disabled={confirm !== "discard" || busy !== null || !dirty}
          onClick={() => call("discard", "/api/git/discard", { confirm })}
        >
          <Trash2 className="size-4" aria-hidden />
          {busy === "discard" ? "discarding…" : "Discard all changes"}
        </Button>
      </section>
    </div>
  );
}
