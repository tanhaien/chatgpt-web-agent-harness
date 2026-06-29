# Local Coding Agent — Windows Tray App

A small C#/.NET WinForms tray app that runs and supervises the Local Coding
Agent on one machine:

- Starts/stops the Node MCP server (`server/server.mjs`) and the OpenAI Secure Tunnel.
- A form to set the workspace root(s), mode, port, and tunnel key.
- Stores the tunnel key **encrypted with Windows DPAPI** (per user) — never plain text.
- Live status, one-click **Copy MCP URL** and **Open Dashboard**.
- **Stop is authoritative** — it stops the server/tunnel even if they were
  started outside the app (e.g. by the launcher script).

> Full documentation and security model: see the [repository README](../README.md).

## Requirements

- **Build:** .NET SDK (project targets `net10.0-windows`). https://aka.ms/dotnet/download
- **Run (after self-contained publish):** nothing extra.
- Node.js (for the MCP server) and a `tunnel-client.exe` you obtained yourself.

## Build / run

```powershell
cd tray-app
dotnet run                                   # dev run
# or a single self-contained exe in .\publish (no .NET needed by users):
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

## First-time setup in the app

1. Launch the app. Path fields auto-fill relative to the repo; set **Workspace**
   to the folder you want the agent to work in.
2. Choose **Mode** (`safe` recommended) and **Policy** (`balanced` recommended;
   `strict` = read-only, `full` = no local approval gate).
3. Point **tunnel-client.exe** at your copy (not shipped — see repo README).
4. Paste **CONTROL_PLANE_API_KEY** → **Save key** (stored encrypted via DPAPI).
5. **Start** → server then tunnel. **Copy MCP URL** and add it as a connector in ChatGPT.

Closing the window keeps it in the tray. Tray → **Exit** fully stops.

## Where settings live

`%APPDATA%\LocalCodingAgent\config.json` — the key is the DPAPI-encrypted
`EncryptedKey` field, decryptable only by the same Windows user on the same machine.

Hidden helper: `LocalCodingAgentTray.exe --kill-strays` stops any running
server/tunnel headlessly.
