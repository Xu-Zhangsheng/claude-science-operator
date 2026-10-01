import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OperatorError,
  RuntimeInspector,
  ScienceClient,
  StateUncertainError,
  assertSecureExecutable,
  buildSciencePageScript,
  callTool,
  extractSingleControlUrl,
  isApiCompatible,
  isScienceHealthyPayload,
  normalizeModelCatalog,
  publicConfig,
  responseCookies,
  selectExactSciencePage,
  validateControlUrl,
} from "./server.mjs";

async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    return await callback({ origin, port: address.port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

async function bodyText(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function authenticatedClient(origin, port, responseLimit, scienceVersion = "0.1.43") {
  return new ScienceClient({
    origin,
    port,
    scienceVersion,
    responseLimit,
    controlUrlProvider: async () => `${origin}/open?nonce=fresh_nonce-123`,
  });
}

test("control URL accepts one exact loopback nonce", () => {
  assert.deepEqual(validateControlUrl("http://127.0.0.1:8990/open?nonce=abc_123-XYZ", 8990), {
    origin: "http://127.0.0.1:8990",
    nonce: "abc_123-XYZ",
  });
  assert.deepEqual(validateControlUrl("http://localhost:8990/?nonce=abc.123~x", 8990), {
    origin: "http://localhost:8990",
    nonce: "abc.123~x",
  });
});

test("control URL fails closed for remote hosts, ports, userinfo, fragments, and duplicate nonces", () => {
  const invalid = [
    "http://example.com:8990/?nonce=abc",
    "https://127.0.0.1:8990/?nonce=abc",
    "http://127.0.0.1:8991/?nonce=abc",
    "http://user@127.0.0.1:8990/?nonce=abc",
    "http://127.0.0.1:8990/?nonce=abc#fragment",
    "http://127.0.0.1:8990/?nonce=abc&nonce=def",
    "http://127.0.0.1:8990/?nonce=abc%2Fdef",
    "http://[::1]:8990/?nonce=abc",
  ];
  for (const value of invalid) {
    assert.throws(() => validateControlUrl(value, 8990), OperatorError);
  }
  assert.throws(
    () =>
      extractSingleControlUrl(
        "http://127.0.0.1:8990/?nonce=one http://127.0.0.1:8990/?nonce=two",
        8990,
      ),
    OperatorError,
  );
});

test("cookie parser extracts only cookie values", () => {
  const cookies = responseCookies([
    "operon_auth=auth-secret; HttpOnly; Path=/",
    "operon_csrf=csrf-secret; SameSite=Strict; Path=/",
  ]);
  assert.equal(cookies.get("operon_auth"), "auth-secret");
  assert.equal(cookies.get("operon_csrf"), "csrf-secret");
});

test("CSSwitch config projection drops keys, URLs, secrets, and credential references", () => {
  const projected = publicConfig({
    schema_version: 4,
    mode: "proxy",
    proxy_port: 18991,
    sandbox_port: 8990,
    active_id: "profile-1",
    secret: "top-secret",
    profiles: [
      {
        id: "profile-1",
        name: "Codex",
        category: "experimental",
        api_format: "openai",
        api_key: "sk-secret",
        base_url: "https://private.invalid",
        credential_ref: "credential-secret",
      },
    ],
  });
  const encoded = JSON.stringify(projected);
  assert.equal(projected.active_profile.name, "Codex");
  assert.doesNotMatch(encoded, /top-secret|sk-secret|private\.invalid|credential-secret/);
});

test("compatibility gate is exact", () => {
  const supported = {
    scienceVersion: "0.1.20",
    schemaVersion: 4,
    binaryVerified: true,
    running: true,
    healthy: true,
    portMatches: true,
  };
  assert.equal(isApiCompatible(supported), true);
  assert.equal(isApiCompatible({ ...supported, scienceVersion: "0.1.25" }), true);
  assert.equal(isApiCompatible({ ...supported, scienceVersion: "0.1.43" }), true);
  assert.equal(isApiCompatible({ ...supported, scienceVersion: "0.1.52" }), true);
  assert.equal(isApiCompatible({ ...supported, scienceVersion: "0.1.53" }), false);
  assert.equal(isApiCompatible({ ...supported, scienceVersion: "0.1.21" }), false);
  assert.equal(isApiCompatible({ ...supported, scienceVersion: "0.1.44" }), false);
  assert.equal(isApiCompatible({ ...supported, schemaVersion: 5 }), false);
  assert.equal(isApiCompatible({ ...supported, portMatches: false }), false);
});

test("binary validation rejects non-executable files and symbolic links", async () => {
  const temporary = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "claude-science-binary-test-")),
  );
  const executable = path.join(temporary, "claude-science");
  const symlink = path.join(temporary, "linked-science");
  try {
    await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    await assert.rejects(assertSecureExecutable(executable), OperatorError);
    await fs.chmod(executable, 0o700);
    await assert.doesNotReject(assertSecureExecutable(executable));
    await fs.symlink(executable, symlink);
    await assert.rejects(assertSecureExecutable(symlink), OperatorError);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("nonce, auth cookie, CSRF cookie, and read retry work on loopback", async () => {
  let authCount = 0;
  let csrfCount = 0;
  let readCount = 0;
  await withServer(async (request, response) => {
    if (request.url === "/api/auth/nonce") {
      authCount += 1;
      assert.equal(request.method, "POST");
      assert.equal(request.headers.origin, `http://${request.headers.host}`);
      assert.match(await bodyText(request), /nonce=fresh_nonce-123/);
      return json(response, 200, {}, { "Set-Cookie": "operon_auth=auth-token; HttpOnly; Path=/" });
    }
    if (request.url === "/api/csrf") {
      csrfCount += 1;
      assert.equal(request.headers.cookie, "operon_auth=auth-token");
      return json(response, 200, {}, { "Set-Cookie": "operon_csrf=csrf-token; Path=/" });
    }
    if (request.url === "/api/read") {
      readCount += 1;
      assert.match(request.headers.cookie, /operon_auth=auth-token/);
      if (readCount === 1) return json(response, 401, { error: "expired" });
      return json(response, 200, { ok: true });
    }
    return json(response, 404, {});
  }, async ({ origin, port }) => {
    const client = authenticatedClient(origin, port);
    assert.deepEqual(await client.request("/api/read"), { ok: true });
  });
  assert.equal(authCount, 2);
  assert.equal(csrfCount, 2);
  assert.equal(readCount, 2);
});

test("read transport failure is safely retried once", async () => {
  let readCount = 0;
  await withServer(async (request, response) => {
    if (request.url === "/api/auth/nonce") {
      await bodyText(request);
      return json(response, 200, {}, { "Set-Cookie": "operon_auth=auth-token; Path=/" });
    }
    if (request.url === "/api/csrf") {
      return json(response, 200, {}, { "Set-Cookie": "operon_csrf=csrf-token; Path=/" });
    }
    if (request.url === "/api/read") {
      readCount += 1;
      if (readCount === 1) {
        request.socket.destroy();
        return;
      }
      return json(response, 200, { recovered: true });
    }
    return json(response, 404, {});
  }, async ({ origin, port }) => {
    const client = authenticatedClient(origin, port);
    assert.deepEqual(await client.request("/api/read"), { recovered: true });
  });
  assert.equal(readCount, 2);
});

test("write sends cookie and CSRF once", async () => {
  let writeCount = 0;
  await withServer(async (request, response) => {
    if (request.url === "/api/auth/nonce") {
      await bodyText(request);
      return json(response, 200, {}, { "Set-Cookie": "operon_auth=auth-token; Path=/" });
    }
    if (request.url === "/api/csrf") {
      return json(response, 200, {}, { "Set-Cookie": "operon_csrf=csrf-token; Path=/" });
    }
    if (request.url === "/api/write") {
      writeCount += 1;
      assert.equal(request.headers["x-operon-csrf"], "csrf-token");
      assert.match(request.headers.cookie, /operon_auth=auth-token; operon_csrf=csrf-token/);
      assert.deepEqual(JSON.parse(await bodyText(request)), { intent_id: "intent-1" });
      return json(response, 200, { id: "frame-1" });
    }
    return json(response, 404, {});
  }, async ({ origin, port }) => {
    const client = authenticatedClient(origin, port);
    assert.deepEqual(
      await client.request("/api/write", {
        method: "POST",
        write: true,
        intentId: "intent-1",
        operation: "test write",
        body: { intent_id: "intent-1" },
      }),
      { id: "frame-1" },
    );
  });
  assert.equal(writeCount, 1);
});

test("unknown write result returns STATE_UNCERTAIN and is never resent", async () => {
  let writeCount = 0;
  await withServer(async (request, response) => {
    if (request.url === "/api/auth/nonce") {
      await bodyText(request);
      return json(response, 200, {}, { "Set-Cookie": "operon_auth=auth-token; Path=/" });
    }
    if (request.url === "/api/csrf") {
      return json(response, 200, {}, { "Set-Cookie": "operon_csrf=csrf-token; Path=/" });
    }
    if (request.url === "/api/write") {
      writeCount += 1;
      request.socket.destroy();
      return;
    }
    return json(response, 404, {});
  }, async ({ origin, port }) => {
    const client = authenticatedClient(origin, port);
    await assert.rejects(
      client.request("/api/write", {
        method: "POST",
        write: true,
        intentId: "intent-uncertain",
        operation: "test write",
        body: { intent_id: "intent-uncertain" },
      }),
      (error) =>
        error instanceof StateUncertainError &&
        error.code === "STATE_UNCERTAIN" &&
        error.details.intent_id === "intent-uncertain",
    );
  });
  assert.equal(writeCount, 1);
});

test("response size limit fails closed", async () => {
  await withServer(async (request, response) => {
    if (request.url === "/api/auth/nonce") {
      await bodyText(request);
      return json(response, 200, {}, { "Set-Cookie": "operon_auth=auth-token; Path=/" });
    }
    if (request.url === "/api/csrf") {
      return json(response, 200, {}, { "Set-Cookie": "operon_csrf=csrf-token; Path=/" });
    }
    if (request.url === "/api/large") return json(response, 200, { data: "x".repeat(200) });
    return json(response, 404, {});
  }, async ({ origin, port }) => {
    const client = authenticatedClient(origin, port, 64);
    await assert.rejects(
      client.request("/api/large"),
      (error) => error instanceof OperatorError && error.code === "SCIENCE_RESPONSE_LIMIT",
    );
  });
});

test("exact Safari page selection uses current port and full project/frame route", () => {
  const tabs = [
    {
      window_index: 1,
      tabs: [
        {
          id: "w1-t1",
          window_index: 1,
          tab_index: 1,
          title: "Claude Science",
          url: "http://localhost:8990/projects/proj-one/frames/frame-one",
        },
        {
          id: "w1-t2",
          window_index: 1,
          tab_index: 2,
          title: "Claude Science",
          url: "http://localhost:8990/projects/proj-one/frames/frame-two",
        },
        {
          id: "w1-t3",
          window_index: 1,
          tab_index: 3,
          title: "Claude Science",
          url: "http://localhost:8990/projects/proj-one",
        },
        {
          id: "w1-t4",
          window_index: 1,
          tab_index: 4,
          title: "Claude Science",
          url: "http://localhost:8991/projects/proj-one/frames/frame-one",
        },
      ],
    },
  ];
  const frame = selectExactSciencePage(tabs, {
    port: 8990,
    projectId: "proj-one",
    frameId: "frame-two",
  });
  assert.equal(frame.matched, true);
  assert.equal(frame.candidates[0].tab_id, "w1-t2");

  const project = selectExactSciencePage(tabs, {port: 8990, projectId: "proj-one"});
  assert.equal(project.matched, true);
  assert.equal(project.candidates[0].tab_id, "w1-t3");
});

test("exact Safari page selection fails closed on duplicate candidates", () => {
  const candidate = {
    title: "Claude Science",
    url: "http://127.0.0.1:8990/projects/proj-one/frames/frame-one",
  };
  const result = selectExactSciencePage([
    {tabs: [{...candidate, id: "w1-t1", window_index: 1, tab_index: 1}]},
    {tabs: [{...candidate, id: "w2-t1", window_index: 2, tab_index: 1}]},
  ], {port: 8990, projectId: "proj-one", frameId: "frame-one"});
  assert.equal(result.matched, false);
  assert.equal(result.reason, "ambiguous");
  assert.equal(result.candidates.length, 2);
});

test("Safari semantic action script rechecks identity and forbids positional selection", () => {
  const script = buildSciencePageScript({
    port: 8990,
    projectId: "proj-one",
    frameId: "frame-one",
    action: "click",
    role: "menuitemradio",
    name: "GPT-5.6",
    context: "More models",
  });
  assert.match(script, /SCIENCE_PAGE_IDENTITY_CHANGED/);
  assert.match(script, /SCIENCE_ELEMENT_AMBIGUOUS/);
  assert.match(script, /accessibleName\(node\) === normalize\(input\.name\)/);
  assert.doesNotMatch(script, /nth-child|nth-of-type|querySelector\(/);
});

test("model catalog normalization preserves provider identity", () => {
  assert.deepEqual(normalizeModelCatalog({
    default_model_id: "model-a",
    models: {
      provider_a: [{id: "model-a", name: "Model A", overflow: false}],
      provider_b: [{id: "model-b", name: "Model B", overflow: true}],
    },
  }), {
    default_model_id: "model-a",
    models: [
      {provider: "provider_a", id: "model-a", name: "Model A", overflow: false},
      {provider: "provider_b", id: "model-b", name: "Model B", overflow: true},
    ],
  });
});

test("expert creation and settings writes use exact version-gated routes once", async () => {
  const calls = [];
  const inspector = {
    client: async () => ({
      request: async (route, options = {}) => {
        calls.push({route, options});
        return {ok: true};
      },
    }),
  };
  await callTool(inspector, "claude_science_expert_action", {
    action: "create",
    confirm: true,
    expert: {
      name: "My Expert",
      description: "Test expert",
      system_prompt: "Be precise.",
    },
  });
  await callTool(inspector, "claude_science_settings", {
    action: "set",
    setting: "reviewer_model",
    value: "model-a",
    confirm: true,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].route, "/api/agents");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.write, true);
  assert.equal(calls[0].options.body.name, "MY_EXPERT");
  assert.equal(calls[0].options.body.displayName, "My Expert");
  assert.equal(calls[0].options.body.systemPrompt, "Be precise.");
  assert.equal(calls[1].route, "/api/preferences/reviewer-model");
  assert.deepEqual(calls[1].options.body, {model: "model-a"});
  assert.notEqual(calls[0].options.intentId, calls[1].options.intentId);
});

// These are synthetic daemon responses, not captures from an installed app.
async function htmlCookieBootstrap(request, response) {
  const origin = `http://${request.headers.host}`;
  if (request.url === "/api/auth/nonce") {
    assert.equal(request.method, "POST");
    assert.equal(request.headers.origin, origin);
    assert.equal(request.headers["content-type"], "application/x-www-form-urlencoded");
    const form = new URLSearchParams(await bodyText(request));
    assert.ok(form.get("nonce"));
    assert.equal(form.get("dest"), "/");
    assert.deepEqual([...form.keys()], ["nonce", "dest"]);
    response.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-store",
      "Set-Cookie": "operon_auth=auth-token; HttpOnly; SameSite=Strict; Path=/",
    });
    response.end('<meta http-equiv="refresh" content="0;url=/unexpected-navigation">');
    return true;
  }
  if (request.url === "/api/csrf") {
    assert.equal(request.method, "GET");
    assert.equal(request.headers.origin, origin);
    assert.equal(request.headers.cookie, "operon_auth=auth-token");
    response.writeHead(204, {
      "Cache-Control": "no-store",
      "Set-Cookie": "operon_csrf=csrf-token; SameSite=Strict; Path=/",
    });
    response.end();
    return true;
  }
  return false;
}

for (const scienceVersion of ["0.1.20", "0.1.25", "0.1.43", "0.1.52"]) {
  test(`${scienceVersion} accepts HTML 200 nonce plus empty 204 CSRF without navigation`, async () => {
    const requests = [];
    await withServer(async (request, response) => {
      requests.push({method: request.method, route: request.url});
      if (await htmlCookieBootstrap(request, response)) return;
      assert.equal(request.url, "/api/preferences/reviewer-model");
      assert.equal(request.method, "PUT");
      assert.equal(request.headers.origin, `http://${request.headers.host}`);
      assert.equal(request.headers.cookie, "operon_auth=auth-token; operon_csrf=csrf-token");
      assert.equal(request.headers["x-operon-csrf"], "csrf-token");
      assert.deepEqual(JSON.parse(await bodyText(request)), {model: null});
      json(response, 200, {model: null, source: "setting"});
    }, async ({origin, port}) => {
      const client = authenticatedClient(origin, port, undefined, scienceVersion);
      assert.deepEqual(await client.request("/api/preferences/reviewer-model", {
        method: "PUT", write: true, body: {model: null},
        intentId: "intent-html", operation: "reviewer preference",
      }), {model: null, source: "setting"});
    });
    assert.deepEqual(requests, [
      {method: "POST", route: "/api/auth/nonce"},
      {method: "GET", route: "/api/csrf"},
      {method: "PUT", route: "/api/preferences/reviewer-model"},
    ]);
  });
}

for (const scienceVersion of [undefined, "0.1.51", "0.1.53", "0.1.52-preview", "unknown"]) {
  test(`unverified client version ${String(scienceVersion)} fails before local access`, () => {
    assert.throws(() => new ScienceClient({
      origin: "http://127.0.0.1:12345", port: 12345, scienceVersion,
      controlUrlProvider: () => assert.fail("must not generate a nonce"),
      fetchImpl: () => assert.fail("must not dispatch HTTP"),
    }), (error) => error instanceof OperatorError && error.code === "API_INCOMPATIBLE");
  });
}

test("RuntimeInspector passes its verified version without touching the real runtime", async () => {
  for (const scienceVersion of ["0.1.20", "0.1.25", "0.1.43", "0.1.52"]) {
    const inspector = new RuntimeInspector();
    inspector.inspect = async () => ({
      apiCompatible: true, claudeScience: {version: scienceVersion},
      csswitch: {sandbox_port: 12345}, compatibility: {reasons: []},
    });
    const client = await inspector.client();
    assert.equal(client.scienceVersion, scienceVersion);
  }
  const inspector = new RuntimeInspector();
  inspector.inspect = async () => ({apiCompatible: false, compatibility: {reasons: ["unsupported_science_version"]}});
  await assert.rejects(inspector.client(), {code: "API_INCOMPATIBLE"});
});

test("0.1.52 status advertises audited core scope rather than blanket mutation support", async () => {
  const result = await callTool({inspect: async () => ({
    apiCompatible: true, claudeScience: {version: "0.1.52", port: 12345},
    compatibility: {reasons: []},
  })}, "claude_science_status");
  assert.match(result.content[0].text, /audited core API/);
  assert.match(result.content[0].text, /mutations remain disabled/);
});

test("normal readiness remains distinct from degraded and staged-hold status ok", () => {
  assert.equal(isScienceHealthyPayload({status: "healthy", service: "gateway"}), true);
  assert.equal(isScienceHealthyPayload({status: "degraded", service: "gateway"}), false);
  assert.equal(isScienceHealthyPayload({status: "ok", boot: "staged-hold"}), false);
  assert.equal(isScienceHealthyPayload({healthy: true}), true);
  assert.equal(isScienceHealthyPayload({ok: true}), true); // Existing older-contract support.
  assert.equal(isScienceHealthyPayload({status: "healthy-ish"}), false);
});

const unauditedMutations = [
  ["POST", "/api/agents"], ["PATCH", "/api/agents/TEST"], ["DELETE", "/api/agents/TEST"],
  ["PUT", "/api/agents/TEST/custom-prompt"], ["POST", "/api/agents/TEST/skills"],
  ["PUT", "/api/preferences/allowed-domains"], ["PUT", "/api/preferences/git-identity"],
  ["PUT", "/api/models/selection"], ["DELETE", "/api/projects"],
  ["POST", "/api/projects/proj-one/request?extra=1"],
  ["POST", "/api/projects/../request"], ["POST", "/api/projects/%2e%2e/request"],
  ["POST", "/api/projects/unsafe%2Fid/request"], ["POST", "/api/projects/%zz/request"],
  ["POST", "/api/projects/proj-one/message"], ["POST", "/api/frames/frame-one/request"],
  ["PUT", "/api/frames/frame-one/session-config"], ["POST", "/api/projects/proj-one/session-config"],
  ["POST", "/api/frames/../session-config"], ["POST", "/api/frames/frame-one/session-config?extra=1"],
  ["POST", "/api/frames/frame-one/session-config/anything"], ["POST", "/api/frames"],
];
for (const [method, route] of unauditedMutations) {
  test(`0.1.52 blocks unaudited ${method} ${route} before nonce and dispatch`, async () => {
    let controlCalls = 0;
    let fetchCalls = 0;
    const client = new ScienceClient({
      origin: "http://127.0.0.1:12345", port: 12345, scienceVersion: "0.1.52",
      controlUrlProvider: async () => {controlCalls++; return "http://127.0.0.1:12345/?nonce=synthetic_nonce";},
      fetchImpl: async () => {fetchCalls++; throw new Error("unexpected synthetic dispatch");},
    });
    // Omitted write=true must not be a capability-gate or safe-retry bypass.
    await assert.rejects(client.request(route, {method}), {code: "API_ACTION_UNSUPPORTED"});
    client.session = {authCookie: "cached-auth", csrfCookie: "cached-csrf"};
    await assert.rejects(client.request(route, {method, write: true}), {code: "API_ACTION_UNSUPPORTED"});
    assert.equal(controlCalls, 0);
    assert.equal(fetchCalls, 0);
  });
}

for (const route of ["/api/projects", "/api/projects/proj-one/request", "/api/frames/frame-one/message", "/api/projects/proj%3Aone/request"]) {
  test(`0.1.52 audited POST ${route} dispatches once with CSRF`, async () => {
    let writes = 0;
    await withServer(async (request, response) => {
      if (await htmlCookieBootstrap(request, response)) return;
      writes++;
      assert.equal(request.method, "POST");
      assert.equal(request.url, route);
      assert.equal(request.headers["x-operon-csrf"], "csrf-token");
      await bodyText(request);
      json(response, route === "/api/projects" ? 201 : 200, {frame_id: "frame-one", project_id: "proj-one"});
    }, async ({origin, port}) => {
      const client = authenticatedClient(origin, port, undefined, "0.1.52");
      await client.request(route, {method: "POST", write: true, body: {}, intentId: "intent-core"});
    });
    assert.equal(writes, 1);
  });
}

for (const scienceVersion of ["0.1.20", "0.1.25", "0.1.43"]) {
  test(`${scienceVersion} retains legacy guarded expert dispatch`, async () => {
    let writes = 0;
    await withServer(async (request, response) => {
      if (await htmlCookieBootstrap(request, response)) return;
      writes++;
      assert.equal(request.url, "/api/agents");
      assert.equal(request.headers["x-operon-csrf"], "csrf-token");
      await bodyText(request);
      json(response, 200, {name: "TEST"});
    }, async ({origin, port}) => {
      await callTool({client: async () => authenticatedClient(origin, port, undefined, scienceVersion)},
        "claude_science_expert_action", {action: "create", confirm: true, expert: {name: "Test"}});
    });
    assert.equal(writes, 1);
  });
}

for (const scenario of ["used-nonce", "expired-nonce", "missing-auth-cookie", "auth-redirect", "missing-csrf-cookie", "csrf-redirect"]) {
  test(`0.1.52 ${scenario} stops bootstrap without fallback or write`, async () => {
    let authCalls = 0;
    let csrfCalls = 0;
    let writes = 0;
    await withServer(async (request, response) => {
      if (request.url === "/api/auth/nonce") {
        authCalls++;
        if (["used-nonce", "expired-nonce"].includes(scenario)) {
          await bodyText(request);
          response.writeHead(401, {"Content-Type": "text/html"});
          return response.end("<p>synthetic private auth failure</p>");
        }
        if (["missing-auth-cookie", "auth-redirect"].includes(scenario)) {
          await bodyText(request);
          response.writeHead(scenario === "auth-redirect" ? 302 : 200, {
            "Content-Type": "text/html", Location: "/unexpected-navigation",
            ...(scenario === "auth-redirect" ? {"Set-Cookie": "operon_auth=auth-token; Path=/"} : {}),
          });
          return response.end("<p>synthetic private auth failure</p>");
        }
      }
      if (request.url === "/api/csrf") {
        csrfCalls++;
        if (["missing-csrf-cookie", "csrf-redirect"].includes(scenario)) {
          response.writeHead(scenario === "csrf-redirect" ? 307 : 204, {
            Location: "/unexpected-navigation",
            ...(scenario === "csrf-redirect" ? {"Set-Cookie": "operon_csrf=csrf-token; Path=/"} : {}),
          });
          return response.end();
        }
      }
      if (await htmlCookieBootstrap(request, response)) return;
      writes++;
      json(response, 500, {});
    }, async ({origin, port}) => {
      const client = authenticatedClient(origin, port, undefined, "0.1.52");
      await assert.rejects(client.request("/api/preferences/reviewer-model", {
        method: "PUT", write: true, body: {model: null}, intentId: "intent-bootstrap",
      }), (error) => {
        assert.ok(error instanceof OperatorError);
        assert.notEqual(error.code, "STATE_UNCERTAIN"); // No business write was sent.
        assert.doesNotMatch(JSON.stringify(error), /synthetic private|auth-token|csrf-token|fresh_nonce/);
        return true;
      });
    });
    assert.equal(authCalls, 1);
    assert.equal(csrfCalls, scenario.startsWith("csrf-") || scenario === "missing-csrf-cookie" ? 1 : 0);
    assert.equal(writes, 0);
  });
}

test("0.1.52 read reauthenticates once using a new single-use nonce", async () => {
  const consumed = new Set();
  let controlCalls = 0;
  let reads = 0;
  await withServer(async (request, response) => {
    if (request.url === "/api/auth/nonce") {
      const form = new URLSearchParams(await bodyText(request));
      const nonce = form.get("nonce");
      assert.equal(consumed.has(nonce), false);
      consumed.add(nonce);
      response.writeHead(200, {"Content-Type": "text/html", "Set-Cookie": "operon_auth=auth-token; Path=/"});
      return response.end("<p>Signed in</p>");
    }
    if (request.url === "/api/csrf") return void await htmlCookieBootstrap(request, response);
    assert.equal(request.url, "/api/models");
    reads++;
    return json(response, reads === 1 ? 403 : 200, reads === 1 ? {error: "csrf_stale"} : {models: {anthropic: []}});
  }, async ({origin, port}) => {
    const client = new ScienceClient({origin, port, scienceVersion: "0.1.52", controlUrlProvider: async () => {
      controlCalls++;
      return `${origin}/?nonce=single_use_${controlCalls}`;
    }});
    assert.deepEqual(await client.request("/api/models"), {models: {anthropic: []}});
  });
  assert.equal(controlCalls, 2);
  assert.equal(consumed.size, 2);
  assert.equal(reads, 2);
});

for (const invalidUrl of [
  "http://remote.invalid:12345/?nonce=synthetic_nonce", "https://127.0.0.1:12345/?nonce=synthetic_nonce",
  "http://127.0.0.1:12346/?nonce=synthetic_nonce", "http://user@127.0.0.1:12345/?nonce=synthetic_nonce",
  "http://127.0.0.1:12345/?nonce=one&nonce=two", "http://127.0.0.1:12345/?nonce=bad%2Fnonce",
]) {
  test("0.1.52 rejects an invalid control identity before any fetch", async () => {
    const client = new ScienceClient({
      origin: "http://127.0.0.1:12345", port: 12345, scienceVersion: "0.1.52",
      controlUrlProvider: async () => invalidUrl,
      fetchImpl: async () => assert.fail("must not fetch an invalid control identity"),
    });
    await assert.rejects(client.request("/api/preferences/reviewer-model", {
      method: "PUT", write: true, body: {model: null},
    }), {code: "SCIENCE_CONTROL_FAILED"});
  });
}

for (const failure of ["transport", "server-error", "invalid-json", "oversized", "partial-body"]) {
  test(`0.1.52 ${failure} after write is STATE_UNCERTAIN and never resent`, async () => {
    let writes = 0;
    let authCalls = 0;
    await withServer(async (request, response) => {
      if (request.url === "/api/auth/nonce") authCalls++;
      if (await htmlCookieBootstrap(request, response)) return;
      writes++;
      assert.equal(request.url, "/api/preferences/reviewer-model");
      assert.equal(request.headers["x-operon-csrf"], "csrf-token");
      await bodyText(request);
      if (failure === "transport") return request.socket.destroy();
      if (failure === "server-error") return json(response, 503, {error: "synthetic private provider failure"});
      if (failure === "oversized") return json(response, 200, {value: "x".repeat(1024)});
      response.writeHead(200, {
        "Content-Type": "text/html", ...(failure === "partial-body" ? {"Content-Length": "1000", Connection: "close"} : {}),
      });
      response.end("<p>synthetic private provider failure</p>");
    }, async ({origin, port}) => {
      const client = authenticatedClient(origin, port, failure === "oversized" ? 128 : undefined, "0.1.52");
      await assert.rejects(client.request("/api/preferences/reviewer-model", {
        method: "PUT", body: {model: null}, // No write flag: method must still guarantee single-dispatch.
        intentId: "intent-uncertain-52", operation: "reviewer preference",
      }), (error) => {
        assert.ok(error instanceof StateUncertainError);
        assert.equal(error.details.intent_id, "intent-uncertain-52");
        assert.equal(error.details.operation, "reviewer preference");
        assert.doesNotMatch(JSON.stringify(error), /synthetic private|auth-token|csrf-token|fresh_nonce/);
        return true;
      });
    });
    assert.equal(writes, 1);
    assert.equal(authCalls, 1);
  });
}

for (const status of [400, 401, 403]) {
  test(`0.1.52 write rejection ${status} is definite and never reauthenticated`, async () => {
    let writes = 0;
    let authCalls = 0;
    await withServer(async (request, response) => {
      if (request.url === "/api/auth/nonce") authCalls++;
      if (await htmlCookieBootstrap(request, response)) return;
      writes++;
      await bodyText(request);
      // This oversized, invalid optional body cannot turn a received rejection
      // into an unknown result or expose application/provider diagnostics.
      response.writeHead(status, {"Content-Type": "text/html"});
      response.end("synthetic private provider failure".repeat(100));
    }, async ({origin, port}) => {
      const client = authenticatedClient(origin, port, 128, "0.1.52");
      await assert.rejects(client.request("/api/preferences/reviewer-model", {
        method: "PUT", write: true, body: {model: null}, intentId: "intent-rejected",
      }), (error) => {
        assert.equal(error.code, status === 400 ? "SCIENCE_API_FAILED" : "SCIENCE_AUTH_FAILED");
        assert.equal(error.details.status, status);
        assert.doesNotMatch(JSON.stringify(error), /synthetic private|auth-token|csrf-token/);
        return true;
      });
    });
    assert.equal(writes, 1);
    assert.equal(authCalls, 1);
  });
}

for (const [operation, tool, args, route] of [
  ["create project", "claude_science_submit_task", {prompt: "Synthetic request"}, "/api/projects"],
  ["submit task", "claude_science_submit_task", {project_id: "proj-one", prompt: "Synthetic request"}, "/api/projects/proj-one/request"],
  ["continue session", "claude_science_continue_session", {frame_id: "frame-one", prompt: "Synthetic follow-up"}, "/api/frames/frame-one/message"],
]) {
  for (const [label, value] of [
    ["missing", undefined], ["empty", ""], ["wrong-type", 42], ["path", "unsafe/id"],
    ["dot-segment", ".."], ["escaped-path", "unsafe%2Fid"], ["too-long", "x".repeat(257)],
  ]) {
    test(`${operation} ${label} required response ID stays uncertain without resending`, async () => {
      const calls = [];
      const inspector = {client: async () => ({request: async (requestRoute, options) => {
        calls.push({route: requestRoute, options});
        return value === undefined ? {} : {id: value};
      }})};
      await assert.rejects(callTool(inspector, tool, args), (error) => {
        assert.ok(error instanceof StateUncertainError);
        assert.equal(error.details.intent_id, calls[0].options.intentId);
        assert.equal(error.details.operation, operation);
        assert.doesNotMatch(JSON.stringify(error), /unsafe\/id|unsafe%2Fid/);
        return true;
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].route, route);
    });
  }
}

test("task submission cannot mistake a project ID for a confirmed frame ID", async () => {
  let writes = 0;
  const inspector = {client: async () => ({request: async () => {writes++; return {project_id: "proj-one"};}})};
  await assert.rejects(callTool(inspector, "claude_science_submit_task", {
    project_id: "proj-one", prompt: "Synthetic request",
  }), {code: "STATE_UNCERTAIN"});
  assert.equal(writes, 1);
});

for (const intent of ["commercial", "noncommercial"]) {
  test(`0.1.52 audited use-intent ${intent} sends one exact PUT`, async () => {
    let writes = 0;
    await withServer(async (request, response) => {
      if (await htmlCookieBootstrap(request, response)) return;
      writes++;
      assert.equal(request.method, "PUT");
      assert.equal(request.url, "/api/preferences/use-intent");
      assert.equal(request.headers["x-operon-csrf"], "csrf-token");
      assert.deepEqual(JSON.parse(await bodyText(request)), {intent});
      json(response, 200, {intent, declared: true});
    }, async ({origin, port}) => {
      const client = authenticatedClient(origin, port, undefined, "0.1.52");
      const result = await callTool({client: async () => client}, "claude_science_settings", {
        action: "set", setting: "use_intent", value: intent, confirm: true,
      });
      assert.deepEqual(result.structuredContent.result, {intent, declared: true});
    });
    assert.equal(writes, 1);
  });
}

const CONFIG_HTTP_ROOT = "root-config-fixture";
const CONFIG_HTTP_EXPECTED = Object.freeze({verifier_mode: "on", memory_mode: "off", reviewer_model: null});
const CONFIG_HTTP_BEFORE = Object.freeze({verifier_mode: "off", memory_mode: "on", reviewer_model: "old-reviewer-fixture"});

function syntheticConfigFrame(config) {
  return {
    id: CONFIG_HTTP_ROOT, root_frame_id: CONFIG_HTTP_ROOT, parent_frame_id: null,
    status: "completed", model: "initial-column-fixture",
    input_data: {memory_mode: "on"},
    context_data: {
      _original_input: {...config}, _model: "runtime-model-fixture", _effort: "high",
      _private_fixture: "PRIVATE_SYNTHETIC_CONTEXT_SENTINEL",
    },
  };
}

test("synthetic HTTP configure/readback/guarded send uses independent GETs and one write each", async () => {
  let stored = {...CONFIG_HTTP_BEFORE};
  const trace = [];
  await withServer(async (request, response) => {
    trace.push(`${request.method} ${request.url}`);
    if (await htmlCookieBootstrap(request, response)) return;
    assert.equal(request.headers.origin, `http://${request.headers.host}`);
    assert.equal(request.headers.cookie, "operon_auth=auth-token; operon_csrf=csrf-token");
    if (request.url === `/api/frames/${CONFIG_HTTP_ROOT}`) {
      assert.equal(request.method, "GET");
      assert.equal(request.headers["x-operon-csrf"], undefined);
      return json(response, 200, syntheticConfigFrame(stored));
    }
    assert.equal(request.method, "POST");
    assert.equal(request.headers["x-operon-csrf"], "csrf-token");
    const body = JSON.parse(await bodyText(request));
    if (request.url === `/api/frames/${CONFIG_HTTP_ROOT}/session-config`) {
      assert.deepEqual(body, CONFIG_HTTP_EXPECTED); // No ignored model/effort/compute/intent fields.
      stored = {...body};
      return json(response, 200, {root_frame_id: CONFIG_HTTP_ROOT, ...body, status: "ok"});
    }
    assert.equal(request.url, `/api/frames/${CONFIG_HTTP_ROOT}/message`);
    assert.deepEqual(body.input_data, {request: "Synthetic guarded follow-up", ultra_mode: false});
    assert.equal(body.model, "next-model-fixture");
    assert.equal(body.effort, "max");
    assert.equal(Object.hasOwn(body, "ultra_mode"), false);
    assert.equal(Object.hasOwn(body, "session_knobs"), false);
    assert.equal(Object.hasOwn(body, "target_agent"), false);
    return json(response, 200, {root_frame_id: CONFIG_HTTP_ROOT, frame_id: CONFIG_HTTP_ROOT, status: "accepted"});
  }, async ({origin, port}) => {
    const client = authenticatedClient(origin, port, undefined, "0.1.52");
    const inspector = {client: async () => client};
    const configured = await callTool(inspector, "claude_science_session_config", {
      action: "set", frame_id: CONFIG_HTTP_ROOT, config: CONFIG_HTTP_EXPECTED, confirm: true,
    });
    assert.equal(configured.structuredContent.configuration_confirmed, true);
    assert.equal(configured.structuredContent.configuration_scope, "explicit_persisted_knobs");
    assert.equal(configured.structuredContent.active_model, "runtime-model-fixture");
    assert.equal(configured.structuredContent.initial_model, "initial-column-fixture");
    assert.doesNotMatch(JSON.stringify(configured), /PRIVATE_SYNTHETIC_CONTEXT_SENTINEL|auth-token|csrf-token/);
    const sent = await callTool(inspector, "claude_science_continue_session", {
      frame_id: CONFIG_HTTP_ROOT, prompt: "Synthetic guarded follow-up", model: "next-model-fixture",
      effort: "max", ultra_mode: false,
      expected_session_config: {frame_id: CONFIG_HTTP_ROOT, config: CONFIG_HTTP_EXPECTED},
    });
    assert.equal(sent.structuredContent.configuration_scope, "explicit_persisted_knobs");
    assert.deepEqual(sent.structuredContent.requested_send_options, {model: "next-model-fixture", effort: "max", ultra_mode: false});
  });
  assert.deepEqual(trace, [
    "POST /api/auth/nonce", "GET /api/csrf", `GET /api/frames/${CONFIG_HTTP_ROOT}`,
    `POST /api/frames/${CONFIG_HTTP_ROOT}/session-config`, `GET /api/frames/${CONFIG_HTTP_ROOT}`,
    `GET /api/frames/${CONFIG_HTTP_ROOT}`, `POST /api/frames/${CONFIG_HTTP_ROOT}/message`,
  ]);
});

for (const failure of ["transport", "server-error", "bad-json", "wrong-ack", "readback-unavailable", "readback-transport", "stale-readback"]) {
  test(`synthetic HTTP config ${failure} stays uncertain without repeat POST or message`, async () => {
    let writes = 0;
    let reads = 0;
    let messages = 0;
    let controlCalls = 0;
    await withServer(async (request, response) => {
      if (await htmlCookieBootstrap(request, response)) return;
      if (request.url === `/api/frames/${CONFIG_HTTP_ROOT}`) {
        reads++;
        if (reads > 1 && failure === "readback-unavailable") return json(response, 503, {error: "PRIVATE_SYNTHETIC_CONTEXT_SENTINEL"});
        if (reads > 1 && failure === "readback-transport") return request.socket.destroy();
        return json(response, 200, syntheticConfigFrame(CONFIG_HTTP_BEFORE));
      }
      if (request.url === `/api/frames/${CONFIG_HTTP_ROOT}/message`) {
        messages++;
        return json(response, 500, {});
      }
      assert.equal(request.url, `/api/frames/${CONFIG_HTTP_ROOT}/session-config`);
      assert.equal(request.method, "POST");
      assert.equal(request.headers["x-operon-csrf"], "csrf-token");
      assert.deepEqual(JSON.parse(await bodyText(request)), CONFIG_HTTP_EXPECTED);
      writes++;
      if (failure === "transport") return request.socket.destroy();
      if (failure === "server-error") return json(response, 503, {error: "PRIVATE_SYNTHETIC_CONTEXT_SENTINEL"});
      if (failure === "bad-json") {
        response.writeHead(200, {"Content-Type": "text/html"});
        return response.end("<p>PRIVATE_SYNTHETIC_CONTEXT_SENTINEL</p>");
      }
      return json(response, 200, {
        root_frame_id: failure === "wrong-ack" ? "foreign-root-fixture" : CONFIG_HTTP_ROOT,
        ...CONFIG_HTTP_EXPECTED, status: "ok",
      });
    }, async ({origin, port}) => {
      const client = new ScienceClient({origin, port, scienceVersion: "0.1.52", controlUrlProvider: async () => {
        controlCalls++;
        return `${origin}/?nonce=config_read_nonce_${controlCalls}`;
      }});
      await assert.rejects(callTool({client: async () => client}, "claude_science_session_config", {
        action: "set", frame_id: CONFIG_HTTP_ROOT, config: CONFIG_HTTP_EXPECTED, confirm: true,
      }), (error) => {
        assert.ok(error instanceof StateUncertainError);
        assert.equal(error.details.operation, "set session config");
        assert.equal(typeof error.details.intent_id, "string");
        assert.doesNotMatch(JSON.stringify(error), /PRIVATE_SYNTHETIC_CONTEXT_SENTINEL|foreign-root-fixture|auth-token|csrf-token|config_read_nonce/);
        return true;
      });
    });
    assert.equal(writes, 1);
    assert.equal(messages, 0);
    assert.equal(reads, failure === "readback-transport" ? 3 : failure.startsWith("readback-") || failure === "stale-readback" ? 2 : 1);
    assert.equal(controlCalls, failure === "readback-transport" ? 2 : 1);
  });
}

test("synthetic HTTP stale guarded config performs no repair or message", async () => {
  let reads = 0;
  let writes = 0;
  await withServer(async (request, response) => {
    if (await htmlCookieBootstrap(request, response)) return;
    if (request.method !== "GET") {
      writes++;
      return json(response, 500, {});
    }
    reads++;
    assert.equal(request.url, `/api/frames/${CONFIG_HTTP_ROOT}`);
    json(response, 200, syntheticConfigFrame(CONFIG_HTTP_BEFORE));
  }, async ({origin, port}) => {
    const client = authenticatedClient(origin, port, undefined, "0.1.52");
    await assert.rejects(callTool({client: async () => client}, "claude_science_continue_session", {
      frame_id: CONFIG_HTTP_ROOT, prompt: "Synthetic request that must not be dispatched",
      expected_session_config: {frame_id: CONFIG_HTTP_ROOT, config: CONFIG_HTTP_EXPECTED},
    }), {code: "SESSION_CONFIG_UNCONFIRMED"});
  });
  assert.equal(reads, 1);
  assert.equal(writes, 0);
});

test("synthetic HTTP guarded message transport uncertainty never rewrites config or resends", async () => {
  let messages = 0;
  let configWrites = 0;
  let reads = 0;
  await withServer(async (request, response) => {
    if (await htmlCookieBootstrap(request, response)) return;
    if (request.url === `/api/frames/${CONFIG_HTTP_ROOT}`) {
      reads++;
      return json(response, 200, syntheticConfigFrame(CONFIG_HTTP_EXPECTED));
    }
    if (request.url === `/api/frames/${CONFIG_HTTP_ROOT}/session-config`) {
      configWrites++;
      return json(response, 500, {});
    }
    messages++;
    assert.equal(request.url, `/api/frames/${CONFIG_HTTP_ROOT}/message`);
    assert.equal(request.headers["x-operon-csrf"], "csrf-token");
    await bodyText(request);
    request.socket.destroy();
  }, async ({origin, port}) => {
    const client = authenticatedClient(origin, port, undefined, "0.1.52");
    await assert.rejects(callTool({client: async () => client}, "claude_science_continue_session", {
      frame_id: CONFIG_HTTP_ROOT, prompt: "Synthetic bounded message",
      expected_session_config: {frame_id: CONFIG_HTTP_ROOT, config: CONFIG_HTTP_EXPECTED},
    }), {code: "STATE_UNCERTAIN"});
  });
  assert.equal(reads, 1);
  assert.equal(messages, 1);
  assert.equal(configWrites, 0);
});

test("synthetic HTTP child preflight never reaches the root-normalizing config setter", async () => {
  let reads = 0;
  let writes = 0;
  await withServer(async (request, response) => {
    if (await htmlCookieBootstrap(request, response)) return;
    if (request.method !== "GET") {
      writes++;
      return json(response, 500, {});
    }
    reads++;
    json(response, 200, {...syntheticConfigFrame(CONFIG_HTTP_BEFORE), id: "child-config-fixture", parent_frame_id: CONFIG_HTTP_ROOT});
  }, async ({origin, port}) => {
    const client = authenticatedClient(origin, port, undefined, "0.1.52");
    await assert.rejects(callTool({client: async () => client}, "claude_science_session_config", {
      action: "set", frame_id: "child-config-fixture", config: CONFIG_HTTP_EXPECTED, confirm: true,
    }), {code: "SCIENCE_SESSION_INVALID"});
  });
  assert.equal(reads, 1);
  assert.equal(writes, 0);
});

test("0.1.52 confirmation guards stop reviewed mutations before nonce generation", async () => {
  const client = new ScienceClient({
    origin: "http://127.0.0.1:12345", port: 12345, scienceVersion: "0.1.52",
    controlUrlProvider: () => assert.fail("must not generate an unconfirmed nonce"),
    fetchImpl: () => assert.fail("must not dispatch an unconfirmed mutation"),
  });
  const inspector = {client: async () => client};
  await assert.rejects(callTool(inspector, "claude_science_settings", {
    action: "set", setting: "reviewer_model", value: null, confirm: false,
  }), {code: "CONFIRMATION_REQUIRED"});
  await assert.rejects(callTool(inspector, "claude_science_expert_action", {
    action: "delete", name: "TEST", confirm: false,
  }), {code: "CONFIRMATION_REQUIRED"});
});
