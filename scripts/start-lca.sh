#!/usr/bin/env bash
# Start LCA server + tunnel-client
# Usage: bash start-lca.sh <tunnel_id> <runtime_api_key>

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LCA_DIR="$(dirname "$SCRIPT_DIR")"

if [ $# -lt 2 ]; then
  echo "Usage: $0 <tunnel_id> <runtime_api_key>"
  echo ""
  echo "1. Create tunnel at: https://platform.openai.com/tunnels"
  echo "2. Create API key at: https://platform.openai.com/settings/organization/api-keys"
  echo "3. Run: $0 <tunnel_id> <api_key>"
  exit 1
fi

TUNNEL_ID="$1"
API_KEY="$2"

echo "=== Starting LCA server (port 8789) ==="
cd "$LCA_DIR/server"
PORT=8789 AGENT_WORKSPACE=/home/ta/lca-workspace AGENT_MODE=safe node server.mjs &
SERVER_PID=$!
echo "Server PID: $SERVER_PID"

sleep 2

echo "=== Starting tunnel-client ==="
export CONTROL_PLANE_TUNNEL_ID="$TUNNEL_ID"
export CONTROL_PLANE_API_KEY="$API_KEY"
"$LCA_DIR/tools/tunnel-client" run --url http://127.0.0.1:8789/mcp &
TUNNEL_PID=$!
echo "Tunnel PID: $TUNNEL_PID"

echo ""
echo "Dashboard: http://127.0.0.1:8790/ui"
echo "MCP endpoint (local): http://127.0.0.1:8789/mcp"
echo ""
echo "Press Ctrl+C to stop both"

wait
