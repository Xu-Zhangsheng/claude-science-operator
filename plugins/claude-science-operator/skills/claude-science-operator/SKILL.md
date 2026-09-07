---
name: claude-science-operator
description: "Operate the locally installed Claude Science app through three coordinated channels: a version-gated loopback API, exact Safari page control, and macOS Computer Use fallback. Use for projects, sessions, experts, models, settings, approvals, uploads, downloads, artifacts, and other Claude Science UI work."
---

# Claude Science Operator

Use API, Safari, and Computer Use as one coverage system. The API is primary for supported structured
operations, exact Safari control is primary for visible web UI, and Computer Use covers native
dialogs and any unsupported or changed UI.

## Route every request

1. Call `claude_science_status` first.
2. Use API tools only when `apiCompatible` is true and `recommendedChannel` is `api`.
3. Use the API for projects, sessions, artifacts metadata, experts, model catalog, reviewer model,
   guarded preferences, and other tools explicitly listed by the MCP server.
4. Use `claude_science_safari_page` for visible UI state and web-only controls.
5. Use Computer Use for login, CAPTCHA, approvals, native file dialogs, upload, download, export,
   artifact interaction, or API/Safari fallback.
6. CSSwitch profile, provider, runtime, or port work belongs to the separate `csswitch-operator`
   plugin.

## Find the exact Claude Science page

Never identify a page by Safari window number, tab position, title alone, or a stale `tab_id`.

For every Safari or Computer Use operation:

1. Determine the exact `project_id` and optional root `frame_id` from the API or the user's target.
2. Call `claude_science_safari_page` with `action: "find"`.
3. The tool re-reads all tabs and requires all of:
   - current Claude Science loopback port from runtime status;
   - HTTP host exactly `localhost` or `127.0.0.1`;
   - exact `/projects/{project_id}` or `/projects/{project_id}/frames/{frame_id}` path;
   - title `Claude Science`.
4. If zero or multiple candidates remain, stop and show the candidates. Never guess.
5. For each snapshot, click, or fill, call the tool again. It re-discovers the tab and performs a
   second in-page origin, path, title, and DOM-anchor check immediately before acting.
6. Locate elements by exact accessible name, role, and optional surrounding context. Positional,
   `nth-*`, or broad first-match selectors are forbidden.
7. Before Computer Use, call `claude_science_safari_page` with `action: "focus"` for the exact
   project/frame. Then read a fresh Safari accessibility tree. If the page changes, focus and read it
   again.

## API operations

- Use `claude_science_list_models` before choosing a task or reviewer model.
- Use `claude_science_list_experts` before creating or changing an expert.
- Use `claude_science_expert_action` for expert creation, update, enabled state, prompt, skills,
  connectors, exclusions, and deletion.
- Use `claude_science_settings` only for its explicit setting allowlist. Host grants, credentials,
  cloud accounts, and secrets stay outside the API tool.
- Task and expert writes are dispatched once with a unique intent id.

If any write returns `STATE_UNCERTAIN`, do not retry it and do not repeat it through Safari or
Computer Use. Inspect the affected object first, then ask the user before any possible duplicate.

## Computer Use

Follow the Computer Use skill. After exact Safari focus, read a fresh accessibility tree and derive
new element indexes after every navigation, modal, submission, model menu, expert editor, or
asynchronous refresh. Never reuse stale indexes.

## Confirmation boundary

Pause for explicit confirmation immediately before:

- sign-in, CAPTCHA, MFA, or granting persistent access;
- approving a plan or external-compute request;
- uploading sensitive data;
- deleting an expert or irreversible data;
- changing security/network/host grants, entering credentials, or spending money.

Routine reads, exact page discovery, snapshots, and non-sensitive navigation do not require
confirmation. Never stop Claude Science automatically.

Read [references/ui-and-api-contract.md](references/ui-and-api-contract.md) when diagnosing API
compatibility or page targeting.
