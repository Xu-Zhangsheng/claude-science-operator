# Claude Science 0.1.52 compatibility audit

## Scope and conclusion

This is a **read-only static contract audit**, not a live integration result. The audited local binary is Claude Science `0.1.52`, SHA-256 `d1724ebb97d1917e9a58e229c885c014fa4545d6e54154a425ad00bce8847eb9`. The hash was independently recomputed. Byte offsets below refer only to that binary specimen and are not stable source identifiers.

The comparison baseline is upstream commit `3461a2da3538b74dcc982e6283a343291dfa1d46` and its [Science bridge](<../plugins/claude-science-operator/scripts/server.mjs>). That baseline **already authenticates by POST `/api/auth/nonce` with a URL-encoded form**, then GET `/api/csrf`. A historical GET-only nonce description is not the actual implementation at this commit. The audited 0.1.52 authentication contract matches the existing bridge; no invented GET fallback or redirect-following branch is necessary.

The baseline's explicit version allowlist contains `0.1.20`, `0.1.25`, and `0.1.43`, but not `0.1.52`. That explains the current fail-closed private-API decision despite a reported healthy runtime. The audit supports a bounded, explicit `0.1.52` addition for the core contracts below, subject to offline regression tests and normal installed-plugin authorization. It does not justify accepting arbitrary versions, removing executable/port/health checks, or claiming every expert mutation is fully certified.

No private API requests, CLI `url` invocation, credential reads, application-log reads, database reads, application start/stop, security-permission changes, or paid model requests were performed. Local static excerpts were kept only in ignored scratch output; this report contains facts rather than copied third-party implementations. The previously reported port `8990` was not re-probed during this audit.

## Authentication, cookies, and CSRF

| Step | Confirmed 0.1.52 contract | Evidence |
| --- | --- | --- |
| Obtain a control URL | Retain the bridge's normal, authorized CLI control-URL path; no browser-state or credential-file substitution. The audit did not execute it. | Baseline `ScienceClient.freshControlUrl` |
| GET a URL containing `?nonce=` | Peeks at nonce validity and returns a sign-in HTML form. It does **not** consume a valid nonce or establish `operon_auth`. An already authenticated caller receives HTML navigation instead. | `ajs`, around `75779402–75782138`; `QKs`, `75773991` |
| Consume a nonce | POST `/api/auth/nonce`, `Content-Type: application/x-www-form-urlencoded`; fields `nonce` and `dest`. The form parser reads a string body with an `8192`-byte body limit and converts URL search parameters to an object. Missing/non-string `nonce` becomes an empty string. Missing/non-string `dest` defaults to `/`. Direct POST does not require the preliminary GET. | POST handler, `75782138`; form parser immediately before it |
| Successful consume | Default HTTP `200`, `text/html`, `Cache-Control: no-store`, and `Set-Cookie: operon_auth=…`. The HTML contains a continue link/meta refresh, **not an HTTP Location/3xx redirect contract**. Do not parse it as API JSON or follow its HTML navigation. | POST handler `75782138`; `ePt`, `75778910` |
| Invalid consume | An unknown/expired/used nonce returns HTTP `401` HTML in token-required operation. Nonces are one-use and expire after `180000` ms. Already-authenticated or tokenless operation can return HTML without a newly issued auth cookie, so `2xx` alone is not sufficient proof of a fresh bridge session. | `JKs`, `75774101`; `dPt=180000`, `75822362`; POST handler |
| Auth cookie | Name `operon_auth`; `HttpOnly; SameSite=Strict; Path=<basePath or />`; `Secure` when the request is HTTPS or its forwarded protocol indicates HTTPS. Cookie parsing turns its value into the bearer credential internally. | `GZn`, `75782737`; `LKs`, `75783005`; `xU`, `72595721` |
| Initialize CSRF | GET `/api/csrf` with `Cookie: operon_auth=…` and the accepted `Origin`. Success is HTTP `204`, no JSON body, `Cache-Control: no-store`, and `Set-Cookie: operon_csrf=…`. CORS allow-origin/credentials headers are removed. | `pjs`, around `75784336` |
| CSRF cookie/header | Cookie `operon_csrf`, `SameSite=Strict; Path=<cookiePath or />`, conditionally `Secure`, not `HttpOnly`. Cookie-authenticated POST/PUT/PATCH/DELETE under `/api/` or `/daemon/` requires `x-operon-csrf` equal to the daemon's CSRF secret; the comparison is constant-time. | `BZn`, `75782910`; `djs`, `75783739`; `cjs="x-operon-csrf"`, `75822362` |
| Exemptions | POST `/api/auth/nonce` is deliberately bearer/CSRF-exempt because the nonce is its credential. Explicit bearer-header and the daemon's internal bridge authentication are also CSRF-exempt. These are server contracts, **not permission to obtain/reuse another credential**. | bearer-exempt registration `75236736`; CSRF exempt set `75823449`; `djs` |

