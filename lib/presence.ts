// When YOU last touched a session, as opposed to when Claude last did.
//
// Two consumers, which is why this is its own module:
//
//   1. Notifications. Being pushed about a prompt already on your screen is
//      noise, and it trains you to ignore the ones that matter.
//   2. Ranking. The home screen sorted by `updatedAt`, which is Claude Code's
//      OWN last write — so a session Claude has been grinding on for an hour
//      outranked one you prompted two minutes ago. That is backwards: the list
//      is for you to find your way back to something, not a leaderboard of
//      whichever agent is busiest.
//
// No client work is needed to collect any of this. The chat view already polls
// /api/session/<id> every 3s and `usePoll` stops the moment `document.hidden`
// is true, so a recent poll means that session is on a screen that is on.
// Sending and answering are already POSTs. Every signal is existing traffic.
//
// ponytail: in memory, so a server restart forgets it and ranking falls back to
// updatedAt. Persist to a JSON file if that ever actually annoys you — 46h of
// uptime says it will not.
//
// Self-check: bun lib/presence.ts

export type Touch = {
  /** Last time the session was open on a screen that was on. */
  viewedAt: number;
  /** Last time you sent or answered something. Stronger signal than viewing. */
  actedAt: number;
};

const touches = new Map<string, Touch>();

/** One poll interval is 3s; 20s is ~6 missed polls, so this errs toward pushing. */
export const VIEWING_MS = 20_000;

const MAX_ENTRIES = 500;

function entry(sessionId: string): Touch {
  let t = touches.get(sessionId);
  if (!t) {
    t = { viewedAt: 0, actedAt: 0 };
    touches.set(sessionId, t);
  }
  return t;
}

/** The chat view is polling this session, so it is on screen right now. */
export function touchViewed(sessionId: string, now = Date.now()): void {
  entry(sessionId).viewedAt = now;
  if (touches.size > MAX_ENTRIES) prune(now);
}

/** You sent a message or answered a prompt. Deliberate, so it also counts as viewing. */
export function touchActed(sessionId: string, now = Date.now()): void {
  const t = entry(sessionId);
  t.actedAt = now;
  t.viewedAt = now;
  if (touches.size > MAX_ENTRIES) prune(now);
}

/** Drop whatever has not been touched in a day; a stale entry is two numbers. */
function prune(now: number): void {
  for (const [k, t] of touches) {
    if (now - Math.max(t.viewedAt, t.actedAt) > 24 * 60 * 60_000) touches.delete(k);
  }
}

/** Is a phone looking at this session right now? */
export function isViewing(sessionId: string, now = Date.now()): boolean {
  const t = touches.get(sessionId);
  return Boolean(t && now - t.viewedAt < VIEWING_MS);
}

/** When you last did anything with this session, or 0. */
export function lastTouched(sessionId: string): number {
  const t = touches.get(sessionId);
  return t ? Math.max(t.viewedAt, t.actedAt) : 0;
}

/**
 * How recent this session is *to you*.
 *
 * The most recent signal of either kind. Your own interaction now counts at
 * all, which it did not before — sorting on `updatedAt` alone could not tell
 * two long-finished sessions apart, however recently you had opened one.
 *
 * Deliberately NOT weighted in your favour: a session Claude wrote to more
 * recently than you touched it still wins. That is fine, because the Recent
 * list excludes busy sessions — those have their own section.
 */
export function recency(sessionId: string, updatedAt: number): number {
  return Math.max(lastTouched(sessionId), updatedAt);
}

/** Test seam — the map is module state on purpose. */
export function reset(): void {
  touches.clear();
}

if (import.meta.main) {
  const assert: typeof import("node:assert").strict = (await import("node:assert")).strict;
  const t0 = 1_800_000_000_000; // a realistic ms epoch; `now - 6h` must stay positive

  reset();
  assert.equal(isViewing("a", t0), false, "never opened -> push");
  assert.equal(lastTouched("a"), 0);

  touchViewed("a", t0);
  assert.equal(isViewing("a", t0 + 1_000), true, "polled 1s ago -> on screen");
  assert.equal(isViewing("a", t0 + VIEWING_MS - 1), true);
  // usePoll stops on document.hidden, so polls stopping IS the phone locking.
  assert.equal(isViewing("a", t0 + VIEWING_MS + 1), false, "polls stopped -> push again");

  // Per session, not per app: the tree does not name a session, so sitting on
  // it must not silence a different session's prompt.
  assert.equal(isViewing("b", t0 + 1_000), false);

  // --- ranking ---
  reset();
  // The case that motivated this: two sessions Claude finished with long ago.
  // The one you actually opened must come back to the top. Sorting on
  // `updatedAt` alone could not tell them apart at all.
  const now = t0;
  const old = now - 6 * 60 * 60_000;
  touchActed("mine", now - 2 * 60_000);
  assert.ok(recency("mine", old) > recency("theirs", old), "the one you touched ranks higher");
  assert.equal(recency("theirs", old), old, "untouched still ranks, by Claude's activity");

  // Honest about the limit: this is max(), so a session Claude wrote to more
  // recently than you touched it does still win. That is why the Recent list
  // excludes busy sessions — they have their own section.
  assert.equal(recency("mine", now), now, "Claude writing later than you still counts");

  // Untouched sessions still rank, by Claude's activity.
  assert.equal(recency("never-opened", 12345), 12345);

  // Acting counts as viewing — you were plainly there.
  reset();
  touchActed("c", t0);
  assert.equal(isViewing("c", t0 + 1_000), true, "sending is proof you are looking at it");
  assert.equal(lastTouched("c"), t0);

  // The newer of the two wins, whichever it is.
  reset();
  touchActed("d", t0);
  touchViewed("d", t0 + 5_000);
  assert.equal(lastTouched("d"), t0 + 5_000);
  touchActed("d", t0 + 9_000);
  assert.equal(lastTouched("d"), t0 + 9_000);

  reset();
  console.log("ok");
}
