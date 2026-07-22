---
name: claude-science-operator
description: Operate the locally installed Claude Science app through CSSwitch, using the version-gated loopback API for safe routine project and session work and macOS Computer Use for startup, login, approvals, uploads, artifact interaction, or API fallback. Use when the user asks to run, continue, monitor, inspect, or retrieve work from Claude Science.
---

# Claude Science Operator

Operate Claude Science as a delegated research environment. Prefer the MCP tools for compatible routine work; use `$computer-use` when the UI is required.

## Route the request

1. Call `claude_science_status` first.
2. Use the API channel only when `apiCompatible` is true and `recommendedChannel` is `api`.
3. Use Computer Use when Claude Science is stopped, CSSwitch must be opened, the API gate is closed, authentication needs attention, or the task needs login, CAPTCHA, approval, upload, download, export, or artifact interaction.
4. Keep the current CSSwitch profile. Do not switch to official Claude unless the user explicitly asks.

The API compatibility contract is deliberately narrow: Claude Science `0.1.20`, CSSwitch schema `4`, a verified binary, matching PID/port, and a healthy loopback service. A version or schema change closes API writes immediately; continue through the GUI.

## Use the API channel

For a new task:

1. If the user named a project, call `claude_science_list_projects` and reuse an exact or clearly intended match.
2. Call `claude_science_submit_task`. If no project is selected, allow it to create a prompt-derived project.
3. Poll with `claude_science_poll_session` for no more than 45 seconds per call. Report meaningful progress between calls.
4. Stop and ask the user when the status is `awaiting_plan_approval`, `awaiting_user_response`, or the response reports another approval item.
5. Use `claude_science_list_artifacts` to inspect artifact metadata. Download and export through the GUI in this version.

For follow-up work, identify the root frame with `claude_science_list_sessions`, call `claude_science_continue_session`, then poll that frame.

Every API write has a unique `intent_id`. If a write returns `STATE_UNCERTAIN`, do not retry it and do not switch to the GUI to resend it. Inspect the project or session first, then ask the user before any possible duplicate.

## Use the GUI channel

Follow the `$computer-use` skill. Open or reuse `/Applications/CSSwitch.app`, then open Safari (`com.apple.Safari`) and Claude Science through CSSwitch. Wait until CSSwitch reports normal operation before interacting with Science.

Re-read the current accessibility tree after every navigation, modal, submission, or material page update. Never reuse an old element index after the UI changes. If an element is missing, refresh the tree and locate it by its current role, label, and surrounding context.

To create or continue work:

1. Confirm the intended project and session visually.
2. Put the full task into the live composer, not a read-only example or placeholder field.
3. Submit once and verify visible acknowledgement before monitoring.
4. Read status and results from the refreshed UI. Keep monitoring while work is active.
5. For artifacts, use the visible Science controls for preview, download, or export.

Do not read the Science database, Codex credentials, API keys, CSSwitch secrets, or browser cookies. Do not modify CSSwitch configuration, models, accounts, or profiles.

## Hand control back to the user

Pause for explicit confirmation before:

- signing in, solving a CAPTCHA, or completing multi-factor authentication;
- approving a plan or external-compute request, including HPC or Modal;
- uploading a sensitive file or sending sensitive data;
- granting permissions, spending money, or accepting a consequential external action.

Routine research prompts may be submitted directly. Never stop Claude Science automatically.

Read [references/ui-and-api-contract.md](references/ui-and-api-contract.md) when diagnosing routing, status, or private-API compatibility.
