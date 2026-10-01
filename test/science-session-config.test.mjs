import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { after, before, test } from "node:test";
import { OperatorError, StateUncertainError, callTool } from "../plugins/claude-science-operator/scripts/server.mjs";

// Only operator/fake-client I/O is exercised. No RuntimeInspector, ScienceClient,
// CLI, application state, provider, or daemon connection is created by this file.
const fixture = JSON.parse(await fs.readFile(new URL("./fixtures/science-session-config.json", import.meta.url), "utf8"));
const clone = (value) => structuredClone(value);
const rootId = fixture.root_id;
const frameRoute = `/api/frames/${rootId}`;
const configRoute = `${frameRoute}/session-config`;
const messageRoute = `${frameRoute}/message`;
const configTool = "claude_science_session_config";
const originalSource = "context_data._original_input";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const originalFetch = globalThis.fetch;
before(() => { globalThis.fetch = () => assert.fail("Synthetic session tests forbid all real network I/O"); });
after(() => { globalThis.fetch = originalFetch; });

function scripted(steps, { scienceVersion = "0.1.52" } = {}) {
  const calls = [];
  const client = {
    scienceVersion,
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
    inspector: { client: async () => client, inspect: async () => assert.fail("No app/runtime inspection is allowed") },
    done() { assert.equal(calls.length, steps.length, "Every expected fake request occurred exactly once"); },
  };
}

async function invoke(h, name, args) {
  const result = await callTool(h.inspector, name, args);
  assert.equal(result.content[0].type, "text");
  return result.structuredContent;
}
const get = (h, args = {}) => invoke(h, configTool, { action: "get", frame_id: rootId, ...args });
const set = (h, config = fixture.config.desired, args = {}) => invoke(h, configTool, { action: "set", frame_id: rootId, config: clone(config), confirm: true, ...args });
const guardedContinue = (h, expected = fixture.config.guarded, args = {}) => invoke(h, "claude_science_continue_session", {
  frame_id: rootId, prompt: "Synthetic guarded follow-up", expected_session_config: { frame_id: rootId, config: clone(expected) }, ...args,
});
const readFrame = (reply = fixture.frames.before) => ({ route: frameRoute, reply });
function postConfig(reply = fixture.responses.session_config_echo, check) {
  return { route: configRoute, method: "POST", reply, check };
}
function assertWrite(options, body) {
  assert.equal(options.write, true);
  assert.equal(options.method, "POST");
  assert.match(options.intentId, uuidPattern);
  assert.equal(typeof options.operation, "string");
  if (body) assert.deepEqual(options.body, body);
}
function assertNoMessage(h) {
  assert.equal(h.calls.some((call) => call.route === messageRoute), false, "No message can be sent before independent confirmation");
}
function frameWithOriginal(original) {
  return { ...clone(fixture.frames.after), context_data: { ...clone(fixture.frames.after.context_data), _original_input: clone(original) } };
}
function configuredTrace(after = fixture.frames.after, before = fixture.frames.before, reply = fixture.responses.session_config_echo) {
  return [readFrame(before), postConfig(reply), readFrame(after)];
}

test("session fixtures document no live requests and the incomplete full-menu API boundary", () => {
  assert.equal(fixture.provenance.science_version, "0.1.52");
  assert.equal(fixture.provenance.runtime_requests, false);
  assert.equal(fixture.provenance.authentication_verified, false);
  assert.match(fixture.provenance.binary_sha256, /^[0-9a-f]{64}$/);
  for (const key of ["model", "reasoning_effort", "delegation", "specialist", "compute"]) {
    assert.equal(fixture.menu[key].api_preconfiguration, false);
  }
  assert.equal(fixture.menu.reasoning_effort.send_value, "max");
  assert.equal(fixture.menu.reasoning_effort.may_be_capped_by_model, true);
  assert.equal(fixture.menu.compute.gpu_off_is_not_compute_local, true);
});

