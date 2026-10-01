import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SUPPORTED_SCIENCE_VERSIONS = Object.freeze(["0.1.20", "0.1.25", "0.1.43", "0.1.52"]);
export const SUPPORTED_SCIENCE_VERSION = SUPPORTED_SCIENCE_VERSIONS.at(-1);
export const SUPPORTED_CSSWITCH_SCHEMA = 4;

const SERVER_NAME = "Claude Science Operator";
const SERVER_VERSION = "0.2.0";
const APP_PATH = "/Applications/Claude Science.app";
const CSSWITCH_APP_PATH = "/Applications/CSSwitch.app";
const BINARY_PATH = `${APP_PATH}/Contents/Resources/bin/claude-science`;
const CSSWITCH_CONFIG_PATH = path.join(os.homedir(), ".csswitch", "config.json");
const SCIENCE_HOME = path.join(os.homedir(), ".csswitch", "sandbox", "home");
const SCIENCE_DATA_DIR = path.join(SCIENCE_HOME, ".claude-science");
const PROCESS_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const CONFIG_LIMIT = 1024 * 1024;
const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 45_000;
const SUCCESS_STATES = new Set(["completed", "succeeded", "done"]);
const TERMINAL_STATES = new Set([...SUCCESS_STATES, "failed", "cancelled", "canceled"]);
const ATTENTION_STATES = new Set(["awaiting_plan_approval", "awaiting_user_response"]);

const JsonRpcError = {
  METHOD_NOT_FOUND: -32601,
  INTERNAL_ERROR: -32603,
};

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
      `The ${operation} request was dispatched but its result is uncertain. Do not retry or resend through the GUI; inspect the project/session first.`,
      { intent_id: intentId, operation },
    );
    this.name = "StateUncertainError";
  }
}

function cleanError(error) {
  if (error instanceof OperatorError) {
    return { code: error.code, message: error.message, ...error.details };
  }
  return {
    code: "CLAUDE_SCIENCE_FAILED",
    message: "Claude Science operation failed without exposing local credentials.",
  };
}

function requireString(value, name, max = 200_000) {
  if (typeof value !== "string" || !value.trim()) {
    throw new OperatorError("INVALID_PARAMS", `${name} must be a non-empty string.`);
  }
  const result = value.trim();
  if (result.length > max) throw new OperatorError("INVALID_PARAMS", `${name} is too long.`);
  return result;
}

function optionalString(value, name, max = 500) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new OperatorError("INVALID_PARAMS", `${name} must be a string.`);
  const result = value.trim();
  if (result.length > max) throw new OperatorError("INVALID_PARAMS", `${name} is too long.`);
  return result || undefined;
}

function boundedInteger(value, name, min, max, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new OperatorError("INVALID_PARAMS", `${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function optionalBoolean(value, name, defaultValue = undefined) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "boolean") throw new OperatorError("INVALID_PARAMS", `${name} must be boolean.`);
  return value;
}

function requireObject(value, name, maxBytes = 256 * 1024) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OperatorError("INVALID_PARAMS", `${name} must be an object.`);
  }
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new OperatorError("INVALID_PARAMS", `${name} must be JSON-serializable.`);
  }
  if (Buffer.byteLength(encoded) > maxBytes) {
    throw new OperatorError("INVALID_PARAMS", `${name} is too large.`);
  }
  return JSON.parse(encoded);
}

function safeId(value, name) {
  const result = requireString(value, name, 256);
  if (!/^[A-Za-z0-9._:-]+$/.test(result)) {
    throw new OperatorError("INVALID_PARAMS", `${name} contains unsupported characters.`);
  }
  return result;
}

function safeAgentName(value, name = "name") {
  const result = requireString(value, name, 200);
  if (/[/,\0\r\n]/.test(result)) {
    throw new OperatorError("INVALID_PARAMS", `${name} contains unsupported characters.`);
  }
  return result;
}

function validPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

export function publicConfig(config) {
  const profiles = Array.isArray(config?.profiles) ? config.profiles : [];
  const activeId = typeof config?.active_id === "string" ? config.active_id : undefined;
  const active = profiles.find((profile) => profile?.id === activeId);
  const profile = active && typeof active === "object"
    ? {
        id: typeof active.id === "string" ? active.id : undefined,
        name: typeof active.name === "string" ? active.name : undefined,
        category: typeof active.category === "string" ? active.category : undefined,
        api_format: typeof active.api_format === "string" ? active.api_format : undefined,
        template_id: typeof active.template_id === "string" ? active.template_id : undefined,
        default_model_route_id:
          typeof active.default_model_route_id === "string" ? active.default_model_route_id : undefined,
      }
    : undefined;
  return {
    schema_version: Number.isInteger(config?.schema_version) ? config.schema_version : undefined,
    mode: typeof config?.mode === "string" ? config.mode : undefined,
    proxy_port: validPort(config?.proxy_port) ? config.proxy_port : undefined,
    sandbox_port: validPort(config?.sandbox_port) ? config.sandbox_port : undefined,
    experimental_codex_enabled:
      typeof config?.experimental_codex_enabled === "boolean" ? config.experimental_codex_enabled : undefined,
    active_profile: profile,
  };
}

export function isApiCompatible({ scienceVersion, schemaVersion, binaryVerified, running, healthy, portMatches }) {
  return (
    SUPPORTED_SCIENCE_VERSIONS.includes(scienceVersion) &&
    schemaVersion === SUPPORTED_CSSWITCH_SCHEMA &&
    binaryVerified === true &&
    running === true &&
    healthy === true &&
    portMatches === true
  );
}

export function isScienceHealthyPayload(payload) {
  return payload?.healthy === true || payload?.status === "healthy" || payload?.ok === true;
}

export function validateControlUrl(raw, expectedPort) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new OperatorError("SCIENCE_CONTROL_FAILED", "Claude Science returned an invalid control URL.");
  }
  const allowedHost = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (
    url.protocol !== "http:" ||
    !allowedHost ||
    Number(url.port) !== expectedPort ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new OperatorError(
      "SCIENCE_CONTROL_FAILED",
      "Claude Science control URL did not match the expected loopback port.",
    );
  }
  const nonces = url.searchParams.getAll("nonce");
  if (
    nonces.length !== 1 ||
    !nonces[0] ||
    nonces[0].length > 512 ||
    !/^[A-Za-z0-9._~-]+$/.test(nonces[0])
  ) {
    throw new OperatorError(
      "SCIENCE_CONTROL_FAILED",
      "Claude Science control URL did not contain exactly one valid nonce.",
    );
  }
  return { origin: `http://${url.hostname}:${expectedPort}`, nonce: nonces[0] };
}

export function extractSingleControlUrl(stdout, expectedPort) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout) > PROCESS_LIMIT) {
    throw new OperatorError("SCIENCE_CONTROL_OUTPUT_LIMIT", "Claude Science control output exceeded 64 KiB.");
  }
  const candidates = stdout
    .split(/\s+/)
    .filter(Boolean)
    .filter((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    });
  if (candidates.length !== 1) {
    throw new OperatorError(
      "SCIENCE_CONTROL_FAILED",
      "Claude Science must return exactly one local HTTP control URL.",
    );
  }
  return validateControlUrl(candidates[0], expectedPort);
}

function splitSetCookie(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g);
}

export function responseCookies(headers) {
  let values = [];
  if (Array.isArray(headers)) values = headers;
  else if (typeof headers?.getSetCookie === "function") values = headers.getSetCookie();
  else if (typeof headers?.get === "function") values = splitSetCookie(headers.get("set-cookie"));
  else if (typeof headers === "string") values = splitSetCookie(headers);
  const cookies = new Map();
  for (const line of values) {
    const first = String(line).split(";", 1)[0];
    const index = first.indexOf("=");
    if (index <= 0) continue;
    cookies.set(first.slice(0, index).trim(), first.slice(index + 1).trim());
  }
  return cookies;
}

export async function assertSecureExecutable(binaryPath) {
  let stat;
  try {
    stat = await fs.lstat(binaryPath);
  } catch {
    throw new OperatorError("SCIENCE_BINARY_INVALID", "Claude Science binary is missing.");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    throw new OperatorError(
      "SCIENCE_BINARY_INVALID",
      "Claude Science binary is not a regular executable file.",
    );
  }
  const real = await fs.realpath(binaryPath).catch(() => "");
  if (real !== binaryPath) {
    throw new OperatorError("SCIENCE_BINARY_INVALID", "Claude Science binary path contains a symbolic link.");
  }
  return true;
}

async function readSecureJson(filePath, limit = CONFIG_LIMIT) {
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > limit) {
    throw new OperatorError(
      "CSSWITCH_CONFIG_INVALID",
      "CSSwitch configuration is missing or unsafe to read.",
    );
  }
  const real = await fs.realpath(filePath).catch(() => "");
  if (real !== filePath) {
    throw new OperatorError("CSSWITCH_CONFIG_INVALID", "CSSwitch configuration path contains a symbolic link.");
  }
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    throw new OperatorError("CSSWITCH_CONFIG_INVALID", "CSSwitch configuration is not valid JSON.");
  }
}

async function pathKind(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  return stat?.isDirectory() ? "directory" : stat?.isFile() ? "file" : undefined;
}

function parseScienceVersion(value) {
  if (typeof value !== "string") return undefined;
  const match = value.match(/(?:claude-science\s+)?(\d+\.\d+\.\d+)/);
  return match?.[1];
}

