# Competitive landscape

*Researched 2026-08-22. Sources are linked inline; anything unlinked is marked.*

## The correction

I told you earlier that "mobile is a genuine gap in the whole category" and that
nobody was serving it. That was wrong, and it was wrong in a way that matters.

**Anthropic shipped official mobile Remote Control on 2026-02-25**, six months
before this project existed. There are at least five other mobile clients for
Claude Code. The mobile-access problem is solved, several times over, by people
with more resources than one operator and a weekend.

What is *not* solved is narrower, and it is still worth building. See
[The actual position](#the-actual-position).

## The field

| | Owns the session? | Fleet view | Diff | Run | PR | Platform |
|---|---|---|---|---|---|---|
| **Claude Code Remote Control** | no, but one at a time | no | no | terminal | no | iOS, Android, web |
| **Happy Coder** | yes (`happy` not `claude`) | basic list | changed files only | no | no | iOS, Android, web |
| **Nimbalyst** | yes (desktop host) | kanban | yes, purpose-built | no | no | iOS only |
| **Paseo** | yes | parallel agents | inline | no | no | [Data gap] |
| **Conductor** | yes | yes | yes | yes | yes | Mac only, no mobile |
| **omg.dev** | yes | yes | yes | yes | no | web PWA |
| **supacode-companion** | **no — attaches** | yes | yes | yes | yes | web PWA |

### Claude Code Remote Control — the one that matters

Official, built in, `/remote-control`. Launched 2026-02-25.

Outbound-only connections, short-lived credentials, zero configuration. No
inbound attack surface, no port to forward, no tunnel to run. That is a better
security story than this project has, and it costs the user nothing to set up.

Limits, from the published guides: **one remote connection per session**, the
terminal must stay open, a ~10 minute network outage times the session out, and
it needs a Pro or Max plan. Terminal-only interface, one active session at a
time, no fleet view.

### Happy Coder — the closest direct competitor

[slopus/happy](https://github.com/slopus/happy). MIT, 23.5k stars, 2k forks,
~2,300 commits. iOS, Android, web. Claude Code and Codex. End-to-end encrypted,
relay/sync architecture through their own Happy Server. Push notifications,
realtime voice, device switching mid-session.

It is a far larger and more mature product than this one. It also owns the
session: you run `happy` instead of `claude`, which means it cannot see anything
you started any other way.

Weaknesses, from their own issue tracker and user write-ups:

- Option dialogs render **raw JSON with a yes/no choice**, described by a user as
  "out of context". This project parses the real dialog and shows the actual
  options with previews, which is the single clearest quality gap in our favour.
- The file browser "only shows changed files and works only half the time".
- `happy --resume` does not sync the resumed session to mobile; the phone starts
  a new one instead ([#875](https://github.com/slopus/happy/issues/875)).
- Codex integration "doesn't feel as well tested".

### The graveyard

- **Terragon** shut down January 2026.
- **Vibe Kanban** is sunsetting; Bloop shut down April 2026. Open source
  continues, community maintained.

Two funded orchestrators in this exact space died within four months of each
other. That is the most important signal in this document and it is not about
features. **[Opinion]** The orchestration layer is being commoditised from above
by the model vendors shipping it themselves.

### Conductor

Mac app, parallel Claude/Codex/Cursor agents in isolated worktrees, review the
diff and ship the PR. Free, bring your own subscription. GitHub and Linear.
**No mobile at all.** This is Supacode's competitor, not ours.

## The actual position

Every competitor **owns the process**. Happy replaces `claude`. Nimbalyst hosts
the session. Paseo and Conductor spawn the agents. Remote Control is invoked
from inside the session it controls.

This project is the only one that **attaches to sessions someone else started**.
That is why it can show 21 live sessions across 48 worktrees that Supacode
launched, and why nothing here has to change how work begins.

The moat is one sentence: *the orchestrator is already chosen, and the phone
adapts to it.* It is narrow, it is real, and it is entirely dependent on
Supacode continuing to exist and continuing to write `~/.supacode/layouts.json`
in a shape we can read.

## What this means for v3

**[Opinion]** Three honest readings, in descending order of how much I believe
them:

1. **Depth over reach.** Do not chase Happy on platform coverage or Remote
   Control on setup cost. Both are unwinnable. Go where owning-the-process
   competitors structurally cannot: cross-session intelligence. Stuck detection
   and attention ranking already live here and nowhere else.
2. **The approval quality gap is the one visible win.** Happy shows raw JSON for
   the thing you interact with most. That is a real, citable weakness in the
   biggest competitor, and this project already beats it.
3. **The dependency is the risk, not the competition.** Supacode is a 2.3k-star
   project whose private state file this depends on. Two comparable products in
   this space died this year. That is a bigger threat to v3 than any feature gap.

## Data gaps

- **Paseo**: no primary source found; the comparison row is from a third-party
  round-up, not the vendor. Treat as low confidence.
- **Nimbalyst**: same, plus it is the author's own product in that round-up, so
  the comparison is not disinterested.
- No pricing analysis: this project has no price and no customers. The
  startup-competitors skill's pricing and GTM deliverables were skipped as
  inapplicable, not overlooked.
- No review mining on G2/Capterra: none of these products are listed there.
- Happy's star and commit counts are as of 2026-08-22 and will drift.

## Red flags

- **The category is consolidating and the vendor is competing directly.** Remote
  Control is free with a plan you already have, needs no setup, and has a better
  security model. Most people will use it.
- **Two funded competitors shut down in the last eight months.**
- **This project's foundation is one other project's private file format.**

## Yellow flags

- Happy has 23.5k stars and 2k forks. Any feature it decides to add, it will
  ship faster than one person can.
- Nimbalyst and Paseo already do fleet view plus mobile diff, which was v2's
  headline. That gap closed while v2 was being built.

## Sources

- [Anthropic Remote Control coverage](https://www.helpnetsecurity.com/2026/02/25/anthropic-remote-control-claude-code-feature/)
- [slopus/happy](https://github.com/slopus/happy) · [happy.engineering](https://happy.engineering/) · [issue #875](https://github.com/slopus/happy/issues/875)
- [Best mobile apps for Claude Code, 2026](https://nimbalyst.com/blog/best-mobile-apps-for-claude-code-2026/) (author's own product is in the comparison)
- [Vibe Kanban](https://vibekanban.com/) · [vibe-kanban alternatives](https://aq.dev/alternatives/vibe-kanban/)
- [Conductor](https://www.conductor.build)
