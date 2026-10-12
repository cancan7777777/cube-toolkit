#!/bin/sh
# CubeTimer launcher for macOS.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required: https://nodejs.org/"
  read -r _
  exit 1
fi

node server.js 8902 &
server_pid=$!
sleep 1
open "http://127.0.0.1:8902/index.html"
wait "$server_pid"
