# Local Coding Agent
# Copyright (c) 2026 Long Nguyen
# SPDX-License-Identifier: AGPL-3.0-or-later

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Local Coding Agent launcher: starts the Node MCP server, then the OpenAI
# Secure MCP Tunnel. Edit the variables below, then run this script.
#
# This file is intentionally pure-ASCII: Windows PowerShell 5.1 reads .ps1 as
# ANSI, so non-ASCII literals (e.g. accented folder names) get corrupted.
# Use $AgentWorkspace below or set it via the AGENT_WORKSPACE env var.
# ---------------------------------------------------------------------------

# Repo root = parent of this script's folder (repo/scripts/..).
$RepoRoot  = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ServerDir = Join-Path $RepoRoot "server"

# ---- Edit these ----------------------------------------------------------
# Folder the agent is allowed to work in (REQUIRED). Example:
#   $AgentWorkspace = "C:\Users\you\source\my-project"
$AgentWorkspace = $env:AGENT_WORKSPACE
# Path to YOUR copy of the OpenAI tunnel-client.exe (not shipped in this repo).
$TunnelExe      = Join-Path $RepoRoot "tools\tunnel-client.exe"
$ProfileName    = "local-coding-agent"
$ProfileDir     = Join-Path $RepoRoot "tools\profiles"
$AgentMode      = "safe"     # "safe" (recommended) or "full"
$ExtraRoots     = ""          # extra folders, semicolon-separated
$AuthToken      = ""          # optional bearer token (defense in depth)
$DashboardPort  = "8790"      # local-only dashboard; do NOT use 8788 (tunnel uses it)
$Port           = "8787"
# --------------------------------------------------------------------------

$McpHealthUrl = "http://127.0.0.1:$Port/healthz"

function Get-McpHealth {
    try {
        $r = Invoke-WebRequest -Uri $McpHealthUrl -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -ne 200) { return $null }
        return ($r.Content | ConvertFrom-Json)
    } catch { return $null }
}

if (-not $AgentWorkspace) {
    throw "Set `$AgentWorkspace at the top of this script (or the AGENT_WORKSPACE env var) to the folder you want the agent to work in."
}
if (-not (Test-Path -LiteralPath $AgentWorkspace)) {
    throw "Workspace folder does not exist: $AgentWorkspace"
}
if (-not (Test-Path -LiteralPath $TunnelExe)) {
    throw "tunnel-client.exe not found at: $TunnelExe  (obtain it yourself and update `$TunnelExe)"
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is required but 'node' was not found on PATH."
}

# Install server deps on first run.
if (-not (Test-Path -LiteralPath (Join-Path $ServerDir "node_modules"))) {
    Write-Host "Installing server dependencies..."
    Push-Location $ServerDir; npm install; Pop-Location
}

# Restart the server if it is running with a different workspace/mode.
$health = Get-McpHealth
if ($health -and (($health.workspace -ne $AgentWorkspace) -or ($health.mode -ne $AgentMode))) {
    Write-Host "Restarting MCP server with the requested config..."
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -like "*server.mjs*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
    $health = $null
}

if (-not $health) {
    Write-Host "Starting MCP server (workspace=$AgentWorkspace mode=$AgentMode)..."
    $env:PORT = $Port
    $env:AGENT_WORKSPACE = $AgentWorkspace
    $env:AGENT_MODE = $AgentMode
    $env:AGENT_EXTRA_ROOTS = $ExtraRoots
    $env:MCP_AUTH_TOKEN = $AuthToken
    $env:DASHBOARD_PORT = $DashboardPort
    Start-Process -FilePath "node.exe" -ArgumentList "server.mjs" `
        -WorkingDirectory $ServerDir -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $ServerDir "mcp.log") `
        -RedirectStandardError (Join-Path $ServerDir "mcp.err.log")
    Start-Sleep -Seconds 2
}

if (-not (Get-McpHealth)) {
    throw "MCP server did not respond at $McpHealthUrl. Check server\mcp.err.log."
}

Write-Host "MCP server OK:  http://127.0.0.1:$Port/mcp"
if ($DashboardPort -ne "0") { Write-Host "Dashboard:      http://127.0.0.1:$DashboardPort/ui" }
Write-Host ""
Write-Host "Paste the Runtime API key for the OpenAI Secure MCP Tunnel."
Write-Host "It connects the tunnel; it is not used for model responses."
$secureKey = Read-Host "CONTROL_PLANE_API_KEY" -AsSecureString
$plainKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey))

try {
    $env:CONTROL_PLANE_API_KEY = $plainKey
    if ($AuthToken) {
        $env:MCP_AUTH_HEADER = "Bearer $AuthToken"
        $env:MCP_EXTRA_HEADERS = "Authorization: env:MCP_AUTH_HEADER"
    }
    Write-Host ""
    Write-Host "Running tunnel. Keep this window open while using the ChatGPT app."
    & $TunnelExe run --profile $ProfileName --profile-dir $ProfileDir --open-web-ui
} finally {
    Remove-Item Env:\CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:\MCP_AUTH_HEADER -ErrorAction SilentlyContinue
    Remove-Item Env:\MCP_EXTRA_HEADERS -ErrorAction SilentlyContinue
}
