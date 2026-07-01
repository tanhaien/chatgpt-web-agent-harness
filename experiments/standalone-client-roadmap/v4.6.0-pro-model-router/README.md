# v4.6.0-pro Model Router

Goal: make the standalone client model-agnostic.

## Planned Capabilities

- Model provider interface:
  - OpenAI Responses API
  - Anthropic Messages API
  - local/Ollama-compatible HTTP models
- Tool schema adapters per provider.
- Configurable model presets:
  - fast
  - balanced
  - deep-review
  - local-only
- Retry and rate-limit handling.
- Cost/latency display per request where the provider exposes usage.

## Deliverables

- `src/providers/openai.mjs`
- `src/providers/anthropic.mjs`
- `src/providers/ollama.mjs`
- `src/tool-schema-adapters.mjs`
- UI model picker with provider status.

## Exit Criteria

- Same MCP tool loop works with at least OpenAI and one local-model adapter.
- Provider errors are shown without leaking API keys.
- Existing v4.5 chat UI still works.
