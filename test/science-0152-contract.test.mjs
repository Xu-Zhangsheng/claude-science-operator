import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { after, before, test } from "node:test";

import {
  OperatorError,
  StateUncertainError,
  callTool,
} from "../plugins/claude-science-operator/scripts/server.mjs";

// Synthetic operator-level regression only. Do not construct RuntimeInspector or
// ScienceClient, read runtime storage, run the installed binary, or call a real
// daemon/provider. Authentication and transport retries belong to separate tests.
const fixture = JSON.parse(await fs.readFile(new URL("./fixtures/science-0152.json", import.meta.url), "utf8"));
const clone = (value) => structuredClone(value);
const projectId = fixture.project.project_id;
const frameId = fixture.submission.root_frame_id;
const modelId = fixture.models.standard.default_model_id;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const originalFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = () => assert.fail("The synthetic contract suite must never perform network I/O");
});
after(() => { globalThis.fetch = originalFetch; });

function scriptedInspector(steps) {
  const calls = [];
  const client = {
    async request(route, options = {}) {
      const step = steps[calls.length];
      assert.ok(step, `Unexpected request or retry: ${options.method || "GET"} ${route}`);
      calls.push({ route, options: clone(options) });
      assert.equal(route, step.route);
      assert.equal(options.method || "GET", step.method || "GET");
      step.check?.(options);
      if (step.uncertain) throw new StateUncertainError(options.intentId, options.operation);
      if (step.error) throw step.error;
      return clone(typeof step.reply === "function" ? step.reply(options) : step.reply);
    },
  };
  return {
    calls,
    inspector: {
      client: async () => client,
      inspect: async () => assert.fail("No real runtime inspection is allowed in synthetic contract tests"),
    },
    done: () => assert.equal(calls.length, steps.length, "All expected fake requests occurred exactly once"),
  };
}

async function invoke(harness, name, args = {}) {
  const result = await callTool(harness.inspector, name, args);
  assert.equal(result.content[0].type, "text");
  assert.equal(typeof result.content[0].text, "string");
  return result.structuredContent;
}

function assertWrite(options, method, operation, { bodyIntent = false } = {}) {
  assert.equal(options.method, method);
  assert.equal(options.write, true);
  assert.equal(options.operation, operation);
  assert.match(options.intentId, uuidPattern);
  if (bodyIntent) assert.equal(options.body.intent_id, options.intentId);
}

function pollHarness(frame, messages) {
  const { requested_from: requestedFrom, ...reply } = messages;
  return scriptedInspector([
    { route: `/api/frames/${frameId}`, reply: frame },
    {
      route: `/api/frames/${frameId}/messages?from=${requestedFrom ?? messages.from}&limit=200`,
      reply,
    },
  ]);
}

test("0.1.52 fixtures document static provenance, not authenticated response captures", () => {
  assert.equal(fixture.provenance.science_version, "0.1.52");
  assert.equal(fixture.provenance.kind, "synthetic-static-contract-fixtures");
  assert.equal(fixture.provenance.runtime_requests, false);
  assert.equal(fixture.provenance.authentication_verified, false);
  assert.match(fixture.provenance.binary_sha256, /^[0-9a-f]{64}$/);
  assert.ok(fixture.provenance.notes.some((note) => note.includes("not runtime response captures")));
  assert.ok(fixture.provenance.notes.some((note) => note.includes("local reconciliation identifier")));
});

test("models retains the grouped catalog contract and default model without new empty metadata", async () => {
  const h = scriptedInspector([{ route: "/api/models", reply: fixture.models.standard }]);
  const result = await invoke(h, "claude_science_list_models");
  assert.equal(result.default_model_id, modelId);
  assert.deepEqual(result.models.map(({ provider, id, name }) => ({ provider, id, name })), [
    { provider: "anthropic", id: modelId, name: "Synthetic Alpha" },
    { provider: "anthropic", id: "model-beta-fixture", name: "Synthetic Beta" },
  ]);
  assert.deepEqual(Object.keys(result).sort(), ["default_model_id", "message", "models"]);
  assert.equal(h.calls[0].options.write, undefined);
  h.done();
});

