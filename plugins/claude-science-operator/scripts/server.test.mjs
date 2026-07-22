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
  extractSingleControlUrl,
  isApiCompatible,
  publicConfig,
  responseCookies,
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
  assert.equal(isApiCompatible({ ...supported, scienceVersion: "0.1.21" }), false);
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