test("session GET projects persisted knobs and their sources without exposing raw context/transcript", async () => {
  const h = scripted([readFrame()]);
  const result = await get(h);
  assert.equal(result.frame_id, rootId);
  assert.equal(result.root_frame_id, rootId);
  assert.equal(result.config_source, originalSource);
  assert.deepEqual(result.config, fixture.config.before);
  for (const key of Object.keys(fixture.config.before)) assert.equal(result.sources[key], originalSource);
  assert.notEqual(result.configuration_confirmed, true, "A read alone does not configure all menu options");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TRANSCRIPT_FIXTURE_SENTINEL|PRIVATE_CONTEXT_FIXTURE_SENTINEL|Synthetic original request/);
  h.done();
});

test("session GET distinguishes the current context model from the initial root column", async () => {
  const h = scripted([readFrame()]);
  const result = await get(h);
  assert.equal(result.active_model, "model-luna-fixture");
  assert.equal(result.active_model_source, "context_data._model");
  assert.equal(result.initial_model, "model-sol-fixture");
  assert.notEqual(result.active_model, result.initial_model);
  assert.equal(result.active_effort, "max");
  assert.equal(result.active_effort_source, "context_data._effort");
  assert.notEqual(result.active_effort, fixture.frames.before.effort);
  h.done();
});

test("missing/ill-typed current model never falls back to the root's initial model", async () => {
  for (const replacement of [undefined, 52, true, { model: "PRIVATE_CONTEXT_FIXTURE_SENTINEL" }]) {
    const frame = clone(fixture.frames.before);
    if (replacement === undefined) delete frame.context_data._model;
    else frame.context_data._model = replacement;
    const h = scripted([readFrame(frame)]);
    const result = await get(h);
    assert.equal(Object.hasOwn(result, "active_model"), false);
    assert.equal(Object.hasOwn(result, "active_model_source"), false);
    assert.equal(result.initial_model, "model-sol-fixture");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CONTEXT_FIXTURE_SENTINEL/);
    h.done();
  }
});

test("explicit null context model/effort stays distinct from missing and the initial columns", async () => {
  const frame = clone(fixture.frames.before);
  frame.context_data._model = null;
  frame.context_data._effort = null;
  const h = scripted([readFrame(frame)]);
  const result = await get(h);
  assert.equal(Object.hasOwn(result, "active_model"), true);
  assert.equal(result.active_model, null);
  assert.equal(result.active_model_source, "context_data._model");
  assert.equal(Object.hasOwn(result, "active_effort"), true);
  assert.equal(result.active_effort, null);
  assert.equal(result.active_effort_source, "context_data._effort");
  assert.equal(result.initial_model, "model-sol-fixture");
  h.done();
});

test("explicit session reviewer null is preserved as inheritance, not mistaken for missing/default proof", async () => {
  const h = scripted([readFrame(fixture.frames.after)]);
  const result = await get(h);
  assert.equal(Object.hasOwn(result.config, "reviewer_model"), true);
  assert.equal(result.config.reviewer_model, null);
  assert.equal(result.sources.reviewer_model, originalSource);
  assert.equal(Object.hasOwn(result.config, "reviewer_default_effective_model"), false);
  h.done();
});

test("an authoritative original-input container never fills missing knobs from old input_data", async () => {
  const frame = frameWithOriginal({ verifier_mode: "on" });
  frame.input_data = clone(fixture.config.before);
  const h = scripted([readFrame(frame)]);
  const result = await get(h);
  assert.deepEqual(result.config, { verifier_mode: "on" });
  assert.deepEqual(result.sources, { verifier_mode: originalSource });
  h.done();
});

test("a null authoritative container means unknown/empty knobs, not fallback to old input_data", async () => {
  const frame = frameWithOriginal(null);
  frame.input_data = clone(fixture.config.before);
  const h = scripted([readFrame(frame)]);
  const result = await get(h);
  assert.deepEqual(result.config, {});
  assert.deepEqual(result.sources, {});
  h.done();
});