`dest` is an internal navigation path, not an arbitrary URL: it must begin with `/` but not `//`, and cannot contain whitespace/control characters or backslashes; quote/angle characters are removed. Invalid paths reduce to `/`. A configured base path affects navigation and cookie scope. The audit does not extend the operator beyond its existing plain-HTTP, exact-port loopback boundary.

The server validates `Host` and write origins. The normal origin predicate accepts the configured strict-origin set when present, otherwise the loopback-origin pattern, plus separately configured gateway origins. The nonce consume endpoint also accepts loopback origins for the unauthenticated sign-in path. CSRF initialization/writes require an accepted non-null `Origin` (initialization alternatively accepts `Sec-Fetch-Site: same-origin` when `Origin` is absent). The bridge should continue sending the exact origin from its validated control URL; broader server acceptance is not a reason to widen the bridge's own allowlist.

CSRF failures are HTTP `403` with a machine-readable `code`, including `csrf_stale`, `origin_required`, or `tokenless_refused`. Keep auth/CSRF values exclusively in memory. Keep manual redirect handling, bounded bodies, and the required cookie checks.

## Core routing and response contracts

All bodies below are JSON except the nonce consume form. Successful JSON routes use HTTP `200` unless stated otherwise.

| Bridge use | Method and route | Confirmed fields and response | Evidence |
| --- | --- | --- | --- |
| Public readiness | GET `/health` | Normal daemon response includes `status: "healthy"` or `"degraded"`, `service: "gateway"`, `agents_registered`, `image_processing_available`, and optional `db_read_pool`. A non-healthy DB read-pool state makes readiness degraded. | Normal registration `75701908` |
| Private health, not needed for initial authentication | GET `/api/health` | Includes `status: "healthy"`, `service`, and further database/sandbox/LLM diagnostics. It is a different endpoint from public readiness. | Route `74866833`; `Bmc`, `72256804–72257184` |
| List models | GET `/api/models`, optional `provider`, `include_disabled` | `provider` is case-normalized and only `anthropic` is accepted by this service. Response remains `{models: {anthropic: [...]}, default_model_id: string, ...diagnostics}`. Model entries include `id`/`name`; ranking adds `overflow` and optional descriptions. Selector mode can add further capability/selection fields. | Route `74866329`; `ihc`, `72260430–72263064` |
| Read reviewer model | GET `/api/preferences/reviewer-model` | `{model: <effective reviewer model or null>, source: "setting" | "default"}`. `source` indicates a stored override rather than successful upstream model validation. | `74832425` |
| Set reviewer model | PUT `/api/preferences/reviewer-model` | Body `{model: string | null}`. A non-null string must have length `1..200`; other types/empty/too-long strings return `400`. `null` means match the session model. Success returns `{model: <requested value>, source: "setting"}`. This is a local preference mutation, not an LLM request. | `74832606`; static handler around `74832425–74833500` |
| List projects | GET `/api/projects` | Query `limit`, `offset`; optional `include_archived`, `archived_only`. Response `{projects: [...], total}`. Project rows contain `project_id`, `name`, `description`, `context`, counts/timestamps, `archived_at`, `default_use_case_id`; list rows additionally contain `last_active_at`. | Route `75193044`; `ymc`, `72232652`; `lU`, `72231563–72231914` |
| Create project | POST `/api/projects` | `name` is trimmed; optional `description`, `context`, `find_or_create`. Normal creation returns `201` and a project row with `project_id`. `find_or_create` with a non-empty name returns `200`. The wrapper does not pass a top-level `intent_id` into creation. | `75192416`; `gmc`, `72232027` |
| Submit project request | POST `/api/projects/:pid/request` | Body accepts `input_data`, `model`, `subagent_model`, `effort`, `thinking`, `target_agent`, `plan_mode`, `ultra_mode`, `verifier_mode`, `memory_mode`, `session_knobs`, `viewport_context`, `intent_id`, `task_source`. The bridge subset `{input_data: {request: prompt}, target_agent: "OPERON", plan_mode, intent_id, model?}` fits the transport schema. A non-empty request and an existing registered target agent/project are required. Success `{root_frame_id, frame_id, status: "accepted"}`. | Wrapper `75194478`; `g5r`, `68169745`; `Emc`, `72240811–72243007` |
| List root sessions | GET `/api/frames` | Query `root_only`, `project_id`, `limit`; service clamps limit to `1..100`, default `50`. Response is an array of serialized frame rows, not a required `{frames: [...]}` wrapper. | Route `75130734`; `dfc`, `72121620–72121858` |
| Poll a frame | GET `/api/frames/:id` | Optional `shallow`, `include_children` cannot both be true. Default returns the frame itself, with `id`, `root_frame_id`, `status`, input/output/context data, timestamps and other metadata; `children_included: false`. Including children is explicit and subject to subtree-size limits. | `75130986`; `tfc`, `72113442–72115668`; `JD`, `69901765` |
| Read messages | GET `/api/frames/:id/messages` | Query `from` (integer), `limit` (positive integer). Output is JSON `{frame_id, from, total, messages: [...]}`. The service constructs an already serialized JSON string, and the transport sends it as JSON, not a JSON string envelope. `messages_json` is internal and is not the public field. | Route `75132477`; `xin`, `68162743`; `ofc`, `72117535–72117733`; `k5o`, `72090613` |
| Continue session | POST `/api/frames/:id/message` | Wrapper forwards `input_data`, `model`, `effort`, `thinking`, `task_source`, **not** top-level `intent_id`. Success `{root_frame_id, frame_id, status: "accepted"}` or a queue status while already processing. See state restrictions below. | Route `75033855`; `FYr`, `68183161`; `Ofc`, `72134245–72136536` |

