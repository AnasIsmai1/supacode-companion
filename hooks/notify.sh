#!/bin/bash
# Claude Code Notification/Stop hook -> ntfy push + ASK spool for the dashboard.
#
# Reads the hook payload as JSON on stdin. Config lives outside the repo so the
# ntfy topic is not committed:
#   ~/.claude/companion/config.env   NTFY_TOPIC=...   DASH_URL=https://host
set -euo pipefail

CONF="$HOME/.claude/companion/config.env"
SPOOL="$HOME/.claude/companion/spool"
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
import json,sys,time,os
json.dump({'message': sys.argv[1], 'type': sys.argv[2], 'at': int(time.time()*1000)},
          open(sys.argv[3],'w'))
" "$msg" "${ntype:-notification}" "$spool_file"

[ -n "${NTFY_TOPIC:-}" ] || exit 0
curl -fsS --max-time 5 \
  -H "Title: $project" \
  -H "Tags: bell" \
  -H "Click: ${DASH_URL:-http://127.0.0.1:7777}/s/$sid" \
  -d "$msg" \
  "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 || true