test("models forwards the optional provider as a query, not a mutation", async () => {
  const h = scriptedInspector([{ route: "/api/models?provider=Anthropic", reply: fixture.models.standard }]);
  await invoke(h, "claude_science_list_models", { provider: "Anthropic" });
  assert.deepEqual(h.calls[0].options, {});
  h.done();
});

test("selector models preserve overflow and safe catalog flags without exposing raw selector state", async () => {
  const h = scriptedInspector([{ route: "/api/models", reply: fixture.models.selector }]);
  const result = await invoke(h, "claude_science_list_models");
  assert.deepEqual(result.models.map((model) => model.overflow), [false, true]);
  assert.equal(result.model_list_source, "selector");
  assert.equal(result.first_party_catalog, true);
  assert.equal(result.default_model_locked, true);
  for (const field of ["model_selector", "selection_source", "default_effort"]) {
    assert.equal(Object.hasOwn(result, field), false);
  }
  assert.equal(Object.hasOwn(result.models[0], "effort"), false);
  h.done();
});

test("auth fallback catalog is not represented as verified authentication or raw auth-error text", async () => {
  const h = scriptedInspector([{ route: "/api/models", reply: fixture.models.auth_fallback }]);
  const result = await invoke(h, "claude_science_list_models");
  assert.equal(result.models.length, 1);
  assert.equal(result.models_source, "fallback");
  assert.equal(result.catalog_usable, false);
  assert.equal(typeof result.auth_error, "string");
  assert.ok(result.auth_error.length > 0);
  assert.equal(Object.hasOwn(result, "auth_failed"), false);
  assert.match(result.message, /unavailable|unusable|fallback|do not|not use|cannot|not select|not suitable|not usable|not be used/i);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ERROR_FIXTURE_SENTINEL/);
  h.done();
});

for (const [name, source, kind] of [
  ["last_good", "last_good", "rate_limited"],
  ["unavailable", "fallback", "unavailable"],
]) {
  test(`models projects ${name} degradation as enum metadata without raw errors`, async () => {
    const h = scriptedInspector([{ route: "/api/models", reply: fixture.models[name] }]);
    const result = await invoke(h, "claude_science_list_models");
    assert.equal(result.models_source, source);
    assert.equal(result.fetch_error_kind, kind);
    assert.equal(result.catalog_usable, false);
    assert.equal(typeof result.fetch_error, "string");
    assert.ok(result.fetch_error.length > 0);
    assert.equal(Object.hasOwn(result, "auth_failed"), false);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ERROR_FIXTURE_SENTINEL/);
    h.done();
  });
}

test("fallback/last-good source alone makes the catalog unusable without fabricating an error", async () => {
  for (const source of ["fallback", "last_good"]) {
    const h = scriptedInspector([{ route: "/api/models", reply: { ...clone(fixture.models.standard), models_source: source } }]);
    const result = await invoke(h, "claude_science_list_models");
    assert.equal(result.models_source, source);
    assert.equal(result.catalog_usable, false);
    assert.equal(Object.hasOwn(result, "auth_error"), false);
    assert.equal(Object.hasOwn(result, "fetch_error"), false);
    h.done();
  }
});

test("auth/fetch errors alone flag an unusable catalog and expose only safe summaries", async () => {
  for (const field of ["auth_error", "fetch_error"]) {
    const h = scriptedInspector([{ route: "/api/models", reply: { ...clone(fixture.models.standard), [field]: "PRIVATE_ERROR_FIXTURE_SENTINEL" } }]);
    const result = await invoke(h, "claude_science_list_models");
    assert.equal(result.catalog_usable, false);
    assert.equal(typeof result[field], "string");
    assert.ok(result[field].length > 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ERROR_FIXTURE_SENTINEL/);
    h.done();
  }
});