### Readiness and model-list distinctions

The staged-boot placeholder server can return `{status: "ok", boot: "staged-hold"}` from `/health` (around `75980937`). That is **not** normal daemon readiness. Do not broaden the current readiness predicate to accept arbitrary `status: "ok"` merely to enable the API. Healthy status alone also does not supersede the exact version, executable, CSSwitch schema, or configured-port checks.

The model endpoint can legitimately return a fallback or last-known-good catalog, with `auth_error`, `fetch_error`, `fetch_error_kind`, `models_source`, `first_party_catalog`, or `model_list_source: "selector"`. The established `models`/`default_model_id` shape remains compatible with the existing normalization, but a model-list success does not prove provider authentication or a successful paid request. Additional diagnostic/capability fields should be handled intentionally; do not dump raw provider/authentication diagnostics as credential evidence. Model listing may cause the application itself to refresh its catalog from its provider; this audit did not invoke it.

Serialized frames expose a top-level `model` field (`JD`, `69901765`; also retained by list serializer `d7e`, `69902860`), which may be a string or null. That per-frame field, the catalog's `default_model_id`, and the reviewer-model preference have different scopes; none alone proves successful provider execution.

PUT `/api/models/selection` exists and takes `model`/`effort`, but it is **not** the reviewer-model preference endpoint. Its selector service has organization/auth/default-lock constraints (`ahc`, `72263769–72266144`). No new default-model-selection tool is authorized by this audit.

### Session-state and write-safety restrictions

The audited direct-message service behaves as follows:

- `processing`: queues the message and returns the queue status with frame/root IDs.
- `completed`: claims the frame and dispatches one manual continuation, returning `accepted`.
- `awaiting_user_response` / `awaiting_plan_approval`: rejects direct continuation until the pending input/approval is resolved.
- `failed` / `cancelled`: rejects direct continuation; the application's resume flow must be used first.
- Other non-addressable states are rejected rather than guessed compatible.

