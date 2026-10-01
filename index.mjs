import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RuntimeInspector, OperatorError as ScienceError, toolsList as scienceTools, callTool as callScience } from "./plugins/claude-science-operator/scripts/server.mjs";
import { OperatorError as SwitchError, toolsList as switchTools, callTool as callSwitch } from "./plugins/csswitch-operator/scripts/server.mjs";
import { adaptTool, serialExecutor } from "./lib/adapter.mjs";

const serialize = serialExecutor();
function registerTool(ctx, tool, invoke, options) {
  const definition = adaptTool(ctx, tool, invoke, options);
  ctx.tools.register({
    ...definition,
    execute(args, exec) {
      const detached = structuredClone(args);
      return serialize(() => definition.execute(detached, exec));
    },
  });
}

export const name = "dsh-claude-science-operator";
export const inject = ["tools", "skills", "approval", "sandboxPolicy"];

const HARNESS_NOTES = `
## DeepSeek Harness runtime (takes precedence over host-specific wording above)

You are operating in DeepSeek Harness, not Codex. Tools are registered natively
through Harness; no MCP connection or Codex plugin installation is needed.
Use the initiating Session's current Harness permission on every operator call.
Existing danger-full-access permission authorizes local-app access without an
approval prompt, as in Harness's native plugin_manager. Other modes request
single-operation approval; rejected/cancelled/unavailable approval sends no local
request. Never infer permission from approval=never alone or cache a grant.
A tool's confirm=true remains a separate reviewed-mutation guard.
Provider keys must be entered in CSSwitch's native UI. Never send secrets in
Tool arguments: Harness persists arguments in its Session log.
Call the relevant status tool first. Never automatically retry STATE_UNCERTAIN,
including writes that finish after cancellation; inspect the affected object.
Safari automation targets Safari only, not Harness's embedded browser. Do not
assume browser or Computer Use tools exist: discover currently available tools.
For native dialogs, login, upload/download/export, and approvals, use an available
Computer Use provider or ask the user to perform the action. If Safari JavaScript
or macOS Automation permission is disabled, ask the user; do not change security
settings or grant permissions automatically. Never automatically stop Science.
`;

async function loadSkill(relativeDirectory, skillName, description) {
  const directory = new URL(relativeDirectory, import.meta.url);
  const skillFile = new URL("SKILL.md", directory);
  const markdown = await fs.readFile(skillFile, "utf8");
  return {
    name: skillName,
    description,
    source: "runtime",
    provider: name,
    path: fileURLToPath(skillFile),
    resourceBase: { kind: "directory", path: fileURLToPath(directory) },
    invocation: { modelInvocable: true, userInvocable: true },
    content: markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "") + HARNESS_NOTES,
  };
}

// Only trusted package resources are read at mount. Runtime inspection, config
// reads, subprocesses, and network requests start inside approved tool calls.
export async function apply(ctx) {
  const skills = await Promise.all([
    loadSkill("./plugins/claude-science-operator/skills/claude-science-operator/", "claude-science-operator", "通过版本受控的本机 API、精确 Safari 页面定位和可用的 Computer Use 操作 Claude Science。"),
    loadSkill("./plugins/csswitch-operator/skills/csswitch-operator/", "csswitch-operator", "通过已认证的本机桥接操作 CSSwitch 配置、模型目录和 Claude Science 运行时。"),
  ]);
  // RuntimeInspector construction has no I/O. Each invocation re-inspects state.
  const inspector = new RuntimeInspector();
  for (const tool of scienceTools()) {
    registerTool(ctx, tool, (toolName, args) => callScience(inspector, toolName, args), {
      isOperatorError: (error) => error instanceof ScienceError,
    });
  }
  for (const tool of switchTools()) {
    registerTool(ctx, tool, callSwitch, {
      isOperatorError: (error) => error instanceof SwitchError,
    });
  }
  for (const skill of skills) ctx.skills.register(skill);
}
