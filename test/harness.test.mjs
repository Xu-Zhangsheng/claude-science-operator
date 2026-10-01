import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { apply, inject } from "../index.mjs";
import { adaptTool, harnessSchema, isReadOnly, serialExecutor } from "../lib/adapter.mjs";
import { OperatorError, StateUncertainError, toolsList as scienceTools, callTool as callScience } from "../plugins/claude-science-operator/scripts/server.mjs";
import { toolsList as switchTools } from "../plugins/csswitch-operator/scripts/server.mjs";

const allTools = [...scienceTools(), ...switchTools()];
const tool = (name) => allTools.find((item) => item.name === name);
const execution = (signal = new AbortController().signal) => ({ agent: { id: "test-session" }, callId: "test-call", signal });
const payload = { content: [{ type: "text", text: "Summary" }], structuredContent: { frame_id: "frame-1", intent_id: "intent-1" } };
function fixture(name = "claude_science_status", outcome = "allowed-once", invoke = async () => payload) {
  const asks = [];
  const ctx = { approval: { request: async (request) => { asks.push(request); return typeof outcome === "function" ? outcome(request) : outcome; } } };
  return { asks, definition: adaptTool(ctx, tool(name), invoke, { platform: "darwin", isOperatorError: (error) => error instanceof OperatorError }) };
}

test("mount registers the exact native tool catalog, two skills, and declared dependencies", async () => {
  const tools = [];
  const skills = [];
  const manifest = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  await apply({ tools: { register: (value) => tools.push(value) }, skills: { register: (value) => skills.push(value) }, approval: { request: () => assert.fail("mount must not ask approval or inspect runtime") } });
  assert.deepEqual(inject, ["tools", "skills", "approval", "sandboxPolicy"]);
  assert.equal(tools.length, allTools.length);
  assert.equal(new Set(tools.map((value) => value.name)).size, allTools.length);
  assert.deepEqual(tools.map((value) => value.name).sort(), allTools.map((value) => value.name).sort());
  assert.deepEqual(skills.map((value) => value.name), ["claude-science-operator", "csswitch-operator"]);
  for (const value of tools) {
    assert.equal(value.parameters.type, "object");
    assert.equal(value.isConcurrencySafe({}), false);
    assert.equal(typeof value.output.render, "function");
    assert.equal(value.timeoutMs, 300_000);
    assert.ok(value.description.endsWith(`Native adapter ${manifest.version}.`), "registered version derives from the package manifest");
  }
  for (const skill of skills) {
    assert.equal(skill.content.startsWith("---"), false);
    assert.match(skill.content, /DeepSeek Harness runtime/);
    assert.match(skill.content, /Harness persists arguments/);
    assert.equal(skill.invocation.modelInvocable, true);
    assert.equal(skill.resourceBase.kind, "directory");
    assert.equal((await fs.stat(skill.path)).isFile(), true);
  }
});

test("full access authorizes local calls without asking a never-policy approver", async () => {
  const session = { id: "full-access-session" };
  let resolutions = 0;
  let calls = 0;
  const ctx = {
    sandboxPolicy: { resolve(request) { assert.equal(request.session, session); resolutions++; return { mode: "danger-full-access" }; } },
    approval: { request: () => assert.fail("full access must not request escalation") },
  };
  const definition = adaptTool(ctx, tool("claude_science_status"), async () => { calls++; return payload; }, { platform: "darwin" });
  await definition.execute({}, { ...execution(), agent: { id: session.id, session } });
  assert.equal(resolutions, 1);
  assert.equal(calls, 1);
});

test("permission is resolved per call and a downgrade cannot reuse full access", async () => {
  let mode = "danger-full-access";
  let calls = 0;
  let asks = 0;
  const ctx = {
    sandboxPolicy: { resolve: () => ({ mode }) },
    approval: { request: async () => { asks++; return "rejected"; } },
  };
  const definition = adaptTool(ctx, tool("claude_science_status"), async () => { calls++; return payload; }, { platform: "darwin" });
  await definition.execute({}, execution());
  mode = "workspace-write";
  await assert.rejects(definition.execute({}, execution()), { code: "APPROVAL_DENIED" });
  assert.equal(calls, 1);
  assert.equal(asks, 1);
});

