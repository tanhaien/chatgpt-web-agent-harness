<p align="center">
  <img src="docs/banner.svg" width="880" alt="ChatGPT Web Agent Harness" />
</p>

<p align="center">
  <a href="https://github.com/tanhaien/chatgpt-web-agent-harness/releases"><img src="https://img.shields.io/github/v/release/tanhaien/chatgpt-web-agent-harness?color=2dd4bf&label=release" alt="release" /></a>
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-60a5fa" alt="platforms" />
  <img src="https://img.shields.io/badge/MCP-server-a78bfa" alt="mcp" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="license" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white" alt="node" />
  <a href="https://github.com/tanhaien/chatgpt-web-agent-harness/stargazers"><img src="https://img.shields.io/github/stars/tanhaien/chatgpt-web-agent-harness?style=social" alt="stars" /></a>
</p>

<p align="center">
  <img alt="ChatGPT Web" src="https://img.shields.io/badge/ChatGPT%20Web-MCP%20connector-10a37f?logo=openai&logoColor=white" />
  <img alt="OpenAI Codex" src="https://img.shields.io/badge/Codex-compatible-412991?logo=openai&logoColor=white" />
  <img alt="Claude Code" src="https://img.shields.io/badge/Claude%20Code-compatible-D97757?logo=anthropic&logoColor=white" />
  <img alt="Docker" src="https://img.shields.io/badge/Docker%20sandbox-2496ED?logo=docker&logoColor=white" />
</p>

---

# 🤖 ChatGPT Web Agent Harness

