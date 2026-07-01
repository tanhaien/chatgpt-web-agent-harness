# v4.8.0-pro Agent Studio UI

Goal: turn the MVP into a real Agent Studio interface.

## Planned Capabilities

- Chat timeline with:
  - model messages
  - tool calls
  - tool outputs
  - errors
  - approvals
- Skill browser:
  - list skills
  - read skill
  - validate skills
  - copy skill prompt
- Support tab:
  - status
  - doctor
  - network doctor
  - export support bundle
- Dashboard tab:
  - health score
  - latency
  - recent calls
  - top tools
- File/diff viewer for changed files.

## Deliverables

- Componentized frontend.
- Tool timeline filters.
- Safer manual tool-call form generated from JSON schema.

## Exit Criteria

- A customer can debug setup without opening terminal for common cases.
- A developer can inspect exactly what the model did.
