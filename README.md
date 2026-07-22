# Claude Science Operator

Claude Science Operator is a Codex plugin for operating a locally installed Claude Science instance through CSSwitch.

It uses the version-gated local API for routine project and session work, and falls back to the macOS GUI when startup, authentication, approvals, uploads, downloads, exports, or artifact interaction require visible user interaction.

## Requirements

- macOS
- Claude Science `0.1.20`
- CSSwitch schema `4`
- Node.js

The API channel is enabled only when the Claude Science binary, running process, health state, and loopback port all match the supported compatibility contract.

## Repository layout

- `.codex-plugin/plugin.json` — plugin manifest
- `.mcp.json` — MCP server configuration
- `scripts/server.mjs` — local Claude Science operator server
- `scripts/server.test.mjs` — automated tests
- `skills/claude-science-operator/` — Codex skill instructions and references
- `assets/logo.png` — plugin icon

## Test

```bash
node --test scripts/server.test.mjs
```

## Safety

The operator communicates with Claude Science through loopback-only endpoints, validates the expected runtime version and CSSwitch schema, and does not expose local credentials. Writes use unique intent IDs; an uncertain write result is never automatically retried.
