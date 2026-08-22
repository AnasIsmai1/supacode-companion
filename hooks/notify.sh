#!/bin/bash
# Claude Code Notification/Stop hook -> push + ASK spool for the dashboard.
#
# Reads the hook payload as JSON on stdin. Config lives outside the repo so the
# ntfy topic is not committed:
#   ~/.claude/companion/config.env   NTFY_TOPIC=...   DASH_URL=https://host
#
# The push goes through the companion server rather than curling ntfy directly.
# The server knows what the session is actually waiting on — it already has
# listSessions() and the screen parsers warm — so it can attach a button per
# option. ntfy's `http` action is run by the ntfy app ON THE PHONE, and the
# phone is on the tailnet, so those buttons POST straight to /api/answer with
# nothing exposed publicly.
#
# If the server is down we fall back to the plain push. A notification with no
# buttons is much better than no notification.
set -euo pipefail

CONF="$HOME/.claude/companion/config.env"
SPOOL="$HOME/.claude/companion/spool"
PORT="${PORT:-7777}"
# shellcheck source=/dev/null
[ -f "$CONF" ] && . "$CONF"
mkdir -p "$SPOOL"

payload=$(cat)
jq_get() { printf '%s' "$payload" | /usr/bin/python3 -c "
import json,sys
d=json.load(sys.stdin)
v=d
for k in '$1'.split('.'):
    v = (v or {}).get(k) if isinstance(v, dict) else None
print(v if v is not None else '')
"; }

sid=$(jq_get session_id)
cwd=$(jq_get cwd)
event=$(jq_get hook_event_name)
[ -n "$sid" ] || exit 0

project=$(basename "${cwd:-unknown}")
spool_file="$SPOOL/$sid.json"

case "$event" in
  Stop|SubagentStop)
    # Turn finished: whatever it was waiting for, it is no longer waiting.
    rm -f "$spool_file"
    exit 0
    ;;
esac

# Notification: prefer the notification message, fall back to the event name.
msg=$(jq_get message)
[ -n "$msg" ] || msg="needs your input"
ntype=$(jq_get notification_type)

/usr/bin/python3 -c "
import json,sys,time
json.dump({'message': sys.argv[1], 'type': sys.argv[2], 'at': int(time.time()*1000)},
          open(sys.argv[3],'w'))
" "$msg" "${ntype:-notification}" "$spool_file"

# Preferred path: the server resolves the pending options and adds the buttons.
body=$(/usr/bin/python3 -c "
import json,sys
print(json.dumps({'sessionId': sys.argv[1], 'project': sys.argv[2], 'message': sys.argv[3]}))
" "$sid" "$project" "$msg")

if curl -fsS --max-time 8 -H 'Content-Type: application/json' \
     -d "$body" "http://127.0.0.1:$PORT/api/notify" >/dev/null 2>&1; then
  exit 0
fi

# Fallback: the server is down, so send the plain push ourselves.
[ -n "${NTFY_TOPIC:-}" ] || exit 0
curl -fsS --max-time 5 \
  -H "Title: $project" \
  -H "Tags: bell" \
  -H "Click: ${DASH_URL:-http://127.0.0.1:7777}/s/$sid" \
  -d "$msg" \
  "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 || true
