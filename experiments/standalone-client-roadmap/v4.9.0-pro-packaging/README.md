# v4.9.0-pro Packaging

Goal: make customer distribution simple.

## Planned Capabilities

- Portable archives:
  - Windows x64
  - macOS arm64/x64
  - Linux x64
- Windows self-contained tray/studio build.
- Update assistant:
  - check current version
  - fetch latest release
  - preserve local config and tools
  - validate after update
- Support bundle:
  - redacted config
  - doctor
  - network doctor
  - status
  - health summary
  - relevant logs

## Deliverables

- Release asset build scripts.
- Checksums for all assets.
- Clear customer install/update docs.

## Exit Criteria

- Customer can download a release asset and run without building from source.
- Support can ask for one bundle instead of many screenshots.
