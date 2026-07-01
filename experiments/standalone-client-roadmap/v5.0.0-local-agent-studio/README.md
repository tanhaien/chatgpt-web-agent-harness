# v5.0.0 Local Agent Studio

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

## Exit Criteria

- A non-expert customer can install, connect a model key, select a workspace,
  ask the agent to inspect a repo, approve risky actions, and send a support
  report if something fails.
- The old GPT Web connector workflow still works for users who prefer it.
