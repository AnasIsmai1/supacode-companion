# Supacode Companion

Phone dashboard for the Claude Code sessions running in your Supacode worktrees.
Mirrors Supacode's own Project → Worktree → Window tree, streams each session's
conversation, and sends replies into the real session.

## Run

```sh
bin/sup up          # build web, install the launchd job, ensure tailscale serve
bin/sup status      # is the whole chain up?
bin/sup restart
```

`sup up` generates `~/Library/LaunchAgents/com.nas.supacode-companion.plist` from
this checkout; it is not committed, because it needs absolute paths.

`sup status` probes all five links, not just the one launchd knows about:

```
  OK  launchd          running pid 25304
  OK  port 7777        listening
  OK  http             HTTP 200 - 21 live sessions
  OK  tailscale serve  proxying to :7777
  --  tailnet          Pixel 8 Pro OFFLINE
  OK  notify url       https://<machine>.ts.net -> HTTP 200
```

Those last two lines are the point. launchd cannot see `tailscale serve`, whether
the phone is on the tailnet, or whether `DASH_URL` still resolves - so it reports
a healthy job while the phone gets nothing, which from the phone is
indistinguishable from the server being down.

`DASH_URL` in particular is worth checking after a rename. Renaming the machine
is how you get a memorable URL:

```sh
tailscale set --hostname=supacode   # -> https://supacode.<tailnet>.ts.net
tailscale serve reset && tailscale serve --bg 7777
# then update DASH_URL, and wait ~30s for Tailscale to fetch the ACME cert
```

All three steps are required. `serve` binds to the OLD DNS name, so a rename on
its own leaves the URL dead — and a `DASH_URL` of `http://127.0.0.1:7777` means
every notification tap opens the *phone*, not this Mac. Both were true here.

Logs in `logs/companion.log` and `logs/companion.err`.

Client dev loop with hot reload: `cd web && bun run dev` (proxies `/api` and `/ws`
to :7777).

## How it resolves a session

```
~/.supacode/layouts.json   worktree → tabs[] → title, surface id, agent pid
        ↓ pid
~/.claude/sessions/<pid>.json      → sessionId, cwd, status
        ↓ sessionId
~/.claude/projects/<slug>/<id>.jsonl   → the conversation
        ↓ surface id
supa-<surface-id>                  → the zmx session to write to
```

## Three things that will bite you

**Use Supacode's zmx, not Homebrew's.** Supacode bundles `zmx 0.6.0` at
`/Applications/supacode.app/Contents/Resources/zmx/zmx` and creates every session
with it. Homebrew's `0.7.0` can `ls` and `history` those sessions but its `send`
exits 0 and delivers nothing. That was the entire "can't send messages" bug.
`lib/zmx.ts` always prefers the bundled binary.

**`bun run build` after editing `web/`.** The server serves static files from
`public/`, which is Vite's output directory. Skip the build and you silently get
the old bundle.

**shift+tab is `\x1b[9;2u`, not `\x1b[Z`.** Claude Code turns on the Kitty
keyboard protocol (it emits `\x1b[=1;1u`), so classic backtab is ignored
outright. This is how `lib/mode.ts` cycles the permission mode. Five distinct
statuslines exist — `manual mode on`, `accept edits on`, `auto mode on`,
`plan mode on`, `bypass permissions on` — and they must not be conflated, or a
switch will stop on the wrong one and still report success.

## What the worktree view can do

`/w?wt=<id>` is the other half of the app. The session views key on a session;
diff, runs and git belong to the **worktree**, and have to work while a session
is busy, modal or dead - which is exactly when you want them.

- **Changes** - everything the branch changed since its fork point, so commits
  Claude already made show up too, not just uncommitted work. The file list
  paints first and each patch loads on expand.
- **Run** - one tap for any script in the worktree's `package.json`, or type a
  command. It runs under `zmx run -d`, so it survives the phone locking and this
  server restarting, and `ZMX_TASK_COMPLETED` gives an exact exit code rather
  than a guess parsed from the output.
- **Actions** - commit, push, open a PR, restore one file, discard everything.
  Force-push is not reachable from here at all.

## What the chat can do

- Markdown with GFM tables and syntax-highlighted code (Shiki, lazy-loaded per
  language). Unlabelled fences stay plain monospace by design.
- `/` opens a filtered palette over ~1,500 skills, plugin commands and personal
  commands; `@` searches the worktree via `git ls-files`. Recents float up.
- Permission mode is read off the statusline and changed by cycling shift+tab,
  verifying after each press and giving up after five rather than looping.
- A terminal for any window, Claude-backed or not, with a key bar for
  esc/tab/ctrl/arrows that a phone keyboard lacks.

## Notifications

Hooks are registered in `~/.claude/settings.json`. The ntfy topic lives in
`~/.claude/companion/config.env` (chmod 600, outside the repo):

```
NTFY_TOPIC=<random>
DASH_URL=https://<your-machine>.ts.net
```

Install the ntfy Android app and subscribe to that topic.

## Terminal fallback

`bin/sup` prints the same data. `sup` lists, `sup -a` includes dormant worktrees,
`sup 3` attaches, `sup log 3` dumps the conversation, `sup say 3 yes` replies.

## Check

```sh
bun run check                # tsc over server.ts and lib/
bun run test                 # eight assert-based self-checks, plus shellcheck
```

Every non-trivial module carries its own `bun <file>` self-check rather than a
test framework. `bun run check` exists because nothing type-checked the server
before, which is how `startClaude` shipped used-but-not-imported.