test("model diagnostic projection rejects non-enum/ill-typed metadata and arbitrary payload fields", async () => {
  const reply = {
    ...clone(fixture.models.standard),
    models_source: "PRIVATE_ERROR_FIXTURE_SENTINEL",
    fetch_error_kind: { error: "PRIVATE_ERROR_FIXTURE_SENTINEL" },
    model_list_source: "unknown-source",
    default_model_locked: "true",
    first_party_catalog: 1,
    auth_error: { error: "PRIVATE_ERROR_FIXTURE_SENTINEL" },
    arbitrary_payload: "PRIVATE_ERROR_FIXTURE_SENTINEL",
  };
  const h = scriptedInspector([{ route: "/api/models", reply }]);
  const result = await invoke(h, "claude_science_list_models");
  assert.deepEqual(Object.keys(result).sort(), ["default_model_id", "message", "models"]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ERROR_FIXTURE_SENTINEL/);
  h.done();
});

test("model diagnostic projection preserves boolean false instead of truthiness-coercing it", async () => {
  const h = scriptedInspector([{
    route: "/api/models",
    reply: { ...clone(fixture.models.standard), first_party_catalog: false, default_model_locked: false },
  }]);
  const result = await invoke(h, "claude_science_list_models");
  assert.equal(result.first_party_catalog, false);
  assert.equal(result.default_model_locked, false);
  h.done();
});

for (const name of ["default", "saved", "match_session"]) {
  test(`reviewer GET preserves model/source for ${name}`, async () => {
    const h = scriptedInspector([{ route: "/api/preferences/reviewer-model", reply: fixture.reviewer[name] }]);
    const result = await invoke(h, "claude_science_settings", { action: "get", setting: "reviewer_model" });
    assert.equal(result.setting, "reviewer_model");
    assert.deepEqual(result.result, fixture.reviewer[name]);
    assert.equal(h.calls[0].options.write, undefined);
    h.done();
  });
}

test("reviewer change then restore uses explicit confirmed PUTs and distinct local intents", async () => {
  const previous = fixture.reviewer.saved;
  const changed = { model: modelId, source: "setting" };
  const h = scriptedInspector([
    { route: "/api/preferences/reviewer-model", reply: previous },
    {
      route: "/api/preferences/reviewer-model", method: "PUT", reply: changed,
      check(options) {
        assertWrite(options, "PUT", "setting:reviewer_model");
        assert.deepEqual(options.body, { model: changed.model });
      },
    },
    { route: "/api/preferences/reviewer-model", reply: changed },
    {
      route: "/api/preferences/reviewer-model", method: "PUT", reply: previous,
      check(options) {
        assertWrite(options, "PUT", "setting:reviewer_model");
        assert.deepEqual(options.body, { model: previous.model });
      },
    },
    { route: "/api/preferences/reviewer-model", reply: previous },
  ]);
  const original = await invoke(h, "claude_science_settings", { action: "get", setting: "reviewer_model" });
  const change = await invoke(h, "claude_science_settings", { action: "set", setting: "reviewer_model", value: changed.model, confirm: true });
  assert.deepEqual(change.result, changed);
  assert.deepEqual((await invoke(h, "claude_science_settings", { action: "get", setting: "reviewer_model" })).result, changed);
  const restored = await invoke(h, "claude_science_settings", { action: "set", setting: "reviewer_model", value: original.result.model, confirm: true });
  assert.deepEqual(restored.result, previous);
  assert.notEqual(restored.intent_id, change.intent_id);
  assert.deepEqual((await invoke(h, "claude_science_settings", { action: "get", setting: "reviewer_model" })).result, previous);
  assert.equal(h.calls.filter((call) => call.options.write).length, 2);
  h.done();
});

