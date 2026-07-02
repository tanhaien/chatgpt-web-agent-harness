# v5.0.0 Local Agent Studio Preview

Goal: productize the standalone local AI coding experience.

## Product Shape

Local Agent Studio is a standalone local app that:

- starts and supervises the MCP server,
- connects to one or more model providers,
- runs the model/tool loop locally,
- manages workspace profiles,
- shows tool calls and approvals,
- validates skills,
- exports support bundles,
- updates safely.

## Implemented Preview Foundation

- OpenAI, Anthropic, and Ollama provider adapters.
- MCP server start, stop, status, connection, and tool execution.
- Workspace profile create, activate, delete, and redacted export.
- Skills list/read/validate controls.
- Metrics, approvals, file preview, and Git diff controls.
- Redacted support bundle export.
- Guarded customer update flow.
- Windows x64 `dist/LocalAgentStudio.exe`.
- Loopback-only API security with a per-process capability token, strict Origin
  and Host validation, JSON-only mutation requests, CSP, and anti-framing
  headers.
- Durable SQLite threads, turns, messages, and tool events.
- Recursive support-bundle redaction with raw tool arguments/results excluded
  from exported event metadata.
- Ed25519-signed commercial license verification. Preview builds run without a
  key; Stable builds fail closed.
- Separate Ed25519 release-integrity verification and an anti-backdoor source
  audit. Signing private keys are never stored in the app or repository.
- Automated security, persistence, licensing, integrity, and HTTP boundary
  regression tests.

## Run

```powershell
npm install
npm test
npm run security:audit
npm start
```

Open `http://127.0.0.1:5182`, or double-click
`dist\LocalAgentStudio.exe`.

Node.js 22.5+ is required for the Preview source launcher because the durable
thread store uses the built-in SQLite module. The production desktop package
will bundle its runtime so customers do not install Node.js.

## Preview Licensing

No commercial key is required while `releaseStage` is `preview`. The Stable
build will accept only an admin-issued license token signed outside the app.
The app contains only the public verification key; an admin private key must
never be committed, bundled, passed on a command line, or sent to customers.

Release integrity uses a different signing key from customer licensing. See
`docs/SECURITY_AND_COMMERCIALIZATION.md` for the threat model and release gates.

## v5 Requirements

- No GPT Web dependency for the core local coding workflow.
- ChatGPT Web tunnel remains optional.
- Installer or portable package for normal customers.
- Safe defaults:
  - `AGENT_MODE=safe`
  - `AGENT_POLICY=balanced`
  - no public tunnel without auth guidance
- Skills are first-class:
  - install
  - validate
  - browse
  - use
  - author
- Diagnostics are first-class:
  - setup doctor
  - network doctor
  - support bundle

## Production Exit Criteria

- A non-expert customer can install, connect a model key, select a workspace,
  ask the agent to inspect a repo, approve risky actions, and send a support
  report if something fails.
- The old GPT Web connector workflow still works for users who prefer it.

---

## Tiếng Việt

Mục tiêu của Local Agent Studio là tạo một coding agent local độc lập, không
phụ thuộc vào khung chat ChatGPT Web, nhưng vẫn dùng Local Coding Agent MCP làm
engine thao tác workspace.

### Nền Tảng Preview Đã Có

- Adapter OpenAI, Anthropic và Ollama.
- Start/stop/status MCP server và thực thi tool.
- Workspace profiles, Skills, metrics, approvals, file preview và Git diff.
- Support Bundle và Customer Update Flow có kiểm soát.
- API chỉ lắng nghe loopback, dùng session token ngẫu nhiên theo tiến trình,
  kiểm tra Origin/Host, chỉ nhận JSON cho thao tác thay đổi và gửi CSP.
- SQLite lưu bền Thread, Turn, message và tool event.
- Support Bundle redaction đệ quy và không xuất raw tool args/results.
- License thương mại ký bằng Ed25519. Preview chưa cần key; Stable sẽ fail-closed.
- Release integrity dùng cặp khóa ký riêng và có security audit chống backdoor.
- Regression tests cho security, persistence, licensing, integrity và HTTP.

### Chạy Preview

```powershell
npm install
npm test
npm run security:audit
npm start
```

Mở `http://127.0.0.1:5182` hoặc chạy `dist\LocalAgentStudio.exe`.

Bản chạy source hiện cần Node.js 22.5+ vì Thread Store dùng SQLite tích hợp.
Bản desktop thương mại sau này sẽ bundle runtime, khách không phải cài Node.js.

### License Preview

Khi `releaseStage` là `preview`, app không yêu cầu key thương mại. Bản Stable
chỉ chấp nhận license token do admin ký ở bên ngoài app. App chỉ chứa public
key để xác minh; admin private key tuyệt đối không được commit, bundle, truyền
qua command line hoặc gửi cho khách.

Khóa ký release phải tách biệt với khóa ký license khách hàng. Xem
`docs/SECURITY_AND_COMMERCIALIZATION.md` để biết threat model và release gates.
