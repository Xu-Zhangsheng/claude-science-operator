import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const SERVER_NAME = "CSSwitch Operator";
const SERVER_VERSION = "0.2.0";
const NATIVE_CONTROL_PATH = path.join(os.homedir(), ".csswitch", "control.json");
const EXTERNAL_CONTROL_PATH = path.join(os.homedir(), ".csswitch", "external-control.json");
const MAX_RECORD = 64 * 1024;
const MAX_RESPONSE = 2 * 1024 * 1024;
const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 65_000;

export class OperatorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "OperatorError";
    this.code = code;
    this.details = details;
  }
}

export class StateUncertainError extends OperatorError {
  constructor(intentId, operation) {
    super(
      "STATE_UNCERTAIN",
      `CSSwitch may have applied ${operation}; inspect current state before any retry.`,
      {intent_id: intentId, operation},
    );
    this.name = "StateUncertainError";
  }
}

function requiredString(value, name, max = 4_000) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new OperatorError("INVALID_PARAMS", `${name} must be a non-empty string.`);
  }
  const result = value.trim();
  if (result.length > max) throw new OperatorError("INVALID_PARAMS", `${name} is too long.`);
  return result;
}

function optionalString(value, name, max = 20_000) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new OperatorError("INVALID_PARAMS", `${name} must be a string.`);
  if (value.length > max) throw new OperatorError("INVALID_PARAMS", `${name} is too long.`);
  return value;
}

function optionalBoolean(value, name, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new OperatorError("INVALID_PARAMS", `${name} must be a boolean.`);
  return value;
}

function optionalPort(value, name) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new OperatorError("INVALID_PARAMS", `${name} must be a valid TCP port.`);
  }
  return value;
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (["api_key", "key", "secret", "token", "credential_ref", "oauth_token"].includes(key)) continue;
    result[key] = redact(nested);
  }
  return result;
}

async function assertSecureFile(filePath) {
  const parent = path.dirname(filePath);
  const parentStat = await fs.lstat(parent).catch(() => null);
  if (
    !parentStat?.isDirectory() ||
    parentStat.isSymbolicLink() ||
    (typeof parentStat.uid === "number" &&
      typeof process.getuid === "function" &&
      parentStat.uid !== process.getuid()) ||
    (parentStat.mode & 0o077) !== 0
  ) {
    throw new OperatorError("CSSWITCH_CONTROL_UNSAFE", "CSSwitch control directory is unsafe.");
  }
  const stat = await fs.lstat(filePath).catch(() => {
    throw new OperatorError(
      "CSSWITCH_CONTROL_UNAVAILABLE",
      "CSSwitch control bridge is not available. Start the external bridge or use the CSSwitch UI.",
    );
  });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new OperatorError("CSSWITCH_CONTROL_UNSAFE", "CSSwitch control record is not a regular file.");
  }
  if (typeof stat.uid === "number" && typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new OperatorError("CSSWITCH_CONTROL_UNSAFE", "CSSwitch control record has the wrong owner.");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new OperatorError("CSSWITCH_CONTROL_UNSAFE", "CSSwitch control record permissions are too broad.");
  }
  if (stat.size < 2 || stat.size > MAX_RECORD) {
    throw new OperatorError("CSSWITCH_CONTROL_UNSAFE", "CSSwitch control record has an invalid size.");
  }
  const realParent = await fs.realpath(parent).catch(() => "");
  const real = await fs.realpath(filePath).catch(() => "");
  if (!realParent || real !== path.join(realParent, path.basename(filePath))) {
    throw new OperatorError("CSSWITCH_CONTROL_UNSAFE", "CSSwitch control record path contains a symbolic link.");
  }
}

async function preferredControlPath() {
  const external = await fs.lstat(EXTERNAL_CONTROL_PATH).catch(() => null);
  return external ? EXTERNAL_CONTROL_PATH : NATIVE_CONTROL_PATH;
}