test("reviewer null is an explicit match-session override, not restoration of source=default", async () => {
  const h = scriptedInspector([{
    route: "/api/preferences/reviewer-model", method: "PUT", reply: fixture.reviewer.match_session,
    check(options) {
      assertWrite(options, "PUT", "setting:reviewer_model");
      assert.deepEqual(options.body, { model: null });
    },
  }]);
  const result = await invoke(h, "claude_science_settings", { action: "set", setting: "reviewer_model", value: null, confirm: true });
  assert.deepEqual(result.result, { model: null, source: "setting" });
  h.done();
});

test("reviewer PUT restores a default model value but cannot remove the saved override", async () => {
  const previous = fixture.reviewer.default;
  const h = scriptedInspector([
    { route: "/api/preferences/reviewer-model", reply: previous },
    { route: "/api/preferences/reviewer-model", method: "PUT", reply: fixture.reviewer.saved },
    { route: "/api/preferences/reviewer-model", method: "PUT", reply: { model: previous.model, source: "setting" } },
  ]);
  const original = await invoke(h, "claude_science_settings", { action: "get", setting: "reviewer_model" });
  await invoke(h, "claude_science_settings", { action: "set", setting: "reviewer_model", value: fixture.reviewer.saved.model, confirm: true });
  const restored = await invoke(h, "claude_science_settings", { action: "set", setting: "reviewer_model", value: original.result.model, confirm: true });
  assert.equal(restored.result.model, original.result.model);
  assert.equal(original.result.source, "default");
  assert.equal(restored.result.source, "setting");
  assert.notDeepEqual(restored.result, original.result);
  h.done();
});

test("reviewer mutations never fabricate confirmation or dispatch a missing value", async () => {
  for (const args of [
    { action: "set", setting: "reviewer_model", value: modelId },
    { action: "set", setting: "reviewer_model", value: modelId, confirm: false },
  ]) {
    const h = scriptedInspector([]);
    await assert.rejects(invoke(h, "claude_science_settings", args), { code: "CONFIRMATION_REQUIRED" });
    h.done();
  }
  const h = scriptedInspector([]);
  await assert.rejects(invoke(h, "claude_science_settings", { action: "set", setting: "reviewer_model", confirm: true }), { code: "INVALID_PARAMS" });
  h.done();
});

test("use-intent GET preserves the commercial/noncommercial enum and declared flag", async () => {
  for (const name of ["undeclared", "commercial", "noncommercial"]) {
    const h = scriptedInspector([{ route: "/api/preferences/use-intent", reply: fixture.use_intent[name] }]);
    const result = await invoke(h, "claude_science_settings", { action: "get", setting: "use_intent" });
    assert.deepEqual(result.result, fixture.use_intent[name]);
    assert.equal(h.calls[0].options.write, undefined);
    h.done();
  }
});

test("use-intent change/restore recovers a declared=true public state, not declaration history", async () => {
  const h = scriptedInspector([
    { route: "/api/preferences/use-intent", reply: fixture.use_intent.commercial },
    {
      route: "/api/preferences/use-intent", method: "PUT", reply: fixture.use_intent.noncommercial,
      check(options) {
        assertWrite(options, "PUT", "setting:use_intent");
        assert.deepEqual(options.body, { intent: "noncommercial" });
      },
    },
    {
      route: "/api/preferences/use-intent", method: "PUT", reply: fixture.use_intent.commercial,
      check(options) {
        assertWrite(options, "PUT", "setting:use_intent");
        assert.deepEqual(options.body, { intent: "commercial" });
      },
    },
    { route: "/api/preferences/use-intent", reply: fixture.use_intent.commercial },
  ]);
  const original = await invoke(h, "claude_science_settings", { action: "get", setting: "use_intent" });
  const changed = await invoke(h, "claude_science_settings", { action: "set", setting: "use_intent", value: "noncommercial", confirm: true });
  assert.deepEqual(changed.result, fixture.use_intent.noncommercial);
  const restored = await invoke(h, "claude_science_settings", { action: "set", setting: "use_intent", value: original.result.intent, confirm: true });
  assert.notEqual(restored.intent_id, changed.intent_id);
  assert.deepEqual(restored.result, original.result);
  assert.deepEqual((await invoke(h, "claude_science_settings", { action: "get", setting: "use_intent" })).result, original.result);
  h.done();
});