test("input-only legacy values without an authoritative original container are not called effective", async () => {
  const h = scripted([readFrame(fixture.frames.input_only)]);
  const result = await get(h);
  assert.deepEqual(result.config, {});
  assert.deepEqual(result.sources, {});
  assert.equal(result.config_source, "source_unknown");
  assert.equal(Object.hasOwn(result, "active_model"), false);
  h.done();
});

test("input-only values cannot satisfy a strict confirmation guard", async () => {
  const frame = clone(fixture.frames.input_only);
  frame.input_data = clone(fixture.config.desired);
  const h = scripted([readFrame(frame)]);
  await assert.rejects(guardedContinue(h), { code: "SESSION_CONFIG_UNCONFIRMED" });
  assertNoMessage(h);
  h.done();
});

test("unreported knobs are not synthesized as Default/on/off for confirmation", async () => {
  const h = scripted([readFrame(fixture.frames.missing)]);
  const result = await get(h);
  assert.deepEqual(result.config, {});
  assert.deepEqual(result.sources, {});
  assert.equal(Object.hasOwn(result, "active_model"), false);
  h.done();
});

test("ill-typed persisted config is not projected as a verified value", async () => {
  const h = scripted([readFrame(frameWithOriginal({ verifier_mode: true, memory_mode: "default", reviewer_model: { private: "PRIVATE_CONTEXT_FIXTURE_SENTINEL" }, auto_mode: 1 }))]);
  const result = await get(h);
  assert.deepEqual(result.config, {});
  assert.deepEqual(result.sources, {});
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CONTEXT_FIXTURE_SENTINEL/);
  h.done();
});

test("session SET preflights root, writes once, then independently reads persisted configuration", async () => {
  const h = scripted([
    readFrame(),
    postConfig(fixture.responses.session_config_echo, (options) => assertWrite(options, fixture.config.desired)),
    readFrame(fixture.frames.after),
  ]);
  const result = await set(h);
  assert.equal(result.configuration_confirmed, true);
  assert.deepEqual([...result.verified_fields].sort(), Object.keys(fixture.config.desired).sort());
  for (const [key, value] of Object.entries(fixture.config.desired)) {
    assert.equal(result.config[key], value);
    assert.equal(result.sources[key], originalSource);
  }
  assert.equal(result.intent_id, h.calls[1].options.intentId);
  assertNoMessage(h);
  h.done();
});

test("config confirmation uses only safe independent frame projection, not arbitrary POST echo metadata", async () => {
  const reply = { ...clone(fixture.responses.session_config_echo), private_fixture_metadata: "PRIVATE_POST_ECHO_FIXTURE_SENTINEL" };
  const h = scripted(configuredTrace(fixture.frames.after, fixture.frames.before, reply));
  const result = await set(h);
  assert.equal(result.configuration_confirmed, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_POST_ECHO_FIXTURE_SENTINEL|PRIVATE_CONTEXT_FIXTURE_SENTINEL|PRIVATE_TRANSCRIPT_FIXTURE_SENTINEL/);
  h.done();
});

test("configure -> fresh readback -> separate guarded read -> message is the only permitted sequence", async () => {
  const h = scripted([
    ...configuredTrace(),
    readFrame(fixture.frames.after),
    { route: messageRoute, method: "POST", reply: fixture.responses.continuation, check: (options) => {
      assertWrite(options);
      assert.deepEqual(options.body.input_data, { request: "Synthetic guarded follow-up" });
      assert.equal(options.body.intent_id, options.intentId);
    } },
  ]);
  const configured = await set(h);
  assert.equal(configured.configuration_confirmed, true);
  const sent = await guardedContinue(h);
  assert.equal(sent.frame_id, rootId);
  assert.deepEqual(h.calls.map((call) => [call.options.method || "GET", call.route]), [
    ["GET", frameRoute], ["POST", configRoute], ["GET", frameRoute], ["GET", frameRoute], ["POST", messageRoute],
  ]);
  assert.equal(h.calls.filter((call) => call.options.write).length, 2);
  assert.notEqual(h.calls[1].options.intentId, h.calls[4].options.intentId);
  h.done();
});

