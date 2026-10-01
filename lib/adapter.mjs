// Native ToolDefinition adapter. No stdio process, MCP dependency, or retries.
import manifest from "../package.json" with { type: "json" };
export class HarnessOperatorError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ""}`);
    this.name = "HarnessOperatorError";
    this.code = code;
  }
}

// Mixed-action tools must be classified by the exact action, not MCP hints alone.
export function isReadOnly(tool, args) {
  if (tool.name === "claude_science_expert_action") return args.action === "get_prompt";
  if (["claude_science_settings", "claude_science_session_config"].includes(tool.name)) return args.action === "get";
  if (tool.name === "claude_science_safari_page") return ["find", "snapshot"].includes(args.action);
  if (tool.name === "csswitch_check_provider") return args.end_to_end === undefined || args.end_to_end === false;
  return tool.annotations?.readOnlyHint === true;
}

// DSH's schema vocabulary uses oneOf rather than arrays in `type`.
export function harnessSchema(schema) {
  if (Array.isArray(schema)) return schema.map(harnessSchema);
  if (!schema || typeof schema !== "object") return schema;
  const converted = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, harnessSchema(value)]));
  // Harness intentionally excludes numeric bound keywords. Preserve their
  // model guidance as an annotation; validate original bounds before dispatch.
  if (converted.minimum !== undefined || converted.maximum !== undefined) {
    converted.description = `${converted.description ?? ""} Allowed range: ${converted.minimum ?? "unbounded"} to ${converted.maximum ?? "unbounded"}.`.trim();
    delete converted.minimum;
    delete converted.maximum;
  }
  if (Array.isArray(converted.type)) {
    const { type, ...rest } = converted;
    return { oneOf: type.map((item) => {
      const branch = { ...rest, type: item };
      if (item !== "array") delete branch.items;
      if (item !== "object") {
        delete branch.properties;
        delete branch.required;
        delete branch.additionalProperties;
      }
      return branch;
    }) };
  }
  return converted;
}

function validate(schema, value, location = "arguments") {
  const fail = () => { throw new HarnessOperatorError("INVALID_PARAMS", `${location} does not match the tool schema.`); };
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  const matches = (type) => {
    if (type === "null") return value === null;
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (type === "integer") return Number.isInteger(value);
    if (type === "number") return typeof value === "number" && Number.isFinite(value);
    return typeof value === type;
  };
  if (types.length && !types.some(matches)) fail();
  if (schema.enum && !schema.enum.includes(value)) fail();
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) fail();
    if (schema.maximum !== undefined && value > schema.maximum) fail();
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validate(schema.items, item, `${location}[${index}]`));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail();
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) validate(schema.properties[key], item, `${location}.${key}`);
      else if (schema.additionalProperties === false) fail();
    }
  }
}

// One bundle-wide queue protects Safari/runtime state across initiating Agents.
export function serialExecutor() {
  let tail = Promise.resolve();
  return (operation) => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
}

function sanitizedFailure(error, isOperatorError) {
  if (!isOperatorError(error)) {
    return new HarnessOperatorError("OPERATOR_FAILED", "Local operator failed; inspect runtime status. Internal errors and credentials are withheld.");
  }
  // Never serialize arbitrary exception properties, stack traces, or local auth.
  const details = {};
  for (const key of ["intent_id", "operation"]) {
    if (typeof error.details?.[key] === "string") details[key] = error.details[key];
  }
  return new HarnessOperatorError(error.code, error.message, details);
}

export function adaptTool(ctx, tool, invoke, { isOperatorError, platform = process.platform } = {}) {
  const parameters = harnessSchema(tool.inputSchema);
  // Harness records tool arguments in the Session log. Keys must be entered in
  // CSSwitch's native UI, not passed through a model-facing Tool.
  if (tool.name === "csswitch_profile_action") delete parameters.properties.key;
  return {
    name: tool.name,
    description: `${tool.description} Requires existing danger-full-access permission or audited one-call approval in DeepSeek Harness. Native adapter ${manifest.version}.`,
    parameters,
    timeoutMs: 300_000, // includes approval and upstream bounded HTTP/poll time
    isConcurrencySafe: () => false, // credentials, GUI state, and writes stay serialized
    output: {
      schema: { type: "object" },
      render(_args, value) {
        const content = [...(value.content ?? [])];
        if (value.structuredContent !== undefined) {
          content.push({ type: "text", text: JSON.stringify(value.structuredContent) });
        }
        return content;
      },
    },
    presentCall() {
      return { card: "generic", title: tool.title ?? tool.name, kind: "execute" };
    },
    async execute(input, exec) {
      if (platform !== "darwin") throw new HarnessOperatorError("UNSUPPORTED_PLATFORM", "These operators require macOS.");
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new HarnessOperatorError("INVALID_PARAMS", "Tool arguments must be an object.");
      }
      // Detach caller-owned arguments before waiting for approval.
      const args = structuredClone(input);
      if (tool.name === "csswitch_profile_action" && Object.hasOwn(args, "key")) {
        throw new HarnessOperatorError("SECRET_INPUT_FORBIDDEN", "Enter provider keys in the CSSwitch UI, never in Harness tool arguments.");
      }
      validate(tool.inputSchema, args);
      if (!exec.agent) throw new HarnessOperatorError("AGENT_REQUIRED", "Local-app access requires an initiating Harness Agent.");
      if (exec.signal.aborted) throw new HarnessOperatorError("ABORTED_BEFORE_DISPATCH", "No local-app request was sent.");
      const readOnly = isReadOnly(tool, args);
      const action = typeof args.action === "string" ? ` (${args.action})` : "";
      // Match Harness's native plugin_manager permission boundary: an existing
      // full-access grant needs no escalation. Resolve the initiating Session on
      // EVERY call; never infer permission from approval=never or model args.
      const policy = ctx.sandboxPolicy?.resolve({ session: exec.agent.session });
      if (policy?.mode !== "danger-full-access") {
        const outcome = await ctx.approval.request({
          agent: exec.agent,
          toolName: tool.name,
          callId: exec.callId,
          signal: exec.signal,
          reason: `${readOnly ? "Read" : "Operate"} local Claude Science/CSSwitch via ${tool.name}${action}. This accesses local applications outside the workspace sandbox.${readOnly ? "" : " It may change application state or dispatch external compute. The operation is sent once and uncertain writes must not be retried."}`,
          displayReason: {
            en: `Allow this one ${tool.name}${action} local-app operation?`,
            "zh-CN": `允许本次 ${tool.name}${action} 操作本机应用吗？${readOnly ? "" : "可能修改应用状态或触发外部计算。"}`,
          },
        });
        if (outcome !== "allowed-once") {
          throw new HarnessOperatorError("APPROVAL_DENIED", `Local-app access was not granted (${outcome}); no request was sent.`);
        }
      }
      if (exec.signal.aborted) throw new HarnessOperatorError("ABORTED_BEFORE_DISPATCH", "No local-app request was sent.");
      // Do not inject confirm=true: approval and the upstream reviewed-mutation
      // confirmation/fingerprint guards are independent and both must hold.
      let result;
      try {
        result = await invoke(tool.name, args);
      } catch (error) {
        throw sanitizedFailure(error, isOperatorError ?? (() => false));
      }
      if (result?.isError) {
        throw new HarnessOperatorError("OPERATOR_RESULT_ERROR", "The local operator returned an error; inspect state before retrying.");
      }
      // Drain dispatched work instead of racing abort/timeout against it. If the
      // caller cancelled, do not let DSH turn a write into an opaque ABORTED result.
      if (exec.signal.aborted && !readOnly) {
        throw new HarnessOperatorError("STATE_UNCERTAIN", "The local operation finished after cancellation; inspect affected objects before any duplicate operation.", {
          ...(result?.structuredContent?.intent_id ? { intent_id: result.structuredContent.intent_id } : {}),
          operation: tool.name,
        });
      }
      // Direct reuse bypasses MCP's stdio JSON serialization. Re-establish that
      // wire boundary BEFORE returning the canonical value to Harness: status
      // deliberately contains absent optional fields with value `undefined`.
      // JSON encoding omits them exactly as the original MCP server does.
      // Do not alter the upstream operator or manufacture missing values.
      try {
        const value = JSON.parse(JSON.stringify(result));
        if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.content)) {
          throw new Error("Expected an MCP result object with content blocks");
        }
        return value;
      } catch {
        throw new HarnessOperatorError(readOnly ? "INVALID_OPERATOR_OUTPUT" : "STATE_UNCERTAIN",
          readOnly
            ? "The operator response could not be encoded as MCP JSON. Internal serialization details are withheld."
            : "The operation was dispatched once but its response could not be encoded as MCP JSON; inspect affected objects before any duplicate operation.",
          { operation: tool.name, ...(typeof result?.structuredContent?.intent_id === "string" ? { intent_id: result.structuredContent.intent_id } : {}) });
      }
    },
  };
}
