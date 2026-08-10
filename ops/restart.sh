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
setsid "${ARGV[@]}" >> "$LOG" 2>&1 &
NEW=$!
echo "restart: started pid $NEW" >> "$LOG"
echo "$NEW"
