# Claude Science 0.1.52: session configuration via API

## Audit boundary and decision

This is a read-only static audit of the same 0.1.52 binary described in the [compatibility audit](<./science-0152-compatibility.md>), SHA-256 `d1724ebb97d1917e9a58e229c885c014fa4545d6e54154a425ad00bce8847eb9` (recomputed). Byte offsets identify this specimen only. No actual API, CLI control-URL generation, credential, application-log, database, or paid-model access was performed. No UI actions were performed. The target session's live configuration was not inspected by this auditor.

**There is no audited API that independently preconfigures and confirms all eight input-menu choices before sending.** The session-config API can persist and independently read back Auto-review, Memory, and the per-session Reviewer override. Model, reasoning effort, and delegation are supported request-time inputs, not fields of this configuration setter. Specialist selection is a request target, not a session-config knob. Compute uses a separate provider-enable subsystem; do not invent a `compute: "local"` session-config field or substitute `gpu_mode: "off"`.

The label mappings below describe the corresponding audited backend semantics, not proof that a browser's draft/menu state has been changed. No browser-local selection API was found in this bounded audit. Unsupported preconfiguration is stated explicitly rather than faked through global preferences or a task-dispatch endpoint.

## Session configuration transport

- **POST** `/api/frames/:root_id/session-config` (registration `75035560`) accepts JSON and calls `ox.updateSessionConfig` / `Rfc` (`72169462–72170975`). There is no same-path GET registration in the audited router.
- To read persisted configuration, use the ordinary **GET** `/api/frames/:id` (`75130986`) and inspect only the necessary serialized frame/context fields. No separate verified all-effective-config endpoint was found.
- The POST wrapper forwards exactly `verifier_mode`, `memory_mode`, `auto_mode`, `reviewer_model`, `rc_context_ceiling`, `python_version`, `kernel_idle_timeout`, `gpu_mode`, `goal_text`, and `use_case_id`. It does **not** forward `model`, `effort`, `ultra_mode`, `target_agent`, or an invented compute selection.
- The service requires at least one supplied session knob. Any supplied `gpu_mode` is explicitly rejected: GPU access is set when the session starts, and changing it requires a new session.
- Successful POST returns `{root_frame_id, ...providedKnobs, status: "ok"}`. This is an echo of accepted inputs, **not** a full resolved/effective configuration. It does not return other unchanged fields or confirm model/effort/compute choices.
- The service normalizes a child frame to its root, checks ownership/transcript integrity, serializes concurrent updates, sets pending signals, and persists the knobs. A bridge can deliberately be narrower: require an exact root before writing rather than silently redirect a child.
- Cookie/CSRF handling and one-dispatch uncertainty rules remain those of the compatibility audit. A failed post-write readback is not permission to retry the mutation.

### DTOs and exact values

The shared knob schema (`63793844–63794900`, including `_v` at `63793988` and `GM` at `63794496`) and `KYr` (`68185025`) define:

| Field | Audited type/value | Session-config POST |
| --- | --- | --- |
| `verifier_mode` | String `"off"` or `"on"` | Supported |
| `memory_mode` | String `"off"` or `"on"` | Supported |
| `auto_mode` | String `"off"` or `"on"` | Supported; this is not Auto-review |
| `reviewer_model` | Non-empty string, length `1..200`, or `null` | Supported; `null` means no session override |
| `rc_context_ceiling` | Integer `200000..2000000`, or `null` | Supported |
| `python_version` | String matching `^3\.\d{1,2}$`, or `null` | Supported |
| `kernel_idle_timeout` | Integer seconds `60..21600`, or `null` | Supported |
| `gpu_mode` | String `"off"` or `"on"` | Schema accepts, but this setter rejects both |
| `goal_text` | String length `1..4000`, or `null`; additional normalization applies | Supported; not needed for menu acceptance |
| `use_case_id` | String matching `^(!none\|[A-Za-z0-9_-]{1,128})$`, or `null` | Supported; not needed for menu acceptance |

The source use-case pattern is `^(!none|[A-Za-z0-9_-]{1,128})$`; the table escapes its alternation for Markdown. Constants are `Rei=4000` at `63791597` and `wYe` at `63790967`. These additional knobs are documented as transport facts; exposing every knob is not required to implement the narrow three-menu-item configuration flow.

## Input-menu choices: where they actually apply