for (const [name, persisted] of [
  ["stale values", fixture.frames.before],
  ["missing reviewer override", frameWithOriginal({ verifier_mode: "on", memory_mode: "off" })],
  ["missing all values", fixture.frames.missing],
  ["wrong nullable reviewer", frameWithOriginal({ verifier_mode: "on", memory_mode: "off", reviewer_model: "model-other-reviewer-fixture" })],
]) {
  test(`a correct POST echo followed by ${name} cannot confirm configuration or send`, async () => {
    const h = scripted(configuredTrace(persisted));
    await assert.rejects(set(h), { code: "STATE_UNCERTAIN" });
    assert.equal(h.calls.filter((call) => call.route === configRoute).length, 1);
    assertNoMessage(h);
    h.done();
  });
}

test("readback failure after config dispatch is STATE_UNCERTAIN and never triggers retry/message", async () => {
  const h = scripted([
    readFrame(), postConfig(),
    { route: frameRoute, error: new OperatorError("SCIENCE_API_UNAVAILABLE", "Synthetic readback failure") },
  ]);
  await assert.rejects(set(h), (error) => {
    assert.ok(error instanceof StateUncertainError);
    assert.equal(error.details.intent_id, h.calls[1].options.intentId);
    return true;
  });
  assertNoMessage(h);
  h.done();
});

test("uncertain config POST is dispatched once without readback or automatic message", async () => {
  const h = scripted([readFrame(), { route: configRoute, method: "POST", uncertain: true }]);
  await assert.rejects(set(h), { code: "STATE_UNCERTAIN" });
  assertNoMessage(h);
  h.done();
});

for (const [name, response] of [
  ["missing root ID", { status: "ok", ...clone(fixture.config.desired) }],
  ["different root ID", { root_frame_id: "frame-another-root-fixture", status: "ok", ...clone(fixture.config.desired) }],
  ["malformed response", "Synthetic malformed config response"],
  ["missing status", { root_frame_id: rootId, ...clone(fixture.config.desired) }],
  ["unexpected status", { root_frame_id: rootId, status: "accepted", ...clone(fixture.config.desired) }],
  ["wrong acknowledged knob", { ...clone(fixture.responses.session_config_echo), memory_mode: "on" }],
  ["missing acknowledged null", { root_frame_id: rootId, status: "ok", verifier_mode: "on", memory_mode: "off" }],
]) {
  test(`config POST with ${name} is uncertain, not proof of an applied configuration`, async () => {
    const h = scripted([readFrame(), postConfig(response)]);
    await assert.rejects(set(h), { code: "STATE_UNCERTAIN" });
    assertNoMessage(h);
    h.done();
  });
}

test("failed root preflight cannot write config or send a message", async () => {
  const h = scripted([{ route: frameRoute, error: new OperatorError("SCIENCE_API_UNAVAILABLE", "Synthetic preflight failure") }]);
  await assert.rejects(set(h), (error) => error instanceof OperatorError);
  assert.equal(h.calls.some((call) => call.options.write), false);
  assertNoMessage(h);
  h.done();
});

for (const name of ["child", "missing_identity", "different_root", "unknown_parent"]) {
  test(`root-only config refuses ${name} before POST`, async () => {
    const frame = clone(fixture.frames.before);
    if (name === "child") Object.assign(frame, fixture.frames.child);
    if (name === "missing_identity") delete frame.id;
    if (name === "different_root") frame.root_frame_id = "frame-another-root-fixture";
    if (name === "unknown_parent") delete frame.parent_frame_id;
    const h = scripted([readFrame(frame)]);
    await assert.rejects(set(h), (error) => error instanceof OperatorError);
    assert.equal(h.calls.some((call) => call.options.write), false);
    h.done();
  });
}

