---
name: csswitch-operator
description: Operate the locally installed CSSwitch app through its authenticated external control bridge, with native-bridge compatibility. Use when the user asks to inspect or change CSSwitch profiles, provider connections, model catalogs, runtime mode, ports, SSH reuse, or the managed Claude Science runtime.
---

# CSSwitch Operator

Use the external MCP bridge for routine CSSwitch work. It is versioned separately from
CSSwitch.app and owns its protocol, authentication record, configuration fingerprints, and
atomic configuration writes; never edit `~/.csswitch/config.json` directly.

## Route operations

1. Call `csswitch_status` first.
2. Read `csswitch_get_config` before any configuration change. Keep its
   `config_fingerprint` for the write.
3. Use `csswitch_list_templates` before creating a profile.
4. Use `csswitch_profile_action` for profile creation, metadata, connection/model catalog changes,
   activation, key clearing, and deletion.
5. Use `csswitch_runtime_action` for start, stop, mode, port, and system-SSH settings.
6. Use `csswitch_check_provider` without end-to-end mode for a local chain check.

Every bridge write is sent once with a unique intent id. If the tool returns `STATE_UNCERTAIN`, do
not repeat it and do not perform the same action through the UI. Read status/config to determine
whether it committed, then ask the user before any possible duplicate.

## Confirmations and secrets

- Reads and local non-billable checks need no confirmation.
- Require the user's explicit intent before changing profiles, model catalogs, ports, mode, or SSH
  reuse. Pass `confirm: true` only for the exact reviewed mutation.
- Require an immediate explicit confirmation before clearing a key, deleting a profile, stopping a
  running Science session, enabling system SSH reuse, or running an end-to-end provider check.
- A provider key may be accepted as an input to create/update a profile, but never read it back,
  print it, log it, or place it in command-line arguments.
- Do not inspect Keychain, Codex credentials, browser state, private logs, or account databases.

## GUI fallback

Use Computer Use for login, OAuth/browser handoff, file pickers, native dialogs, Skill package
selection, download, release, or any operation the native capability response does not list. Read a
fresh accessibility tree after every material UI change and never reuse stale element indexes.