> **Fullstack MCP harness for ChatGPT Web (Codex Web) — turn ChatGPT's GPT-5.5 into a full-stack local coding agent with Docker sandboxed execution, web search, review gates, and verification.**
>
> Fork of [LongNgn204/local-coding-agent](https://github.com/LongNgn204/local-coding-agent) with `sandbox_exec` for Docker-isolated code execution and dynamic workspace switching.

---

## English

### Quick Start

#### Prerequisites
- Node.js ≥ 18
- Docker (optional, for sandbox_exec)
- A ChatGPT Plus subscription ($20/mo — free GPT-5.5 with Codex Web)

#### Setup (5 minutes)

```bash
# 1. Clone
git clone https://github.com/tanhaien/chatgpt-web-agent-harness.git
cd chatgpt-web-agent-harness

# 2. Install
npm install

# 3. Configure
cp server/.env.example server/.env
# Edit .env: set your OPENAI_API_KEY (for Secure Tunnel)

# 4. Start the tunnel
bash scripts/start-tunnel.sh
# Follow the URL to authorize → OpenAI opens a tunnel to your machine

# 5. Open ChatGPT Web (chatgpt.com/codex)
# → Connect MCP server → tools appear automatically
```

#### Verify it works

```bash
# MCP server health (port 8787)
curl http://localhost:8787/health

# Dashboard (port 8790)
curl http://localhost:8790/
```

In ChatGPT Codex, call `ping` or `workspace_info` to confirm the connection.

---

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                 ChatGPT Web (Codex Web)                  │
│              GPT-5.5 inference — FREE in $20/mo          │
│           Plans → Codes → Reviews → Verifies             │
└────────────────────────┬────────────────────────────────┘
                         │ OpenAI Secure MCP Tunnel
                         ▼
┌─────────────────────────────────────────────────────────┐
│             LCA MCP Server  (server/server.mjs)          │
│             Node.js · port 8787 · Zod schemas            │
├─────────────────────────────────────────────────────────┤
│  Tools:                                                  │
│  · ping           — health check                         │
│  · read_file      — read file with offset/limit          │
│  · write_file     — write entire file                    │
│  · run_commands   — batch commands (up to 12)            │
│  · search_text    — ripgrep-backed content search        │
│  · web_search     — DuckDuckGo search (no API key)      │
│  · web_fetch      — URL content → markdown              │
│  · git_status/diff— git operations                       │
│  · sandbox_exec   — Docker-isolated code execution      │
│  · set_workspace  — switch repo without restart          │
│  · verify_done    — evidence gate                        │
│  · quality_gate   — lint/test/build gate                │
│  · workspace_*    — snapshot, doctor, info              │
│  · skills/policy  — project conventions & rules          │
└─────────────────────────────────────────────────────────┘
```

---

### What makes this different from plain Codex Web?

| Capability | Codex Web only | Codex Web + LCA Harness |
|---|---|---|
| Local file system | ❌ | ✅ Full read/write/patch |
| Docker sandbox exec | ❌ | ✅ `sandbox_exec` (this fork) |
| Web search | ❌ | ✅ DuckDuckGo (free, no API key) |
| Code review gate | ❌ | ✅ `verify_done` evidence gate |
| MCP routing | ❌ | ✅ Native stdio MCP |
| Dynamic workspace switch | ❌ | ✅ `set_workspace` (this fork) |

---

### What's in this fork (v2.9+)

- **sandbox_exec** — Docker-isolated code execution (pytest, npm test, cargo build, etc.)
- **set_workspace** — switch repo at runtime, no restart needed
- **AGENTS.md** — structured agent workflow playbook
- **verify_done** — formal evidence gate for task completion

---

### Full Tool Reference

#### Added by this fork
| Tool | Description |
|---|---|
| `sandbox_exec` | Run code in Docker container — isolated, repeatable |
| `set_workspace` | Switch workspace repo dynamically |

#### Built-in (from LCA core)
| Tool | Description |
|---|---|
| `ping` | Health check |
| `read_file` / `write_file` | File read/write |
| `run_commands` | Batch command execution (up to 12) |
| `search_text` | Ripgrep-backed content search |
| `web_search` / `web_fetch` | Web research (DuckDuckGo) |
| `git_status` / `git_diff` | Git operations |
| `verify_done` | Verification with evidence gate |
| `quality_gate` | Lint/test/build gate |
| `workspace_info` / `workspace_snapshot` / `workspace_doctor` | Workspace introspection |
| `list_skills` / `policy_status` | MCP metadata |

---

### Workflow

```
EVERY non-trivial task:
  1. Plan the task with the user → structured plan
  2. Present → wait for confirmation
  3. For each sub-task:
     a. Edit code (read_file → write_file)
     b. Run tests via sandbox_exec (NOT execute_command)
     c. Fix failures (max 3 retries)
     d. Review changes before moving on
  4. Call verify_done with evidence
  5. Report: DONE ✅ or BLOCKED ❌ with reason
```

---

### AGENTS.md

This repo includes an `AGENTS.md` — a playbook for AI coding agents (ChatGPT Codex, Claude Code, Cursor). It enforces:

- Plan-then-execute workflow
- Tool selection guide (which tool for which job)
- Never use `execute_command` for tests — always `sandbox_exec`
- Never claim done without `verify_done`
- Anti-patterns checklist

To use: the agent reads `AGENTS.md` at workspace start.

---

### Safety Defaults

- All dangerous operations require explicit approval
- `sandbox_exec` runs in Docker — host system is isolated
- `execute_command` restricted to safe commands (echo, ls, mkdir)
- Audit log at `server/data/audit.log`
- Workspace-isolated state/backup/approval files

---

### Development

```bash
# Start dev server with auto-reload
node --watch server/server.mjs

# Run agent test suite
npm run test:agent

# Run security tests
npm run test:security

# Build Windows tray app
npm run build:tray
```

#### Project Structure

```
├── server/           # MCP server (Node.js, Zod)
│   ├── server.mjs    # Main entry point
│   ├── tools/        # Tool implementations
│   └── data/         # Metrics, audit logs
├── scripts/          # Tunnel client, setup scripts
├── docs/             # Documentation, banner SVG
├── AGENTS.md         # AI agent playbook
└── LICENSE           # AGPL-3.0
```

---

### License

AGPL-3.0 — see [LICENSE](LICENSE).

---

## Tiếng Việt

### Bắt Đầu Nhanh

```bash
# 1. Clone repo
git clone https://github.com/tanhaien/chatgpt-web-agent-harness.git
cd chatgpt-web-agent-harness

# 2. Cài đặt
npm install

# 3. Cấu hình
cp server/.env.example server/.env
# Sửa .env: điền OPENAI_API_KEY

# 4. Chạy tunnel
bash scripts/start-tunnel.sh
# Theo URL → OpenAI mở tunnel đến máy bạn

# 5. Mở ChatGPT Web (chatgpt.com/codex)
# → Kết nối MCP → tools xuất hiện
```

### Kiến Trúc

```
ChatGPT Web (Codex Web)  ← OpenAI Tunnel
        │
        ▼
  LCA MCP Server (port 8787)
        │
        ├── 📁 File ops (read/write)
        ├── 🐳 Docker sandbox (sandbox_exec)
        ├── 🌐 Web search (DuckDuckGo)
        └── ✅ Review + verify gates
```

### Tính Năng Chính

| Tính năng | Mô tả |
|---|---|
| `sandbox_exec` | Chạy code trong Docker — cô lập, an toàn |
| `set_workspace` | Chuyển repo workspace không cần restart |
| `set_workspace` | Chuyển repo workspace không cần restart |
| AGENTS.md | Playbook cho AI agent — workflow chuẩn |
| `verify_done` | Evidence gate |

### An Toàn

- Mọi thao tác nguy hiểm cần approval
- `sandbox_exec` chạy trong Docker — cách ly hoàn toàn với host
- `execute_command` CHỈ dùng lệnh an toàn (echo, ls, mkdir)
- Audit log tại `server/data/audit.log`

### Giấy Phép

AGPL-3.0 — xem [LICENSE](LICENSE).

---

<p align="center">
  <sub>Built on <a href="https://github.com/LongNgn204/local-coding-agent">LongNgn204/local-coding-agent</a> · AGPL-3.0</sub>
</p>