test("SET requires explicit confirm=true; GET cannot fabricate that approval", async () => {
  for (const args of [{ confirm: false }, { confirm: undefined }]) {
    const h = scripted([]);
    await assert.rejects(set(h, fixture.config.desired, args), { code: "CONFIRMATION_REQUIRED" });
    h.done();
  }
});

for (const [name, config] of [
  ["empty", {}], ["null", null], ["array", []],
  ["boolean verifier", { verifier_mode: true }],
  ["boolean memory", { memory_mode: false }],
  ["null memory", { memory_mode: null }],
  ["unknown verifier enum", { verifier_mode: "default" }],
  ["empty reviewer model", { reviewer_model: "" }],
  ["long reviewer model", { reviewer_model: "x".repeat(201) }],
  ["reviewer object", { reviewer_model: {} }],
]) {
  test(`invalid ${name} configuration fails before client requests`, async () => {
    const h = scripted([]);
    await assert.rejects(set(h, config), { code: "INVALID_PARAMS" });
    h.done();
  });
}

for (const [key, value] of [
  ["model", "model-luna-fixture"], ["effort", "max"], ["reasoning_effort", "Max"],
  ["delegation", "off"], ["ultra_mode", false], ["target_agent", "OPERON"],
  ["specialist", "default"], ["compute", "local"], ["compute_mode", "local"], ["gpu_mode", "off"],
  ["auto_mode", "on"], ["rc_context_ceiling", 200000], ["python_version", "3.12"],
]) {
  test(`${key} is not falsely accepted as a no-dispatch session-config setter`, async () => {
    const h = scripted([]);
    await assert.rejects(set(h, { ...clone(fixture.config.desired), [key]: value }), { code: "API_ACTION_UNSUPPORTED" });
    assertNoMessage(h);
    h.done();
  });
}

test("a full screenshot-menu guard with unsupported/local options fails before any message", async () => {
  const h = scripted([]);
  await assert.rejects(guardedContinue(h, {
    ...clone(fixture.config.guarded), model: "model-luna-fixture", effort: "max", delegation: "off", specialist: "default", compute: "local",
  }), (error) => error instanceof OperatorError);
  assertNoMessage(h);
  h.done();
});

test("guard validates nonempty exact persisted fields instead of trusting a caller confirmed boolean", async () => {
  const h = scripted([]);
  await assert.rejects(guardedContinue(h, {}, { configuration_confirmed: true }), (error) => error instanceof OperatorError);
  assertNoMessage(h);
  h.done();
});

for (const [name, frame] of [
  ["stale config", fixture.frames.before],
  ["missing config", fixture.frames.missing],
  ["reviewer null absent", frameWithOriginal({ verifier_mode: "on", memory_mode: "off" })],
  ["child frame", fixture.frames.child],
]) {
  test(`guarded continuation with ${name} reads then fails closed without a POST`, async () => {
    const h = scripted([readFrame(frame)]);
    await assert.rejects(guardedContinue(h), { code: name === "child frame" ? "SCIENCE_SESSION_INVALID" : "SESSION_CONFIG_UNCONFIRMED" });
    assertNoMessage(h);
    h.done();
  });
}

test("guard root binding is explicit and cannot be transplanted to another root", async () => {
  const h = scripted([]);
  await assert.rejects(guardedContinue(h, fixture.config.guarded, {
    expected_session_config: { frame_id: "frame-another-root-fixture", config: clone(fixture.config.guarded) },
  }), { code: "INVALID_PARAMS" });
  assertNoMessage(h);
  h.done();
});

