import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OperatorError,
  ScienceClient,
  StateUncertainError,
  assertSecureExecutable,
  buildSciencePageScript,
  callTool,
  extractSingleControlUrl,
  isApiCompatible,
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

function authenticatedClient(origin, port, responseLimit) {
  return new ScienceClient({
    origin,
    port,
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