async function runBinary(binary, args, env, timeout = 10_000) {
  try {
    const result = await execFileAsync(binary, args, {
      env,
      encoding: "utf8",
      timeout,
      maxBuffer: PROCESS_LIMIT,
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    if (error?.killed || error?.signal) {
      throw new OperatorError("SCIENCE_CONTROL_TIMEOUT", "Claude Science command timed out.");
    }
    throw new OperatorError("SCIENCE_CONTROL_FAILED", "Claude Science command failed.");
  }
}

async function runOsascript(args, operation, timeout = 15_000) {
  try {
    const result = await execFileAsync("/usr/bin/osascript", args, {
      encoding: "utf8",
      timeout,
      maxBuffer: RESPONSE_LIMIT,
      windowsHide: true,
    });
    return String(result.stdout || result.stderr || "").trim();
  } catch (error) {
    const message = String(error?.stderr || error?.message || "Safari automation failed.");
    if (message.includes("Allow JavaScript from Apple Events")) {
      throw new OperatorError(
        "SAFARI_JAVASCRIPT_DISABLED",
        "Enable Safari Develop > Allow JavaScript from Apple Events, then retry.",
      );
    }
    if (message.includes("not allowed") || message.includes("not authorized")) {
      throw new OperatorError(
        "SAFARI_AUTOMATION_PERMISSION",
        "Allow this Codex/Node process to control Safari in macOS Privacy & Security > Automation.",
      );
    }
    throw new OperatorError("SAFARI_FAILED", `${operation} failed.`);
  }
}

async function listSafariTabs() {
  const script = `
const Safari = Application("Safari");
function safe(value) { try { return String(value()); } catch { return ""; } }
const result = Safari.windows().map((window, wi) => ({
  window_index: wi + 1,
  current_tab_index: (() => { try { return Number(window.currentTab().index()); } catch { return 1; } })(),
  tabs: window.tabs().map((tab, ti) => ({
    id: "w" + (wi + 1) + "-t" + (ti + 1),
    window_index: wi + 1,
    tab_index: ti + 1,
    title: safe(tab.name),
    url: safe(tab.url),
  })),
}));
console.log(JSON.stringify(result));
`;
  const output = await runOsascript(["-l", "JavaScript", "-e", script], "Safari tab discovery");
  try {
    const value = JSON.parse(output);
    if (!Array.isArray(value)) throw new Error("not an array");
    return value;
  } catch {
    throw new OperatorError("SAFARI_FAILED", "Safari tab discovery returned invalid data.");
  }
}

function normalizePathname(value) {
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

function scienceRoute(pathname) {
  const normalized = normalizePathname(pathname);
  const frame = /^\/projects\/([A-Za-z0-9._:-]+)\/frames\/([A-Za-z0-9._:-]+)$/.exec(normalized);
  if (frame) return {kind: "frame", project_id: frame[1], frame_id: frame[2]};
  const project = /^\/projects\/([A-Za-z0-9._:-]+)$/.exec(normalized);
  if (project) return {kind: "project", project_id: project[1]};
  return undefined;
}

export function selectExactSciencePage(tabs, {
  port,
  projectId,
  frameId,
} = {}) {
  if (!validPort(port)) throw new OperatorError("INVALID_PARAMS", "port must be a valid TCP port.");
  const safeProject = safeId(projectId, "project_id");
  const safeFrame = frameId === undefined ? undefined : safeId(frameId, "frame_id");
  const flat = Array.isArray(tabs)
    ? tabs.flatMap((window) => Array.isArray(window?.tabs) ? window.tabs : [])
    : [];
  const candidates = [];
  for (const tab of flat) {
    let url;
    try {
      url = new URL(tab?.url);
    } catch {
      continue;
    }
    if (
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      Number(url.port) !== port ||
      String(tab?.title || "").trim() !== "Claude Science"
    ) {
      continue;
    }
    const route = scienceRoute(url.pathname);
    if (!route || route.project_id !== safeProject) continue;
    if (safeFrame ? route.frame_id !== safeFrame : route.kind !== "project") continue;
    candidates.push({
      tab_id: String(tab.id || ""),
      window_index: tab.window_index,
      tab_index: tab.tab_index,
      title: String(tab.title || ""),
      url: url.href,
      route,
    });
  }
  return {
    matched: candidates.length === 1,
    reason: candidates.length === 0 ? "not_found" : candidates.length === 1 ? "exact" : "ambiguous",
    candidates,
  };
}

function tabPosition(value) {
  const id = requireString(value, "tab_id", 64);
  const match = /^w([1-9][0-9]*)-t([1-9][0-9]*)$/.exec(id);
  if (!match) throw new OperatorError("SAFARI_FAILED", "Safari tab identity is invalid.");
  return {windowIndex: Number(match[1]), tabIndex: Number(match[2])};
}

async function runSafariPageJavaScript(tabId, javascript) {
  const {windowIndex, tabIndex} = tabPosition(tabId);
  const script = `on run argv
set javascriptSource to item 1 of argv
set windowIndex to (item 2 of argv) as integer
set tabIndex to (item 3 of argv) as integer
tell application "Safari"
return do JavaScript javascriptSource in tab tabIndex of window windowIndex
end tell
end run`;
  return runOsascript(
    ["-e", script, "--", javascript, String(windowIndex), String(tabIndex)],
    "Safari page operation",
  );
}

async function focusSafariPage(page) {
  const {windowIndex, tabIndex} = tabPosition(page.tab_id);
  const script = `function run(argv) {
  const Safari = Application("Safari");
  const windowIndex = Number(argv[0]);
  const tabIndex = Number(argv[1]);
  const expectedUrl = String(argv[2]);
  const window = Safari.windows()[windowIndex - 1];
  const tab = window.tabs()[tabIndex - 1];
  if (String(tab.url()) !== expectedUrl) {
    console.log(JSON.stringify({ok:false, code:"SCIENCE_PAGE_IDENTITY_CHANGED"}));
    return;
  }
  window.currentTab = tab;
  window.index = 1;
  Safari.activate();
  console.log(JSON.stringify({ok:true}));
}`;
  const output = await runOsascript(
    [
      "-l",
      "JavaScript",
      "-e",
      script,
      "--",
      String(windowIndex),
      String(tabIndex),
      page.url,
    ],
    "Safari page focus",
  );
  try {
    return JSON.parse(output);
  } catch {
    throw new OperatorError("SAFARI_FAILED", "Safari page focus returned invalid data.");
  }
}

export function buildSciencePageScript({
  port,
  projectId,
  frameId,
  action,
  role,
  name,
  context,
  value,
}) {
  const expectedPath = frameId
    ? `/projects/${encodeURIComponent(projectId)}/frames/${encodeURIComponent(frameId)}`
    : `/projects/${encodeURIComponent(projectId)}`;
  const input = JSON.stringify({
    port,
    expectedPath,
    action,
    role: role || null,
    name: name || null,
    context: context || null,
    value: value ?? null,
  });
  return `(() => {
  const input = ${input};
  const normalizedPath = location.pathname.length > 1 && location.pathname.endsWith("/")
    ? location.pathname.slice(0, -1) : location.pathname;
  if (
    location.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(location.hostname) ||
    Number(location.port) !== input.port ||
    normalizedPath !== input.expectedPath ||
    document.title.trim() !== "Claude Science"
  ) return JSON.stringify({ok:false, code:"SCIENCE_PAGE_IDENTITY_CHANGED"});
  const normalize = (text) => String(text || "").replace(/\\s+/g, " ").trim();
  const visible = (node) => {
    if (!(node instanceof Element)) return false;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const inferredRole = (node) => node.getAttribute("role") ||
    (node.tagName === "BUTTON" ? "button" :
     node.tagName === "A" ? "link" :
     ["INPUT", "TEXTAREA"].includes(node.tagName) || node.isContentEditable ? "textbox" : "");
  const accessibleName = (node) => normalize(
    node.getAttribute("aria-label") ||
    node.getAttribute("placeholder") ||
    node.innerText ||
    node.textContent
  );
  const anchor = [...document.querySelectorAll("button,[role],[aria-label]")]
    .some((node) => visible(node) && (
      accessibleName(node) === "Customize" ||
      accessibleName(node) === "New" ||
      String(node.getAttribute("aria-label") || "").startsWith("Model:")
    ));
  if (!anchor) return JSON.stringify({ok:false, code:"SCIENCE_PAGE_DOM_MISMATCH"});
  if (input.action === "snapshot") {
    const nodes = [...document.querySelectorAll("a,button,input,textarea,select,[role],[contenteditable='true'],h1,h2,h3")]
      .filter(visible).slice(0, 2000).map((node) => ({
        tag: node.tagName.toLowerCase(),
        role: inferredRole(node) || null,
        name: accessibleName(node).slice(0, 500),
        selected: node.getAttribute("aria-selected"),
        checked: node.getAttribute("aria-checked"),
      }));
    return JSON.stringify({
      ok:true,
      url:location.href,
      title:document.title,
      nodes,
      text:normalize(document.body.innerText).slice(0, 20000),
    });
  }
  const nodes = [...document.querySelectorAll("a,button,input,textarea,select,[role],[contenteditable='true']")]
    .filter((node) => visible(node))
    .filter((node) => !input.role || inferredRole(node) === input.role)
    .filter((node) => accessibleName(node) === normalize(input.name))
    .filter((node) => !input.context || normalize(node.parentElement?.innerText).includes(normalize(input.context)));
  if (nodes.length === 0) return JSON.stringify({ok:false, code:"SCIENCE_ELEMENT_NOT_FOUND"});
  if (nodes.length !== 1) return JSON.stringify({ok:false, code:"SCIENCE_ELEMENT_AMBIGUOUS", count:nodes.length});
  const node = nodes[0];
  node.scrollIntoView({block:"center", inline:"nearest"});
  if (input.action === "click") {
    node.click();
  } else if (input.action === "fill") {
    node.focus();
    if (node.isContentEditable) node.textContent = input.value;
    else node.value = input.value;
    node.dispatchEvent(new Event("input", {bubbles:true}));
    node.dispatchEvent(new Event("change", {bubbles:true}));
  } else {
    return JSON.stringify({ok:false, code:"SCIENCE_SAFARI_ACTION_INVALID"});
  }
  return JSON.stringify({ok:true, action:input.action, role:inferredRole(node), name:accessibleName(node)});
})()`;
}

async function readBodyLimited(response, limit) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new OperatorError(
        "SCIENCE_RESPONSE_LIMIT",
        `Claude Science response exceeded ${limit} bytes.`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parsePayload(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new OperatorError("SCIENCE_RESPONSE_INVALID", "Claude Science returned an invalid JSON response.");
  }
}

function requestStatusError(status) {
  if (status === 401 || status === 403) {
    return new OperatorError(
      "SCIENCE_AUTH_FAILED",
      "Claude Science rejected the in-memory control session.",
      { status },
    );
  }
  return new OperatorError("SCIENCE_API_FAILED", `Claude Science API returned HTTP ${status}.`, { status });
}

// Only these mutation contracts were audited for 0.1.52. Registration of another
// route is not proof that its payload or side effects are compatible.
function isAuditedScience0152Mutation(method, route) {
  if (method === "POST" && route === "/api/projects") return true;
  if (method === "PUT" && ["/api/preferences/reviewer-model", "/api/preferences/use-intent"].includes(route)) return true;
  if (method !== "POST") return false;
  const match = /^\/api\/(projects|frames)\/([A-Za-z0-9._:%-]+)\/(request|message|session-config)$/.exec(route);
  if (!match || match[0] !== route) return false;
  let id;
  try {
    id = decodeURIComponent(match[2]);
  } catch {
    return false;
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(id) || id === "." || id === "..") return false;
  return (match[1] === "projects" && match[3] === "request") ||
    (match[1] === "frames" && ["message", "session-config"].includes(match[3]));
}

export class ScienceClient {
  constructor({
    origin,
    port,
    scienceVersion,
    binary = BINARY_PATH,
    dataDir = SCIENCE_DATA_DIR,
    home = SCIENCE_HOME,
    fetchImpl = globalThis.fetch,
    responseLimit = RESPONSE_LIMIT,
    controlUrlProvider,
  }) {
    if (!SUPPORTED_SCIENCE_VERSIONS.includes(scienceVersion)) {
      throw new OperatorError("API_INCOMPATIBLE", "A verified supported Claude Science version is required.");
    }
    this.origin = origin;
    this.port = port;
    this.scienceVersion = scienceVersion;
    this.binary = binary;
    this.dataDir = dataDir;
    this.home = home;
    this.fetch = fetchImpl;
    this.responseLimit = responseLimit;
    this.controlUrlProvider = controlUrlProvider;
    this.session = undefined;
  }

  async freshControlUrl() {
    if (this.controlUrlProvider) {
      return extractSingleControlUrl(await this.controlUrlProvider(), this.port);
    }
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "claude-science-operator-"));
    await fs.chmod(temp, 0o700);
    try {
      const stdout = await runBinary(
        this.binary,
        ["url", "--data-dir", this.dataDir],
        { HOME: this.home, TMPDIR: temp, LC_ALL: "C" },
      );
      return extractSingleControlUrl(stdout, this.port);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }

  async authenticate() {
    const { origin, nonce } = await this.freshControlUrl();
    // freshControlUrl already proves HTTP, exact port, and one of the two allowed
    // loopback host spellings. Use the spelling emitted by Claude Science so its
    // Origin checks remain satisfied without widening the network boundary.
    this.origin = origin;
    const auth = await this.fetch(`${origin}/api/auth/nonce`, {
      method: "POST",
      redirect: "manual",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: origin,
      },
      body: new URLSearchParams({ nonce, dest: "/" }),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    }).catch(() => {
      throw new OperatorError("SCIENCE_AUTH_FAILED", "Claude Science nonce authentication failed.");
    });
    if (!auth.ok) throw requestStatusError(auth.status);
    await readBodyLimited(auth, this.responseLimit);
    const authCookie = responseCookies(auth.headers).get("operon_auth");
    if (!authCookie) {
      throw new OperatorError("SCIENCE_AUTH_FAILED", "Claude Science did not return an auth cookie.");
    }

    const csrf = await this.fetch(`${origin}/api/csrf`, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "application/json", Cookie: `operon_auth=${authCookie}`, Origin: origin },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    }).catch(() => {
      throw new OperatorError("SCIENCE_AUTH_FAILED", "Claude Science CSRF initialization failed.");
    });
    if (!csrf.ok) throw requestStatusError(csrf.status);
    await readBodyLimited(csrf, this.responseLimit);
    const csrfCookie = responseCookies(csrf.headers).get("operon_csrf");
    if (!csrfCookie) {
      throw new OperatorError("SCIENCE_AUTH_FAILED", "Claude Science did not return a CSRF cookie.");
    }
    this.session = { authCookie, csrfCookie };
    return this.session;
  }

  async request(route, { method = "GET", body, write = false, intentId, operation = "write" } = {}) {
    if (typeof route !== "string" || !route.startsWith("/api/") || route.includes("\\")) {
      throw new OperatorError("SCIENCE_ROUTE_INVALID", "Claude Science route must be an /api/ path.");
    }
    if (this.scienceVersion === "0.1.52") {
      const normalizedMethod = typeof method === "string" ? method.toUpperCase() : "";
      if (write || !["GET", "HEAD"].includes(normalizedMethod)) {
        if (!isAuditedScience0152Mutation(normalizedMethod, route)) {
          throw new OperatorError(
            "API_ACTION_UNSUPPORTED",
            "This mutation has not been audited for Claude Science 0.1.52; no control session or request was sent.",
          );
        }
        // A mutation remains single-dispatch even if a caller omitted write=true.
        write = true;
      }
      method = normalizedMethod;
    }
    const send = async () => {
      if (!this.session) await this.authenticate();
      const headers = {
        Accept: "application/json",
        Cookie: `operon_auth=${this.session.authCookie}; operon_csrf=${this.session.csrfCookie}`,
        Origin: this.origin,
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (write) headers["x-operon-csrf"] = this.session.csrfCookie;
      let response;
      try {
        response = await this.fetch(`${this.origin}${route}`, {
          method,
          redirect: "manual",
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS),
        });
      } catch {
        if (write) throw new StateUncertainError(intentId, operation);
        throw new OperatorError("SCIENCE_API_UNAVAILABLE", "Claude Science read request failed.");
      }
      if (!response.ok && response.status < 500) {
        // A received rejection is definite even if its optional error body is
        // malformed, too large, or interrupted. Never expose that body.
        await response.body?.cancel().catch(() => {});
        throw requestStatusError(response.status);
      }
      let text;
      try {
        text = await readBodyLimited(response, this.responseLimit);
      } catch (error) {
        if (write) throw new StateUncertainError(intentId, operation);
        throw error;
      }
      if (!response.ok) {
        if (write && response.status >= 500) throw new StateUncertainError(intentId, operation);
        throw requestStatusError(response.status);
      }
      try {
        return parsePayload(text);
      } catch (error) {
        if (write) throw new StateUncertainError(intentId, operation);
        throw error;
      }
    };

    try {
      return await send();
    } catch (error) {
      if (
        !write &&
        error instanceof OperatorError &&
        ["SCIENCE_AUTH_FAILED", "SCIENCE_API_UNAVAILABLE"].includes(error.code)
      ) {
        this.session = undefined;
        return send();
      }
      throw error;
    }
  }
}

