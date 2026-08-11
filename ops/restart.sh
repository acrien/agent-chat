#!/usr/bin/env bash
# Restart the server, from outside it.
#
# WHY THIS IS A SCRIPT AND NOT A COMMAND. The server hosts the agent's own
# session, so the agent restarting it kills the process running the restart.
# Everything after the kill has to already be somewhere else — a shell that was
# started detached, holding the argv it read BEFORE anything died.
#
# IT RE-EXECS WHAT WAS ACTUALLY RUNNING, read from /proc rather than from a
# remembered command line. The port, the host, the cwd and the session token
# are all in that argv, and a script that hardcoded them would hand out a new
# token on every restart — silently signing the owner out of a page that looks
# identical.
#
# NOTHING HERE SELECTS BY PATTERN. `pkill -f server.mjs` matches this script's
# own command line, which is how a restart script kills the shell running it
# and reports success for work it never did. The pid is passed in.
#
#     ops/restart.sh <pid> [log]
set -uo pipefail

PID="${1:?usage: restart.sh <pid> [log]}"
LOG="${2:-$HOME/.rainsmoke3/agent-chat.log}"

if [ ! -d "/proc/$PID" ]; then
  echo "restart: no process $PID" >&2
  exit 1
fi

# Read everything about the old process BEFORE killing it. After the kill,
# /proc/$PID is gone and so is any chance of asking what it was.
mapfile -d '' ARGV < "/proc/$PID/cmdline"
CWD="$(readlink "/proc/$PID/cwd")"
EXE="$(readlink "/proc/$PID/exe")"
ARGV[0]="$EXE"

mkdir -p "$(dirname "$LOG")"
{
  echo "--- restart $(date -Is): pid $PID, ${#ARGV[@]} args, cwd $CWD"
} >> "$LOG"

# ARM THE REVIVE WATCH BEFORE THE KILL. This restart kills the very process
# that would notice it failed, so nothing inside the server can check on it —
# that half belongs to rainsmoke3's revive job, which polls from outside. The
# watch is armed here, in the detached thing that survives the kill, so a
# restart that does not come back is found by the poller instead of sitting
# dead behind a page nobody is watching. Before this, a restart armed via the
# server never armed a watch at all, and the failure it exists to catch had no
# catcher. FAIL-OPEN: no rm3, no port, or a refused arm still restarts — a
# gate that could break the restart on its own bug is worse than no watch.
PORT=""
for ((i = 0; i < ${#ARGV[@]}; i++)); do
  if [ "${ARGV[$i]}" = "--port" ]; then PORT="${ARGV[$((i + 1))]}"; fi
done
RM3="${RM3_BIN:-$HOME/projects/rainsmoke3/ops/rm3}"
if [ -n "$PORT" ] && [ -x "$RM3" ]; then
  printf '{"what":"the chat server","url":"http://127.0.0.1:%s/api/health","was_pid":%s,"cwd":"%s","why":"restarting the chat server"}' \
    "$PORT" "$PID" "$CWD" | "$RM3" revive expect >> "$LOG" 2>&1 \
    || echo "restart: could not arm the revive watch" >> "$LOG"
fi

kill "$PID" 2>/dev/null
for _ in $(seq 1 20); do
  [ -d "/proc/$PID" ] || break
  sleep 0.5
done
# Still there after ten seconds: it is not going to shut down politely, and a
# port still held is a restart that will fail in a way nobody can read.
if [ -d "/proc/$PID" ]; then
  echo "restart: $PID did not exit on TERM, sending KILL" >> "$LOG"
  kill -9 "$PID" 2>/dev/null
  sleep 1
fi

cd "$CWD" || { echo "restart: cannot enter $CWD" >> "$LOG"; exit 1; }

# SETSID IS NOT EVERYWHERE, and the one place it is missing is the place this
# most needed to work. Measured 2026-08-10 in the lab pod: `command -v setsid`
# finds nothing — util-linux is not in that image — so this line would have run
# the kill, failed to start anything, and left the pod's page dead with the
# reason in a log nobody was reading. The pod exists to fail differently from
# production; this is the shape where that costs the thing being tested.
#
# It is a new session so the server outlives whoever asked for the restart. When
# that is unavailable, `nohup` plus a background job survives the hangup, which
# is the half that actually matters here: the caller is already detached (the
# server spawns this with its own session) and exits immediately either way.
if command -v setsid >/dev/null 2>&1; then
  setsid "${ARGV[@]}" >> "$LOG" 2>&1 &
else
  echo "restart: no setsid — starting with nohup instead" >> "$LOG"
  nohup "${ARGV[@]}" >> "$LOG" 2>&1 &
fi
NEW=$!
echo "restart: started pid $NEW" >> "$LOG"
echo "$NEW"
