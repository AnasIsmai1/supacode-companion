// Supacode Companion — phone dashboard for live Claude sessions.
// Binds loopback only; `tailscale serve` fronts it with HTTPS for the tailnet.

import { listSessions, type Session } from "./lib/sessions.ts";
import { listWorktrees, type Worktree } from "./lib/worktrees.ts";
import { tree } from "./lib/tree.ts";
import { ZMX, zmx as zmxCmd } from "./lib/zmx.ts";
import { windowByPid, windowsByWorktree } from "./lib/layout.ts";
import { ARROW, sendText, sendChoice } from "./lib/send.ts";
import { readChat, transcriptPath } from "./lib/transcript.ts";
import { saveUpload } from "./lib/upload.ts";
import { appRunning, closeWindow, newWindow, newWorktree, openRepo, repos, startClaude } from "./lib/supacode.ts";
import { pending, pendingLiveQuestion } from "./lib/prompts.ts";
import { MODES, readMode, setMode, type Mode } from "./lib/mode.ts";
import { commands } from "./lib/commands.ts";
import { readState } from "./lib/state.ts";
import { liveTool, readEvents } from "./lib/events.ts";
import { agentsFor } from "./lib/agents.ts";
import { notify } from "./lib/notify.ts";
import { runningOutput } from "./lib/running.ts";
import { files } from "./lib/files.ts";
import { listDir, safePath, HOME } from "./lib/fs.ts";
import { diffStat, diffSummary, filePatch, resolveWorktree } from "./lib/diff.ts";
import { runState, scripts, startRun, stopRun } from "./lib/run.ts";
import { commit, createPR, discardAll, push, restoreFile, status } from "./lib/git.ts";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

const PORT = Number(Bun.env.PORT ?? 7777);
const PUBLIC = join(import.meta.dir, "public");

/** Claude Code's own permission-mode vocabulary -> our ids. */
function fromTranscript(v: string | null): Mode | null {
  switch (v) {
    case "default": return "manual";
    case "acceptEdits": return "accept";
    case "auto": return "auto";
    case "plan": return "plan";
    case "bypassPermissions": return "bypass";
    default: return null;
  }
}

const RANK = { ask: 0, busy: 1, idle: 2, shell: 3 } as const;
const rank = (s: Session) => (s.ask ? RANK.ask : RANK[s.status] ?? 3);

const json = (v: unknown, status = 200) =>
  Response.json(v, { status, headers: { "cache-control": "no-store" } });

async function findSession(id: string): Promise<Session | null> {
  return (await listSessions()).find((s) => s.sessionId === id) ?? null;
}

/** One payload: live sessions ranked by attention, then dormant worktrees. */
async function list() {
  const [sessions, worktrees] = await Promise.all([listSessions(), listWorktrees()]);

  const byPath = new Map<string, Worktree>(worktrees.map((w) => [w.path, w]));
  const live = sessions
    .map((s) => {
      const w = byPath.get(s.cwd);
      return {
        ...s,
        repo: w?.repo ?? s.cwd.split("/").pop(),
        branch: w?.branch ?? null,
        dirty: w?.dirty ?? false,
      };
    })
    .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);

  const taken = new Set(sessions.map((s) => s.cwd));
  const dormant = worktrees
    .filter((w) => !taken.has(w.path))
    .sort((a, b) => (b.lastCommit ?? 0) - (a.lastCommit ?? 0));

  return { live, dormant, at: Date.now() };
}

const sendRaw = (session: string, data: string) => sendChoice(session, data);

/**
 * Move a live dialog's highlight onto an option.
 *
 * The dialog documents "Enter to select · ↑/↓ to navigate" and no number keys —
 * a bare digit does nothing, which is why answering appeared to be ignored. So
 * walk with arrows and verify after each press rather than trusting a key count.
 */
