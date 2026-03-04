#!/usr/bin/env node

const baseUrl = (process.argv[2] ?? "http://localhost:8787").replace(/\/+$/, "");
const sessionId = process.argv[3] ?? "do-smoke-session";
const sessionEndpoint = `${baseUrl}/session/${encodeURIComponent(sessionId)}`;
const debugSqlEndpoint = `${sessionEndpoint}/debug/sql`;

let rpcId = 1;
const wsMessages = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = predicate();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function rpc(method, params = {}, id = rpcId++) {
  const response = await fetch(sessionEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    }),
  });
  const body = await response.json();
  return { status: response.status, body };
}

function expectRpcResult(result, method) {
  assert(result.status === 200, `${method}: expected HTTP 200, got ${result.status}`);
  assert(!result.body.error, `${method}: unexpected rpc error ${JSON.stringify(result.body.error)}`);
  assert(result.body.result !== undefined, `${method}: missing result`);
}

async function debugSql(sql, params = []) {
  const response = await fetch(debugSqlEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const body = await response.json();
  assert(response.status === 200, `debug/sql HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function openWebSocket() {
  return new Promise((resolve, reject) => {
    const wsUrl = sessionEndpoint.replace(/^http/i, "ws");
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error("failed to open websocket")), {
      once: true,
    });
    ws.addEventListener("message", (event) => {
      try {
        wsMessages.push(JSON.parse(String(event.data)));
      } catch (error) {
        wsMessages.push({ parseError: String(error), raw: String(event.data) });
      }
    });
  });
}

async function closeWebSocket(ws) {
  if (ws.readyState >= WebSocket.CLOSING) {
    return;
  }
  await new Promise((resolve) => {
    ws.addEventListener("close", () => resolve(), { once: true });
    ws.close(1000, "done");
  });
}

async function main() {
  console.log(`BASE=${baseUrl}`);
  console.log(`SESSION=${sessionId}`);

  const health = await fetch(`${baseUrl}/healthz`);
  assert(health.status === 200, `healthz HTTP ${health.status}`);
  assert((await health.text()) === "ok", "healthz body should be ok");

  const init = await rpc("initialize", {});
  expectRpcResult(init, "initialize");
  assert(
    init.body.result.serverInfo?.name === "codex-app-server-wasm",
    `unexpected server name: ${init.body.result.serverInfo?.name}`,
  );

  const threadStart = await rpc("thread/start", {
    preview: "smoke thread",
    sourceKind: "cloudflare",
    modelProvider: "openai",
    model: "gpt-5",
  });
  expectRpcResult(threadStart, "thread/start");
  const threadId = threadStart.body.result.thread.id;
  assert(threadId, "thread/start did not return a thread id");

  const ws = await openWebSocket();

  const turnStart = await rpc("turn/start", {
    threadId,
    input: [{ type: "text", text: "hello from smoke test" }],
  });
  expectRpcResult(turnStart, "turn/start");
  assert(turnStart.body.result.turn.status === "completed", "turn should be completed");
  const assistantText = turnStart.body.result.output?.text ?? "";
  assert(
    typeof assistantText === "string" && assistantText.trim().length > 0,
    `assistant output was empty: ${assistantText}`,
  );
  assert(
    !assistantText.startsWith("Echo from Wasm app-server:"),
    `assistant output still looks synthetic: ${assistantText}`,
  );

  const commandTurn = await rpc("turn/start", {
    threadId,
    input: [{ type: "text", text: "!pwd" }],
  });
  expectRpcResult(commandTurn, "turn/start (!pwd)");
  const commandText = commandTurn.body.result.output?.text ?? "";
  assert(
    typeof commandText === "string" && commandText.includes("$ pwd"),
    `command output missing prompt: ${commandText}`,
  );

  const toolTurn = await rpc("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text: "Run the command pwd and return its exact output only.",
      },
    ],
  });
  expectRpcResult(toolTurn, "turn/start (tool call)");
  const toolText = toolTurn.body.result.output?.text ?? "";
  assert(
    typeof toolText === "string" && toolText.includes("/"),
    `tool output missing expected pwd result: ${toolText}`,
  );

  await waitFor(
    () => wsMessages.find((message) => message.method === "turn/completed"),
    4000,
    "turn/completed notification",
  );

  const turns = await debugSql(
    "SELECT id, thread_id AS threadId, seq, status FROM turns WHERE thread_id = ? ORDER BY seq;",
    [threadId],
  );
  assert(Array.isArray(turns.rows), "turns.rows must be an array");
  assert(turns.rows.length >= 1, "expected at least one turn row");
  assert(turns.rows[0].status === "completed", `unexpected turn status: ${turns.rows[0].status}`);

  const assistantEvents = await debugSql(
    "SELECT event_type AS eventType, body_json AS bodyJson FROM event_log WHERE thread_id = ? AND event_type = 'assistant.message' ORDER BY event_seq;",
    [threadId],
  );
  assert(Array.isArray(assistantEvents.rows), "assistantEvents.rows must be an array");
  assert(assistantEvents.rows.length >= 1, "expected assistant.message event rows");

  await closeWebSocket(ws);

  console.log("smoke test passed");
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exit(1);
});