export class RuntimeInspector {
  constructor({
    appPath = APP_PATH,
    csswitchAppPath = CSSWITCH_APP_PATH,
    binary = BINARY_PATH,
    configPath = CSSWITCH_CONFIG_PATH,
    home = SCIENCE_HOME,
    dataDir = SCIENCE_DATA_DIR,
  } = {}) {
    this.appPath = appPath;
    this.csswitchAppPath = csswitchAppPath;
    this.binary = binary;
    this.configPath = configPath;
    this.home = home;
    this.dataDir = dataDir;
  }

  async inspect() {
    const [appKind, csswitchKind] = await Promise.all([
      pathKind(this.appPath),
      pathKind(this.csswitchAppPath),
    ]);
    let config;
    let configError;
    try {
      config = publicConfig(await readSecureJson(this.configPath));
    } catch (error) {
      configError = cleanError(error).code;
      config = {};
    }

    let binaryVerified = false;
    let scienceVersion;
    let binaryError;
    try {
      await assertSecureExecutable(this.binary);
      binaryVerified = true;
      scienceVersion = parseScienceVersion(
        await runBinary(
          this.binary,
          ["--version"],
          { HOME: this.home, TMPDIR: os.tmpdir(), LC_ALL: "C" },
        ),
      );
    } catch (error) {
      binaryError = cleanError(error).code;
    }

    let processStatus = {};
    let statusError;
    if (binaryVerified) {
      try {
        const raw = await runBinary(
          this.binary,
          ["status", "--data-dir", this.dataDir],
          { HOME: this.home, TMPDIR: os.tmpdir(), LC_ALL: "C" },
        );
        const parsed = JSON.parse(raw);
        processStatus = {
          running: parsed?.running === true,
          pid: Number.isInteger(parsed?.pid) && parsed.pid > 0 ? parsed.pid : undefined,
          version: parseScienceVersion(parsed?.version),
          port: validPort(parsed?.port) ? parsed.port : undefined,
          started_at: typeof parsed?.started_at === "string" ? parsed.started_at : undefined,
        };
        scienceVersion = processStatus.version || scienceVersion;
      } catch (error) {
        statusError = error instanceof SyntaxError ? "SCIENCE_STATUS_INVALID" : cleanError(error).code;
      }
    }

    const configuredPort = config.sandbox_port;
    const portMatches = validPort(configuredPort) && processStatus.port === configuredPort;
    let healthy = false;
    let healthError;
    if (processStatus.running && portMatches) {
      try {
        const response = await fetch(`http://127.0.0.1:${configuredPort}/health`, {
          redirect: "manual",
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(5_000),
        });
        const text = await readBodyLimited(response, PROCESS_LIMIT);
        const payload = response.ok ? parsePayload(text) : {};
        healthy = response.ok && isScienceHealthyPayload(payload);
      } catch (error) {
        healthError = cleanError(error).code;
      }
    }

    const apiCompatible = isApiCompatible({
      scienceVersion,
      schemaVersion: config.schema_version,
      binaryVerified,
      running: processStatus.running,
      healthy,
      portMatches,
    });
    const reasons = [];
    if (!SUPPORTED_SCIENCE_VERSIONS.includes(scienceVersion)) reasons.push("unsupported_science_version");
    if (config.schema_version !== SUPPORTED_CSSWITCH_SCHEMA) reasons.push("unsupported_csswitch_schema");
    if (!binaryVerified) reasons.push("binary_not_verified");
    if (!processStatus.running) reasons.push("science_not_running");
    if (!portMatches) reasons.push("port_mismatch");
    if (!healthy) reasons.push("health_check_failed");

    return {
      claudeScience: {
        installed: appKind === "directory",
        binaryVerified,
        version: scienceVersion,
        running: processStatus.running === true,
        pid: processStatus.pid,
        port: processStatus.port,
        started_at: processStatus.started_at,
        healthy,
      },
      csswitch: {
        installed: csswitchKind === "directory",
        ...config,
      },
      apiCompatible,
      recommendedChannel: apiCompatible ? "api" : "gui",
      compatibility: {
        supportedScienceVersion: SUPPORTED_SCIENCE_VERSION,
        supportedScienceVersions: SUPPORTED_SCIENCE_VERSIONS,
        supportedCsswitchSchema: SUPPORTED_CSSWITCH_SCHEMA,
        reasons,
      },
      diagnostics: { configError, binaryError, statusError, healthError },
    };
  }

