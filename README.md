# 🤖 ChatGPT Web Agent Harness

> **MCP harness for ChatGPT Web (Codex Web) — turn ChatGPT's free GPT-5.5 into a fullstack local coding agent with sandboxed execution, web search, review gates, and verification.**

[![GitHub release](https://img.shields.io/github/v/release/tanhaien/chatgpt-web-agent-harness)](https://github.com/tanhaien/chatgpt-web-agent-harness/releases)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                 ChatGPT Web (Codex Web)                  │
│              GPT-5.5 inference — FREE in $20/mo         │
│           Plans → Codes → Reviews → Verifies            │
└────────────────────────┬────────────────────────────────┘
                         │ OpenAI Secure MCP Tunnel
                         ▼
┌─────────────────────────────────────────────────────────┐
│             OpenAI Secure Tunnel  (tunnel-client)        │
│              Cloud ↔ Local bridge (19MB ELF)             │
└────────────────────────┬────────────────────────────────┘
                         │ stdio MCP protocol
                         ▼
┌─────────────────────────────────────────────────────────┐
│              LCA MCP Server  (server/server.mjs)          │
│              Node.js · port 8787 · Zod schemas            │
├─────────────────────────────────────────────────────────┤
│  Tools:                                                  │
│  · sandbox_exec   — Docker-isolated code execution      │
│  · web_search     — DuckDuckGo search (no API key)      │
│  · web_fetch      — URL content → markdown              │
│  · file ops       — read/write/patch/search files       │
│  · git ops        — status/log/diff/show                │
│  · review_changes — diff-based code review gate         │
│  · verify_done    — x-harness light (checklist+evidence)│
│  · quality_gate   — lint/test/build gate                │
│  · plan_task      — structured plan generation          │
│  · workspace_*    — snapshot, doctor, info              │
│  · skills/policy  — project conventions & rules         │
└─────────────────────────────────────────────────────────┘
```

### What makes this different from plain Codex Web?

| Capability | Codex Web only | Codex Web + LCA Harness |
|---|---|---|
| Local file system | ❌ | ✅ Full access |
| Docker sandbox | ❌ | ✅ Isolated exec |
| Web search | ❌ (uses OpenAI browsing) | ✅ DuckDuckGo |
| Review gate | ❌ | ✅ review_changes + verify_done |
| Plan workflow | Manual | ✅ plan_task structured |
| Custom MCP tools | ❌ | ✅ Add your own |

---

## Quick Start

### Prerequisites
- Node.js ≥ 18
- Docker (for `sandbox_exec` tool)
- npm
- ChatGPT Plus subscription ($20/mo) for Codex Web access
- **OpenAI Secure Tunnel client** — download from [OpenAI MCP Tunnel docs](https://docs.openai.com/)

### Setup (5 minutes)

```bash
# 1. Clone
git clone https://github.com/tanhaien/chatgpt-web-agent-harness.git
cd chatgpt-web-agent-harness

# 2. Install server dependencies
cd server && npm install && cd ..

# 3. Get the tunnel client
# Download from OpenAI → save as tools/tunnel-client && chmod +x

# 4. Start everything
AGENT_WORKSPACE=/path/to/your/project bash scripts/start-tunnel.sh

# 5. Open ChatGPT Web → Codex → your LCA tools appear automatically
```

### Verify it works
```bash
curl http://127.0.0.1:8787/healthz
# → {"status":"ok","workspace":"/path/to/your/project","version":"2.9.0"}
```

---

## Tools Reference

### New in v2.9 (this fork)
| Tool | Description | When to use |
|---|---|---|
| `sandbox_exec` | Run code in Docker container (isolated) | All tests, builds, linting |
| `web_search` | DuckDuckGo web search | Research docs, debugging errors |
| `web_fetch` | Fetch URL → clean markdown | Read API docs, changelogs |
| `verify_done` | Evidence-gated done-check | Final verification after all tasks |

### Built-in (from LCA core)
| Tool | Description |
|---|---|
| `read_file` / `write_file` / `patch` | File editing with line numbers |
| `search_files` | Ripgrep-backed content/file search |
| `git status` / `git log` / `git diff` / `git show` | Git operations |
| `execute_command` | Safe one-off shell commands |
| `plan_task` | Generate structured coding plan |
| `review_changes` | Diff-based code review |
| `quality_gate` | Lint/test/build gate |
| `workspace_snapshot` | Full codebase structure overview |
| `workspace_doctor` | Workspace health check |

---

## Workflow

Every non-trivial task follows this **mandatory** workflow:

```
plan_task → [user approves] → code → sandbox_exec test → review_changes → verify_done
```

1. **Plan** — call `plan_task(task_description)` → structured sub-tasks
2. **Code** — for each sub-task: read → edit → test (via `sandbox_exec`) → fix
3. **Review** — call `review_changes` for each sub-task
4. **Verify** — call `verify_done` with evidence (test output, build logs)

> Full details in [`AGENTS.md`](AGENTS.md) — the operating playbook for ChatGPT Web.

---

## Comparison with Other Stacks

| Feature | This Harness | Codex CLI (OpenAI) | Claude Code / OMC | OpenCode / OMO |
|---|---|---|---|---|
| **Brain** | ChatGPT Web GPT-5.5 (FREE) | Codex CLI API (paid) | Claude API (paid) | Any API (paid) |
| **Sandbox** | Docker | Docker | VM | None |
| **MCP tools** | ✅ Full | ✅ | ✅ | ✅ |
| **Review gate** | ✅ verify_done | ❌ | ❌ | ❌ |
| **Orchestration** | ChatGPT Web auto | Single agent | Single agent | Single agent |
| **Surface** | Web (chatgpt.com) | CLI + Web | TUI + CLI | TUI + CLI |
| **Cost** | $20/mo (ChatGPT Plus) | API tokens | API tokens | API tokens |

---

## Development

### Project Structure
```
chatgpt-web-agent-harness/
├── server/
│   ├── server.mjs          # Main MCP server (~5200 lines)
│   ├── package.json
│   └── test-*.mjs          # Test scripts
├── scripts/
│   ├── start-tunnel.sh     # Tunnel launcher (macOS/Linux)
│   ├── start-tunnel.ps1    # Tunnel launcher (Windows)
│   └── network-doctor.mjs  # Diagnostic tool
├── tools/
│   ├── tunnel-client       # OpenAI Secure Tunnel binary
│   └── profiles/           # Tunnel profiles
├── AGENTS.md               # ChatGPT Web operating playbook
├── CHANGELOG.md
└── README.md
```

---

## License

AGPL-3.0 — this is a fork of [LongNgn204/local-coding-agent](https://github.com/LongNgn204/local-coding-agent).
