# Backlog

## Next up

- [ ] Decide whether `hooks/events.sh` earns its ~52ms per tool call. Measured,
      against the 27ms its own comment claims. Backgrounding the bun call drops
      it to ~5ms and gives up delivery guarantees. Now that stuck detection
      depends on its heartbeat, removing it costs more than it did.
- [ ] Watch whether the finished-turn push is the right threshold. 90 seconds is
      a guess. Too low and every turn buzzes; too high and the build you walked
      away from stays silent.

## Done 2026-08-22

- [x] Qualitative repo audit. Four real defects, all fixed: unbounded supacode
      waits (the CLI defaults to 180s), whole-transcript re-reads on every poll,
      an unbounded request body, and one unbounded network spawn.
- [x] Option descriptions in a live question. They were on screen the whole
      time, indented under each title; the parser only understood the other
      layout and threw them away.
- [x] Per-file revert from the diff view.
- [x] Branch history, with unpushed commits marked.
- [x] A push when a long turn finishes, not only when Claude asks.
- [x] Phone layout. The chat header carried seven controls that could not
      shrink and set a floor width wider than the screen.

Open work, roughly in the order I'd do it. `V2.md` holds the design and the
decision log; this is just what is left.

## Blocked

**Cold-launch test for `open -g -a supacode`.** Verified it does not steal focus
when Supacode is already running. The cold launch is untested, because it means
quitting Supacode with a lot of live worktrees open. `-g` stops LaunchServices
activating the app, but an app can still call `NSApp.activate()` itself.

Asked the maintainer directly on
[supacode#821](https://github.com/supabitapp/supacode/issues/821), since they can
answer from the source faster than this can be tested. If `-g` works cold, that
issue should be closed and the escape hatch wired with `-g`.

## Not started

- **Consolidate the polling onto one WebSocket.** Per open chat there are three
  independent loops: a 3s `/api/session` poll, the transcript socket, and an 8s
  diff poll. Fine for one phone. omg.dev moved to a single live socket, and it is
  the next thing that breaks if several sessions are open at once on a mobile
  radio.
- **Per-file restore from the diff view.** `restoreFile` is in `lib/git.ts` and
  tested, but nothing in the UI calls it. A long press on a row in Changes.
- **`git log` / branch view.** You can see what changed and land it, but not what
  you already landed.
- **Notify when a session goes idle after a long turn.** Pushes happen when Claude
  asks. They do not happen when it finishes, which is the other half of walking
  away. The `Stop` hook already fires and already clears the spool.

## Known ceilings, deliberately not fixed

- **Screen scraping.** `prompts.ts` and `mode.ts` still parse Ink output. A Claude
  Code UI change still breaks approving from the phone. v2 moved diff and runs
  onto structured sources; the approval path has no structured source to move to.
- **`bin/sup` is not type-checked.** TypeScript with a bun shebang and no `.ts`
  extension, so tsc's globs skip its ~180 lines. The `lib/` it imports is covered.
- **No hang detector for the server itself.** `KeepAlive: {SuccessfulExit: false}`
  catches a crash but not a wedged event loop. Never observed in 46h with zero
  stderr. Revisit on the first actual hang.
- **Presence is in memory.** A server restart forgets who viewed what and ranking
  falls back to `updatedAt`.
- **Stuck detection is blind on old sessions.** Claude Code caches hooks at session
  start, so sessions predating the `hooks/events.sh` registration never emit
  events and fall back to a 30 minute bar instead of 4.
- **`hooks/events.sh` costs ~52ms per tool call**, measured, against the 27ms its
  own comment claims. Backgrounding the bun call drops it to ~5ms at the cost of
  delivery guarantees.

## Filed upstream

Checked 2026-08-27. All three got a maintainer response within a day.

- **[supacode#820](https://github.com/supabitapp/supacode/issues/820)** `tab list
  --json`. Labelled `ready`, self-assigned by sbertix, who plans to mirror
  `worktree status` and add `--json` across the commands. Flagged in a followup
  that the agent pid is NEW data rather than a reformat: `tab list` does not
  carry it at all today, and it is the only field that cannot be worked around.
  Offered to test a branch. Nothing to do but wait.
- **[supacode#821](https://github.com/supabitapp/supacode/issues/821)** launching
  without activating. Labelled `question`. sbertix asked whether
  `open -g -a supacode` already does it. Probably yes. Answered honestly that
  only the warm case is verified and asked whether the app self-activates on
  launch. Likely outcome is that this closes as already-solved.
- **[zmx#211](https://github.com/neurosnap/zmx/issues/211)** silent cross-version
  `send`. neurosnap replied "I didn't think about embedded versions. I might
  merge the associated pr" — PR #212 had been closed unmerged, and the
  Supacode-bundles-0.6.0 angle moved it back toward landing. Still no release
  past v0.7.0, so the bug is live and `lib/zmx.ts` must keep preferring the
  bundled binary. Offered to test a build.