test("use-intent PUT of the original default cannot restore an undeclared=false state", async () => {
  const h = scriptedInspector([
    { route: "/api/preferences/use-intent", reply: fixture.use_intent.undeclared },
    {
      route: "/api/preferences/use-intent", method: "PUT", reply: fixture.use_intent.commercial,
      check(options) { assert.deepEqual(options.body, { intent: "commercial" }); },
    },
  ]);
  const original = await invoke(h, "claude_science_settings", { action: "get", setting: "use_intent" });
  const written = await invoke(h, "claude_science_settings", { action: "set", setting: "use_intent", value: original.result.intent, confirm: true });
  assert.equal(original.result.declared, false);
  assert.equal(written.result.declared, true);
  assert.notDeepEqual(written.result, original.result);
  h.done();
});

test("project request sends input_data, target_agent, chosen model, plan_mode and one intent", async () => {
  const prompt = "Synthetic bounded request";
  const h = scriptedInspector([{
    route: `/api/projects/${projectId}/request`, method: "POST", reply: fixture.submission,
    check(options) {
      assertWrite(options, "POST", "submit task", { bodyIntent: true });
      assert.deepEqual(options.body, {
        input_data: { request: prompt }, target_agent: "OPERON", model: modelId,
        plan_mode: true, intent_id: options.intentId,
      });
    },
  }]);
  const result = await invoke(h, "claude_science_submit_task", { prompt, project_id: projectId, model: modelId, plan_mode: true });
  assert.equal(result.project_id, projectId);
  assert.equal(result.frame_id, frameId);
  assert.equal(result.created_project, false);
  assert.equal(result.intent_id, h.calls[0].options.intentId);
  h.done();
});

test("default project request omits model and explicitly disables plan_mode", async () => {
  const h = scriptedInspector([{
    route: `/api/projects/${projectId}/request`, method: "POST", reply: fixture.submission,
    check(options) {
      assertWrite(options, "POST", "submit task", { bodyIntent: true });
      assert.equal(Object.hasOwn(options.body, "model"), false);
      assert.equal(options.body.plan_mode, false);
    },
  }]);
  await invoke(h, "claude_science_submit_task", { prompt: "Synthetic bounded request", project_id: projectId });
  h.done();
});

test("new-project submission creates once then submits once with one reconciliation intent", async () => {
  const h = scriptedInspector([
    {
      route: "/api/projects", method: "POST", reply: fixture.project,
      check(options) {
        assertWrite(options, "POST", "create project", { bodyIntent: true });
        assert.deepEqual(options.body, { name: "Synthetic explicit project", intent_id: options.intentId });
      },
    },
    { route: `/api/projects/${projectId}/request`, method: "POST", reply: fixture.submission },
  ]);
  const result = await invoke(h, "claude_science_submit_task", { prompt: "Synthetic bounded request", project_name: "Synthetic explicit project", model: modelId });
  assert.equal(result.created_project, true);
  assert.equal(result.project_id, projectId);
  assert.equal(result.frame_id, frameId);
  assert.equal(h.calls[0].options.intentId, h.calls[1].options.intentId);
  assert.equal(h.calls[1].options.body.intent_id, result.intent_id);
  assert.equal(h.calls[1].options.body.model, modelId);
  h.done();
});