export async function readControlRecord(filePath = undefined) {
  const selectedPath = filePath ?? await preferredControlPath();
  await assertSecureFile(selectedPath);
  let record;
  try {
    record = JSON.parse(await fs.readFile(selectedPath, "utf8"));
  } catch {
    throw new OperatorError("CSSWITCH_CONTROL_INVALID", "CSSwitch control record is invalid.");
  }
  if (
    !(
      (record?.schema_version === 2 && record?.protocol_version === "2.0.0") ||
      (record?.schema_version === 1 && record?.protocol_version === "csswitch-control/1")
    ) ||
    !Number.isInteger(record?.port) ||
    record.port < 1 ||
    record.port > 65_535 ||
    !Number.isInteger(record?.pid) ||
    record.pid < 1 ||
    typeof record?.token !== "string" ||
    record.token.length < 16 ||
    record.token.length > 512
  ) {
    throw new OperatorError("CSSWITCH_CONTROL_INCOMPATIBLE", "CSSwitch control bridge version is incompatible.");
  }
  try {
    process.kill(record.pid, 0);
  } catch {
    throw new OperatorError("CSSWITCH_CONTROL_STALE", "CSSwitch control record belongs to a stopped process.");
  }
  return record;
}

function readResponseLimited(response, limit = MAX_RESPONSE) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    response.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        response.destroy();
        reject(new OperatorError("CSSWITCH_RESPONSE_LIMIT", "CSSwitch control response was too large."));
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    response.on("error", reject);
  });
}

function parseResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new OperatorError("CSSWITCH_RESPONSE_INVALID", "CSSwitch control response was not valid JSON.");
  }
}

export class BridgeClient {
  constructor({recordPath = undefined, httpRequest = http.request} = {}) {
    this.recordPath = recordPath;
    this.httpRequest = httpRequest;
  }

  async request(method, route, {body, write = false, intentId, operation = route} = {}) {
    if (!["GET", "POST"].includes(method) || !/^\/v1\/[a-z-]+$/.test(route)) {
      throw new OperatorError("INVALID_PARAMS", "Invalid CSSwitch control route.");
    }
    const attempts = write ? 1 : 2;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const record = await readControlRecord(this.recordPath);
        return await this.requestOnce(record, method, route, body, write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS);
      } catch (error) {
        lastError = error;
        if (write) {
          if (error instanceof OperatorError && error.code.startsWith("CSSWITCH_CONTROL_")) throw error;
          throw new StateUncertainError(intentId, operation);
        }
      }
    }
    if (lastError instanceof OperatorError) throw lastError;
    throw new OperatorError("CSSWITCH_CONTROL_UNAVAILABLE", "CSSwitch control request failed.");
  }

  requestOnce(record, method, route, body, timeoutMs) {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = this.httpRequest({
        hostname: "127.0.0.1",
        port: record.port,
        method,
        path: route,
        headers: {
          Accept: "application/json",
          "X-CSSwitch-Control": record.token,
          ...(encoded ? {"Content-Type": "application/json", "Content-Length": encoded.length} : {}),
        },
        agent: false,
      }, async (response) => {
        try {
          const payload = parseResponse(await readResponseLimited(response));
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            throw new OperatorError(
              payload?.error?.code ?? "CSSWITCH_CONTROL_FAILED",
              payload?.error?.message ?? `CSSwitch control returned HTTP ${response.statusCode}.`,
              {status: response.statusCode},
            );
          }
          resolve(redact(payload));
        } catch (error) {
          reject(error);
        }
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error("timeout")));
      request.on("error", reject);
      if (encoded) request.write(encoded);
      request.end();
    });
  }
}

function toolResult(message, data) {
  return {content: [{type: "text", text: JSON.stringify({message, ...redact(data)})}]};
}

function mutationEnvelope(args, operation) {
  const confirm = optionalBoolean(args.confirm, "confirm", false);
  if (!confirm) {
    throw new OperatorError("CONFIRMATION_REQUIRED", `${operation} requires confirm=true after reviewing the current state.`);
  }
  return {
    ...args,
    confirm: true,
    expected_config_fingerprint: requiredString(
      args.expected_config_fingerprint,
      "expected_config_fingerprint",
      256,
    ),
    intent_id: crypto.randomUUID(),
  };
}