test("full access never fabricates reviewed-mutation confirmation", async () => {
  const ctx = { sandboxPolicy: { resolve: () => ({ mode: "danger-full-access" }) }, approval: { request: () => assert.fail("unexpected approval") } };
  const definition = adaptTool(ctx, tool("claude_science_settings"), async (_name, args) => {
    assert.equal(args.confirm, false);
    throw new OperatorError("CONFIRMATION_REQUIRED", "Reviewed mutation required");
  }, { platform: "darwin", isOperatorError: (error) => error instanceof OperatorError });
  await assert.rejects(definition.execute({ action: "set", setting: "reviewer_model", value: "test-model", confirm: false }, execution()), { code: "CONFIRMATION_REQUIRED" });
});

test("unknown or unavailable permission modes still require approval", async () => {
  for (const mode of [undefined, "read-only", "workspace-write", "never", "full-access"]) {
    const ctx = { sandboxPolicy: { resolve: () => ({ mode }) }, approval: { request: async () => "rejected" } };
    const definition = adaptTool(ctx, tool("claude_science_status"), () => assert.fail("unauthorized dispatch"), { platform: "darwin" });
    await assert.rejects(definition.execute({}, execution()), { code: "APPROVAL_DENIED" });
  }
});

test("structured MCP results are rendered for the Harness model without loss", async () => {
  const { definition } = fixture();
  const result = await definition.execute({}, execution());
  assert.deepEqual(result, payload);
  assert.deepEqual(definition.output.render({}, result), [payload.content[0], { type: "text", text: JSON.stringify(payload.structuredContent) }]);
});

test("the reused upstream Science status crosses the same JSON boundary as MCP", async () => {
  const status = {
    claudeScience: { version: "0.1.43", port: 8990, pid: undefined, started_at: undefined },
    apiCompatible: true,
    compatibility: { reasons: [] },
    diagnostics: { configError: undefined, binaryError: undefined, statusError: undefined, healthError: undefined },
  };
  const inspector = { inspect: async () => status };
  const raw = await callScience(inspector, "claude_science_status", {});
  const { definition } = fixture("claude_science_status", "allowed-once", (name, args) => callScience(inspector, name, args));
  const result = await definition.execute({}, execution());
  assert.deepEqual(result, JSON.parse(JSON.stringify(raw)));
  assert.deepEqual(result.structuredContent.diagnostics, {});
  assert.equal(Object.hasOwn(result.structuredContent.claudeScience, "pid"), false);
  assert.equal(Object.hasOwn(status.claudeScience, "pid"), true, "upstream state is not mutated");
});

test("JSON wire conversion preserves dates, array gaps, and detached result identity", async () => {
  const raw = { content: [], structuredContent: { date: new Date("2026-09-30T12:00:00Z"), values: [undefined, "frame-1"], omitted: undefined } };
  const { definition } = fixture("claude_science_status", "allowed-once", async () => raw);
  const result = await definition.execute({}, execution());
  assert.deepEqual(result, JSON.parse(JSON.stringify(raw)));
  raw.structuredContent.values[1] = "changed";
  assert.deepEqual(result.structuredContent.values, [null, "frame-1"]);
});

test("unencodable read responses fail without leaking serialization details", async () => {
  const circular = { content: [], privateValue: "probe-secret" };
  circular.self = circular;
  for (const raw of [undefined, { content: [], number: 1n }, circular, { malformed: true }]) {
    const { definition } = fixture("claude_science_status", "allowed-once", async () => raw);
    await assert.rejects(definition.execute({}, execution()), (error) => {
      assert.equal(error.code, "INVALID_OPERATOR_OUTPUT");
      assert.doesNotMatch(error.message, /probe-secret|BigInt|circular|privateValue/);
      return true;
    });
  }
});

test("write output serialization failure stays uncertain and is never resent", async () => {
  let calls = 0;
  const raw = { content: [], structuredContent: { intent_id: "intent-encoding" } };
  raw.self = raw;
  const { definition } = fixture("claude_science_submit_task", "allowed-once", async () => { calls++; return raw; });
  await assert.rejects(definition.execute({ prompt: "Bounded fixture" }, execution()), (error) => {
    assert.equal(error.code, "STATE_UNCERTAIN");
    assert.match(error.message, /intent-encoding/);
    return true;
  });
  assert.equal(calls, 1);
});

test("CSSwitch text-only results stay text-only", () => {
  const { definition } = fixture("csswitch_status");
  const result = { content: [{ type: "text", text: '{"csswitch":{"running":true}}' }] };
  assert.deepEqual(definition.output.render({}, result), result.content);
});