test("follow-up forwards only input_data/model plus the local intent to the frame message route", async () => {
  const prompt = "Synthetic follow-up request";
  const h = scriptedInspector([{
    route: `/api/frames/${frameId}/message`, method: "POST", reply: fixture.continuation.accepted,
    check(options) {
      assertWrite(options, "POST", "continue session", { bodyIntent: true });
      assert.deepEqual(options.body, { input_data: { request: prompt }, model: modelId, intent_id: options.intentId });
    },
  }]);
  const result = await invoke(h, "claude_science_continue_session", { frame_id: frameId, prompt, model: modelId });
  assert.equal(result.frame_id, frameId);
  assert.equal(result.root_frame_id, frameId);
  assert.equal(result.intent_id, h.calls[0].options.intentId);
  h.done();
});

test("processing follow-up may return message_queued without another dispatch or a forced model", async () => {
  const h = scriptedInspector([{
    route: `/api/frames/${frameId}/message`, method: "POST", reply: fixture.continuation.queued,
    check(options) {
      assertWrite(options, "POST", "continue session", { bodyIntent: true });
      assert.equal(Object.hasOwn(options.body, "model"), false);
      assert.equal(Object.hasOwn(options.body, "target_agent"), false);
      assert.equal(Object.hasOwn(options.body, "plan_mode"), false);
    },
  }]);
  const result = await invoke(h, "claude_science_continue_session", { frame_id: frameId, prompt: "Synthetic queued follow-up" });
  assert.equal(result.root_frame_id, frameId);
  h.done();
});

for (const [name, tool, args, step] of [
  ["reviewer PUT", "claude_science_settings", { action: "set", setting: "reviewer_model", value: modelId, confirm: true }, { route: "/api/preferences/reviewer-model", method: "PUT" }],
  ["project request", "claude_science_submit_task", { prompt: "Synthetic bounded request", project_id: projectId }, { route: `/api/projects/${projectId}/request`, method: "POST" }],
  ["frame message", "claude_science_continue_session", { prompt: "Synthetic follow-up request", frame_id: frameId }, { route: `/api/frames/${frameId}/message`, method: "POST" }],
]) {
  test(`${name} propagates synthetic STATE_UNCERTAIN once, without retries or success output`, async () => {
    const h = scriptedInspector([{ ...step, uncertain: true }]);
    await assert.rejects(invoke(h, tool, args), (error) => {
      assert.ok(error instanceof StateUncertainError);
      assert.equal(error.code, "STATE_UNCERTAIN");
      assert.equal(error.details.intent_id, h.calls[0].options.intentId);
      assert.match(error.details.intent_id, uuidPattern);
      return true;
    });
    h.done();
  });
}

test("uncertain project creation stops before submission and does not recreate automatically", async () => {
  const h = scriptedInspector([{ route: "/api/projects", method: "POST", uncertain: true }]);
  await assert.rejects(invoke(h, "claude_science_submit_task", { prompt: "Synthetic bounded request" }), { code: "STATE_UNCERTAIN" });
  h.done();
});

test("uncertain request after creation does not recreate the project or resubmit", async () => {
  const h = scriptedInspector([
    { route: "/api/projects", method: "POST", reply: fixture.project },
    { route: `/api/projects/${projectId}/request`, method: "POST", uncertain: true },
  ]);
  await assert.rejects(invoke(h, "claude_science_submit_task", { prompt: "Synthetic bounded request" }), { code: "STATE_UNCERTAIN" });
  assert.equal(h.calls[0].options.intentId, h.calls[1].options.intentId);
  h.done();
});

test("awaiting-input follow-up rejection is not retried or silently changed to resume", async () => {
  const error = new OperatorError("SCIENCE_HTTP_ERROR", "Synthetic frame awaiting input; resolve its approval card first.");
  const h = scriptedInspector([{ route: `/api/frames/${frameId}/message`, method: "POST", error }]);
  await assert.rejects(invoke(h, "claude_science_continue_session", { frame_id: frameId, prompt: "Synthetic follow-up" }), (caught) => caught === error);
  h.done();
});

