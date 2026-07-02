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
  <img alt="SSH Tunnel" src="https://img.shields.io/badge/SSH%20Tunnel-v2-22c55e" />
  <img alt="Docker" src="https://img.shields.io/badge/Docker%20sandbox-2496ED?logo=docker&logoColor=white" />
</p>

---

# 🤖 ChatGPT Web Agent Harness

> **Fullstack MCP harness for ChatGPT Web (Codex Web) — turn ChatGPT's GPT-5.5 into a full-stack local coding agent with Docker sandboxed execution, web search, review gates, and verification.**
>
> Fork of [LongNgn204/local-coding-agent](https://github.com/LongNgn204/local-coding-agent) with SSH tunnel support, `sandbox_exec` for Docker-isolated code execution, dynamic workspace switching, and enhanced VN stock data tools.

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

> **Need SSH instead of OpenAI Tunnel?** See `docs/SSH_TUNNEL.md`.

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
                         │ or SSH Tunnel (this fork)
                         ▼
┌─────────────────────────────────────────────────────────┐
│             LCA MCP Server  (server/server.mjs)          │
│             Node.js · port 8787 · Zod schemas            │
├─────────────────────────────────────────────────────────┤
│  Tools:                                                  │
│  · sandbox_exec   — Docker-isolated code execution       │
│  · web_search     — DuckDuckGo search (no API key)       │
│  · web_fetch      — URL content → markdown               │
│  · set_workspace  — switch repo without restart          │
│  · file ops       — read/write/patch/search files        │
│  · git ops        — status/log/diff/show                │
│  · review_changes — diff-based code review gate          │
│  · verify_done    — checklist + evidence gate            │
│  · quality_gate   — lint/test/build gate                │
│  · plan_task      — structured plan generation           │
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
| Code review gate | ❌ | ✅ `review_changes` + `verify_done` |
| MCP routing | ❌ | ✅ Native stdio MCP |
| SSH tunnel (cloud→local) | ❌ | ✅ (this fork) |
| Dynamic workspace switch | ❌ | ✅ `set_workspace` (this fork) |
| VN stock data tools | ❌ | ✅ vnstock integration (this fork) |

---

### What's in this fork (v2.9+)

- **sandbox_exec** — Docker-isolated code execution (pytest, npm test, cargo build, etc.)
- **set_workspace** — switch repo at runtime, no restart needed
- **SSH tunnel** — connect via SSH instead of OpenAI's tunnel
- **vn_data Bridge** — Vietnamese stock data via vnstock
- **AGENTS.md** — structured agent workflow playbook
- **enhanced review gate** — review_changes + verify_done with evidence collection

---

### Full Tool Reference

#### Added by this fork
| Tool | Description |
|---|---|
| `sandbox_exec` | Run code in Docker container — isolated, repeatable |
| `set_workspace` | Switch workspace repo dynamically |
| `vn_get_quotes` | Fetch VN stock OHLCV data |
| `vn_scan_momentum` | Scan VN stocks for momentum signals |
| `vn_check_signal` | Check entry/SL/RSI signals |
| `vn_get_index` | VN-Index / VN30 data |

#### Built-in (from LCA core)
| Tool | Description |
|---|---|
| `ping` | Health check |
| `read_file` / `write_file` / `patch` | File operations |
| `search_files` | Ripgrep-backed content/file search |
| `git_status` / `git_log` / `git_diff` / `git_show` | Git operations |
| `web_search` / `web_fetch` | Web research (DuckDuckGo) |
| `review_changes` | Diff-based code review |
| `verify_done` | Verification with evidence gate |
| `quality_gate` | Lint/test/build gate |
| `plan_task` | Structured plan generation |
| `workspace_info` / `workspace_snapshot` / `workspace_doctor` | Workspace introspection |
| `list_tools` / `list_skills` / `policy_status` | MCP metadata |

---

### Workflow

```
EVERY non-trivial task:
  1. plan_task(description)  → structured plan
  2. Present → wait for confirmation
  3. For each sub-task:
     a. Edit code (read_file → patch / write_file)
     b. Run tests via sandbox_exec (NOT execute_command)
     c. Fix failures (max 3 retries)
     d. Call review_changes
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
ChatGPT Web (Codex Web)  ← OpenAI Tunnel / SSH Tunnel
        │
        ▼
  LCA MCP Server (port 8787)
        │
        ├── 📁 File ops (read/write/patch/search)
        ├── 🐳 Docker sandbox (sandbox_exec)
        ├── 🌐 Web search (DuckDuckGo)
        ├── 📊 VN stock data (vnstock)
        └── ✅ Review + verify gates
```

### Tính Năng Chính

| Tính năng | Mô tả |
|---|---|
| `sandbox_exec` | Chạy code trong Docker — cô lập, an toàn |
| `set_workspace` | Chuyển repo workspace không cần restart |
| SSH Tunnel | Kết nối cloud→local thay cho OpenAI Tunnel |
| AGENTS.md | Playbook cho AI agent — workflow chuẩn |
| Review gate | `review_changes` + `verify_done` |
| VN stock data | Lấy dữ liệu chứng khoán Việt Nam |

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