| Desired choice | Audited representation | Can it be independently set/read back before a send? |
| --- | --- | --- |
| Selected model | Request-time top-level `model` string using the catalog ID; persisted runtime selection is `context_data._model` when known | **Not by session-config.** Include it in the eventual request and distinguish requested selection from observed persisted state. |
| Reasoning effort **Max** | Request-time top-level `effort: "max"` | **Not by session-config.** Standard ordering is `low, medium, high, xhigh, max`; a model's supported set can constrain/downgrade the effective effort. |
| Delegation **Off** | Root request input `ultra_mode: false` (Boolean) | **Not by session-config.** New project requests accept top-level `ultra_mode`; direct continuation can carry it inside `input_data`. No standalone pre-send delegation setter was verified. |
| Auto-review **On** | `verifier_mode: "on"` | **Yes**, through POST then independent GET of the authoritative stored input. Do not substitute `auto_mode`. |
| Reviewer **Default** | `reviewer_model: null` | **Yes** for clearing the session override. This confirms inheritance, not a fixed reviewer model ID. |
| Memory **Off** | `memory_mode: "off"` | **Yes**, through POST then independent GET. It does not mean delete prior memory/history. |
| Specialist **Default** | For a new project request, omit/null `target_agent` to inherit `xe().default_agent` (built-in configuration default `OPERON`) | **Not by session-config.** Direct-message continuation keeps its existing target and does not forward `target_agent`. The configured default can differ from the built-in default. |
| Compute **Local** | A separate session provider-enable subsystem, not one scalar session knob | **Not certified as a complete selection operation.** The audited setter cannot set/read back this menu choice. `gpu_mode: "off"` is not equivalent. |

`DM` (`63835378`) establishes the effort ordering, and `WYe` (`63835148`) resolves a requested level against supported levels. LLM adaptation explicitly recognizes `"max"` (`65472136`), but requesting Max is not proof that every selected model/provider will execute Max.

Delegation semantics are confirmed by runtime settings (`ultra_mode === true` enables delegation) and root input merging. Nested input remains JSON and is subject to the service's input-depth/internal-key sanitation; do not use internal `_model` or `_effort` keys as a shortcut.

Reviewer inheritance is explicit: the session knob resolver's result, then `settings.reviewer_model`, then `state.model`, then the built-in large-model fallback; reviewer capping/fallback can apply afterward (`_pickReviewers`, around `68915200–68915600`). Thus `null`/missing session override does **not** universally mean “same as this session”; a global reviewer override may still apply. Never send the literal display label `"Default"` as a model ID.

Compute's existing routes include GET `/api/compute/session/:rootFrameId/enabled`, PUT `/api/compute/session/:rootFrameId/enabled/:name` with `checked`, and POST `/api/compute/session/migrate`. These manipulate enabled provider names (`mQi`, `68209516`; `hQi`, `68209670`; `gQi`, `68209817`). Their existence does not establish a safe “all other providers off, Local only” recipe, provider defaults, or browser-label equivalence. Those mutations remain outside this report's certified bridge scope.

## Stored, inherited, requested, and effective are different

### Authoritative original input

The frame decoder `Dde` (`64888562`) uses the following **whole-object** rule:

1. If context has its own `_original_input` property, that property's value is authoritative; `null` means an empty object.
2. Do **not** fill missing keys from older `frame.input_data`. A missing key is missing/inherited, not an explicit configured value.
3. If the property is absent, the application reconstructs input from `input_data` plus `_original_input_delta` (`DIe`/`dz`). A bridge that has not separately implemented and tested that decoder must return unknown/unverified source or fail closed, not invent a per-key fallback.

The repository's `patchSessionKnobs` (`64999275`) persists into `_original_input`; the async service (`69920806`) then broadcasts metadata. Pending verifier/memory/knob signals are consumed by the running agent. A GET proving persisted explicit values therefore confirms storage, not necessarily that an in-flight model request already consumed every update.

The `ly` resolver (`68060481–68061067`) uses local validated input for the root, and the root's stored original input for descendants (with application-specific fallback/guards). `aS` (`68060371`) treats null as absent and schema-validates a value. The bridge should report explicit raw stored values and their provenance, not attempt to reproduce every dynamic global/default/license/capability policy.

### Model and effort observation

- `frame.model` and `frame.effort` are columns/display metadata. Direct-message continuation can change the runtime selection without updating those columns. They are not reliable continuation-effective predicates. The generic-request helper even labels root-column model persistence display-only (`sbe`, `72094746`).
- Serialized runtime context includes `_model: state.model` and `_effort: state.effort` (`64896509`, `64896563`). Explicit incoming constructor overrides update the runtime state (`69737500–69738600`). These values are string or null; distinguish valid observed values, explicit null, missing, and malformed values.
- `getFrameModelSources` (`64984978`) itself distinguishes the column `model` from `contextModel = context._model` and context readability. This is internal storage logic, not a newly authorized API/DB read path.
- A null/missing context selection may resolve through the application's default-model resolver (`effectiveModel`, `64891318`). Do not silently relabel the old column as current selected/effective model.
- Runtime selection, normalized request effort, catalog defaults, GUI draft selections, and actual upstream provider routing are different scopes. Neither a model's self-description in reply text nor a persisted selection proves which provider model executed a paid call.