async function focusOption(zmxName: string, key: string): Promise<boolean> {
  let cur = await pendingLiveQuestion(zmxName);
  if (!cur || cur.kind !== "live-question") return false;

  for (let i = 0; i < cur.options.length + 2; i++) {
    if (cur.highlighted === key) return true;
    const from = Number(cur.highlighted ?? 1);
    await sendChoice(zmxName, Number(key) > from ? ARROW.down : ARROW.up);
    await Bun.sleep(140);
    const next = await pendingLiveQuestion(zmxName);
    if (!next || next.kind !== "live-question") return false;
    cur = next;
  }
  return cur.highlighted === key;
}


type WSData = { sessionId: string; raw: boolean; watcher?: FSWatcher; tail?: Bun.Subprocess };

/** Every window has a surface; only some have a Claude session. zmx names the
 *  session after the surface, so the raw terminal keys on that instead. */
async function zmxForSurface(surfaceId: string): Promise<string | null> {
  const name = `supa-${surfaceId.toLowerCase()}`;
  const { out } = await zmxCmd(["ls", "--short"]);
  return out.split("\n").some((l) => l.trim() === name) ? name : null;
}

/** Files handed over by the Android share sheet, awaiting a session choice. */
let lastAck: { at: number; body: string } | null = null;

const shareInbox = new Map<string, { files: File[]; text: string; at: number }>();
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of shareInbox) if (v.at < cutoff) shareInbox.delete(k);
}, 60_000).unref();