  async client() {
    const status = await this.inspect();
    if (!status.apiCompatible) {
      throw new OperatorError(
        "API_INCOMPATIBLE",
        "Private API is disabled for this runtime. Use CSSwitch and Safari through Computer Use.",
        { reasons: status.compatibility.reasons },
      );
    }
    const port = status.csswitch.sandbox_port;
    return new ScienceClient({
      origin: `http://127.0.0.1:${port}`,
      port,
      scienceVersion: status.claudeScience.version,
      binary: this.binary,
      dataDir: this.dataDir,
      home: this.home,
    });
  }
}

function listFrom(data, key) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[key])) return data[key];
  if (Array.isArray(data?.value?.[key])) return data.value[key];
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

function selectFields(object, keys) {
  const result = {};
  for (const key of keys) {
    const value = object?.[key];
    if (["string", "number", "boolean"].includes(typeof value) || value === null) result[key] = value;
  }
  return result;
}

function messagePageFrom(data, fallback = 0) {
  const from = data?.from ?? data?.value?.from;
  return Number.isSafeInteger(from) && from >= 0 ? from : fallback;
}

export function normalizedMessages(data, fallbackFrom = 0) {
  const messages = listFrom(data, "messages");
  const from = messagePageFrom(data, fallbackFrom);
  return messages.map((message, index) => {
    const chunks = [];
    const add = (value) => {
      if (typeof value === "string" && value.trim()) chunks.push(value.trim());
    };
    add(message?.text);
    if (typeof message?.content === "string") add(message.content);
    add(message?.input_data?.request);
    const parts = Array.isArray(message?.content)
      ? message.content
      : Array.isArray(message?.parts)
        ? message.parts
        : [];
    for (const part of parts) {
      if (typeof part === "string") add(part);
      else {
        add(part?.text);
        add(part?.content);
        add(part?.value);
      }
    }
    return {
      index: Number.isSafeInteger(message?.index) && message.index >= 0 ? message.index : from + index,
      id: typeof message?.id === "string"
        ? message.id
        : typeof message?._uuid === "string" ? message._uuid : undefined,
      role:
        typeof message?.role === "string"
          ? message.role
          : typeof message?.sender === "string"
            ? message.sender
            : undefined,
      text: [...new Set(chunks)].join("\n\n"),
      created_at: typeof message?.created_at === "string" ? message.created_at : undefined,
    };
  });
}

function normalizeProject(project) {
  return selectFields(project, ["id", "project_id", "name", "title", "status", "created_at", "updated_at"]);
}

function frameModelFields(frame) {
  return typeof frame?.model === "string" || frame?.model === null ? {model: frame.model} : {};
}

function normalizeFrame(frame) {
  return {
    ...selectFields(frame, [
      "id",
      "frame_id",
      "root_frame_id",
      "project_id",
      "title",
      "name",
      "status",
      "created_at",
      "updated_at",
    ]),
    ...frameModelFields(frame),
  };
}

function normalizeArtifact(artifact) {
  return selectFields(artifact, [
    "id",
    "artifact_id",
    "project_id",
    "frame_id",
    "name",
    "title",
    "filename",
    "type",
    "mime_type",
    "size",
    "status",
    "created_at",
    "updated_at",
  ]);
}

function writeResponseId(data, kind, intentId, operation) {
  const value = kind === "project"
    ? data?.id ?? data?.project_id ?? data?.value?.id
    : data?.id ?? data?.frame_id ?? data?.root_frame_id ?? data?.value?.id;
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 256 ||
    !/^[A-Za-z0-9._:-]+$/.test(value) ||
    value === "." || value === ".."
  ) {
    // The write already succeeded at the HTTP boundary. A missing/unsafe ID
    // prevents reconciliation; it does not prove that the side effect failed.
    throw new StateUncertainError(intentId, operation);
  }
  return value;
}

function deriveProjectName(prompt) {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 60) || "Codex research task";
}

function toolResult(message, structuredContent) {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { message, ...structuredContent },
  };
}

async function statusOperation(inspector) {
  const status = await inspector.inspect();
  const summary = status.apiCompatible
    ? status.claudeScience.version === "0.1.52"
      ? `Claude Science 0.1.52 is healthy on loopback port ${status.claudeScience.port}; the audited core API is available. Unverified expert and other settings mutations remain disabled.`
      : `Claude Science ${status.claudeScience.version} is healthy on loopback port ${status.claudeScience.port}; use the API channel for routine work.`
    : `Claude Science private API is unavailable (${status.compatibility.reasons.join(", ") || "unknown reason"}); use CSSwitch and Safari through Computer Use.`;
  return toolResult(summary, status);
}

async function listProjectsOperation(inspector, args) {
  const limit = boundedInteger(args.limit, "limit", 1, 100, 25);
  const offset = boundedInteger(args.offset, "offset", 0, 100_000, 0);
  const client = await inspector.client();
  const data = await client.request(`/api/projects?limit=${limit}&offset=${offset}`);
  const projects = listFrom(data, "projects").map(normalizeProject);
  return toolResult(`Found ${projects.length} Claude Science project(s).`, { projects, limit, offset });
}

async function listSessionsOperation(inspector, args) {
  const projectId = safeId(args.project_id, "project_id");
  const limit = boundedInteger(args.limit, "limit", 1, 100, 25);
  const client = await inspector.client();
  const query = new URLSearchParams({ root_only: "true", project_id: projectId, limit: String(limit) });
  const data = await client.request(`/api/frames?${query}`);
  const sessions = listFrom(data, "frames").map(normalizeFrame);
  return toolResult(`Found ${sessions.length} root session(s) in project ${projectId}.`, {
    project_id: projectId,
    sessions,
  });
}

const SESSION_CONFIG_FIELDS = Object.freeze(["verifier_mode", "memory_mode", "reviewer_model"]);
const REQUEST_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

function sessionConfigSchema() {
  return {
    type: "object",
    description: "Non-empty explicit persisted knobs only. This is not a full input-menu/effective preset.",
    properties: {
      verifier_mode: {type: "string", enum: ["off", "on"], description: "Auto-review, not auto_mode."},
      memory_mode: {type: "string", enum: ["off", "on"]},
      reviewer_model: {type: ["string", "null"], description: "Catalog model ID, 1-200 characters, or null to inherit. Never the display label Default."},
    },
    additionalProperties: false,
  };
}

function expectedSessionConfigSchema() {
  return {
    type: "object",
    description: "Bind a non-empty expected persisted config to this exact existing root. Fresh service readback must match before a message is sent.",
    properties: {frame_id: {type: "string"}, config: sessionConfigSchema()},
    required: ["frame_id", "config"],
    additionalProperties: false,
  };
}

function rootSessionId(value) {
  const id = safeId(value, "frame_id");
  if (id === "." || id === "..") throw new OperatorError("INVALID_PARAMS", "frame_id must identify an exact root session.");
  return id;
}

function isSessionConfigValue(field, value) {
  if (field === "reviewer_model") {
    return value === null || (typeof value === "string" && value.length <= 200 && Boolean(value.trim()) && value !== "Default");
  }
  return value === "off" || value === "on";
}

function validatedSessionConfig(value) {
  const config = requireObject(value, "config", 4096);
  const entries = Object.entries(config);
  if (!entries.length) throw new OperatorError("INVALID_PARAMS", "config must contain at least one explicit persisted knob.");
  for (const [field, item] of entries) {
    if (!SESSION_CONFIG_FIELDS.includes(field)) {
      throw new OperatorError("API_ACTION_UNSUPPORTED", "This per-session option cannot be preconfigured by the audited session-config tool.");
    }
    if (!isSessionConfigValue(field, item)) {
      throw new OperatorError("INVALID_PARAMS", "A session-config value does not match the audited type or enum.");
    }
  }
  return config;
}

