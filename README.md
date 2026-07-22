# Claude Science Operator

Claude Science Operator is a Codex plugin for operating a locally installed Claude Science instance through CSSwitch.

It uses the version-gated local API for routine project and session work, and falls back to the macOS GUI when startup, authentication, approvals, uploads, downloads, exports, or artifact interaction require visible user interaction.

## Requirements

- macOS
- Claude Science `0.1.20`
- CSSwitch schema `4`
- Node.js

The API channel is enabled only when the Claude Science binary, running process, health state, and loopback port all match the supported compatibility contract.

## Install from GitHub

Add this repository as a Codex plugin marketplace, then install the plugin:

```bash
codex plugin marketplace add Xu-Zhangsheng/claude-science-operator --ref main
codex plugin add claude-science-operator@claude-science-operator
```

Start a new Codex task after installation so the new skill and MCP server are loaded.

## Install from the package

Download `claude-science-operator-0.1.0.zip` from the [GitHub Release](https://github.com/Xu-Zhangsheng/claude-science-operator/releases/latest), extract it into `~/plugins/`, and install it through a local marketplace entry. The archive contains the complete plugin directory, including its manifest, MCP server, skills, references, tests, and logo.

For normal online installation, the GitHub Marketplace method above is recommended.

## Repository layout

- `.agents/plugins/marketplace.json` — Codex marketplace catalog
- `plugins/claude-science-operator/.codex-plugin/plugin.json` — plugin manifest
- `plugins/claude-science-operator/.mcp.json` — MCP server configuration
- `plugins/claude-science-operator/scripts/server.mjs` — local operator server
- `plugins/claude-science-operator/scripts/server.test.mjs` — automated tests
- `plugins/claude-science-operator/skills/` — Codex skill instructions and references
- `plugins/claude-science-operator/assets/logo.png` — plugin icon

## Test

```bash
node --test plugins/claude-science-operator/scripts/server.test.mjs
```

## Safety

The operator communicates with Claude Science through loopback-only endpoints, validates the expected runtime version and CSSwitch schema, and does not expose local credentials. Writes use unique intent IDs; an uncertain write result is never automatically retried.
