// Push notifications that carry the decision, not just a link to it.
//
// A permission prompt is the most common thing this tool exists for, and until
// now answering one meant: unlock, open the PWA, wait for the tree, tap in,
// tap the option. Five steps to press "1".
//
// ntfy's `http` action is performed by the ntfy APP ON THE PHONE, from the
// phone's own network — not by ntfy.sh's servers. Verified against
// docs.ntfy.sh/publish. The phone is on the tailnet, so an action button can
// POST straight to /api/answer with nothing exposed publicly and no auth added.
// That is the whole reason this is possible at all.
//
// Config lives outside the repo at ~/.claude/companion/config.env (chmod 600):
//   NTFY_TOPIC=<random>
//   DASH_URL=https://<machine>.<tailnet>.ts.net
//
// Self-check: bun lib/notify.ts

import { homedir } from "node:os";
import { join } from "node:path";
import { pending } from "./prompts.ts";
import { listSessions } from "./sessions.ts";
import { isViewing } from "./presence.ts";

const CONFIG = join(homedir(), ".claude", "companion", "config.env");

/** ntfy renders at most three, and drops the whole notification if given more. */
const MAX_ACTIONS = 3;
/** A phone notification is not a place to read a sentence. */
const LABEL_MAX = 24;

export type Config = { topic: string | null; dashUrl: string | null };

export function parseConfig(text: string): Config {
  const get = (k: string) => text.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "") ?? null;
  return { topic: get("NTFY_TOPIC"), dashUrl: get("DASH_URL")?.replace(/\/+$/, "") ?? null };
}

export async function readConfig(): Promise<Config> {
  const f = Bun.file(CONFIG);
  return (await f.exists()) ? parseConfig(await f.text()) : { topic: null, dashUrl: null };
}

/**
 * Can this URL host action buttons?
 *
 * The phone performs the request, so a loopback DASH_URL points the button at
 * the PHONE. That is not a hypothetical — DASH_URL really was
 * http://127.0.0.1:7777 here, which is why every notification tap did nothing
 * for as long as notifications existed.
 */
export function actionable(dashUrl: string | null): boolean {
  return Boolean(dashUrl && !/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])\b/.test(dashUrl));
}

export type Action = {
  action: "http";
  label: string;
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  clear: boolean;
};

export type Push = {
  topic: string;
  title: string;
  message: string;
  click?: string;
  tags: string[];
  /** ntfy 1-5. See PRIORITY below — the default is not good enough here. */
  priority: number;
  actions?: Action[];
};

/**
 * Priority, and why the default is wrong.
 *
 * ntfy's default is 3, which Android is free to batch and defer — observed
 * directly: a max-priority test arrived instantly while a default-priority
 * permission prompt sent 90 seconds later never surfaced at all. A session
 * blocked waiting on you is not a "default" event; it is the entire reason
 * this program exists, and a deferred one stalls real work.
 *
 * 5 when there is something to answer, 4 otherwise. 4 still pops and sounds but
 * respects Do Not Disturb; 5 is reserved for "a session is stopped until you
 * act". Turn both down here if it ever gets noisy.
 */
const PRIORITY = { actionable: 5, informational: 4, idle: 2 } as const;

/**
 * Claude Code sends two very different things down one hook.
 *
 *   permission_prompt  a session is STOPPED until you answer
 *   idle_prompt        you have not typed in a while
 *
 * Treating them alike is why 23 of 27 spool entries were idle_prompt and the
 * tree showed 17 of 21 sessions as needing attention. It also trains you to
 * ignore the notification that actually matters.
 *
 * idle_prompt still arrives — a finished turn is worth knowing about — but
 * silently, at a priority Android will not sound or vibrate for.
 */
export const isUrgent = (type: string | null | undefined): boolean => type !== "idle_prompt";

const label = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) || "?";

/** One button per option, capped at what ntfy will render. */
export function buildActions(
  dashUrl: string,
  sessionId: string,
  options: { key: string; label: string }[],
): Action[] {
  return options.slice(0, MAX_ACTIONS).map((o) => ({
    action: "http" as const,
    label: label(o.label),
    url: `${dashUrl}/api/answer/${sessionId}`,
    method: "POST" as const,
    headers: { "Content-Type": "application/json" },
    // A label can contain commas, which the Actions *header* format cannot
    // escape — so this is only ever sent via the JSON publish body.
    body: JSON.stringify({ key: o.key }),
    clear: true,
  }));
}

