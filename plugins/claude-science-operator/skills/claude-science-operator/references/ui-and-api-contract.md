# UI and API contract

## Supported local layout

- Claude Science app: `/Applications/Claude Science.app`
- Claude Science CLI: `/Applications/Claude Science.app/Contents/Resources/bin/claude-science`
- CSSwitch app: `/Applications/CSSwitch.app`
- CSSwitch config: `~/.csswitch/config.json`
- CSSwitch Science data directory: `~/.csswitch/sandbox/home/.claude-science`
- Supported Claude Science versions: `0.1.20`, `0.1.25`, `0.1.43` (explicit allowlist; unknown versions fall back to GUI)
- Supported CSSwitch schema: `4`

The MCP service reads only CSSwitch mode, ports, schema, experimental-Codex flag, active profile id, and a small allowlist of profile metadata. It never returns profile URLs, keys, secrets, credential references, browser state, or cookies.

## Private API routes

The version-gated bridge uses these loopback routes:

- `POST /api/auth/nonce`
- `GET /api/csrf`
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/frames`
- `GET /api/frames/{id}`
- `GET /api/frames/{id}/messages`
- `POST /api/projects/{id}/request`
- `POST /api/frames/{id}/message`
- `GET /api/projects/{id}/artifacts`
- `GET /api/frames/{id}/artifacts`
- `GET /api/agents`
- `GET /api/models`
- `POST /api/agents`
- `PATCH|DELETE /api/agents/{name}`
- `GET|PUT|DELETE /api/agents/{name}/custom-prompt`
- `POST /api/agents/{name}/enabled`
- `POST|PUT /api/agents/{name}/skills`
- `DELETE /api/agents/{name}/skills/{skillName}`
- `POST /api/agents/{name}/connectors`
- `DELETE /api/agents/{name}/connectors/{serverId}`
- `PUT /api/agents/{name}/connectors/{serverId}/exclusions`
- Guarded `GET|PUT /api/preferences/*` routes listed by `claude_science_settings`

Authentication is generated on demand by `claude-science url --data-dir …`. The control URL must be plain HTTP on exactly `127.0.0.1` or `localhost`, use the configured sandbox port, contain no userinfo or fragment, and contain exactly one valid nonce. `operon_auth`, `operon_csrf`, and the CSRF header stay in memory and are never logged or returned.

Writes are dispatched once with a generated `intent_id`. Transport failure, timeout, or a server failure after dispatch becomes `STATE_UNCERTAIN`; neither the server nor the Skill retries it.

## Session states

- Active: `processing`, `running`, `queued`, `pending`
- Complete: `completed`, `succeeded`, `done`
- Failed: `failed`, `cancelled`, `canceled`
- Needs user: `awaiting_plan_approval`, `awaiting_user_response`, or any approval object in the response

When state names change or the payload shape is no longer recognized, treat the API as unsuitable and inspect the current GUI.

## Exact Safari identity

Each Safari operation re-lists tabs and matches the current Science loopback port plus an exact
project or project/frame path. Window and tab indexes are ephemeral and are never accepted as
identity by themselves. Immediately before a page action, in-page JavaScript rechecks protocol,
loopback host, port, path, title, and a visible Claude Science DOM anchor. Ambiguous page or element
matches fail closed.

## GUI recovery

Use the separate CSSwitch Operator to start or reuse the isolated runtime. Focus the exact Science
project/frame page before Computer Use. After every page transition, modal, submission, or
asynchronous refresh, read a new accessibility tree. Old numeric indexes are stale by definition
and must not be reused.