function validatedExpectedSessionConfig(value, frameId) {
  const expected = requireObject(value, "expected_session_config", 8192);
  if (Object.keys(expected).some((key) => !["frame_id", "config"].includes(key))) {
    throw new OperatorError("INVALID_PARAMS", "expected_session_config must contain only frame_id and config.");
  }
  if (rootSessionId(expected.frame_id) !== frameId) {
    throw new OperatorError("INVALID_PARAMS", "Expected configuration is not bound to the requested root session.");
  }
  return {frame_id: frameId, config: validatedSessionConfig(expected.config)};
}

function requireAuditedSessionVersion(client) {
  if (client.scienceVersion !== "0.1.52") {
    throw new OperatorError("API_ACTION_UNSUPPORTED", "Session configuration and these request-time options are only audited for Claude Science 0.1.52.");
  }
}

function optionalRequestEffort(value) {
  if (value === undefined) return undefined;
  if (!REQUEST_EFFORTS.includes(value)) {
    throw new OperatorError("INVALID_PARAMS", "effort must be low, medium, high, xhigh, or max.");
  }
  return value;
}

function optionalRequestDelegation(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new OperatorError("INVALID_PARAMS", "ultra_mode must be boolean; false requests Delegation Off.");
  return value;
}

async function readRootSessionConfig(client, frameId) {
  const frame = await client.request(`/api/frames/${encodeURIComponent(frameId)}`);
  if (
    !frame || typeof frame !== "object" || Array.isArray(frame) ||
    !Object.hasOwn(frame, "id") || !Object.hasOwn(frame, "root_frame_id") || !Object.hasOwn(frame, "parent_frame_id") ||
    frame.id !== frameId || frame.root_frame_id !== frameId || frame.parent_frame_id !== null
  ) {
    throw new OperatorError("SCIENCE_SESSION_INVALID", "The API did not return the exact requested root session.");
  }
  const context = frame.context_data && typeof frame.context_data === "object" && !Array.isArray(frame.context_data)
    ? frame.context_data : {};
  const config = {};
  const sources = {};
  const unverified = [];
  let configSource = "source_unknown";
  if (Object.hasOwn(context, "_original_input")) {
    configSource = "context_data._original_input";
    const original = context._original_input ?? {};
    if (typeof original !== "object" || Array.isArray(original)) {
      throw new OperatorError("SCIENCE_RESPONSE_INVALID", "The authoritative session configuration is malformed.");
    }
    for (const field of SESSION_CONFIG_FIELDS) {
      if (!Object.hasOwn(original, field)) continue;
      if (!isSessionConfigValue(field, original[field])) {
        unverified.push(field);
        continue;
      }
      config[field] = original[field];
      sources[field] = configSource;
    }
  }
  // Do not implement a guessed per-key input_data/delta fallback or copy raw
  // context. Missing knobs are unknown/inherited, not friendly display defaults.
  const observed = {frame_id: frameId, root_frame_id: frameId, config, sources, config_source: configSource};
  if (unverified.length) observed.unverified_fields = unverified;
  if (Object.hasOwn(frame, "model") && (typeof frame.model === "string" || frame.model === null)) {
    observed.initial_model = frame.model;
  }
  for (const [field, source] of [["active_model", "_model"], ["active_effort", "_effort"]]) {
    if (Object.hasOwn(context, source) && (typeof context[source] === "string" || context[source] === null)) {
      observed[field] = context[source];
      observed[`${field}_source`] = `context_data.${source}`;
    }
  }
  return observed;
}

function assertSessionConfigMatches(observed, expected) {
  if (
    observed.config_source !== "context_data._original_input" ||
    Object.entries(expected).some(([field, value]) => !Object.hasOwn(observed.config, field) || observed.config[field] !== value)
  ) {
    throw new OperatorError("SESSION_CONFIG_UNCONFIRMED", "Fresh service readback did not confirm every expected explicit session knob; no message was sent.");
  }
}

async function sessionConfigOperation(inspector, args) {
  const action = requireString(args.action, "action", 16);
  if (!["get", "set"].includes(action)) throw new OperatorError("INVALID_PARAMS", "action must be get or set.");
  const frameId = rootSessionId(args.frame_id);
  const config = action === "set" ? validatedSessionConfig(args.config) : undefined;
  if (action === "get" && args.config !== undefined) throw new OperatorError("INVALID_PARAMS", "config is only accepted for action=set.");
  const intentId = action === "set" ? confirmationIntent(args, "set session config") : undefined;
  const client = await inspector.client();
  requireAuditedSessionVersion(client);
  const before = await readRootSessionConfig(client, frameId);
  if (action === "get") {
    return toolResult("Read explicit persisted session knobs and observed runtime selections; missing values are not inferred defaults or a complete menu preset.", before);
  }
  const operation = "set session config";
  const response = await client.request(`/api/frames/${encodeURIComponent(frameId)}/session-config`, {
    method: "POST", write: true, body: config, intentId, operation,
  });
  if (
    !response || typeof response !== "object" || Array.isArray(response) ||
    !Object.hasOwn(response, "root_frame_id") || !Object.hasOwn(response, "status") ||
    response.root_frame_id !== frameId || response.status !== "ok" ||
    Object.entries(config).some(([field, value]) => !Object.hasOwn(response, field) || response[field] !== value)
  ) {
    throw new StateUncertainError(intentId, operation);
  }
  let observed;
  try {
    observed = await readRootSessionConfig(client, frameId);
    assertSessionConfigMatches(observed, config);
  } catch {
    throw new StateUncertainError(intentId, operation);
  }
  return toolResult("Independently confirmed explicit session knobs in storage. This does not preconfigure the full input menu or prove in-flight/effective model settings.", {
    ...observed, intent_id: intentId, configuration_confirmed: true,
    configuration_scope: "explicit_persisted_knobs", verified_fields: Object.keys(config),
  });
}

async function submitTaskOperation(inspector, args) {
  if (args.expected_session_config !== undefined) {
    throw new OperatorError("API_ACTION_UNSUPPORTED", "A new task has no existing root to preconfigure/read back. Use an already existing root; no project or task was created.");
  }
  const prompt = requireString(args.prompt, "prompt");
  const model = optionalString(args.model, "model", 200);
  const effort = optionalRequestEffort(args.effort);
  const ultraMode = optionalRequestDelegation(args.ultra_mode);
  const planMode = optionalBoolean(args.plan_mode, "plan_mode", false);
  let projectId = args.project_id === undefined ? undefined : safeId(args.project_id, "project_id");
  const projectName = optionalString(args.project_name, "project_name", 120) || deriveProjectName(prompt);
  const intentId = crypto.randomUUID();
  const client = await inspector.client();
  if (effort !== undefined || ultraMode !== undefined) requireAuditedSessionVersion(client);
  let createdProject = false;
  if (!projectId) {
    const created = await client.request("/api/projects", {
      method: "POST",
      write: true,
      intentId,
      operation: "create project",
      body: { name: projectName, intent_id: intentId },
    });
    projectId = writeResponseId(created, "project", intentId, "create project");
    createdProject = true;
  }
  const body = {
    input_data: { request: prompt },
    target_agent: "OPERON",
    plan_mode: planMode,
    intent_id: intentId,
  };
  if (model) body.model = model;
  if (effort !== undefined) body.effort = effort;
  if (ultraMode !== undefined) body.ultra_mode = ultraMode;
  const response = await client.request(`/api/projects/${encodeURIComponent(projectId)}/request`, {
    method: "POST",
    write: true,
    intentId,
    operation: "submit task",
    body,
  });
  const frameId = writeResponseId(response, "frame", intentId, "submit task");
  return toolResult(`Submitted one Claude Science task to project ${projectId}.`, {
    project_id: projectId,
    frame_id: frameId,
    intent_id: intentId,
    created_project: createdProject,
    ...(effort !== undefined || ultraMode !== undefined ? {requested_send_options: {
      ...(model ? {model} : {}), ...(effort !== undefined ? {effort} : {}),
      ...(ultraMode !== undefined ? {ultra_mode: ultraMode} : {}),
    }} : {}),
  });
}

async function continueSessionOperation(inspector, args) {
  const frameId = safeId(args.frame_id, "frame_id");
  const prompt = requireString(args.prompt, "prompt");
  const model = optionalString(args.model, "model", 200);
  const effort = optionalRequestEffort(args.effort);
  const ultraMode = optionalRequestDelegation(args.ultra_mode);
  const expected = args.expected_session_config === undefined
    ? undefined : validatedExpectedSessionConfig(args.expected_session_config, rootSessionId(frameId));
  const intentId = crypto.randomUUID();
  const body = { input_data: { request: prompt }, intent_id: intentId };
  if (model) body.model = model;
  if (effort !== undefined) body.effort = effort;
  if (ultraMode !== undefined) body.input_data.ultra_mode = ultraMode;
  const client = await inspector.client();
  if (expected || effort !== undefined || ultraMode !== undefined) requireAuditedSessionVersion(client);
  if (expected) {
    const observed = await readRootSessionConfig(client, frameId);
    assertSessionConfigMatches(observed, expected.config);
  }
  const response = await client.request(`/api/frames/${encodeURIComponent(frameId)}/message`, {
    method: "POST",
    write: true,
    intentId,
    operation: "continue session",
    body,
  });
  const returnedFrame = writeResponseId(response, "frame", intentId, "continue session");
  if (expected && (response.root_frame_id !== frameId || returnedFrame !== frameId)) {
    throw new StateUncertainError(intentId, "continue session");
  }
  const summary = expected || effort !== undefined || ultraMode !== undefined
    ? `Sent one follow-up task to Claude Science frame ${frameId}; request-time selections are not prior persisted or provider-effective proof.`
    : `Sent one follow-up task to Claude Science frame ${frameId}.`;
  return toolResult(summary, {
    frame_id: returnedFrame,
    root_frame_id: frameId,
    intent_id: intentId,
    ...(expected ? {configuration_confirmed: true, configuration_scope: "explicit_persisted_knobs", verified_fields: Object.keys(expected.config)} : {}),
    ...(effort !== undefined || ultraMode !== undefined ? {requested_send_options: {
      ...(model ? {model} : {}), ...(effort !== undefined ? {effort} : {}),
      ...(ultraMode !== undefined ? {ultra_mode: ultraMode} : {}),
    }} : {}),
  });
}