export function buildPush(
  cfg: Config,
  o: {
    sessionId: string;
    project: string;
    message: string;
    options?: { key: string; label: string }[];
    /** Claude Code's notification_type. See isUrgent. */
    type?: string | null;
  },
): Push | null {
  if (!cfg.topic) return null;

  const urgent = isUrgent(o.type);
  const actionable_ = Boolean(o.options?.length) && actionable(cfg.dashUrl);
  // Spell the options out even when the buttons are unavailable: reading them
  // on the lock screen still beats opening the app to find out what was asked.
  const body = o.options?.length && urgent
    ? `${o.message}\n\n${optionLines(o.options)}`
    : o.message;
  const push: Push = {
    topic: cfg.topic,
    title: o.project,
    message: body.slice(0, 3500),
    tags: [urgent ? "bell" : "speech_balloon"],
    priority: !urgent ? PRIORITY.idle : actionable_ ? PRIORITY.actionable : PRIORITY.informational,
  };
  if (cfg.dashUrl) push.click = `${cfg.dashUrl}/s/${o.sessionId}`;

  // No buttons rather than buttons that point at the phone itself. An idle
  // nudge has nothing to answer even when a stale dialog is still on screen.
  if (actionable_ && urgent) push.actions = buildActions(cfg.dashUrl!, o.sessionId, o.options!);
  return push;
}

/**
 * A finished run.
 *
 * The whole point of runs surviving the phone locking is that you walk away.
 * A four-minute build that finishes while you are gone should say so, with its
 * real exit code — not wait for you to remember to look.
 *
 * Informational priority: nothing is blocked on you, so this must not be as
 * loud as a session that has actually stopped waiting.
 */
export function buildRunPush(
  cfg: Config,
  o: { worktree: string; command: string; exitCode: number; seconds: number },
): Push | null {
  if (!cfg.topic) return null;
  const ok = o.exitCode === 0;
  const push: Push = {
    topic: cfg.topic,
    title: o.worktree,
    message: `${ok ? "passed" : `failed (exit ${o.exitCode})`} in ${o.seconds}s — ${o.command}`.slice(0, 300),
    tags: [ok ? "white_check_mark" : "x"],
    priority: PRIORITY.informational,
  };
  if (cfg.dashUrl) push.click = `${cfg.dashUrl}/w?wt=${encodeURIComponent(o.worktree)}`;
  return push;
}

export type Option = { key: string; label: string; description?: string };

/** Options for whatever this session is currently waiting on, if anything. */
export async function pendingOptions(sessionId: string): Promise<Option[]> {
  const s = (await listSessions()).find((x) => x.sessionId === sessionId);
  const p = await pending(sessionId, s?.zmx ?? null);
  if (!p) return [];
  if (p.kind === "permission" || p.kind === "live-question") return p.options;
  // An AskUserQuestion from the transcript numbers its options by position, and
  // is the only shape that carries descriptions at all.
  if (p.kind === "question") {
    return (p.questions[0]?.options ?? []).map((c, i) => ({
      key: String(i + 1),
      label: c.label,
      description: c.description,
    }));
  }
  return [];
}

/**
 * The options, spelled out in the notification body.
 *
 * A button label is capped at 24 characters, so "Yes, and don't ask again,
 * allow all edits" arrives as "Yes, and don't ask again". You cannot choose
 * between options you can only half read. The body has room, so put the full
 * text there and let the buttons be the shortcut rather than the only source.
 */
export function optionLines(options: Option[]): string {
  return options
    .map((o) => {
      const head = `${o.key}. ${o.label}`.slice(0, 160);
      const desc = o.description?.replace(/\s+/g, " ").trim();
      return desc ? `${head}\n   ${desc.slice(0, 200)}` : head;
    })
    .join("\n");
}