for (const outcome of ["rejected", "cancelled", "unavailable", "allow", undefined]) {
  test(`approval ${String(outcome)} fails closed before local I/O`, async () => {
    let calls = 0;
    const { definition } = fixture("claude_science_status", () => outcome, async () => { calls++; return payload; });
    await assert.rejects(definition.execute({}, execution()), { code: "APPROVAL_DENIED" });
    assert.equal(calls, 0);
  });
}

test("reads ask on every call; approvals are correlated and not cached", async () => {
  const { definition, asks } = fixture();
  const exec = execution();
  await definition.execute({}, exec);
  await definition.execute({}, exec);
  assert.equal(asks.length, 2);
  assert.equal(asks[0].agent, exec.agent);
  assert.equal(asks[0].signal, exec.signal);
  assert.equal(asks[0].callId, exec.callId);
  assert.match(asks[0].reason, /outside the workspace sandbox/);
});

test("no Agent and pre-aborted calls cannot access local apps", async () => {
  let calls = 0;
  const { definition, asks } = fixture("claude_science_status", "allowed-once", async () => { calls++; return payload; });
  await assert.rejects(definition.execute({}, { ...execution(), agent: undefined }), { code: "AGENT_REQUIRED" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(definition.execute({}, execution(controller.signal)), { code: "ABORTED_BEFORE_DISPATCH" });
  assert.equal(asks.length, 0);
  assert.equal(calls, 0);
});

test("cancellation while awaiting approval never dispatches", async () => {
  const controller = new AbortController();
  const { definition } = fixture("claude_science_status", () => { controller.abort(); return "allowed-once"; }, () => assert.fail("dispatch after abort"));
  await assert.rejects(definition.execute({}, execution(controller.signal)), { code: "ABORTED_BEFORE_DISPATCH" });
});

test("dispatched write drains once and preserves STATE_UNCERTAIN after cancellation", async () => {
  const controller = new AbortController();
  let calls = 0;
  const { definition } = fixture("claude_science_submit_task", "allowed-once", async () => { calls++; controller.abort(); return payload; });
  await assert.rejects(definition.execute({ prompt: "Research" }, execution(controller.signal)), (error) => {
    assert.equal(error.code, "STATE_UNCERTAIN");
    assert.match(error.message, /intent-1/);
    return true;
  });
  assert.equal(calls, 1);
});

test("upstream uncertain writes are thrown as errors, never retried", async () => {
  let calls = 0;
  const { definition } = fixture("claude_science_submit_task", "allowed-once", async () => { calls++; throw new StateUncertainError("intent-2", "submit task"); });
  await assert.rejects(definition.execute({ prompt: "Research" }, execution()), (error) => {
    assert.equal(error.code, "STATE_UNCERTAIN");
    assert.match(error.message, /intent-2/);
    return true;
  });
  assert.equal(calls, 1);
});

test("unknown failures cannot leak secrets or stacks", async () => {
  const { definition } = fixture("claude_science_status", "allowed-once", async () => { throw new Error("token=SECRET_AUTH_VALUE"); });
  await assert.rejects(definition.execute({}, execution()), (error) => {
    assert.equal(error.code, "OPERATOR_FAILED");
    assert.doesNotMatch(error.message, /SECRET_AUTH_VALUE/);
    return true;
  });
});

test("upstream error details include only reconciliation identifiers", async () => {
  const { definition } = fixture("claude_science_status", "allowed-once", async () => { throw new OperatorError("SCIENCE_CONTROL_FAILED", "Safe failure", { token: "SECRET", stack: "PRIVATE", intent_id: "intent-3" }); });
  await assert.rejects(definition.execute({}, execution()), (error) => {
    assert.match(error.message, /intent-3/);
    assert.doesNotMatch(error.message, /SECRET|PRIVATE/);
    return true;
  });
});

test("approval does not fabricate confirm or configuration fingerprints", async () => {
  let received;
  const { definition } = fixture("csswitch_runtime_action", "allowed-once", async (_name, args) => { received = args; return payload; });
  const args = { action: "start", confirm: false, expected_config_fingerprint: "fresh-fingerprint" };
  await definition.execute(args, execution());
  assert.deepEqual(received, args);
});

test("arguments are detached before awaiting approval", async () => {
  const args = { prompt: "Approved research" };
  let received;
  const { definition } = fixture("claude_science_submit_task", () => { args.prompt = "Changed research"; return "allowed-once"; }, async (_name, value) => { received = value; return payload; });
  await definition.execute(args, execution());
  assert.equal(received.prompt, "Approved research");
});

test("secret input is absent from DSH schema and rejected before approval", async () => {
  const { definition, asks } = fixture("csswitch_profile_action", "allowed-once", () => assert.fail("secret input reached bridge"));
  assert.equal(definition.parameters.properties.key, undefined);
  assert.ok(tool("csswitch_profile_action").inputSchema.properties.key); // Codex unchanged
  await assert.rejects(definition.execute({ key: "SECRET" }, execution()), { code: "SECRET_INPUT_FORBIDDEN" });
  assert.equal(asks.length, 0);
});

test("malformed, extra, out-of-range, and invalid-action args fail before approval", async () => {
  const { definition, asks } = fixture("claude_science_list_projects");
  for (const args of [null, [], { injected: true }, { limit: 0 }, { limit: 101 }, { limit: "5" }]) {
    await assert.rejects(definition.execute(args, execution()), { code: "INVALID_PARAMS" });
  }
  const settings = fixture("claude_science_settings");
  await assert.rejects(settings.definition.execute({ action: "erase", setting: "reviewer_model" }, execution()), { code: "INVALID_PARAMS" });
  assert.equal(asks.length, 0);
  assert.equal(settings.asks.length, 0);
});

test("read/write classification respects every mixed action", () => {
  for (const [name, reads, writes] of [
    ["claude_science_expert_action", [{ action: "get_prompt" }], [{ action: "delete" }, {}]],
    ["claude_science_settings", [{ action: "get" }], [{ action: "set" }, {}]],
    ["claude_science_safari_page", [{ action: "find" }, { action: "snapshot" }], [{ action: "focus" }, { action: "click" }, { action: "fill" }]],
    ["csswitch_check_provider", [{}, { end_to_end: false }], [{ end_to_end: true }, { end_to_end: "false" }]],
  ]) {
    for (const args of reads) assert.equal(isReadOnly(tool(name), args), true);
    for (const args of writes) assert.equal(isReadOnly(tool(name), args), false);
  }
});

test("session configuration classification treats only exact get as read-only", () => {
  const source = { name: "claude_science_session_config", annotations: { readOnlyHint: true } };
  assert.equal(isReadOnly(source, { action: "get" }), true);
  for (const args of [{ action: "set" }, { action: "GET" }, { action: "unknown" }, {}]) {
    assert.equal(isReadOnly(source, args), false);
  }
});

test("schema conversion preserves nullable CSSwitch fields without mutation", () => {
  const original = { type: ["array", "null"], items: { type: "object" } };
  const result = harnessSchema(original);
  assert.deepEqual(result, { oneOf: [{ type: "array", items: { type: "object" } }, { type: "null" }] });
  assert.deepEqual(original.type, ["array", "null"]);
});

test("non-macOS execution fails before approval", async () => {
  const definition = adaptTool({ approval: { request: () => assert.fail("approval on unsupported platform") } }, tool("claude_science_status"), () => assert.fail("non-macOS dispatch"), { platform: "linux" });
  await assert.rejects(definition.execute({}, execution()), { code: "UNSUPPORTED_PLATFORM" });
});

test("bundle queue serializes across Agents and recovers after failures", async () => {
  const schedule = serialExecutor();
  const seen = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = schedule(async () => { seen.push("first-start"); await gate; seen.push("first-end"); throw new Error("failed"); });
  const rejected = assert.rejects(first, /failed/);
  const second = schedule(async () => { seen.push("second"); return 2; });
  await Promise.resolve();
  assert.deepEqual(seen, ["first-start"]);
  release();
  await rejected;
  assert.equal(await second, 2);
  assert.deepEqual(seen, ["first-start", "first-end", "second"]);
});

test("package manifest exposes a Cordis bundle and restricts runtime compatibility", async () => {
  const manifest = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.name, "dsh-claude-science-operator");
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(manifest.peerDependencies["@deepseek-ai/dsh"], "0.2.0-rc.2");
  assert.equal(manifest.scripts.postinstall, undefined);
  assert.equal(manifest.dependencies, undefined);
  const patch = await fs.readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8");
  assert.match(patch, /name: dsh-claude-science-operator/);
  assert.match(patch, /config: \{\}/, "explicit Config prevents legacy simple-patch auto-mount");
});