Frame status remains visible to the existing poller; awaiting states require user attention. The public message envelope supports the existing message normalizer. Structured approval payload extraction beyond the existing recognized fields is not certified here.

The project-request wrapper forwards `intent_id`, and `Emc` incorporates it into internal request handling. **The project-creation and direct-message wrappers do not forward that field.** Therefore the operator's returned intent ID is not universal proof of server-side idempotency, and this report makes no such claim. Preserve the one-dispatch write policy: timeout, transport failure, or server failure after dispatch is `STATE_UNCERTAIN`, not permission to retry a create/request/message/settings write automatically.

## Other bridge operations: bounded evidence, not blanket certification

Static registration confirms the existing `/api/agents` listing, custom-prompt GET/PUT/DELETE, create/update/delete, enabled toggle, and skill attachment/update/removal route families around `74866329` and its following agent router. Their transport naming agrees with the bridge's existing routes; for example prompt updates use `prompt_text`, enabled toggles use `enabled`, and skill attachment uses `skill_name`.

This audit did **not** fully follow expert create/patch schemas, connector attachment/exclusion validation, or every preference handler. The remaining guarded routes for allowed domains, built-in allowlists, telemetry consent, Git identity, and Conda mirror should not be described as fully 0.1.52-certified merely because their names appear in an earlier bridge. Use-intent transport and declaration-history behavior are separately confirmed in the supplement below. Artifact listing registrations are present, but exhaustive artifact payload/download/export contracts were not acceptance targets. Keep those operations behind their existing authorization, confirmation, and sensitive-field guards; use GUI/fail-closed recovery for an unrecognized payload. Expanding any of these capabilities needs a separate bounded audit and regression evidence.

## Validation boundary and implementation guidance

Confirmed for the identified specimen: nonce/CSRF exchange, cookie/header names and encoding, normal/staged readiness distinction, model-list envelope, reviewer-model get/set, project listing/creation/request, frame listing/self-polling, transcript envelope, direct continuation state/response restrictions, and use-intent get/set transport with append-only declaration history.

Not performed: live authentication, real project/task creation, real continuation, preference mutation/restoration, paid model execution, actual GUI navigation, cross-version execution of the older allowed binaries, or arbitrary 0.1.52 rebuild verification. Static evidence cannot prove that a mutable runtime, account policy, provider, database, or network is currently healthy.

Implementation acceptance should include synthetic tests for HTML `200` nonce success plus CSRF `204`, single-use/expired nonce rejection, missing cookies, manual redirect/no unexpected `3xx` acceptance, exact loopback origin/port enforcement, normal-versus-staged readiness, grouped model catalogs, nullable reviewer preference, project/frame IDs and envelopes, and no write retry after uncertainty. Real private requests, if separately authorized, must run only through the final installed plugin's normal control-session path. Unknown versions and unrecognized required payloads remain fail closed.

## Supplement: use-intent declaration contract

The tests member's static findings were independently rechecked against the same binary hash; no live API or database access was performed.

- GET `/api/preferences/use-intent` returns `{intent, declared}` from the user's latest declaration. With no declaration, it returns `intent: "commercial"` and `declared: false`. Handler byte offset: `74808679`; default `IPe="commercial"`: `67658278`.
- PUT `/api/preferences/use-intent` takes JSON `{intent: "commercial" | "noncommercial"}`. Missing, null, or other values return `400`. A valid write appends a declaration and returns `{intent: <requested value>, declared: true}`. It does not accept an undeclare/reset value.
- The declaration repository (`gW`, `67657791`) inserts a new history row for each `record` call; `latest` orders by creation time and row ID. Restoring a previously declared intent can restore its effective value and `declared: true`, but **cannot erase appended history** or restore an originally undeclared state.

Any separately authorized live mutation/restoration test must read the baseline first and proceed only when `declared` is exactly `true` and `intent` is one of the two accepted values. If `declared` is false or the baseline is unrecognized, remain read-only. No live mutation or successful restoration is claimed by this supplement; all other unaudited preferences remain outside its confirmed scope.