for (const [name, expected] of [
  ["legacy flat config", fixture.config.guarded],
  ["missing bound frame", { config: fixture.config.guarded }],
  ["caller confirmation flag", { frame_id: rootId, config: fixture.config.guarded, configuration_confirmed: true }],
  ["null envelope", null],
  ["array envelope", []],
]) {
  test(`guard rejects ${name} before a read or message`, async () => {
    const h = scripted([]);
    await assert.rejects(guardedContinue(h, fixture.config.guarded, { expected_session_config: clone(expected) }), { code: "INVALID_PARAMS" });
    h.done();
  });
}

test("guarded send maps Max effort and Delegation Off to audited request-time fields only", async () => {
  const h = scripted([
    readFrame(fixture.frames.after),
    { route: messageRoute, method: "POST", reply: fixture.responses.continuation, check(options) {
      assertWrite(options);
      assert.deepEqual(options.body, {
        input_data: { request: "Synthetic guarded follow-up", ultra_mode: false },
        model: "model-luna-fixture", effort: "max", intent_id: options.intentId,
      });
      assert.equal(Object.hasOwn(options.body, "ultra_mode"), false);
      assert.equal(Object.hasOwn(options.body, "target_agent"), false);
      assert.equal(Object.hasOwn(options.body, "session_knobs"), false);
    } },
  ]);
  const result = await guardedContinue(h, fixture.config.guarded, { model: "model-luna-fixture", effort: "max", ultra_mode: false });
  assert.equal(result.frame_id, rootId);
  h.done();
});

test("new project request maps effort/ultra_mode at the top level, but does not preconfirm a new root", async () => {
  const route = `/api/projects/${fixture.project_id}/request`;
  const h = scripted([{ route, method: "POST", reply: fixture.responses.continuation, check(options) {
    assertWrite(options);
    assert.equal(options.body.effort, "max");
    assert.equal(options.body.ultra_mode, false);
    assert.deepEqual(options.body.input_data, { request: "Synthetic new-root request" });
    assert.equal(Object.hasOwn(options.body.input_data, "ultra_mode"), false);
  } }]);
  const result = await invoke(h, "claude_science_submit_task", {
    project_id: fixture.project_id, prompt: "Synthetic new-root request", model: "model-luna-fixture", effort: "max", ultra_mode: false,
  });
  assert.equal(result.frame_id, rootId);
  assert.notEqual(result.configuration_confirmed, true);
  h.done();
});

test("legacy continuation without new options neither reads configuration nor silently changes delegation", async () => {
  const h = scripted([{ route: messageRoute, method: "POST", reply: fixture.responses.continuation, check(options) {
    assertWrite(options);
    assert.deepEqual(options.body.input_data, { request: "Synthetic legacy follow-up" });
    assert.equal(Object.hasOwn(options.body, "effort"), false);
    assert.equal(Object.hasOwn(options.body.input_data, "ultra_mode"), false);
  } }]);
  await invoke(h, "claude_science_continue_session", { frame_id: rootId, prompt: "Synthetic legacy follow-up" });
  h.done();
});

for (const [name, args] of [
  ["invalid effort", { effort: "Max" }], ["unknown effort", { effort: "unlimited" }],
  ["boolean effort", { effort: true }], ["string delegation", { ultra_mode: "off" }],
]) {
  test(`${name} is rejected before any guarded read or send`, async () => {
    const h = scripted([]);
    await assert.rejects(guardedContinue(h, fixture.config.guarded, args), { code: "INVALID_PARAMS" });
    h.done();
  });
}

test("an earlier successful set cannot authorize a later continuation after the server changes", async () => {
  const h = scripted([...configuredTrace(), readFrame(fixture.frames.before)]);
  const configured = await set(h);
  assert.equal(configured.configuration_confirmed, true);
  await assert.rejects(guardedContinue(h), (error) => error instanceof OperatorError);
  assertNoMessage(h);
  h.done();
});