test("session listing preserves observed frame model strings/nulls without projecting raw frame data", async () => {
  const h = scriptedInspector([{
    route: `/api/frames?root_only=true&project_id=${projectId}&limit=25`,
    reply: [
      { ...clone(fixture.frames.completed), model: "model-observed-server-fixture", private_fixture_metadata: "PRIVATE_FRAME_FIXTURE_SENTINEL" },
      { ...clone(fixture.frames.processing), model: null },
      clone(fixture.frames.processing),
      { ...clone(fixture.frames.processing), model: { private: "PRIVATE_FRAME_FIXTURE_SENTINEL" } },
    ],
  }]);
  const result = await invoke(h, "claude_science_list_sessions", { project_id: projectId });
  assert.equal(result.sessions[0].model, "model-observed-server-fixture");
  assert.equal(result.sessions[1].model, null);
  assert.equal(Object.hasOwn(result.sessions[2], "model"), false);
  assert.equal(Object.hasOwn(result.sessions[3], "model"), false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FRAME_FIXTURE_SENTINEL|Synthetic contract answer/);
  h.done();
});

test("model verification reads a later frame response, not the submitted model argument", async () => {
  const observedModel = "model-observed-server-fixture";
  const h = scriptedInspector([
    { route: `/api/projects/${projectId}/request`, method: "POST", reply: fixture.submission },
    { route: `/api/frames/${frameId}`, reply: { ...clone(fixture.frames.completed), model: observedModel } },
    { route: `/api/frames/${frameId}/messages?from=0&limit=200`, reply: fixture.messages.completed },
  ]);
  const submitted = await invoke(h, "claude_science_submit_task", { prompt: "Synthetic bounded request", project_id: projectId, model: modelId });
  assert.equal(Object.hasOwn(submitted, "model"), false, "Dispatch result cannot verify the effective session model");
  const polled = await invoke(h, "claude_science_poll_session", { frame_id: submitted.frame_id, wait_seconds: 0 });
  assert.equal(polled.model, observedModel);
  assert.notEqual(polled.model, h.calls[0].options.body.model);
  h.done();
});

test("poll preserves a null model and omits missing/ill-typed model values instead of guessing", async () => {
  const withNull = pollHarness({ ...clone(fixture.frames.processing), model: null }, fixture.messages.intermediate);
  const result = await invoke(withNull, "claude_science_poll_session", { frame_id: frameId, wait_seconds: 0 });
  assert.equal(result.model, null);
  withNull.done();
  for (const fields of [{}, { model: { private: "PRIVATE_FRAME_FIXTURE_SENTINEL" } }, { model: 52 }, { model: true }]) {
    const h = pollHarness({ ...clone(fixture.frames.processing), ...fields }, fixture.messages.intermediate);
    const polled = await invoke(h, "claude_science_poll_session", { frame_id: frameId, wait_seconds: 0 });
    assert.equal(Object.hasOwn(polled, "model"), false);
    assert.doesNotMatch(JSON.stringify(polled), /PRIVATE_FRAME_FIXTURE_SENTINEL/);
    h.done();
  }
});

test("completed poll extracts the final assistant text blocks, not thinking/tool payloads", async () => {
  const h = pollHarness(fixture.frames.completed, fixture.messages.completed);
  const result = await invoke(h, "claude_science_poll_session", { frame_id: frameId, wait_seconds: 0 });
  assert.equal(result.status, "completed");
  assert.equal(result.requires_attention, false);
  assert.equal(result.messages.length, 4);
  assert.equal(result.final_answer, "Synthetic contract answer.\n\nSecond paragraph.");
  assert.equal(result.messages.at(-1).id, "msg-final-fixture");
  assert.equal(result.messages[1].text, "");
  assert.equal(result.next_from_message, 4);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_THINKING_FIXTURE_SENTINEL|PRIVATE_TOOL_FIXTURE_SENTINEL/);
  h.done();
});

