# UI and API contract

## Supported local layout

- Claude Science app: `/Applications/Claude Science.app`
- Claude Science CLI: `/Applications/Claude Science.app/Contents/Resources/bin/claude-science`
- CSSwitch app: `/Applications/CSSwitch.app`
- CSSwitch config: `~/.csswitch/config.json`
- CSSwitch Science data directory: `~/.csswitch/sandbox/home/.claude-science`
- Supported Claude Science version: `0.1.20`
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

Authentication is generated on demand by `claude-science url --data-dir …`. The control URL must be plain HTTP on exactly `127.0.0.1` or `localhost`, use the configured sandbox port, contain no userinfo or fragment, and contain exactly one valid nonce. `operon_auth`, `operon_csrf`, and the CSRF header stay in memory and are never logged or returned.

Writes are dispatched once with a generated `intent_id`. Transport failure, timeout, or a server failure after dispatch becomes `STATE_UNCERTAIN`; neither the server nor the Skill retries it.

## Session states

- Active: `processing`, `running`, `queued`, `pending`
- Complete: `completed`, `succeeded`, `done`
- Failed: `failed`, `cancelled`, `canceled`
- Needs user: `awaiting_plan_approval`, `awaiting_user_response`, or any approval object in the response

When state names change or the payload shape is no longer recognized, treat the API as unsuitable and inspect the current GUI.

## GUI recovery

Use CSSwitch to start or reuse the isolated Science runtime, then use Safari for Science. After every page transition, modal, submission, or asynchronous refresh, read a new accessibility tree. Old numeric indexes are stale by definition and must not be reused.