test("a guard read failure cannot send or make an automatic configuration repair", async () => {
  const h = scripted([{ route: frameRoute, error: new OperatorError("SCIENCE_API_UNAVAILABLE", "Synthetic guard read failure") }]);
  await assert.rejects(guardedContinue(h), (error) => error instanceof OperatorError);
  assert.equal(h.calls.some((call) => call.options.write), false);
  h.done();
});

test("guarded continuation uncertainty does not retry a message or rewrite configuration", async () => {
  const h = scripted([readFrame(fixture.frames.after), { route: messageRoute, method: "POST", uncertain: true }]);
  await assert.rejects(guardedContinue(h), { code: "STATE_UNCERTAIN" });
  assert.equal(h.calls.filter((call) => call.options.write).length, 1);
  h.done();
});

test("a new-root project submission cannot claim an existing root's configuration was verified", async () => {
  for (const args of [{}, { project_id: fixture.project_id }]) {
    const h = scripted([]);
    await assert.rejects(invoke(h, "claude_science_submit_task", {
      prompt: "Synthetic new-root request", expected_session_config: { frame_id: rootId, config: clone(fixture.config.guarded) }, ...args,
    }), (error) => error instanceof OperatorError);
    h.done();
  }
});

test("restoring existing original-input knobs verifies both values and the same recorded source", async () => {
  const restoredEcho = { root_frame_id: rootId, status: "ok", ...clone(fixture.config.before) };
  const h = scripted([...configuredTrace(), readFrame(fixture.frames.after), postConfig(restoredEcho), readFrame(fixture.frames.before)]);
  const changed = await set(h);
  assert.equal(changed.configuration_confirmed, true);
  const restored = await set(h, fixture.config.before);
  assert.equal(restored.configuration_confirmed, true);
  assert.deepEqual(restored.config, fixture.config.before);
  for (const key of Object.keys(fixture.config.before)) assert.equal(restored.sources[key], originalSource);
  assert.equal(Object.hasOwn(restored, "strict_restore"), false, "No deletion/history restoration is claimed");
  assertNoMessage(h);
  h.done();
});

test("setting unknown-source input establishes an explicit new source but never claims strict restoration", async () => {
  const h = scripted(configuredTrace(fixture.frames.after, fixture.frames.input_only));
  const result = await set(h);
  assert.equal(result.configuration_confirmed, true);
  assert.equal(result.config_source, originalSource);
  for (const key of Object.keys(fixture.config.desired)) assert.equal(result.sources[key], originalSource);
  assert.equal(Object.hasOwn(result, "strict_restore"), false);
  assertNoMessage(h);
  h.done();
});

test("new send-time options require the audited version even though legacy sends still work", async () => {
  for (const name of ["claude_science_continue_session", "claude_science_submit_task"]) {
    const h = scripted([], { scienceVersion: "0.1.43" });
    const args = name === "claude_science_continue_session"
      ? { frame_id: rootId, prompt: "Synthetic follow-up", effort: "max", ultra_mode: false }
      : { project_id: fixture.project_id, prompt: "Synthetic new-root request", effort: "max", ultra_mode: false };
    await assert.rejects(invoke(h, name, args), { code: "API_ACTION_UNSUPPORTED" });
    h.done();
  }
});

test("missing set configuration and unsafe frame identifiers fail before API requests", async () => {
  for (const args of [
    { action: "set", frame_id: rootId, confirm: true },
    { action: "get", frame_id: "not/a/root" },
    { action: "set", frame_id: "..", config: clone(fixture.config.desired), confirm: true },
  ]) {
    const h = scripted([]);
    await assert.rejects(invoke(h, configTool, args), { code: "INVALID_PARAMS" });
    h.done();
  }
});

test("session-config operations reject an unverified/unsupported runtime before reading or writing", async () => {
  for (const scienceVersion of ["0.1.43", "0.1.53", undefined]) {
    const h = scripted([], { scienceVersion: scienceVersion === undefined ? null : scienceVersion });
    await assert.rejects(get(h), (error) => error instanceof OperatorError);
    h.done();
  }
});