function frameStatus(frame) {
  return String(frame?.status ?? frame?.state ?? frame?.value?.status ?? "unknown").toLowerCase();
}

function approvalItems(frame) {
  const candidates = [
    frame?.approvals,
    frame?.pending_approvals,
    frame?.approval_requests,
    frame?.value?.approvals,
  ];
  return candidates.find(Array.isArray) || [];
}

function frameFailure(frame) {
  const output = frame?.output_data;
  if (!output || typeof output !== "object") return undefined;
  const failure = selectFields(output, [
    "error_kind",
    "error_status",
    "stop_reason",
    "boundary_stop",
    "boundary_stop_resets_at",
    "failure_ts",
  ]);
  if (typeof output.error === "string" && output.error) {
    failure.error = output.error
      .slice(0, 2000)
      .replace(/(?:sk|key|token|secret)[-_][A-Za-z0-9._~-]{8,}/gi, "[REDACTED]");
  }
  return Object.keys(failure).length ? failure : undefined;
}

async function pollSessionOperation(inspector, args) {
  const frameId = safeId(args.frame_id, "frame_id");
  const waitSeconds = boundedInteger(args.wait_seconds, "wait_seconds", 0, 45, 10);
  const fromMessage = boundedInteger(args.from_message, "from_message", 0, 1_000_000, 0);
  const client = await inspector.client();
  const deadline = Date.now() + waitSeconds * 1000;
  let frame;
  do {
    frame = await client.request(`/api/frames/${encodeURIComponent(frameId)}`);
    const status = frameStatus(frame);
    if (TERMINAL_STATES.has(status) || ATTENTION_STATES.has(status) || approvalItems(frame).length) break;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(1000, Math.max(0, deadline - Date.now()))),
    );
  } while (Date.now() <= deadline);

  const query = new URLSearchParams({ from: String(fromMessage), limit: "200" });
  const messageData = await client.request(
    `/api/frames/${encodeURIComponent(frameId)}/messages?${query}`,
  );
  const pageFrom = messagePageFrom(messageData, fromMessage);
  const messages = normalizedMessages(messageData, pageFrom);
  const assistant = messages.filter(
    (message) => /assistant|agent|operon/i.test(message.role || "") && message.text,
  );
  const status = frameStatus(frame);
  const approvals = approvalItems(frame).map((item) =>
    selectFields(item, ["id", "type", "title", "description", "status", "created_at"]),
  );
  const requiresAttention = ATTENTION_STATES.has(status) || approvals.length > 0;
  const finalAnswer = SUCCESS_STATES.has(status) ? assistant.at(-1)?.text : undefined;
  const failure = frameFailure(frame);
  return toolResult(`Claude Science frame ${frameId} is ${status}.`, {
    frame_id: frameId,
    status,
    requires_attention: requiresAttention,
    approvals,
    messages,
    next_from_message: pageFrom + messages.length,
    final_answer: finalAnswer,
    failure,
    ...frameModelFields(frame),
  });
}