function toolsList() {
  const readOnly = {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false};
  return [
    {
      name: "csswitch_status",
      title: "CSSwitch Status",
      description: "Read native CSSwitch runtime status. Call this before other CSSwitch tools.",
      inputSchema: {type: "object", properties: {}, additionalProperties: false},
      annotations: readOnly,
    },
    {
      name: "csswitch_capabilities",
      title: "CSSwitch Native Capabilities",
      description: "List the operations supported by the installed native CSSwitch bridge.",
      inputSchema: {type: "object", properties: {}, additionalProperties: false},
      annotations: readOnly,
    },
    {
      name: "csswitch_get_config",
      title: "CSSwitch Configuration",
      description: "Read the sanitized CSSwitch configuration and a fingerprint required for writes.",
      inputSchema: {type: "object", properties: {}, additionalProperties: false},
      annotations: readOnly,
    },
    {
      name: "csswitch_list_templates",
      title: "CSSwitch Profile Templates",
      description: "List available CSSwitch profile templates.",
      inputSchema: {type: "object", properties: {}, additionalProperties: false},
      annotations: readOnly,
    },
    {
      name: "csswitch_check_provider",
      title: "Check CSSwitch Provider",
      description: "Inspect the local provider chain. End-to-end mode sends one bounded provider request and requires confirmation.",
      inputSchema: {
        type: "object",
        properties: {
          end_to_end: {type: "boolean", default: false},
          confirm: {type: "boolean", default: false}
        },
        additionalProperties: false
      },
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
    },
    {
      name: "csswitch_runtime_action",
      title: "Manage CSSwitch Runtime",
      description: "Start/stop the managed runtime, switch mode, or update runtime ports and SSH reuse. Requires a fresh config fingerprint and confirmation.",
      inputSchema: {
        type: "object",
        properties: {
          action: {type: "string", enum: ["start", "stop", "set_mode", "set_settings"]},
          expected_config_fingerprint: {type: "string"},
          confirm: {type: "boolean"},
          runtime_choice: {type: "string"},
          mode: {type: "string", enum: ["proxy", "official"]},
          proxy_port: {type: "integer", minimum: 1, maximum: 65535},
          sandbox_port: {type: "integer", minimum: 1, maximum: 65535},
          reuse_system_ssh: {type: "boolean"}
        },
        required: ["action", "expected_config_fingerprint", "confirm"],
        additionalProperties: false
      },
      annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true},
    },
    {
      name: "csswitch_profile_action",
      title: "Manage CSSwitch Profile",
      description: "Create, edit, activate, clear a key, or delete a CSSwitch profile. Connection edits include model catalogs. Requires a fresh config fingerprint and confirmation.",
      inputSchema: {
        type: "object",
        properties: {
          action: {type: "string", enum: ["create", "update_metadata", "update_connection", "clear_key", "delete", "activate"]},
          expected_config_fingerprint: {type: "string"},
          confirm: {type: "boolean"},
          id: {type: "string"},
          template_id: {type: "string"},
          name: {type: "string"},
          notes: {type: ["string", "null"]},
          key: {type: ["string", "null"]},
          base_url: {type: ["string", "null"]},
          api_format: {type: ["string", "null"]},
          model: {type: ["string", "null"]},
          model_catalog: {type: ["array", "null"], items: {type: "object"}},
          default_model_route_id: {type: ["string", "null"]},
          role_bindings: {type: ["object", "null"]},
          skip_verify: {type: "boolean", default: false}
        },
        required: ["action", "expected_config_fingerprint", "confirm"],
        additionalProperties: false
      },
      annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true},
    }
  ];
}

