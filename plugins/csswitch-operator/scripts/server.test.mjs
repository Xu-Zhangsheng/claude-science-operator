import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BridgeClient,
  OperatorError,
  StateUncertainError,
  callTool,
  readControlRecord,
} from "./server.mjs";

async function fixtureRecord(t, port, extra = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "csswitch-operator-test-"));
  const file = path.join(directory, "control.json");
  await fs.writeFile(file, JSON.stringify({
    schema_version: 2,
    protocol_version: "2.0.0",
    port,
    token: "0123456789abcdef0123456789abcdef",
    pid: process.pid,
    ...extra,
  }), {mode: 0o600});
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  return file;
}

async function serverFixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

test("secure control record rejects symlinks and broad permissions", async (t) => {
  const record = await fixtureRecord(t, 12345);
  await fs.chmod(record, 0o644);
  await assert.rejects(() => readControlRecord(record), (error) => error.code === "CSSWITCH_CONTROL_UNSAFE");

  await fs.chmod(record, 0o600);
  const link = `${record}.link`;
  await fs.symlink(record, link);
  await assert.rejects(() => readControlRecord(link), (error) => error.code === "CSSWITCH_CONTROL_UNSAFE");
});

test("read calls authenticate and redact secrets", async (t) => {
  let calls = 0;
  const port = await serverFixture(t, (request, response) => {
    calls += 1;
    assert.equal(request.headers["x-csswitch-control"], "0123456789abcdef0123456789abcdef");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ok: true, secret: "hidden", result: {name: "safe", api_key: "hidden"}}));
  });
  const recordPath = await fixtureRecord(t, port);
  const result = await new BridgeClient({recordPath}).request("GET", "/v1/status");
  assert.equal(calls, 1);
  assert.deepEqual(result, {ok: true, result: {name: "safe"}});
});

test("safe reads retry once but writes are dispatched exactly once", async (t) => {
  let readCalls = 0;
  const readPort = await serverFixture(t, (request, response) => {
    readCalls += 1;
    if (readCalls === 1) {
      request.socket.destroy();
      return;
    }
    response.end(JSON.stringify({ok: true}));
  });
  const readRecord = await fixtureRecord(t, readPort);
  assert.deepEqual(await new BridgeClient({recordPath: readRecord}).request("GET", "/v1/status"), {ok: true});
  assert.equal(readCalls, 2);

  let writeCalls = 0;
  const writePort = await serverFixture(t, (request) => {
    writeCalls += 1;
    request.socket.destroy();
  });
  const writeRecord = await fixtureRecord(t, writePort);
  await assert.rejects(
    () => new BridgeClient({recordPath: writeRecord}).request("POST", "/v1/profile", {
      body: {intent_id: "intent"},
      write: true,
      intentId: "intent",
      operation: "profile:create",
    }),
    StateUncertainError,
  );
  assert.equal(writeCalls, 1);
});

test("tool layer requires explicit confirmation and never returns supplied keys", async () => {
  const client = {request: async (_method, _route, options) => ({ok: true, echoed: options?.body})};
  await assert.rejects(
    () => callTool("csswitch_profile_action", {
      action: "create",
      template_id: "relay",
      name: "test",
      key: "do-not-return",
      expected_config_fingerprint: "fp",
      confirm: false,
    }, client),
    (error) => error instanceof OperatorError && error.code === "CONFIRMATION_REQUIRED",
  );
  const result = await callTool("csswitch_profile_action", {
    action: "create",
    template_id: "relay",
    name: "test",
    key: "do-not-return",
    expected_config_fingerprint: "fp",
    confirm: true,
  }, client);
  assert.doesNotMatch(result.content[0].text, /do-not-return/);
});