## Request DTOs and precedence

New project submission (`Gl.submitRequest` / `Emc`, `72240811`) forwards top-level `model`, `effort`, `target_agent`, `ultra_mode`, `verifier_mode`, `memory_mode` and `session_knobs`, among other fields. The typed `session_knobs` are the shared `_v` fields (plus the internal routine flag); they are **not** an unbounded place for model/effort/specialist/compute selections. `Emc` constructs root input from the request and mode flags, then applies non-null session knobs.

The general POST `/api/request` (`75199297`) uses `jor` and `I5o`; it supports request-time overrides and existing/new root selection. It is a **dispatch endpoint**, not a no-LLM configuration setter. Do not call it with an empty prompt merely to simulate preconfiguration.

Direct continuation POST `/api/frames/:id/message` (`75033855`, `Ofc` at `72134245`) forwards only `input_data`, `model`, `effort`, `thinking`, and `task_source`. It does not forward top-level `ultra_mode`, `session_knobs`, or `target_agent`. Where a root continuation uses delegation/mode inputs, put the intended supported root input fields into `input_data`; do not claim ignored top-level fields succeeded.

The running root merges sanitized new input over its existing original input, then consumes pending verifier/memory/session-knob updates (`69740663` and following code). Root-only sticky modes are scrubbed on child inputs (`Ypc`, `72095111`; `E5o` at `72129861`). A robust bridge should avoid contradictory mode settings across a preconfiguration write and the subsequent send, and should re-read persisted state immediately before dispatch when using an expected-config guard. The guard verifies observed state, not all dynamic effective defaults.

## API-only pre-send workflow and its limits

For an existing root:

1. Fresh GET the exact frame and verify identity. Public fields are `id`, `root_frame_id`, and **`parent_frame_id`**, not `parent_id` (DTO `63799124`; `py`, `69904231`; `JD`, `69901765`). A strict bridge requires `id === root_frame_id === requestedRoot` and `parent_frame_id === null`. Missing/malformed identity or a child should prevent writes; do not guess legacy root semantics.
2. POST once with only confirmed supported configuration, for example `{verifier_mode: "on", memory_mode: "off", reviewer_model: null}`.
3. Fresh GET independently and compare each provided key in the authoritative stored original input. Missing keys or source ambiguity must not count as confirmed. Report this as **explicit configuration persisted**, not “all menu options effective.”
4. Before the eventual send, optionally enforce a fresh expected-config guard. Attach supported request-time model/effort/delegation inputs to that single send. Do not perform a paid send if the user requires prior persisted confirmation of an unsupported menu item.

For a new conversation, POST `/api/frames` with `{project_id}` returns `201` and `{root_frame_id, project_id}` (`75133394`). `pfc` (`72121858–72122190`) creates an empty root in `completed` state using the configured default agent and **does not dispatch a task**. This is static behavior evidence only, not approval to add a creation endpoint to the current bridge: the immediate implementation should remain scoped to the existing root, and an empty-root tool needs separate route-guard/integration acceptance. At the application-contract level, it permits creation of an empty conversation, configuration/readback of the supported subset, then an explicitly authorized first send. It does not add a model/effort/delegation/compute/specialist setter. Before that first configuration write, an empty root may have no authoritative original-input object; do not claim inferred defaults as observed values. A setter can write explicit knobs after identity checks, but an expected-state guard must reject values whose baseline is unknown.

If “before opening the conversation” means before any root exists at all, no per-root readback is possible. If it means before the first model request, empty-root creation plus supported-knob readback is the audited no-LLM path. The unsupported choices remain request-time or separately unaudited, not magically preconfirmed.

## Bounded implementation acceptance

Keep the explicit 0.1.52 route/method gate, normal in-memory nonce/cookie/CSRF authorization, per-write confirmation, root identity, strict field validation, independent readback, and no write retries. Preserve unknown/ambiguous source states rather than filling friendly display defaults. Synthetic regression tests should distinguish POST echo from stored confirmation, whole-object original-input authority, root versus child, stale column model versus context selection, reviewer null inheritance, unsupported knobs, GPU rejection, and send-time versus persisted configuration. This report does not certify a real mutation, a full eight-item menu preset, or actual provider execution.
