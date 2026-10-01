import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";
import * as plugin from "../index.mjs";
import { adaptTool } from "../lib/adapter.mjs";
import { toolsList } from "../plugins/claude-science-operator/scripts/server.mjs";
import { toolsList as switchTools } from "../plugins/csswitch-operator/scripts/server.mjs";

// Optional integration with the exact installed Harness. On macOS desktop use
// ELECTRON_RUN_AS_NODE=1 so Electron's fs can load its packaged app.asar SDK.
const root = process.env.DSH_TEST_RUNTIME_ROOT;
const options = { skip: !root };

test("real Harness accepts all native parameter and output schemas", options, async () => {
  const require = createRequire(`${root}/package.json`);
  const { assertSupportedJsonSchema } = require("@deepseek-ai/dsh-tools");
  const definitions = [];
  await plugin.apply({ tools: { register: (value) => definitions.push(value) }, skills: { register() {} }, approval: {} });
  for (const definition of definitions) {
    assert.doesNotThrow(() => assertSupportedJsonSchema(definition.parameters), definition.name);
    assert.doesNotThrow(() => assertSupportedJsonSchema(definition.output.schema), definition.name);
  }
});

test("real Cordis/Harness mounts, executes, renders, reports errors, and disposes", options, async () => {
  const require = createRequire(`${root}/package.json`);
  const { Context, Service } = require("@deepseek-ai/cordis");
  const { default: SystemPrompt } = require("@deepseek-ai/dsh-system-prompt");
  const { default: Tools } = require("@deepseek-ai/dsh-tools");
  const { default: Skills } = require("@deepseek-ai/dsh-skill");
  const { default: SandboxPolicy } = require("@deepseek-ai/dsh-sandbox-policy");
  const { default: SessionProjections } = require("@deepseek-ai/dsh-session-projection");
  class Approval extends Service {
    constructor(ctx) { super(ctx, "approval"); }
    async request() { return "rejected"; }
  }
  const ctx = new Context();
  const services = [ctx.plugin(SystemPrompt), ctx.plugin(Tools), ctx.plugin(Skills), ctx.plugin(Approval), ctx.plugin(SessionProjections), ctx.plugin(SandboxPolicy, { mode: "workspace-write" })];
  await Promise.all(services);
  const fiber = ctx.plugin(plugin, {});
  await fiber;
  try {
    const tools = ctx.get("tools");
    const skills = ctx.get("skills");
    assert.ok(tools, "Tools service mounted");
    assert.ok(skills, "Skills service mounted");
    assert.deepEqual(
      tools.schemas().filter((value) => /^(claude_science_|csswitch_)/.test(value.name)).map((value) => value.name).sort(),
      [...toolsList(), ...switchTools()].map((value) => value.name).sort(),
    );
    assert.equal((await skills.list()).filter((value) => value.provider === plugin.name).length, 2);
    const denied = await tools.execute({ name: "claude_science_status", arguments: {}, callId: "integration-denied", agent: { id: "integration-agent" }, signal: new AbortController().signal });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied.content), /APPROVAL_DENIED/);
    // A separate fixture Tool uses the actual registry pipeline but no apps or
    // credentials: exercise output validation/projection, not just our mocks.
    const source = toolsList().find((value) => value.name === "claude_science_status");
    const fixture = adaptTool({ approval: { request: async () => "allowed-once" } }, { ...source, name: "operator_fixture" }, async () => ({ content: [{ type: "text", text: "Fixture" }], structuredContent: { project_id: "project-1", frame_id: "frame-1", diagnostics: { configError: undefined }, absent: undefined, timestamp: new Date("2026-09-30T12:00:00Z") } }), { platform: "darwin" });
    const unregister = tools.register(fixture);
    const result = await tools.execute({ name: "operator_fixture", arguments: {}, callId: "integration-success", agent: { id: "integration-agent" }, signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(JSON.stringify(result.content), /project-1/);
    assert.match(JSON.stringify(result.content), /frame-1/);
    assert.match(JSON.stringify(result.content), /diagnostics/);
    assert.match(JSON.stringify(result.content), /2026-09-30T12:00:00.000Z/);
    unregister();
    await fiber.dispose();
    assert.equal(tools.schemas().filter((value) => /^(claude_science_|csswitch_)/.test(value.name)).length, 0);
    assert.equal((await skills.list()).filter((value) => value.provider === plugin.name).length, 0);
  } finally {
    await fiber.dispose();
    for (const service of services.reverse()) await service.dispose();
  }
});

test("real zh_pro simple-patch parser declines the managed entry to avoid double registration", { skip: !process.env.DSH_TEST_ZH_HOT_MOUNT }, async () => {
  const source = await fs.readFile(process.env.DSH_TEST_ZH_HOT_MOUNT, "utf8");
  const start = source.indexOf("function parseSimplePatch(patchText) {");
  const end = source.indexOf("/**", start);
  assert.ok(start >= 0 && end > start, "known zh_pro 0.9.5 parser is available");
  // Isolate just the pure parser: no third-party module initialization, file
  // watchers, profile mutations, or hot-mount side effects are run by this test.
  const parser = source.slice(start, end);
  const script = new vm.Script(`${parser}\nparseSimplePatch(patchText)`);
  const oldPatch = "- insert:\n    - id: dsh-claude-science-operator\n      name: dsh-claude-science-operator\n";
  assert.equal(script.runInNewContext({ patchText: oldPatch }, { timeout: 1000 }).length, 1);
  const patchText = await fs.readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8");
  assert.equal(script.runInNewContext({ patchText }, { timeout: 1000 }), null);
});