export async function callTool(name, args = {}, client = new BridgeClient()) {
  if (name === "csswitch_status") {
    return toolResult("Read CSSwitch native runtime status.", {csswitch: await client.request("GET", "/v1/status")});
  }
  if (name === "csswitch_capabilities") {
    return toolResult("Read CSSwitch native capabilities.", {csswitch: await client.request("GET", "/v1/capabilities")});
  }
  if (name === "csswitch_get_config") {
    return toolResult("Read sanitized CSSwitch configuration.", {csswitch: await client.request("GET", "/v1/config")});
  }
  if (name === "csswitch_list_templates") {
    return toolResult("Read CSSwitch profile templates.", {csswitch: await client.request("GET", "/v1/templates")});
  }
  if (name === "csswitch_check_provider") {
    const endToEnd = optionalBoolean(args.end_to_end, "end_to_end", false);
    const confirm = optionalBoolean(args.confirm, "confirm", false);
    if (endToEnd && !confirm) {
      throw new OperatorError("CONFIRMATION_REQUIRED", "End-to-end provider checks require confirm=true.");
    }
    return toolResult("Completed CSSwitch provider check.", {
      csswitch: await client.request("POST", "/v1/check", {body: {end_to_end: endToEnd, confirm}}),
    });
  }
  if (name === "csswitch_runtime_action") {
    const action = requiredString(args.action, "action", 32);
    const body = mutationEnvelope({
      action,
      expected_config_fingerprint: args.expected_config_fingerprint,
      confirm: args.confirm,
      runtime_choice: optionalString(args.runtime_choice, "runtime_choice", 128),
      mode: optionalString(args.mode, "mode", 32),
      proxy_port: optionalPort(args.proxy_port, "proxy_port"),
      sandbox_port: optionalPort(args.sandbox_port, "sandbox_port"),
      reuse_system_ssh: optionalBoolean(args.reuse_system_ssh, "reuse_system_ssh", false),
    }, `CSSwitch runtime action ${action}`);
    const route = {start: "/v1/start", stop: "/v1/stop", set_mode: "/v1/mode", set_settings: "/v1/settings"}[action];
    if (!route) throw new OperatorError("INVALID_PARAMS", `Unsupported runtime action: ${action}.`);
    return toolResult(`Completed CSSwitch runtime action ${action}.`, {
      csswitch: await client.request("POST", route, {
        body,
        write: true,
        intentId: body.intent_id,
        operation: action,
      }),
    });
  }
  if (name === "csswitch_profile_action") {
    const action = requiredString(args.action, "action", 32);
    if (!["create", "update_metadata", "update_connection", "clear_key", "delete", "activate"].includes(action)) {
      throw new OperatorError("INVALID_PARAMS", `Unsupported profile action: ${action}.`);
    }
    const body = mutationEnvelope({
      ...args,
      action,
      expected_config_fingerprint: args.expected_config_fingerprint,
      confirm: args.confirm,
    }, `CSSwitch profile action ${action}`);
    return toolResult(`Completed CSSwitch profile action ${action}.`, {
      csswitch: await client.request("POST", "/v1/profile", {
        body,
        write: true,
        intentId: body.intent_id,
        operation: `profile:${action}`,
      }),
    });
  }
  throw new OperatorError("INVALID_PARAMS", `Unknown CSSwitch tool: ${name || ""}`);
}

function errorPayload(error) {
  if (error instanceof OperatorError) return {code: error.code, message: error.message, ...redact(error.details)};
  return {code: "CSSWITCH_OPERATOR_FAILED", message: String(error?.message ?? error)};
}

async function handle(message) {
  const id = message?.id;
  if (message?.method === "notifications/initialized" || message?.method === "notifications/cancelled") return null;
  if (message?.method === "initialize") {
    return {jsonrpc: "2.0", id, result: {
      protocolVersion: "2024-11-05",
      capabilities: {tools: {listChanged: false}},
      serverInfo: {name: SERVER_NAME, version: SERVER_VERSION},
      instructions: "Call csswitch_status first. Native writes require a fresh config fingerprint, explicit confirmation, and are never retried after uncertain state.",
    }};
  }
  if (message?.method === "ping") return {jsonrpc: "2.0", id, result: {}};
  if (message?.method === "tools/list") return {jsonrpc: "2.0", id, result: {tools: toolsList()}};
  if (message?.method === "tools/call") {
    try {
      return {jsonrpc: "2.0", id, result: await callTool(message.params?.name, message.params?.arguments ?? {})};
    } catch (error) {
      return {jsonrpc: "2.0", id, result: {
        isError: true,
        content: [{type: "text", text: JSON.stringify(errorPayload(error))}],
      }};
    }
  }
  if (id === undefined) return null;
  return {jsonrpc: "2.0", id, error: {code: -32601, message: `Method not found: ${message?.method}`}};
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
  for await (const line of input) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({jsonrpc: "2.0", id: null, error: {code: -32700, message: "Invalid JSON"}})}\n`);
      continue;
    }
    const response = await handle(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}
