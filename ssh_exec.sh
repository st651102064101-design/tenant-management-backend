#!/bin/bash
# SSH execution helper script
# Usage: ./ssh_exec.sh "command"

HOST="192.168.1.132"
USER="admin"
PASS="1234"
PORT="22"
CMD="$1"

sshpass -p "$PASS" ssh -4 \
  -o ConnectTimeout=5 \
  -o ServerAliveInterval=5 \
  -o UserKnownHostsFile=/dev/null \
  -o StrictHostKeyChecking=no \
  -p "$PORT" \
  "$USER@$HOST" \
  "$CMD" 2>&1