export async function send(push: Push): Promise<boolean> {
  try {
    const r = await fetch("https://ntfy.sh/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(push),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Resolve what the session is waiting on, then push it with buttons. */
export async function notify(
  o: { sessionId: string; project: string; message: string; type?: string | null },
): Promise<{ ok: boolean; actions: number; suppressed?: boolean }> {
  // You are already looking at it. The prompt card is on screen.
  if (isViewing(o.sessionId)) return { ok: true, actions: 0, suppressed: true };

  const cfg = await readConfig();
  // Only worth a zmx spawn when there is something to answer.
  const options = isUrgent(o.type) ? await pendingOptions(o.sessionId).catch(() => []) : [];
  const push = buildPush(cfg, { ...o, options });
  if (!push) return { ok: false, actions: 0 };
  return { ok: await send(push), actions: push.actions?.length ?? 0 };
}

if (import.meta.main) {
  const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;

  // --- config parsing ---
  const cfg = parseConfig('NTFY_TOPIC=abc123\nDASH_URL=https://supacode.example.ts.net/\n# a comment\n');
  assert.deepEqual(cfg, { topic: "abc123", dashUrl: "https://supacode.example.ts.net" });
  assert.deepEqual(parseConfig(""), { topic: null, dashUrl: null });
  assert.equal(parseConfig('DASH_URL="https://x.ts.net"').dashUrl, "https://x.ts.net");

  // --- the loopback trap, which really happened ---
  assert.equal(actionable("https://supacode.example.ts.net"), true);
  assert.equal(actionable("http://127.0.0.1:7777"), false);
  assert.equal(actionable("http://localhost:7777"), false);
  assert.equal(actionable(null), false);

  // --- actions ---
  const opts = [
    { key: "1", label: "Yes" },
    { key: "2", label: "Yes, and don't ask again, allow all edits" },
    { key: "3", label: "No" },
    { key: "4", label: "Never" },
  ];
  const acts = buildActions("https://x.ts.net", "11111111-1111-1111-1111-111111111111", opts);
  assert.equal(acts.length, MAX_ACTIONS, "ntfy drops the notification if given more than three");
  assert.equal(acts[0].label, "Yes");
  assert.equal(acts[1].label.length, LABEL_MAX, "long labels are cut, not wrapped");
  assert.equal(acts[0].url, "https://x.ts.net/api/answer/11111111-1111-1111-1111-111111111111");
  assert.deepEqual(JSON.parse(acts[2].body), { key: "3" });
  assert.equal(acts[0].clear, true);

  // A comma in a label must survive — this is exactly what the header format
  // cannot express, and why we publish as JSON.
  const comma = buildActions("https://x.ts.net", "abc", [{ key: "1", label: "Yes, allow all" }]);
  assert.ok(comma[0].label.includes(","));
  assert.equal(JSON.parse(JSON.stringify(comma))[0].label, "Yes, allow all");

  // --- push assembly ---
  const good: Config = { topic: "t", dashUrl: "https://x.ts.net" };
  const p = buildPush(good, { sessionId: "sid", project: "repo", message: "needs you", options: opts })!;
  assert.equal(p.topic, "t");
  assert.equal(p.title, "repo");
  assert.equal(p.click, "https://x.ts.net/s/sid");
  assert.equal(p.actions?.length, 3);
  // Default priority (3) gets batched and deferred by Android: a max-priority
  // test arrived instantly while a default-priority permission prompt 90s later
  // never surfaced. A blocked session must not be droppable.
  assert.equal(p.priority, 5, "something to answer -> max priority");

  // Loopback: still notify, just without buttons that would hit the phone.
  const loop = buildPush({ topic: "t", dashUrl: "http://127.0.0.1:7777" }, {
    sessionId: "sid", project: "repo", message: "needs you", options: opts,
  })!;
  assert.equal(loop.actions, undefined);
  assert.ok(loop.click, "the link is still worth sending even when buttons are not");
  assert.equal(loop.priority, 4, "no buttons -> high, not max");

  // Nothing to answer -> a plain push, not an empty actions array.
  assert.equal(buildPush(good, { sessionId: "s", project: "r", message: "m" })!.actions, undefined);

  // No topic configured -> nothing at all, rather than a push to nowhere.
  assert.equal(buildPush({ topic: null, dashUrl: "https://x.ts.net" }, { sessionId: "s", project: "r", message: "m" }), null);

  // --- the wire shape ntfy actually requires ---
  const wire = JSON.parse(JSON.stringify(p));
  assert.equal(wire.actions[0].action, "http");
  assert.equal(wire.actions[0].method, "POST");
  assert.equal(wire.actions[0].headers["Content-Type"], "application/json");
  assert.equal(typeof wire.actions[0].body, "string", "ntfy wants body as a STRING, not an object");

  // --- the join that matters: a real permission screen -> real buttons ---
  // pendingOptions() needs a live session, so drive the parser directly with a
  // screen of the shape parsePermission is built for. Without this, nothing
  // proves the parser's output actually fits buildActions().
  const { parsePermission } = await import("./prompts.ts");
  const screen = [
    "\u23fa I'll update the config.",
    "",
    "\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e",
    "\u2502 Do you want to make this edit to config.ts?  \u2502",
    "\u2502                                              \u2502",
    "\u2502 \u276f 1. Yes                                     \u2502",
    "\u2502   2. Yes, allow all edits during this session \u2502",
    "\u2502   3. No, and tell Claude what to do differently \u2502",
    "\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f",
  ].join("\n");

  const parsed = parsePermission(screen);
  assert.ok(parsed && parsed.kind === "permission", "fixture must parse as a permission prompt");
  const real = buildActions("https://x.ts.net", "sid", parsed.options);
  assert.equal(real.length, 3);
  assert.deepEqual(real.map((a) => a.label), [
    "Yes",
    "Yes, allow all edits dur",
    "No, and tell Claude what",
  ]);
  // Option 2's label contains a comma; the header format could not carry it.
  assert.deepEqual(JSON.parse(real[1].body), { key: "2" });

  const full = buildPush(good, {
    sessionId: "sid", project: "repo", message: "Claude needs your permission", options: parsed.options,
  })!;
  assert.equal(full.actions?.length, 3);
  assert.ok(JSON.stringify(full).length < 4000, "ntfy rejects oversized payloads");

  // --- run completion pushes ---
  const pass = buildRunPush(good, { worktree: "/w/repo", command: "bun test", exitCode: 0, seconds: 12 })!;
  assert.ok(pass.message.startsWith("passed in 12s"));
  assert.deepEqual(pass.tags, ["white_check_mark"]);
  assert.equal(pass.priority, 4, "a finished run blocks nothing — must not be as loud as a prompt");
  assert.equal(pass.actions, undefined, "there is nothing to answer");
  assert.ok(pass.click?.includes("/w?wt="), "clicking goes to the worktree, not a session");

  const fail = buildRunPush(good, { worktree: "/w/repo", command: "bun run build", exitCode: 2, seconds: 240 })!;
  assert.ok(fail.message.startsWith("failed (exit 2) in 240s"));
  assert.deepEqual(fail.tags, ["x"]);

  assert.equal(buildRunPush({ topic: null, dashUrl: null }, { worktree: "w", command: "c", exitCode: 0, seconds: 1 }), null);

  // --- idle_prompt is not a permission prompt ---
  assert.equal(isUrgent("permission_prompt"), true);
  assert.equal(isUrgent("idle_prompt"), false);
  assert.equal(isUrgent(null), true, "unknown types must stay loud, not silently vanish");

  const idle = buildPush(good, {
    sessionId: "sid", project: "repo", message: "Claude is waiting for your input",
    options: opts, type: "idle_prompt",
  })!;
  assert.equal(idle.priority, 2, "you have not typed lately; nothing is blocked");
  assert.equal(idle.actions, undefined, "an idle nudge has nothing to answer");
  assert.deepEqual(idle.tags, ["speech_balloon"]);

  // --- the body must carry what the buttons cannot ---
  assert.equal(
    optionLines([{ key: "1", label: "Yes" }, { key: "2", label: "No" }]),
    "1. Yes\n2. No",
  );
  assert.equal(
    optionLines([{ key: "1", label: "Yes", description: "does   the\n thing" }]),
    "1. Yes\n   does the thing",
    "descriptions are included and whitespace collapsed",
  );

  const spelled = buildPush(good, {
    sessionId: "sid", project: "repo", message: "Claude needs your permission",
    options: opts, type: "permission_prompt",
  })!;
  // The label the button shows is cut at 24 chars; the full text must survive
  // in the body or you are choosing between options you can only half read.
  assert.ok(spelled.message.includes("2. Yes, and don't ask again, allow all edits"));
  assert.ok(spelled.actions![1].label.length === LABEL_MAX);

  const perm = buildPush(good, {
    sessionId: "sid", project: "repo", message: "Claude needs your permission",
    options: opts, type: "permission_prompt",
  })!;
  assert.equal(perm.priority, 5);
  assert.equal(perm.actions?.length, 3);
  assert.deepEqual(perm.tags, ["bell"]);

  console.log("ok");
}
