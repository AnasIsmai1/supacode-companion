# Supacode Companion

Phone dashboard for the Claude Code sessions running in your Supacode worktrees.
Mirrors Supacode's own Project → Worktree → Window tree, streams each session's
conversation, and sends replies into the real session.

## Run

```sh
cd web && bun run build      # REQUIRED after any change under web/
cd .. && bun run server.ts   # or: launchctl kickstart -k gui/$(id -u)/com.nas.supacode-companion
tailscale serve --bg 7777    # https://<your-machine>.ts.net
```

Under launchd already: `~/Library/LaunchAgents/com.nas.supacode-companion.plist`.
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
bun test.ts                  # parsers, grouping, send payload, path containment
shellcheck hooks/notify.sh
```
