# v4.7.0-pro Workspace Profiles

Goal: support multiple customer workspaces cleanly.

## Planned Capabilities

- Profile CRUD:
  - create
  - use
  - rename
  - delete
  - export redacted
- Per-profile settings:
  - workspace
  - extra roots
  - mode
  - policy
  - MCP port
  - dashboard port
  - tunnel ID
  - organization ID
  - model preset
- One-click launch profile.
- Clear warning when the active workspace differs from expected.

## Deliverables

- Shared config format between CLI and standalone client.
- Profile selector in the standalone UI.
- Migration from existing CLI config.

## Exit Criteria

- A user can switch between two repos without editing environment variables.
- `workspace_info` shown in UI always matches the active profile.
