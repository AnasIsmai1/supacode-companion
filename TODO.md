# Backlog

Open work, roughly in the order I'd do it. `V2.md` holds the design and the
decision log; this is just what is left.

## Blocked on a decision

**Cold-launch test for `open -g -a supacode`.** `open -g` is documented as "Does
not bring the application to the foreground", and it verifiably does not steal
focus when Supacode is already running (frontmost stayed `zen` across the call).
What is untested is a cold launch: `-g` stops LaunchServices activating the app,
but an app can still call `NSApp.activate()` itself during startup. Testing means
quitting Supacode, which closes tabs and windows. zmx sessions survive, since zmx
owns them, but it is disruptive enough to ask first.

Outcome changes what happens to
[supacode#821](https://github.com/supabitapp/supacode/issues/821): if `-g` works
cold, that issue should be closed by its own author and the escape hatch wired
with `-g` instead.

**Merge `run-notify` into `main`.** Six commits, nothing landed on main since the
morning of 2026-08-22.

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

- [supacode#820](https://github.com/supabitapp/supacode/issues/820) `tab list
  --json` with titles, surface ids and agent pid. Would let `lib/layout.ts` stop
  parsing `~/.supacode/layouts.json`.
- [supacode#821](https://github.com/supabitapp/supacode/issues/821) launching the
  app from the CLI without activating it. See the blocked item above.
- [zmx#211](https://github.com/neurosnap/zmx/issues/211#issuecomment-5378285847)
  commented: `send` returns exit 0 and delivers nothing across a version
  boundary. Their own `get` already fails fast with "daemon too old?", which is
  the behaviour `send` should copy.