async function listArtifactsOperation(inspector, args) {
  const projectId = args.project_id === undefined ? undefined : safeId(args.project_id, "project_id");
  const frameId = args.frame_id === undefined ? undefined : safeId(args.frame_id, "frame_id");
  if ((projectId ? 1 : 0) + (frameId ? 1 : 0) !== 1) {
    throw new OperatorError("INVALID_PARAMS", "Provide exactly one of project_id or frame_id.");
  }
  const client = await inspector.client();
  const route = projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/artifacts`
    : `/api/frames/${encodeURIComponent(frameId)}/artifacts`;
  const data = await client.request(route);
  const artifacts = listFrom(data, "artifacts").map(normalizeArtifact);
  return toolResult(
    `Found ${artifacts.length} Claude Science artifact(s). Download and export through the GUI.`,
    {
      project_id: projectId,
      frame_id: frameId,
      artifacts,
      interaction_channel: "gui",
    },
  );
}

function confirmationIntent(args, operation) {
  if (optionalBoolean(args.confirm, "confirm", false) !== true) {
    throw new OperatorError(
      "CONFIRMATION_REQUIRED",
      `${operation} requires confirm=true after reviewing the exact target and requested change.`,
    );
  }
  return crypto.randomUUID();
}

function rejectSensitiveFields(value, path = "payload") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSensitiveFields(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (/(?:password|secret|token|credential|api[_-]?key|cookie)/i.test(key)) {
      throw new OperatorError("INVALID_PARAMS", `${path}.${key} is not accepted by this tool.`);
    }
    rejectSensitiveFields(nested, `${path}.${key}`);
  }
}

function normalizeExpert(agent, includePrompt = false) {
  const metadata = agent?.metadata && typeof agent.metadata === "object" ? agent.metadata : {};
  const result = selectFields(agent, [
    "name",
    "description",
    "enabled",
    "healthy",
    "source",
    "supportsPlanMode",
    "skillsLocked",
    "unrestricted",
    "userHidden",
  ]);
  result.skills = Array.isArray(metadata.skills) ? metadata.skills : [];
  result.connectors = Array.isArray(metadata.mcp_servers) ? metadata.mcp_servers : [];
  result.tools = Array.isArray(metadata.tools) ? metadata.tools : [];
  result.excluded_tools = Array.isArray(metadata.excluded_tools) ? metadata.excluded_tools : [];
  result.tags = Array.isArray(metadata.tags) ? metadata.tags : [];
  result.parameters = agent?.parameters && typeof agent.parameters === "object" ? agent.parameters : {};
  if (includePrompt) {
    result.system_prompt =
      typeof agent?.systemPrompt === "string"
        ? agent.systemPrompt
        : typeof metadata.system_prompt === "string"
          ? metadata.system_prompt
          : undefined;
  }
  return result;
}

async function listExpertsOperation(inspector, args) {
  const includePrompt = optionalBoolean(args.include_prompt, "include_prompt", false);
  const names = Array.isArray(args.names)
    ? args.names.map((name) => safeAgentName(name, "names[]"))
    : undefined;
  const query = new URLSearchParams({include_metadata: "true"});
  if (names?.length) query.set("names", names.join(","));
  const client = await inspector.client();
  const data = await client.request(`/api/agents?${query}`);
  const experts = listFrom(data, "agents").map((agent) => normalizeExpert(agent, includePrompt));
  return toolResult(`Found ${experts.length} Claude Science expert(s).`, {experts});
}

function normalizedExpertPayload(value, name, {create = false} = {}) {
  const payload = requireObject(value, name);
  rejectSensitiveFields(payload, name);
  if (typeof payload.system_prompt === "string" && payload.systemPrompt === undefined) {
    payload.systemPrompt = payload.system_prompt;
    delete payload.system_prompt;
  }
  if (typeof payload.display_name === "string" && payload.displayName === undefined) {
    payload.displayName = payload.display_name;
    delete payload.display_name;
  }
  if (Array.isArray(payload.skill_names) && payload.skillNames === undefined) {
    payload.skillNames = payload.skill_names;
    delete payload.skill_names;
  }
  if (create) {
    const suppliedName = requireString(payload.name, `${name}.name`, 200);
    payload.displayName =
      typeof payload.displayName === "string" && payload.displayName.trim()
        ? payload.displayName.trim()
        : suppliedName;
    payload.name = suppliedName
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase();
    if (!/^[A-Z0-9_]{2,32}$/.test(payload.name)) {
      throw new OperatorError(
        "INVALID_PARAMS",
        `${name}.name must produce a 2-32 character A-Z, 0-9, underscore expert id.`,
      );
    }
    if (typeof payload.description !== "string") payload.description = "";
    if (typeof payload.systemPrompt !== "string") payload.systemPrompt = "";
  }
  return payload;
}

async function expertActionOperation(inspector, args) {
  const action = requireString(args.action, "action", 64);
  const intentId = action === "get_prompt" ? undefined : confirmationIntent(args, `expert action ${action}`);
  const client = await inspector.client();
  let method;
  let route;
  let body;
  const name = args.name === undefined ? undefined : safeAgentName(args.name, "name");
  if (action === "create") {
    method = "POST";
    route = "/api/agents";
    body = normalizedExpertPayload(args.expert, "expert", {create: true});
  } else {
    if (!name) throw new OperatorError("INVALID_PARAMS", "name is required for this expert action.");
    const encodedName = encodeURIComponent(name);
    if (action === "update") {
      method = "PATCH";
      route = `/api/agents/${encodedName}`;
      body = normalizedExpertPayload(args.patch, "patch");
    } else if (action === "delete") {
      method = "DELETE";
      route = `/api/agents/${encodedName}`;
    } else if (action === "set_enabled") {
      method = "POST";
      route = `/api/agents/${encodedName}/enabled`;
      const enabled = optionalBoolean(args.enabled, "enabled");
      if (enabled === undefined) throw new OperatorError("INVALID_PARAMS", "enabled is required.");
      body = {enabled};
    } else if (action === "get_prompt") {
      method = "GET";
      route = `/api/agents/${encodedName}/custom-prompt`;
    } else if (action === "set_prompt") {
      method = "PUT";
      route = `/api/agents/${encodedName}/custom-prompt`;
      body = {prompt_text: requireString(args.prompt_text, "prompt_text")};
    } else if (action === "delete_prompt") {
      method = "DELETE";
      route = `/api/agents/${encodedName}/custom-prompt`;
    } else if (action === "attach_skill") {
      method = "POST";
      route = `/api/agents/${encodedName}/skills`;
      body = {skill_name: safeId(args.skill_name, "skill_name")};
    } else if (action === "detach_skill") {
      method = "DELETE";
      route = `/api/agents/${encodedName}/skills/${encodeURIComponent(safeId(args.skill_name, "skill_name"))}`;
    } else if (action === "update_skills") {
      method = "PUT";
      route = `/api/agents/${encodedName}/skills`;
      body = {
        attach: Array.isArray(args.attach) ? args.attach.map((item) => safeId(item, "attach[]")) : [],
        detach: Array.isArray(args.detach) ? args.detach.map((item) => safeId(item, "detach[]")) : [],
      };
    } else if (action === "attach_connector") {
      method = "POST";
      route = `/api/agents/${encodedName}/connectors`;
      body = {
        server_id: safeId(args.server_id, "server_id"),
        includeToolsPattern: optionalString(args.include_tools_pattern, "include_tools_pattern", 2_000),
        excludeToolsPattern: optionalString(args.exclude_tools_pattern, "exclude_tools_pattern", 2_000),
        allowUnauthorized: optionalBoolean(args.allow_unauthorized, "allow_unauthorized", false),
      };
    } else if (action === "detach_connector") {
      method = "DELETE";
      route = `/api/agents/${encodedName}/connectors/${encodeURIComponent(safeId(args.server_id, "server_id"))}`;
    } else if (action === "set_connector_exclusions") {
      method = "PUT";
      route = `/api/agents/${encodedName}/connectors/${encodeURIComponent(safeId(args.server_id, "server_id"))}/exclusions`;
      body = {
        excludedTools: Array.isArray(args.excluded_tools)
          ? args.excluded_tools.map((item) => safeId(item, "excluded_tools[]"))
          : [],
      };
    } else {
      throw new OperatorError("INVALID_PARAMS", `Unsupported expert action: ${action}.`);
    }
  }
  const response = await client.request(route, {
    method,
    body,
    write: method !== "GET",
    intentId,
    operation: `expert:${action}`,
  });
  return toolResult(`Completed Claude Science expert action ${action}.`, {
    action,
    name,
    intent_id: intentId,
    result: response,
  });
}

export function normalizeModelCatalog(data) {
  const groups = data?.models && typeof data.models === "object" ? data.models : {};
  const models = [];
  for (const [provider, value] of Object.entries(groups)) {
    const items = Array.isArray(value) ? value : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      models.push({
        provider,
        id: typeof item.id === "string" ? item.id : undefined,
        name: typeof item.name === "string" ? item.name : undefined,
        overflow: typeof item.overflow === "boolean" ? item.overflow : undefined,
      });
    }
  }
  const catalog = {
    default_model_id: typeof data?.default_model_id === "string" ? data.default_model_id : undefined,
    models,
  };
  const authFailed = typeof data?.auth_error === "string" && Boolean(data.auth_error.trim());
  const fetchFailed = typeof data?.fetch_error === "string" && Boolean(data.fetch_error.trim());
  // Provider errors may contain private URLs or credentials. Preserve diagnostic
  // meaning with static summaries, never the underlying exception text.
  if (authFailed) catalog.auth_error = "Claude Science model authentication failed.";
  if (fetchFailed) catalog.fetch_error = "Claude Science model catalog fetch failed.";
  if (["rate_limited", "unavailable"].includes(data?.fetch_error_kind)) {
    catalog.fetch_error_kind = data.fetch_error_kind;
  }
  if (["fallback", "last_good"].includes(data?.models_source)) catalog.models_source = data.models_source;
  if (data?.model_list_source === "selector") catalog.model_list_source = "selector";
  for (const field of ["first_party_catalog", "default_model_locked"]) {
    if (typeof data?.[field] === "boolean") catalog[field] = data[field];
  }
  if (authFailed || fetchFailed || catalog.fetch_error_kind || catalog.models_source) {
    catalog.catalog_usable = false;
  }
  return catalog;
}

async function listModelsOperation(inspector, args) {
  const provider = optionalString(args.provider, "provider", 200);
  const query = provider ? `?${new URLSearchParams({provider})}` : "";
  const client = await inspector.client();
  const data = await client.request(`/api/models${query}`);
  const catalog = normalizeModelCatalog(data);
  const summary = catalog.catalog_usable === false
    ? `Claude Science returned ${catalog.models.length} model(s), but the catalog is stale or unavailable. Do not use it to select a model or infer successful provider authentication.`
    : `Found ${catalog.models.length} Claude Science model(s).`;
  return toolResult(summary, catalog);
}

const SETTING_DEFINITIONS = {
  reviewer_model: {
    route: "/api/preferences/reviewer-model",
    body: (value) => ({model: value}),
  },
  allowed_domains: {
    route: "/api/preferences/allowed-domains",
    body: (value) => ({domains: value}),
  },
  builtin_allowlist_disabled: {
    route: "/api/preferences/builtin-allowlist/disabled",
    getRoute: "/api/preferences/builtin-allowlist",
    body: (value) => ({disabled: value}),
  },
  builtin_allowlist_disabled_groups: {
    route: "/api/preferences/builtin-allowlist/disabled-groups",
    getRoute: "/api/preferences/builtin-allowlist",
    body: (value) => ({disabledGroups: value}),
  },
  telemetry_consent: {
    route: "/api/preferences/telemetry-consent",
    body: (value) => ({consent: value}),
  },
  git_identity: {
    route: "/api/preferences/git-identity",
    body: (value) => value,
  },
  conda_mirror: {
    route: "/api/preferences/conda-mirror",
    body: (value) => value,
  },
  use_intent: {
    route: "/api/preferences/use-intent",
    body: (value) => ({intent: value}),
  },
};

async function settingsOperation(inspector, args) {
  const action = requireString(args.action, "action", 16);
  const setting = requireString(args.setting, "setting", 80);
  const definition = SETTING_DEFINITIONS[setting];
  if (!definition) throw new OperatorError("INVALID_PARAMS", `Unsupported setting: ${setting}.`);
  const client = await inspector.client();
  if (action === "get") {
    const result = await client.request(definition.getRoute || definition.route);
    return toolResult(`Read Claude Science setting ${setting}.`, {setting, result});
  }
  if (action !== "set") throw new OperatorError("INVALID_PARAMS", "action must be get or set.");
  if (!Object.hasOwn(args, "value")) throw new OperatorError("INVALID_PARAMS", "value is required.");
  const value = args.value === null ? null : JSON.parse(JSON.stringify(args.value));
  rejectSensitiveFields(value, "value");
  const intentId = confirmationIntent(args, `setting ${setting}`);
  const result = await client.request(definition.route, {
    method: "PUT",
    body: definition.body(value),
    write: true,
    intentId,
    operation: `setting:${setting}`,
  });
  return toolResult(`Updated Claude Science setting ${setting}.`, {
    setting,
    intent_id: intentId,
    result,
  });
}

async function safariPageOperation(inspector, args) {
  const action = requireString(args.action, "action", 32);
  const projectId = safeId(args.project_id, "project_id");
  const frameId = args.frame_id === undefined ? undefined : safeId(args.frame_id, "frame_id");
  const status = await inspector.inspect();
  const port = status.claudeScience?.port;
  if (!status.claudeScience?.running || !validPort(port)) {
    throw new OperatorError("SCIENCE_PAGE_UNAVAILABLE", "Claude Science is not running on a known loopback port.");
  }
  const selection = selectExactSciencePage(await listSafariTabs(), {port, projectId, frameId});
  if (action === "find") {
    return toolResult(
      selection.matched
        ? "Found exactly one matching Claude Science page."
        : `Claude Science page match is ${selection.reason}.`,
      {page_match: selection},
    );
  }
  if (!selection.matched) {
    throw new OperatorError(
      selection.reason === "ambiguous" ? "SCIENCE_PAGE_AMBIGUOUS" : "SCIENCE_PAGE_NOT_FOUND",
      "Could not identify exactly one Claude Science page; no Safari action was taken.",
      {candidates: selection.candidates},
    );
  }
  if (action === "focus") {
    const result = await focusSafariPage(selection.candidates[0]);
    if (result?.ok !== true) {
      throw new OperatorError(
        result?.code || "SAFARI_FAILED",
        "Safari refused to focus the page because its identity changed.",
      );
    }
    return toolResult("Focused the exact Claude Science Safari page for Computer Use.", {
      page: selection.candidates[0],
      result,
    });
  }
  if (!["snapshot", "click", "fill"].includes(action)) {
    throw new OperatorError("INVALID_PARAMS", `Unsupported Safari action: ${action}.`);
  }
  if (action !== "snapshot" && optionalBoolean(args.confirm, "confirm", false) !== true) {
    throw new OperatorError("CONFIRMATION_REQUIRED", `${action} requires confirm=true for the exact page and element.`);
  }
  const role = optionalString(args.role, "role", 80);
  const name = action === "snapshot" ? undefined : requireString(args.name, "name", 1_000);
  const context = optionalString(args.context, "context", 2_000);
  const value = action === "fill" ? requireString(args.value, "value") : undefined;
  const script = buildSciencePageScript({
    port,
    projectId,
    frameId,
    action,
    role,
    name,
    context,
    value,
  });
  const output = await runSafariPageJavaScript(selection.candidates[0].tab_id, script);
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw new OperatorError("SAFARI_FAILED", "Safari page operation returned invalid data.");
  }
  if (result?.ok !== true) {
    throw new OperatorError(
      result?.code || "SAFARI_FAILED",
      "Safari refused the operation because page or element identity was not exact.",
      {count: result?.count},
    );
  }
  return toolResult(`Completed exact Claude Science Safari action ${action}.`, {
    page: selection.candidates[0],
    result,
  });
}

export function toolsList() {
  return [
    {
      name: "claude_science_status",
      title: "Claude Science Status",
      description:
        "Inspect the local Claude Science and CSSwitch runtime and recommend the API or GUI channel without returning credentials.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "claude_science_list_projects",
      title: "List Claude Science Projects",
      description: "Page through Claude Science projects using the compatible local API.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
          offset: { type: "integer", minimum: 0, maximum: 100000, default: 0 },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "claude_science_list_experts",
      title: "List Claude Science Experts",
      description: "List Claude Science experts, enabled state, skills, connectors, and tools. Prompts are omitted unless explicitly requested.",
      inputSchema: {
        type: "object",
        properties: {
          names: {type: "array", items: {type: "string"}},
          include_prompt: {type: "boolean", default: false}
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "claude_science_expert_action",
      title: "Manage Claude Science Expert",
      description: "Create, update, enable, delete, or manage prompts, skills, connectors, and exclusions for a Claude Science expert. Writes require confirmation and are never retried.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "create",
              "update",
              "delete",
              "set_enabled",
              "get_prompt",
              "set_prompt",
              "delete_prompt",
              "attach_skill",
              "detach_skill",
              "update_skills",
              "attach_connector",
              "detach_connector",
              "set_connector_exclusions"
            ]
          },
          confirm: {type: "boolean", default: false},
          name: {type: "string"},
          expert: {type: "object"},
          patch: {type: "object"},
          enabled: {type: "boolean"},
          prompt_text: {type: "string"},
          skill_name: {type: "string"},
          attach: {type: "array", items: {type: "string"}},
          detach: {type: "array", items: {type: "string"}},
          server_id: {type: "string"},
          include_tools_pattern: {type: "string"},
          exclude_tools_pattern: {type: "string"},
          allow_unauthorized: {type: "boolean"},
          excluded_tools: {type: "array", items: {type: "string"}}
        },
        required: ["action"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "claude_science_list_models",
      title: "List Claude Science Models",
      description: "List the model catalog currently visible to Claude Science and the default model id.",
      inputSchema: {
        type: "object",
        properties: {provider: {type: "string"}},
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "claude_science_settings",
      title: "Claude Science Settings",
      description: "Read or update a guarded allowlist of Claude Science settings: reviewer model, network allowlist, built-in allowlist, telemetry consent, Git identity, Conda mirror, and use intent.",
      inputSchema: {
        type: "object",
        properties: {
          action: {type: "string", enum: ["get", "set"]},
          setting: {
            type: "string",
            enum: [
              "reviewer_model",
              "allowed_domains",
              "builtin_allowlist_disabled",
              "builtin_allowlist_disabled_groups",
              "telemetry_consent",
              "git_identity",
              "conda_mirror",
              "use_intent"
            ]
          },
          value: {},
          confirm: {type: "boolean", default: false}
        },
        required: ["action", "setting"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "claude_science_safari_page",
      title: "Control Exact Claude Science Safari Page",
      description: "Freshly discover an exact Claude Science Safari page by current loopback port plus project/frame route, then find, snapshot, click, or fill one semantically exact element. Ambiguous matches never act.",
      inputSchema: {
        type: "object",
        properties: {
          action: {type: "string", enum: ["find", "focus", "snapshot", "click", "fill"]},
          project_id: {type: "string"},
          frame_id: {type: "string"},
          role: {type: "string"},
          name: {type: "string"},
          context: {type: "string"},
          value: {type: "string"},
          confirm: {type: "boolean", default: false}
        },
        required: ["action", "project_id"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "claude_science_list_sessions",
      title: "List Claude Science Sessions",
      description: "List root frames, statuses, and titles for one Claude Science project.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        },
        required: ["project_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "claude_science_session_config",
      title: "Read or Set Claude Science Session Configuration",
      description: "Read or set explicit persisted Auto-review, Memory, and Reviewer override for an existing exact root on audited 0.1.52. Set requires confirm=true, one POST, and independent fresh GET confirmation. Model/effort/delegation are send-time inputs; Specialist/Compute preconfiguration and a complete eight-item menu preset are not supported. Unknown results are never retried.",
      inputSchema: {
        type: "object",
        properties: {
          action: {type: "string", enum: ["get", "set"]},
          frame_id: {type: "string", description: "Existing exact root session, never a child."},
          config: sessionConfigSchema(),
          confirm: {type: "boolean", default: false},
        },
        required: ["action", "frame_id"],
        additionalProperties: false,
      },
      annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true},
    },
    {
      name: "claude_science_submit_task",
      title: "Submit Claude Science Task",
      description:
        "Submit one task to a project, or create a prompt-named project when no project id is supplied. Writes are never automatically retried.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          project_id: { type: "string" },
          project_name: { type: "string" },
          model: { type: "string" },
          effort: {type: "string", enum: [...REQUEST_EFFORTS], description: "Audited 0.1.52 send-time request; model capability may constrain it. Not preconfigured/effective proof."},
          ultra_mode: {type: "boolean", description: "Audited 0.1.52 send-time delegation request; false means Off."},
          expected_session_config: {...expectedSessionConfigSchema(), description: "Not supported for new task submission: no existing root can be independently preconfirmed. Supplied guard rejects before any project/task write; use continue_session for an existing root."},
          plan_mode: { type: "boolean", default: false },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    {
      name: "claude_science_continue_session",
      title: "Continue Claude Science Session",
      description: "Send one follow-up task to a root frame. Writes are never automatically retried.",
      inputSchema: {
        type: "object",
        properties: {
          frame_id: { type: "string" },
          prompt: { type: "string" },
          model: { type: "string" },
          effort: {type: "string", enum: [...REQUEST_EFFORTS], description: "Audited 0.1.52 send-time request, not independently persisted or provider-effective Max proof."},
          ultra_mode: {type: "boolean", description: "Audited 0.1.52 delegation is placed inside input_data. False requests Off, not prior storage confirmation."},
          expected_session_config: expectedSessionConfigSchema(),
        },
        required: ["frame_id", "prompt"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    {
      name: "claude_science_poll_session",
      title: "Poll Claude Science Session",
      description:
        "Wait up to 45 seconds for a frame and return status, incremental messages, approval items, and any final answer.",
      inputSchema: {
        type: "object",
        properties: {
          frame_id: { type: "string" },
          wait_seconds: { type: "integer", minimum: 0, maximum: 45, default: 10 },
          from_message: { type: "integer", minimum: 0, maximum: 1000000, default: 0 },
        },
        required: ["frame_id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "claude_science_list_artifacts",
      title: "List Claude Science Artifacts",
      description:
        "List artifact metadata for exactly one project or frame. Downloads and exports use the GUI.",
      inputSchema: {
        type: "object",
        properties: { project_id: { type: "string" }, frame_id: { type: "string" } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

export async function callTool(inspector, name, args = {}) {
  if (name === "claude_science_status") return statusOperation(inspector);
  if (name === "claude_science_list_projects") return listProjectsOperation(inspector, args);
  if (name === "claude_science_list_experts") return listExpertsOperation(inspector, args);
  if (name === "claude_science_expert_action") return expertActionOperation(inspector, args);
  if (name === "claude_science_list_models") return listModelsOperation(inspector, args);
  if (name === "claude_science_settings") return settingsOperation(inspector, args);
  if (name === "claude_science_session_config") return sessionConfigOperation(inspector, args);
  if (name === "claude_science_safari_page") return safariPageOperation(inspector, args);
  if (name === "claude_science_list_sessions") return listSessionsOperation(inspector, args);
  if (name === "claude_science_submit_task") return submitTaskOperation(inspector, args);
  if (name === "claude_science_continue_session") return continueSessionOperation(inspector, args);
  if (name === "claude_science_poll_session") return pollSessionOperation(inspector, args);
  if (name === "claude_science_list_artifacts") return listArtifactsOperation(inspector, args);
  throw new OperatorError("INVALID_PARAMS", `Unknown tool: ${name || ""}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

export function startServer(inspector = new RuntimeInspector()) {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    void (async () => {
      const { id, method, params } = message;
      if (method === "initialize") {
        return sendResult(id, {
          protocolVersion: params?.protocolVersion ?? "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            "Call claude_science_status before other tools. Use private API tools only when compatible. Use Computer Use for startup, login, approval, uploads, downloads, export, or fallback. Never retry STATE_UNCERTAIN writes.",
        });
      }
      if (method === "ping") return sendResult(id, {});
      if (method === "tools/list") return sendResult(id, { tools: toolsList() });
      if (method === "tools/call") {
        try {
          return sendResult(id, await callTool(inspector, params?.name, params?.arguments ?? {}));
        } catch (error) {
          const clean = cleanError(error);
          return sendResult(id, {
            isError: true,
            content: [{ type: "text", text: `${clean.code}: ${clean.message}` }],
            structuredContent: clean,
          });
        }
      }
      if (id !== undefined) sendError(id, JsonRpcError.METHOD_NOT_FOUND, `Method not found: ${method}`);
    })().catch(() => {
      if (message.id !== undefined) {
        sendError(message.id, JsonRpcError.INTERNAL_ERROR, "Internal Claude Science Operator error.");
      }
    });
  });
  return lines;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) startServer();