test("incremental poll preserves returned page.from, UUID and absolute message index", async () => {
  const h = pollHarness(fixture.frames.completed, fixture.messages.incremental);
  const result = await invoke(h, "claude_science_poll_session", { frame_id: frameId, from_message: 3, wait_seconds: 0 });
  assert.equal(result.messages[0].index, 3);
  assert.equal(result.messages[0].id, "msg-final-fixture");
  assert.equal(result.next_from_message, 4);
  assert.equal(result.final_answer, "Synthetic contract answer.\n\nSecond paragraph.");
  h.done();
});

test("out-of-range empty poll uses the server-clamped page.from, not the requested cursor", async () => {
  const h = pollHarness(fixture.frames.completed, { ...clone(fixture.messages.clamped_empty), requested_from: 999 });
  const result = await invoke(h, "claude_science_poll_session", { frame_id: frameId, from_message: 999, wait_seconds: 0 });
  assert.deepEqual(result.messages, []);
  assert.equal(result.next_from_message, 4);
  h.done();
});

test("legacy paginated message objects still prefer explicit index/id over page.from and _uuid", async () => {
  const h = pollHarness(fixture.frames.processing, {
    frame_id: frameId, from: 2, total: 3,
    messages: [{ index: 8, id: "explicit-id-fixture", _uuid: "fallback-uuid-fixture", sender: "assistant", text: "Synthetic legacy message" }],
  });
  const result = await invoke(h, "claude_science_poll_session", { frame_id: frameId, from_message: 2, wait_seconds: 0 });
  assert.equal(result.messages[0].index, 8);
  assert.equal(result.messages[0].id, "explicit-id-fixture");
  assert.equal(result.messages[0].text, "Synthetic legacy message");
  assert.equal(result.next_from_message, 3);
  assert.equal(result.final_answer, undefined);
  h.done();
});

for (const [name, attention] of [["processing", false], ["awaiting_plan_approval", true]]) {
  test(`${name} poll reports attention without promoting intermediate text to a final answer`, async () => {
    const h = pollHarness(fixture.frames[name], fixture.messages.intermediate);
    const result = await invoke(h, "claude_science_poll_session", { frame_id: frameId, wait_seconds: 0 });
    assert.equal(result.status, name);
    assert.equal(result.requires_attention, attention);
    assert.equal(result.final_answer, undefined);
    assert.equal(result.next_from_message, 1);
    h.done();
  });
}

for (const name of ["failed", "cancelled"]) {
  test(`${name} poll never presents an intermediate assistant message as a successful final answer`, async () => {
    const h = pollHarness(fixture.frames[name], fixture.messages.intermediate);
    const result = await invoke(h, "claude_science_poll_session", { frame_id: frameId, wait_seconds: 0 });
    assert.equal(result.status, name);
    assert.equal(result.final_answer, undefined);
    assert.equal(typeof result.failure, "object");
    if (name === "failed") {
      assert.equal(result.failure.error_kind, "auth_error");
      assert.equal(result.failure.error_status, 401);
      assert.equal(result.failure.error, "Synthetic failure with [REDACTED]");
      assert.doesNotMatch(JSON.stringify(result.failure), /fixture-secret-redaction-marker|PRIVATE_ERROR_FIXTURE_SENTINEL/);
    }
    h.done();
  });
}

test("invalid task/model/plan or poll cursor inputs fail before any fake API request", async () => {
  for (const [name, args] of [
    ["claude_science_submit_task", { prompt: "Synthetic bounded request", project_id: projectId, model: 52 }],
    ["claude_science_submit_task", { prompt: "Synthetic bounded request", project_id: projectId, plan_mode: "true" }],
    ["claude_science_continue_session", { frame_id: "not/a/frame", prompt: "Synthetic follow-up" }],
    ["claude_science_poll_session", { frame_id: frameId, from_message: -1, wait_seconds: 0 }],
  ]) {
    const h = scriptedInspector([]);
    await assert.rejects(invoke(h, name, args), { code: "INVALID_PARAMS" });
    h.done();
  }
});