const server = Bun.serve<WSData>({
  port: PORT,
  hostname: "127.0.0.1",
  maxRequestBodySize: 32 * 1024 * 1024,

  async fetch(req, srv) {
    const url = new URL(req.url);
    const p = url.pathname;

    // --- websocket: stream new transcript turns ---
    const ws = p.match(/^\/ws\/(chat|raw)\/([0-9a-f-]{36})$/i);
    if (ws) {
      return srv.upgrade(req, { data: { sessionId: ws[2], raw: ws[1] === "raw" } })
        ? undefined
        : new Response("upgrade failed", { status: 400 });
    }

    if (p === "/api/tree") return json(await tree());

    const chat = p.match(/^\/api\/chat\/([0-9a-f-]{36})$/i);
    if (chat) {
      const s = await findSession(chat[1]);
      const turns = await readChat(chat[1], Number(url.searchParams.get("n")) || 200);
      // Show Supacode's own window title, not Claude's derived session name.
      const hit = s?.pid != null ? windowByPid().get(s.pid) : undefined;
      return json({
        session: s && {
          ...s,
          title: hit?.window.title ?? s.name,
          worktree: hit?.worktree ?? s.cwd,
          surfaceId: hit?.window.surfaceId ?? null,
          tabId: hit?.window.tabId ?? null,
          worktreeId: hit ? encodeURIComponent(hit.worktree + "/") : null,
        },
        turns,
        pending: await pending(chat[1], s?.zmx ?? null),
      });
    }

    const send = p.match(/^\/api\/send\/([0-9a-f-]{36})$/i);
    if (send && req.method === "POST") {
      const s = await findSession(send[1]);
      if (!s?.zmx) return json({ error: "session not found or not under zmx" }, 404);

      const { text } = (await req.json().catch(() => ({}))) as { text?: string };
      if (!String(text ?? "").trim()) return json({ error: "empty" }, 400);
      // A message accepted mid-turn goes into Claude's OWN queue, not the
      // transcript, and can sit there for minutes. Reporting that as "sent" is
      // how the echo ends up claiming something that has not happened yet.
      const queued = s.status === "busy";
      return (await sendText(s.zmx, String(text)))
        ? json({ ok: true, queued })
        : json({ error: "zmx send failed" }, 502);
    }

    // --- answer a question or permission prompt: one keystroke, no vim prefix ---
    const ans = p.match(/^\/api\/answer\/([0-9a-f-]{36})$/i);
    if (ans && req.method === "POST") {
      const s = await findSession(ans[1]);
      if (!s?.zmx) return json({ error: "session not found" }, 404);
      const { key } = (await req.json().catch(() => ({}))) as { key?: string };
      if (!/^[1-9]$/.test(String(key))) return json({ error: "key must be 1-9" }, 400);

      const live = await pendingLiveQuestion(s.zmx);
      if (live && live.kind === "live-question") {
        if (!(await focusOption(s.zmx, String(key)))) {
          return json({ error: "could not move to that option" }, 502);
        }
        return (await sendChoice(s.zmx, "\r"))
          ? json({ ok: true })
          : json({ error: "zmx send failed" }, 502);
      }

      // A classic permission box still takes the digit directly.
      return (await sendChoice(s.zmx, String(key)))
        ? json({ ok: true })
        : json({ error: "zmx send failed" }, 502);
    }

    // --- one payload for the chat header: state + prompt, no zmx spawn ---
    const sess = p.match(/^\/api\/session\/([0-9a-f-]{36})$/i);
    if (sess) {
      const s = await findSession(sess[1]);
      if (!s) return json({ error: "session not found" }, 404);
      const hit = s.pid != null ? windowByPid().get(s.pid) : undefined;
      const state = await readState(sess[1]);
      return json({
        session: {
          ...s,
          title: hit?.window.title ?? state.title ?? s.name,
          worktree: hit?.worktree ?? s.cwd,
          surfaceId: hit?.window.surfaceId ?? null,
          tabId: hit?.window.tabId ?? null,
          worktreeId: hit ? encodeURIComponent(hit.worktree + "/") : null,
        },
        state: { ...state, mode: fromTranscript(state.permissionMode) },
        agents: await agentsFor(sess[1]),
        // Hooks fire the instant a tool starts; the transcript only records it
        // once the tool_result lands. So a long Bash shows as the live tool here
        // while state.lastTool still names the previous one.
        live: liveTool(await readEvents(sess[1], 30)),
        // Reading the screen costs a zmx spawn (~500ms), so only pay it while the
        // session is actually working — idle polls stay on the transcript path.
        running: s.status === "busy" && s.zmx ? await runningOutput(s.zmx) : null,
        pending: await pending(sess[1], s.zmx ?? null),
      });
    }

    // --- completions: ~1,500 commands to filter, and the worktree's files ---
    if (p === "/api/commands") return json({ commands: commands() });

    const fl = p.match(/^\/api\/files\/([0-9a-f-]{36})$/i);
    if (fl) {
      const s = await findSession(fl[1]);
      if (!s) return json({ error: "session not found" }, 404);
      return json({ files: await files(s.cwd, url.searchParams.get("q") ?? "") });
    }

    // --- permission mode: scrape to read, press-and-verify to write ---
    const md = p.match(/^\/api\/mode\/([0-9a-f-]{36})$/i);
    if (md) {
      const s = await findSession(md[1]);
      if (!s?.zmx) return json({ error: "session not found" }, 404);

      // Reading is a transcript lookup (5ms); only writing needs the TUI.
      if (req.method !== "POST") {
        const st = await readState(md[1]);
        return json({ mode: fromTranscript(st.permissionMode) ?? (await readMode(s.zmx)), modes: MODES });
      }

      const { target } = (await req.json().catch(() => ({}))) as { target?: Mode };
      if (!MODES.some((m) => m.id === target)) return json({ error: "unknown mode" }, 400);
      const r = await setMode(s.zmx, target!);
      return r.ok ? json(r) : json({ ...r, error: r.error }, 409);
    }

    // --- subagents of a session: "busy" says nothing when three Tasks are running
    const ag = p.match(/^\/api\/agents\/([0-9a-f-]{36})$/i);
    if (ag) return json({ agents: await agentsFor(ag[1]) });

    // --- the current rendered screen of a window, colours intact.
    // --- Re-reading and replacing is what makes `clear` work; appending does not.
    const scr = p.match(/^\/api\/screen\/([0-9a-f-]{36})$/i);
    if (scr) {
      const name = await zmxForSurface(scr[1]);
      if (!name) return json({ error: "no terminal for this window" }, 404);
      const { ok, out } = await zmxCmd(["history", name, "--vt"]);
      if (!ok) return json({ error: "could not read screen" }, 502);
      // The screen is ~17KB and mostly identical between polls; the client parses
      // it into thousands of styled spans, so let it skip that when nothing moved.
      const hash = Bun.hash(out).toString(36);
      if (url.searchParams.get("since") === hash) return json({ hash, unchanged: true });
      return json({ screen: out, hash });
    }

    // --- interrupt a running turn. Esc is what does this in Claude Code: it stops
    // --- the turn, keeps work done so far, and sends anything queued next.
    const intr = p.match(/^\/api\/interrupt\/([0-9a-f-]{36})$/i);
    if (intr && req.method === "POST") {
      const s = await findSession(intr[1]);
      if (!s?.zmx) return json({ error: "session not found" }, 404);
      return (await sendChoice(s.zmx, "\x1b"))
        ? json({ ok: true })
        : json({ error: "zmx send failed" }, 502);
    }

    // --- move the highlight in a live question dialog, to fetch that option's
    // --- preview: the screen only ever renders the highlighted option's box.
    const hl = p.match(/^\/api\/highlight\/([0-9a-f-]{36})$/i);
    if (hl && req.method === "POST") {
      const s = await findSession(hl[1]);
      if (!s?.zmx) return json({ error: "session not found" }, 404);
      const { key } = (await req.json().catch(() => ({}))) as { key?: string };
      if (!/^[1-9]$/.test(String(key))) return json({ error: "key must be 1-9" }, 400);

      // Arrow keys only — looking at a preview must never select anything.
      await focusOption(s.zmx, String(key));
      return json({ pending: await pendingLiveQuestion(s.zmx) });
    }

    // --- answer a question in prose. The dialog is modal, so plain text typed
    // --- while it is open goes nowhere: you must first move to its "Chat about
    // --- this" row and select it. Arrow + verify, never a blind key count.
    const chatAbout = p.match(/^\/api\/chat-about\/([0-9a-f-]{36})$/i);
    if (chatAbout && req.method === "POST") {
      const s = await findSession(chatAbout[1]);
      if (!s?.zmx) return json({ error: "session not found" }, 404);
      const { text } = (await req.json().catch(() => ({}))) as { text?: string };
      if (!String(text ?? "").trim()) return json({ error: "empty" }, 400);

      let cur = await pendingLiveQuestion(s.zmx);
      if (!cur || cur.kind !== "live-question") return json({ error: "no live question" }, 409);
      if (!cur.canChat) return json({ error: "this dialog has no chat option" }, 409);

      // When "Chat about this" is itself a numbered option, one keystroke picks it.
      if (cur.chatKey) {
        await sendChoice(s.zmx, cur.chatKey);
        await Bun.sleep(400);
        return (await sendText(s.zmx, String(text)))
          ? json({ ok: true })
          : json({ error: "could not submit the reply" }, 502);
      }

      // Otherwise walk down until the chat row has focus, bounded by option count.
      for (let i = 0; i <= cur.options.length + 1 && !cur.chatFocused; i++) {
        await sendChoice(s.zmx, ARROW.down);
        await Bun.sleep(140);
        const next = await pendingLiveQuestion(s.zmx);
        if (!next || next.kind !== "live-question") break;
        cur = next;
      }
      if (!cur || cur.kind !== "live-question" || !cur.chatFocused) {
        return json({ error: "could not reach the chat option" }, 502);
      }

      await sendChoice(s.zmx, "\r");   // open the chat input
      await Bun.sleep(350);
      return (await sendText(s.zmx, String(text)))
        ? json({ ok: true })
        : json({ error: "could not submit the reply" }, 502);
    }

    // --- what a session changed, against the fork point of its branch ---
    // --- Three depths: counts for the list, files for the view, one patch on
    // --- expand. A phone should never parse 40 files of hunks to paint a list.
    if (p.startsWith("/api/diff")) {
      const wt = await resolveWorktree(url.searchParams.get("wt"));
      if (!wt) return json({ error: "unknown worktree" }, 404);

      if (p === "/api/diff/stat") return json(await diffStat(wt));
      if (p === "/api/diff") return json(await diffSummary(wt));
      if (p === "/api/diff/file") {
        const hit = await filePatch(wt, url.searchParams.get("path") ?? "");
        return hit ? json(hit) : json({ error: "no diff for that file" }, 404);
      }
      return json({ error: "not found" }, 404);
    }

    // --- run a command in a worktree, and read back what it printed ---
    // --- zmx owns the process, so a build survives this server restarting. ---
    if (p.startsWith("/api/run")) {
      const wt = await resolveWorktree(url.searchParams.get("wt"));
      if (!wt) return json({ error: "unknown worktree" }, 404);
      const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, string>) : {};

      if (p === "/api/run/scripts") return json({ scripts: await scripts(wt) });
      if (p === "/api/run/stop" && req.method === "POST") {
        return (await stopRun(wt)) ? json({ ok: true }) : json({ error: "could not interrupt" }, 502);
      }
      if (p === "/api/run" && req.method === "POST") {
        const r = await startRun(wt, String(body.command ?? ""));
        return r.ok ? json({ ok: true, session: r.session }) : json({ error: r.error }, 400);
      }
      if (p === "/api/run") {
        const st = await runState(wt);
        // Same trick as /api/screen: the screen is mostly identical between polls
        // and the client parses it into thousands of spans.
        if (url.searchParams.get("since") === st.hash) {
          return json({ ...st, screen: "", unchanged: true });
        }
        return json(st);
      }
      return json({ error: "not found" }, 404);
    }

    // --- git writes. Read-only diff lives above; this is the half that can
    // --- change your repo, so it is deliberately five operations wide.
    if (p.startsWith("/api/git/")) {
      const wt = await resolveWorktree(url.searchParams.get("wt"));
      if (!wt) return json({ error: "unknown worktree" }, 404);

      if (p === "/api/git/status") return json(await status(wt));
      if (req.method !== "POST") return json({ error: "not found" }, 404);

      const b = (await req.json().catch(() => ({}))) as Record<string, string>;
      const done = (r: { ok: boolean; out: string; error?: string }) =>
        r.ok ? json({ ok: true, out: r.out }) : json({ error: r.error ?? "failed" }, 502);

      switch (p) {
        case "/api/git/commit": return done(await commit(wt, String(b.message ?? "")));
        case "/api/git/push": return done(await push(wt));
        case "/api/git/pr": return done(await createPR(wt, String(b.title ?? ""), String(b.body ?? "")));
        case "/api/git/restore": return done(await restoreFile(wt, String(b.path ?? "")));
        // Typed confirm on the client is not enough on its own — require it here too.
        case "/api/git/discard":
          return b.confirm === "discard"
            ? done(await discardAll(wt))
            : json({ error: "confirmation required" }, 400);
      }
      return json({ error: "not found" }, 404);
    }

    // --- push a notification that carries the decision ---
    // --- The hook calls this instead of curling ntfy itself: resolving what a
    // --- session is waiting on needs listSessions + the screen parsers, all of
    // --- which live here and are already warm.
    // A tapped button proves phone -> tailnet -> this server. Pointing a TEST
    // button at /api/answer would type a real digit into a real session, so the
    // test path gets its own no-op that only records the round trip.
    if (p === "/api/notify/ack" && req.method === "POST") {
      lastAck = { at: Date.now(), body: await req.text().catch(() => "") };
      console.log(`notify ack ${new Date(lastAck.at).toISOString()} ${lastAck.body.slice(0, 120)}`);
      return json({ ok: true, at: lastAck.at });
    }
    if (p === "/api/notify/ack") return json(lastAck ?? { at: null });

    if (p === "/api/notify" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as Record<string, string>;
      if (!/^[0-9a-f-]{36}$/i.test(String(b.sessionId ?? ""))) return json({ error: "bad sessionId" }, 400);
      const r = await notify({
        sessionId: String(b.sessionId),
        project: String(b.project ?? "claude").slice(0, 60),
        message: String(b.message ?? "needs your input").slice(0, 300),
      });
      return r.ok ? json(r) : json({ ...r, error: "ntfy send failed" }, 502);
    }

    // --- disk browser, for adding a project ---
    if (p === "/api/fs") {
      try {
        const dir = safePath(url.searchParams.get("path"));
        const known = new Set((await repos()).map((r) => decodeURIComponent(r.id).replace(/\/+$/, "")));
        return json(listDir(dir, known));
      } catch (e) {
        return json({ error: String((e as Error).message) }, 400);
      }
    }

    if (p === "/api/repo-open" && req.method === "POST") {
      const { path: target } = (await req.json().catch(() => ({}))) as { path?: string };
      try {
        const dir = safePath(target ?? null);
        const r = await openRepo(dir);
        return r.ok ? json({ ok: true, path: dir }) : json({ error: r.out || "supacode failed" }, 502);
      } catch (e) {
        return json({ error: String((e as Error).message) }, 400);
      }
    }

    // --- close a window. Exiting the shell inside it does not remove the tab,
    // --- which is why quitting from the terminal appeared to do nothing.
    if (p === "/api/window/close" && req.method === "POST") {
      const { tab, surface, worktree } = (await req.json().catch(() => ({}))) as Record<string, string>;
      // The terminal view only knows its surface, so resolve the owning tab.
      let tabId = tab;
      let wt = worktree;
      if (!tabId && surface) {
        for (const [path, windows] of windowsByWorktree()) {
          const hit = windows.find((w) => w.surfaceId.toLowerCase() === surface.toLowerCase());
          if (hit) { tabId = hit.tabId; wt = encodeURIComponent(path + "/"); break; }
        }
      }
      if (!tabId) return json({ error: "tab or surface required" }, 400);
      const r = await closeWindow(tabId, wt);
      return r.ok ? json({ ok: true }) : json({ error: r.out || "supacode failed" }, 502);
    }

    // --- new window in ANY worktree, including ones that already have sessions ---
    if (p === "/api/window" && req.method === "POST") {
      const { worktree, input, title } = (await req.json().catch(() => ({}))) as Record<string, string>;
      if (!worktree) return json({ error: "worktree required" }, 400);
      const r = await newWindow(worktree, input || "claude", title);
      return r.ok ? json({ ok: true, tab: r.out }) : json({ error: r.out || "supacode failed" }, 502);
    }

    // --- files: multipart upload into the session's worktree ---
    const up = p.match(/^\/api\/upload\/([0-9a-f-]{36})$/i);
    if (up && req.method === "POST") {
      const s = await findSession(up[1]);
      if (!s) return json({ error: "session not found" }, 404);
      const form = await req.formData().catch(() => null);
      const files = form?.getAll("file").filter((f): f is File => f instanceof File) ?? [];
      if (!files.length) return json({ error: "no file" }, 400);
      try {
        return json({ saved: await Promise.all(files.map((f) => saveUpload(s.cwd, f))) });
      } catch (e) {
        return json({ error: String((e as Error).message) }, 400);
      }
    }

    // Android share sheet posts here; stash the files, then hand off to the picker.
    if (p === "/share-target" && req.method === "POST") {
      const form = await req.formData().catch(() => null);
      const files = form?.getAll("file").filter((f): f is File => f instanceof File) ?? [];
      const id = crypto.randomUUID();
      shareInbox.set(id, { files, text: String(form?.get("text") ?? ""), at: Date.now() });
      return Response.redirect(`/share/${id}`, 303);
    }

    const share = p.match(/^\/api\/share\/([0-9a-f-]{36})$/i);
    if (share) {
      const item = shareInbox.get(share[1]);
      if (!item) return json({ error: "expired" }, 404);
      if (req.method === "GET") {
        return json({ text: item.text, files: item.files.map((f) => ({ name: f.name, size: f.size })) });
      }
      // POST { sessionId } commits the stashed files into that session's worktree.
      const { sessionId } = (await req.json().catch(() => ({}))) as { sessionId?: string };
      const s = sessionId ? await findSession(sessionId) : null;
      if (!s) return json({ error: "session not found" }, 404);
      try {
        const saved = await Promise.all(item.files.map((f) => saveUpload(s.cwd, f)));
        shareInbox.delete(share[1]);
        return json({ saved, text: item.text });
      } catch (e) {
        return json({ error: String((e as Error).message) }, 400);
      }
    }

    // --- create: start a session, or make a new worktree ---


    if (p === "/api/worktree-new" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as Record<string, any>;
      if (!b.repo || !b.branch) return json({ error: "repo and branch required" }, 400);
      const r = await newWorktree(b as any);
      if (!r.ok) return json({ error: r.out || "supacode failed" }, 502);
      // worktree-new prints the new worktree id; feed it straight back in.
      if (b.start && r.out) await startClaude(r.out);
      return json({ ok: true, worktree: r.out });
    }

    // --- static, with SPA fallback for /s/:id and /w/:id ---
    // index.html must never be cached: it names the content-hashed asset chunks,
    // so a stale copy asks for chunk hashes that no longer exist after a rebuild
    // and the client silently keeps running an old bundle. The assets themselves
    // are content-hashed, so they can be cached hard.
    const html = { "content-type": "text/html;charset=utf-8", "cache-control": "no-store, must-revalidate" };
    const asset = { "cache-control": "public, max-age=31536000, immutable" };

    const file = Bun.file(join(PUBLIC, p === "/" ? "index.html" : p));
    if (await file.exists()) {
      if (p === "/" || p.endsWith(".html")) return new Response(file, { headers: html });
      if (p === "/sw.js" || p === "/manifest.json") {
        return new Response(file, { headers: { "cache-control": "no-store" } });
      }
      return new Response(file, { headers: p.startsWith("/assets/") ? asset : {} });
    }
    if (!p.startsWith("/api/")) return new Response(Bun.file(join(PUBLIC, "index.html")), { headers: html });
    return new Response("not found", { status: 404 });
  },

  websocket: {
    async open(ws) {
      // Raw mode: replay the scrollback, then follow the PTY. Half duplex —
      // `zmx tail` is output only, input goes back through `zmx send`.
      if (ws.data.raw) {
        const name = await zmxForSurface(ws.data.sessionId);
        if (!name) return ws.close(1011, "no terminal for this window");

        // --vt replays the current screen, which is what a TUI actually looks like.
        const hist = Bun.spawnSync([ZMX, "history", name, "--vt"], { stdout: "pipe", stderr: "ignore" });
        ws.send(hist.stdout.toString());

        const tail = Bun.spawn([ZMX, "tail", name], { stdout: "pipe", stderr: "ignore" });
        ws.data.tail = tail;
        (async () => {
          for await (const chunk of tail.stdout) {
            try { ws.send(chunk); } catch { break; }
          }
        })();
        return;
      }

      const path = await transcriptPath(ws.data.sessionId);
      if (!path) return ws.close(1011, "no transcript");
      ws.send(JSON.stringify({ turns: await readChat(ws.data.sessionId, 120) }));

      let pending = false;
      ws.data.watcher = watch(path, () => {
        if (pending) return;
        pending = true; // fs.watch fires in bursts; coalesce
        setTimeout(async () => {
          pending = false;
          try {
            // 10 was too narrow: a burst of tool_result records could push a real
            // user message out of the window before it was ever pushed.
            ws.send(JSON.stringify({ turns: await readChat(ws.data.sessionId, 60) }));
          } catch {
            /* socket closed mid-read */
          }
        }, 150);
      });
    },
    async message(ws, msg) {
      if (!ws.data.raw) return;
      const name = await zmxForSurface(ws.data.sessionId);
      if (name) sendRaw(name, typeof msg === "string" ? msg : new TextDecoder().decode(msg));
    },
    close(ws) {
      ws.data.watcher?.close();
      ws.data.tail?.kill();
    },
  },
});

console.log(`companion on http://127.0.0.1:${server.port}`);
