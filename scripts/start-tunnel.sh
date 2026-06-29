#!/usr/bin/env bash
# Local Coding Agent
# Copyright (c) 2026 Long Nguyen
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# macOS / Linux launcher: starts the Node MCP server, then the OpenAI Secure
# MCP Tunnel. Edit the variables below, then run:  bash scripts/start-tunnel.sh
set -euo pipefail

# Repo root = parent of this script's folder.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"

# ---- Edit these -----------------------------------------------------------
# Folder the agent may work in (REQUIRED). Or set the AGENT_WORKSPACE env var.
AGENT_WORKSPACE="${AGENT_WORKSPACE:-}"
# Path to YOUR copy of the OpenAI tunnel client (not shipped in this repo).
TUNNEL_BIN="${TUNNEL_BIN:-$REPO_ROOT/tools/tunnel-client}"
PROFILE_NAME="${PROFILE_NAME:-local-coding-agent}"
PROFILE_DIR="${PROFILE_DIR:-$REPO_ROOT/tools/profiles}"
AGENT_MODE="${AGENT_MODE:-safe}"      # "safe" (recommended) or "full"
EXTRA_ROOTS="${AGENT_EXTRA_ROOTS:-}"  # extra folders, ':' or ';' separated
AUTH_TOKEN="${MCP_AUTH_TOKEN:-}"      # optional bearer token
DASHBOARD_PORT="${DASHBOARD_PORT:-8790}"  # do NOT use 8788 (tunnel uses it)
PORT="${PORT:-8787}"
# ---------------------------------------------------------------------------

HEALTH_URL="http://127.0.0.1:$PORT/healthz"

need() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: '$1' not found on PATH." >&2; exit 1; }; }
need node
need curl

get_field() { # $1 = json field; reads health, prints value or empty
  curl -fsS "$HEALTH_URL" 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d);
    process.stdin.on("end",()=>{try{process.stdout.write(String(JSON.parse(s)["'"$1"'"]??""))}catch{process.stdout.write("")}});' 2>/dev/null || true
}

[ -n "$AGENT_WORKSPACE" ] || { echo "ERROR: set AGENT_WORKSPACE (top of script or env var)." >&2; exit 1; }
[ -d "$AGENT_WORKSPACE" ] || { echo "ERROR: workspace does not exist: $AGENT_WORKSPACE" >&2; exit 1; }
[ -x "$TUNNEL_BIN" ] || { echo "ERROR: tunnel client not found/executable: $TUNNEL_BIN" >&2; exit 1; }

# First-run install.
[ -d "$SERVER_DIR/node_modules" ] || { echo "Installing server dependencies..."; (cd "$SERVER_DIR" && npm install); }

# Restart server if running with a different workspace/mode.
cur_ws="$(get_field workspace)"
cur_mode="$(get_field mode)"
if [ -n "$cur_ws" ] && { [ "$cur_ws" != "$AGENT_WORKSPACE" ] || [ "$cur_mode" != "$AGENT_MODE" ]; }; then
  echo "Restarting MCP server with the requested config..."
  pkill -f "server.mjs" 2>/dev/null || true
  sleep 1
fi

if ! curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
  echo "Starting MCP server (workspace=$AGENT_WORKSPACE mode=$AGENT_MODE)..."
  PORT="$PORT" AGENT_HOST=127.0.0.1 AGENT_WORKSPACE="$AGENT_WORKSPACE" AGENT_MODE="$AGENT_MODE" \
  AGENT_EXTRA_ROOTS="$EXTRA_ROOTS" MCP_AUTH_TOKEN="$AUTH_TOKEN" DASHBOARD_PORT="$DASHBOARD_PORT" \
    nohup node "$SERVER_DIR/server.mjs" >"$SERVER_DIR/mcp.log" 2>"$SERVER_DIR/mcp.err.log" &
  sleep 2
fi

curl -fsS "$HEALTH_URL" >/dev/null 2>&1 || { echo "MCP server did not respond. Check server/mcp.err.log" >&2; exit 1; }

echo "MCP server OK:  http://127.0.0.1:$PORT/mcp"
[ "$DASHBOARD_PORT" != "0" ] && echo "Dashboard:      http://127.0.0.1:$DASHBOARD_PORT/ui"
echo
echo "Paste the Runtime API key for the OpenAI Secure MCP Tunnel (input hidden)."
read -r -s -p "CONTROL_PLANE_API_KEY: " CP_KEY
echo

cleanup() { unset CP_KEY; }
trap cleanup EXIT
echo "Running tunnel. Keep this terminal open while using the ChatGPT app."
CONTROL_PLANE_API_KEY="$CP_KEY" "$TUNNEL_BIN" run --profile "$PROFILE_NAME" --profile-dir "$PROFILE_DIR" --open-web-ui
