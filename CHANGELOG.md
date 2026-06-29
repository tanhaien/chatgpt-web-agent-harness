# Changelog

All notable changes to Local Coding Agent are documented here. The project
follows [Semantic Versioning](https://semver.org/).

## [4.0.0] - 2026-06-29

Version 4 is the cross-platform and security-focused release. It promotes the
Windows-first 2.x runtime into a consistent Windows, macOS, and Linux package,
while retaining the MCP coding tools, local dashboard, skill support, and
Windows tray workflow.

### Added

- Cross-platform shell selection: `cmd` and PowerShell on Windows, plus
  `bash`, `sh`, and `zsh` support on macOS/Linux.
- Cross-platform process-tree supervision. Windows child processes are stopped
  with `taskkill`; POSIX children run in their own process group and are
  terminated as a group.
- `AGENT_EXTRA_ROOTS_JSON` for unambiguous multi-root configuration when paths
  contain `:` or `;`.
- Structured `git_status` and `git_diff` MCP tools.
- Skill authoring tools: `create_skill` and `delete_skill`.
- Dashboard mini-IDE endpoints and UI for browsing the workspace, previewing
  files, viewing Git diffs, and clearing local metrics.
- A security regression suite covering symlink/junction escape attempts,
  unsafe raw-Git flags, non-repository behavior, and recursive audit redaction.
- GitHub Actions CI on Windows, macOS, and Ubuntu, plus a Windows tray publish
  gate.

### Changed

- Server and tray versions are now `4.0.0`.
- The Windows tray app now defaults to `safe` mode, including migration of
  empty legacy settings to the safer default.
- The tray app targets `.NET 10` and publishes a self-contained Windows x64
  executable.
- Root confinement now canonicalizes existing path segments before access,
  blocking symlink and junction escapes while preserving new-file workflows.
- Windows path comparisons are case-insensitive; POSIX comparisons remain
  case-sensitive.
- Command execution and output capture share platform-aware spawn and cleanup
  behavior, reducing orphaned background processes.
- Audit logging recursively redacts commands, patches, file contents, tokens,
  passwords, authorization headers, and nested secret-like fields.
- Package-lock and CI installs are deterministic through `npm ci`.

### Tunnel authentication

- When `MCP_AUTH_TOKEN` is configured, the Windows tray app and both launcher
  scripts pass `Authorization: Bearer <token>` to the tunnel through
  `MCP_EXTRA_HEADERS`.
- Secrets are passed through environment variables rather than command-line
  arguments and are cleared by launcher cleanup paths.

### Upgrade notes

- Building the tray app now requires the .NET 10 SDK. Users of the published
  self-contained executable do not need to install the .NET runtime.
- Existing installations should keep `AGENT_MODE=safe` unless unrestricted
  command execution inside configured roots is explicitly required.
- If `MCP_AUTH_TOKEN` is enabled, restart both the MCP server and tunnel so the
  new forwarded authorization header takes effect.
- Dashboard port `8788` remains reserved by the tunnel client; use the default
  dashboard port `8790`.

[4.0.0]: https://github.com/LongNgn204/local-coding-agent/releases/tag/v4.0.0
