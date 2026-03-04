import initWasm, {
  WasmAppServer,
} from "../build/platform-wasm/codex_app_server_platform.js";
import wasmModule from "../build/platform-wasm/codex_app_server_platform_bg.wasm";
import { CloudflarePlatform } from "../platform/cloudflarePlatform";

const REGISTRY_SESSION_ID = "__codex_registry__";

type Env = {
  APP_SERVER_SESSION: DurableObjectNamespace;
  SANDBOX_BASE_URL?: string;
  MODEL_HTTP_PROXY_URL?: string;
  JUST_BASH_TIMEOUT_MS?: string;
};

type JsonRpcEnvelope = {
  response: unknown;
  notifications: unknown[];
};

type DebugSqlBody = {
  sql: string;
  params?: unknown[];
};

type SnapshotBody = {
  idSequence: { nextId: number };
  threads: unknown[];
  turns: unknown[];
  eventLog: unknown[];
};

type RegistryRegisterBody = {
  sessionId: string;
  forkedFrom?: string | null;
};

type SessionListEntry = {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  forkedFrom: string | null;
};

let wasmInitPromise: Promise<unknown> | null = null;

function isWebSocketUpgrade(req: Request): boolean {
  const upgradeHeader = req.headers.get("upgrade") ?? req.headers.get("Upgrade");
  return upgradeHeader?.toLowerCase() === "websocket";
}

function sessionStub(env: Env, sessionId: string): DurableObjectStub {
  const durableObjectId = env.APP_SERVER_SESSION.idFromName(sessionId);
  return env.APP_SERVER_SESSION.get(durableObjectId);
}

async function registerSession(
  env: Env,
  sessionId: string,
  forkedFrom: string | null = null,
): Promise<void> {
  const response = await sessionStub(env, REGISTRY_SESSION_ID).fetch(
    "https://registry/registry/register",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        forkedFrom,
      } satisfies RegistryRegisterBody),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`registry register failed: ${response.status} ${body}`);
  }
}

async function listSessions(env: Env): Promise<SessionListEntry[]> {
  const response = await sessionStub(env, REGISTRY_SESSION_ID).fetch(
    "https://registry/registry/list",
    {
      method: "GET",
    },
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`registry list failed: ${response.status} ${body}`);
  }
  const payload = (await response.json()) as { sessions?: SessionListEntry[] };
  return Array.isArray(payload.sessions) ? payload.sessions : [];
}

function uiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codex App Server Cloudflare</title>
  <style>
    :root {
      --bg: #f6f5f2;
      --surface: #ffffff;
      --ink: #1f1f1d;
      --muted: #6a6a66;
      --accent: #0a7d63;
      --accent-soft: #e7f6f2;
      --border: #ddd9d0;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Avenir Next", "Gill Sans", "Trebuchet MS", sans-serif;
      background: radial-gradient(circle at top right, #e7ede4, var(--bg) 45%);
      color: var(--ink);
    }
    .layout {
      max-width: 1160px;
      margin: 0 auto;
      min-height: 100vh;
      padding: 20px;
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 16px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      box-shadow: 0 10px 32px rgba(20, 20, 16, 0.06);
    }
    .sidebar {
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 0;
    }
    .title {
      font-size: 14px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--muted);
      margin: 0;
    }
    .toolbar {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .toolbar button:nth-child(3) {
      grid-column: 1 / -1;
    }
    button {
      border: 1px solid var(--border);
      background: #fff;
      color: var(--ink);
      border-radius: 10px;
      padding: 9px 10px;
      cursor: pointer;
      font-size: 13px;
    }
    button.primary {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: #06513f;
      font-weight: 600;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .sessions {
      overflow: auto;
      border-top: 1px solid var(--border);
      padding-top: 8px;
    }
    .session {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 8px;
      cursor: pointer;
      margin-bottom: 8px;
      background: #fff;
    }
    .session.active {
      border-color: var(--accent);
      background: var(--accent-soft);
    }
    .session-id {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      word-break: break-all;
    }
    .session-meta {
      margin-top: 4px;
      font-size: 11px;
      color: var(--muted);
    }
    .main {
      display: grid;
      grid-template-rows: auto 1fr auto;
      min-height: 0;
    }
    .main-header {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
    }
    .session-chip {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .messages {
      padding: 14px;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
      background:
        linear-gradient(to bottom, rgba(10, 125, 99, 0.08), transparent 20%),
        var(--surface);
    }
    .bubble {
      max-width: 85%;
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid var(--border);
      white-space: pre-wrap;
      line-height: 1.35;
    }
    .bubble.user {
      margin-left: auto;
      background: #f3ede2;
    }
    .bubble.assistant {
      background: #fff;
    }
    .bubble.pending {
      opacity: 0.7;
      font-style: italic;
    }
    .composer {
      border-top: 1px solid var(--border);
      padding: 12px;
      display: grid;
      gap: 8px;
    }
    textarea {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 10px;
      min-height: 88px;
      padding: 10px;
      resize: vertical;
      font-family: inherit;
      font-size: 14px;
    }
    .status {
      font-size: 12px;
      color: var(--muted);
      min-height: 18px;
    }
    @media (max-width: 900px) {
      .layout {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="layout">
    <aside class="card sidebar">
      <h1 class="title">Sessions</h1>
      <div class="toolbar">
        <button id="refreshSessions">Refresh</button>
        <button id="newSession" class="primary">New</button>
        <button id="forkSession">Fork Selected</button>
      </div>
      <div id="sessions" class="sessions"></div>
    </aside>
    <main class="card main">
      <header class="main-header">
        <div>
          <div class="title">Simple Chat UI</div>
          <div id="sessionChip" class="session-chip">No session selected</div>
        </div>
      </header>
      <section id="messages" class="messages"></section>
      <form id="composer" class="composer">
        <textarea id="prompt" placeholder="Type a message or !<bash command>"></textarea>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
          <div id="status" class="status"></div>
          <button id="sendMessage" type="submit" class="primary">Send</button>
        </div>
      </form>
    </main>
  </div>
  <script>
    const sessionsEl = document.getElementById("sessions");
    const messagesEl = document.getElementById("messages");
    const statusEl = document.getElementById("status");
    const sessionChipEl = document.getElementById("sessionChip");
    const promptEl = document.getElementById("prompt");
    const sendButtonEl = document.getElementById("sendMessage");
    const forkButtonEl = document.getElementById("forkSession");

    const state = {
      sessions: [],
      currentSessionId: null,
      rpcId: 1,
      initializedSessions: new Set(),
      threadBySession: new Map(),
    };

    function setStatus(message) {
      statusEl.textContent = message;
    }

    async function requestJson(url, init) {
      const response = await fetch(url, init);
      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new Error((payload && payload.message) || (payload && payload.error) || text || ("HTTP " + response.status));
      }
      return payload;
    }

    async function rpc(sessionId, method, params) {
      const payload = {
        jsonrpc: "2.0",
        id: state.rpcId++,
        method,
        params: params || {},
      };
      const result = await requestJson("/session/" + encodeURIComponent(sessionId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (result.error) {
        throw new Error(JSON.stringify(result.error));
      }
      return result.result;
    }

    async function debugSql(sessionId, sql, params) {
      return requestJson("/session/" + encodeURIComponent(sessionId) + "/debug/sql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sql,
          params: params || [],
        }),
      });
    }

    function parseHashSession() {
      const id = window.location.hash.replace(/^#/, "").trim();
      return id.length > 0 ? id : null;
    }

    function setHashSession(sessionId) {
      window.location.hash = "#" + sessionId;
    }

    function renderSessions() {
      sessionsEl.innerHTML = "";
      for (const session of state.sessions) {
        const item = document.createElement("div");
        item.className = "session";
        if (session.sessionId === state.currentSessionId) {
          item.classList.add("active");
        }

        const idLine = document.createElement("div");
        idLine.className = "session-id";
        idLine.textContent = session.sessionId;
        item.appendChild(idLine);

        const metaLine = document.createElement("div");
        metaLine.className = "session-meta";
        const forkText = session.forkedFrom ? ("fork of " + session.forkedFrom + " • ") : "";
        metaLine.textContent = forkText + "updated " + new Date(session.updatedAt * 1000).toLocaleString();
        item.appendChild(metaLine);

        item.addEventListener("click", () => {
          selectSession(session.sessionId, true).catch((error) => {
            setStatus(String(error && error.message ? error.message : error));
          });
        });
        sessionsEl.appendChild(item);
      }
      forkButtonEl.disabled = !state.currentSessionId;
    }

    function renderMessages(messages) {
      messagesEl.innerHTML = "";
      for (const message of messages) {
        appendMessageBubble(message.role, message.text || "", false);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function appendMessageBubble(role, text, pending) {
      const bubble = document.createElement("div");
      bubble.className = "bubble " + (role === "user" ? "user" : "assistant");
      if (pending) {
        bubble.classList.add("pending");
      }
      bubble.textContent = text || "";
      messagesEl.appendChild(bubble);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return bubble;
    }

    async function loadTranscript(sessionId) {
      const result = await debugSql(
        sessionId,
        "SELECT event_type AS eventType, body_json AS bodyJson FROM event_log WHERE event_type IN ('user.message', 'assistant.message') ORDER BY event_seq;",
        [],
      );
      const messages = [];
      for (const row of result.rows || []) {
        let body = null;
        try {
          body = JSON.parse(row.bodyJson);
        } catch {
          body = null;
        }
        if (!body || typeof body.text !== "string") {
          continue;
        }
        const role = row.eventType === "user.message" ? "user" : "assistant";
        messages.push({ role, text: body.text });
      }
      renderMessages(messages);
    }

    async function ensureInitialized(sessionId, force) {
      if (!force && state.initializedSessions.has(sessionId)) {
        return;
      }
      await rpc(sessionId, "initialize", {});
      state.initializedSessions.add(sessionId);
    }

    async function ensureThread(sessionId) {
      const existing = state.threadBySession.get(sessionId);
      if (existing) {
        return existing;
      }
      const existingThread = await debugSql(
        sessionId,
        "SELECT id FROM threads ORDER BY updated_at DESC LIMIT 1;",
        [],
      );
      if (existingThread.rows && existingThread.rows[0] && existingThread.rows[0].id) {
        const threadId = String(existingThread.rows[0].id);
        state.threadBySession.set(sessionId, threadId);
        return threadId;
      }
      const started = await rpc(sessionId, "thread/start", {
        preview: "ui thread",
        sourceKind: "cloudflare-ui",
        modelProvider: "openai",
        model: "gpt-5",
      });
      const threadId = started.thread && started.thread.id ? String(started.thread.id) : "";
      if (!threadId) {
        throw new Error("thread/start did not return thread id");
      }
      state.threadBySession.set(sessionId, threadId);
      return threadId;
    }

    async function sendMessage() {
      const sessionId = state.currentSessionId;
      const prompt = promptEl.value.trim();
      if (!sessionId || prompt.length === 0) {
        return;
      }
      promptEl.value = "";
      appendMessageBubble("user", prompt, false);
      const pendingAssistant = appendMessageBubble("assistant", "Thinking...", true);
      sendButtonEl.disabled = true;
      setStatus("Sending...");
      try {
        await ensureInitialized(sessionId, true);
        const threadId = await ensureThread(sessionId);
        try {
          await rpc(sessionId, "turn/start", {
            threadId,
            input: [{ type: "text", text: prompt }],
          });
        } catch (error) {
          const message = String(error && error.message ? error.message : error);
          if (!message.includes("Not initialized")) {
            throw error;
          }
          state.initializedSessions.delete(sessionId);
          await ensureInitialized(sessionId, true);
          await rpc(sessionId, "turn/start", {
            threadId,
            input: [{ type: "text", text: prompt }],
          });
        }
        if (state.currentSessionId === sessionId) {
          await loadTranscript(sessionId);
        }
        setStatus("Completed");
      } catch (error) {
        if (pendingAssistant.isConnected) {
          pendingAssistant.remove();
        }
        setStatus(String(error && error.message ? error.message : error));
      } finally {
        if (pendingAssistant.isConnected && state.currentSessionId === sessionId) {
          pendingAssistant.remove();
        }
        sendButtonEl.disabled = false;
      }
    }

    async function loadSessions() {
      const payload = await requestJson("/api/sessions", { method: "GET" });
      state.sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
      renderSessions();
    }

    async function createSession() {
      setStatus("Creating session...");
      const payload = await requestJson("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      await loadSessions();
      if (payload.sessionId) {
        await selectSession(String(payload.sessionId), true);
      }
      setStatus("Session created");
    }

    async function forkSelectedSession() {
      if (!state.currentSessionId) {
        return;
      }
      setStatus("Forking session...");
      const payload = await requestJson("/api/sessions/" + encodeURIComponent(state.currentSessionId) + "/fork", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      await loadSessions();
      if (payload.sessionId) {
        await selectSession(String(payload.sessionId), true);
      }
      setStatus("Session forked");
    }

    async function selectSession(sessionId, updateHash) {
      state.currentSessionId = sessionId;
      if (updateHash) {
        setHashSession(sessionId);
      }
      sessionChipEl.textContent = sessionId;
      renderSessions();
      await ensureInitialized(sessionId, false);
      await loadTranscript(sessionId);
      setStatus("Ready");
    }

    document.getElementById("refreshSessions").addEventListener("click", () => {
      loadSessions().catch((error) => setStatus(String(error && error.message ? error.message : error)));
    });
    document.getElementById("newSession").addEventListener("click", () => {
      createSession().catch((error) => setStatus(String(error && error.message ? error.message : error)));
    });
    forkButtonEl.addEventListener("click", () => {
      forkSelectedSession().catch((error) => setStatus(String(error && error.message ? error.message : error)));
    });
    document.getElementById("composer").addEventListener("submit", (event) => {
      event.preventDefault();
      sendMessage();
    });
    promptEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });
    window.addEventListener("hashchange", () => {
      const hashSession = parseHashSession();
      if (!hashSession) {
        return;
      }
      selectSession(hashSession, false).catch((error) => {
        setStatus(String(error && error.message ? error.message : error));
      });
    });

    (async () => {
      try {
        await loadSessions();
        const hashSession = parseHashSession();
        if (hashSession) {
          await requestJson("/api/sessions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: hashSession }),
          });
          await loadSessions();
          await selectSession(hashSession, false);
          return;
        }
        if (state.sessions.length === 0) {
          await createSession();
          return;
        }
        await selectSession(state.sessions[0].sessionId, true);
      } catch (error) {
        setStatus(String(error && error.message ? error.message : error));
      }
    })();
  </script>
</body>
</html>`;
}

export class AppServerSession {
  private readonly sockets = new Map<string, WebSocket>();
  private readonly platform: CloudflarePlatform;
  private wasm: WasmAppServer | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.platform = new CloudflarePlatform(
      {
        storage: {
          sql: {
            exec: (statement: string, ...bindings: unknown[]) =>
              this.state.storage.sql.exec(statement, ...bindings),
          },
        },
        getWebSockets: () => this.state.getWebSockets(),
      },
      (id: string) => this.socketById(id),
      this.env.SANDBOX_BASE_URL ?? "http://127.0.0.1:8080",
      this.env as Record<string, string | undefined>,
    );
    this.ensureSchema();
  }

  async fetch(req: Request): Promise<Response> {
    if (isWebSocketUpgrade(req)) {
      return this.acceptWebSocket();
    }

    const path = new URL(req.url).pathname;
    if (path.endsWith("/debug/sql")) {
      return this.handleDebugSql(req);
    }
    if (path.endsWith("/registry/register")) {
      return this.handleRegistryRegister(req);
    }
    if (path.endsWith("/registry/list")) {
      return this.handleRegistryList(req);
    }
    if (path.endsWith("/snapshot/export")) {
      return this.handleSnapshotExport(req);
    }
    if (path.endsWith("/snapshot/import")) {
      return this.handleSnapshotImport(req);
    }
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    const payload = await req.text();
    const envelope = await this.runJsonRpc(payload);
    this.broadcastNotifications(envelope.notifications);
    return Response.json(envelope.response);
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") {
      return;
    }
    const envelope = await this.runJsonRpc(message);
    ws.send(JSON.stringify(envelope.response));
    this.broadcastNotifications(envelope.notifications);
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    this.removeSocket(ws);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.removeSocket(ws);
  }

  private ensureSchema(): void {
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS id_sequence(next_id INTEGER NOT NULL);",
    );
    this.state.storage.sql.exec(
      `INSERT INTO id_sequence(next_id)
       SELECT 0
       WHERE NOT EXISTS (SELECT 1 FROM id_sequence);`,
    );
    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS threads(
          id TEXT PRIMARY KEY,
          preview TEXT NOT NULL,
          status TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          cwd TEXT,
          model TEXT,
          model_provider TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          archived_at INTEGER
      );`,
    );
    this.state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_threads_updated_at ON threads(updated_at DESC);",
    );
    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS turns(
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          status TEXT NOT NULL,
          input_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          completed_at INTEGER,
          UNIQUE(thread_id, seq)
      );`,
    );
    this.state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_turns_thread_seq ON turns(thread_id, seq);",
    );
    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS event_log(
          event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id TEXT NOT NULL,
          turn_id TEXT,
          event_type TEXT NOT NULL,
          body_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
      );`,
    );
    this.state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_event_log_thread_seq ON event_log(thread_id, event_seq);",
    );
  }

  private acceptWebSocket(): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const connectionId = crypto.randomUUID();
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ connectionId });
    this.sockets.set(connectionId, server);
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleDebugSql(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    try {
      const debugBody = (await req.json()) as DebugSqlBody;
      const params = Array.isArray(debugBody.params) ? debugBody.params : [];
      const cursor = this.state.storage.sql.exec(debugBody.sql, ...params);
      return Response.json({
        rows: cursor.toArray(),
        rowsWritten: cursor.rowsWritten,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown debug sql error";
      return Response.json({ message }, { status: 500 });
    }
  }

  private ensureRegistrySchema(): void {
    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS session_registry(
          session_id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          forked_from TEXT
      );`,
    );
    this.state.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_session_registry_updated_at ON session_registry(updated_at DESC);",
    );
  }

  private async handleRegistryRegister(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    try {
      const payload = (await req.json()) as RegistryRegisterBody;
      if (!payload.sessionId || typeof payload.sessionId !== "string") {
        return Response.json(
          { message: "sessionId is required" },
          { status: 400 },
        );
      }
      const now = Math.floor(Date.now() / 1000);
      this.ensureRegistrySchema();
      this.state.storage.sql.exec(
        `INSERT INTO session_registry(session_id, created_at, updated_at, forked_from)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(session_id)
         DO UPDATE SET
           updated_at = excluded.updated_at,
           forked_from = COALESCE(session_registry.forked_from, excluded.forked_from);`,
        payload.sessionId,
        now,
        now,
        payload.forkedFrom ?? null,
      );
      return Response.json({ ok: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown registry error";
      return Response.json({ message }, { status: 500 });
    }
  }

  private async handleRegistryList(req: Request): Promise<Response> {
    if (req.method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }
    try {
      this.ensureRegistrySchema();
      const rows = this.state.storage.sql.exec(
        `SELECT
           session_id AS sessionId,
           created_at AS createdAt,
           updated_at AS updatedAt,
           forked_from AS forkedFrom
         FROM session_registry
         ORDER BY updated_at DESC;`,
      );
      return Response.json({
        sessions: rows.toArray(),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown registry error";
      return Response.json({ message }, { status: 500 });
    }
  }

  private async handleSnapshotExport(req: Request): Promise<Response> {
    if (req.method !== "GET") {
      return new Response("method not allowed", { status: 405 });
    }
    try {
      const idSequenceRows = this.state.storage.sql.exec(
        "SELECT next_id AS nextId FROM id_sequence LIMIT 1;",
      );
      const threads = this.state.storage.sql.exec(
        `SELECT
           id,
           preview,
           status,
           source_kind AS sourceKind,
           cwd,
           model,
           model_provider AS modelProvider,
           created_at AS createdAt,
           updated_at AS updatedAt,
           archived_at AS archivedAt
         FROM threads
         ORDER BY created_at ASC, id ASC;`,
      );
      const turns = this.state.storage.sql.exec(
        `SELECT
           id,
           thread_id AS threadId,
           seq,
           status,
           input_json AS inputJson,
           created_at AS createdAt,
           completed_at AS completedAt
         FROM turns
         ORDER BY thread_id ASC, seq ASC;`,
      );
      const eventLog = this.state.storage.sql.exec(
        `SELECT
           event_seq AS eventSeq,
           thread_id AS threadId,
           turn_id AS turnId,
           event_type AS eventType,
           body_json AS bodyJson,
           created_at AS createdAt
         FROM event_log
         ORDER BY event_seq ASC;`,
      );
      return Response.json({
        idSequence: idSequenceRows.toArray()[0] ?? { nextId: 0 },
        threads: threads.toArray(),
        turns: turns.toArray(),
        eventLog: eventLog.toArray(),
      } satisfies SnapshotBody);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown snapshot export error";
      return Response.json({ message }, { status: 500 });
    }
  }

  private async handleSnapshotImport(req: Request): Promise<Response> {
    if (req.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    try {
      const payload = (await req.json()) as SnapshotBody;
      const idSequence = payload.idSequence ?? { nextId: 0 };
      const threads = Array.isArray(payload.threads) ? payload.threads : [];
      const turns = Array.isArray(payload.turns) ? payload.turns : [];
      const eventLog = Array.isArray(payload.eventLog) ? payload.eventLog : [];

      this.state.storage.sql.exec("DELETE FROM event_log;");
      this.state.storage.sql.exec("DELETE FROM turns;");
      this.state.storage.sql.exec("DELETE FROM threads;");
      this.state.storage.sql.exec("DELETE FROM id_sequence;");

      for (const threadRow of threads) {
        const thread = threadRow as Record<string, unknown>;
        this.state.storage.sql.exec(
          `INSERT INTO threads(
            id, preview, status, source_kind, cwd, model, model_provider, created_at, updated_at, archived_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          String(thread.id ?? ""),
          String(thread.preview ?? ""),
          String(thread.status ?? ""),
          String(thread.sourceKind ?? ""),
          thread.cwd == null ? null : String(thread.cwd),
          thread.model == null ? null : String(thread.model),
          String(thread.modelProvider ?? ""),
          Number(thread.createdAt ?? 0),
          Number(thread.updatedAt ?? 0),
          thread.archivedAt == null ? null : Number(thread.archivedAt),
        );
      }

      for (const turnRow of turns) {
        const turn = turnRow as Record<string, unknown>;
        this.state.storage.sql.exec(
          `INSERT INTO turns(
            id, thread_id, seq, status, input_json, created_at, completed_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?);`,
          String(turn.id ?? ""),
          String(turn.threadId ?? ""),
          Number(turn.seq ?? 0),
          String(turn.status ?? ""),
          String(turn.inputJson ?? "[]"),
          Number(turn.createdAt ?? 0),
          turn.completedAt == null ? null : Number(turn.completedAt),
        );
      }

      for (const eventRow of eventLog) {
        const event = eventRow as Record<string, unknown>;
        this.state.storage.sql.exec(
          `INSERT INTO event_log(
            event_seq, thread_id, turn_id, event_type, body_json, created_at
          ) VALUES(?, ?, ?, ?, ?, ?);`,
          Number(event.eventSeq ?? 0),
          String(event.threadId ?? ""),
          event.turnId == null ? null : String(event.turnId),
          String(event.eventType ?? ""),
          String(event.bodyJson ?? "{}"),
          Number(event.createdAt ?? 0),
        );
      }

      this.state.storage.sql.exec(
        "INSERT INTO id_sequence(next_id) VALUES(?);",
        Number(idSequence.nextId ?? 0),
      );
      return Response.json({
        ok: true,
        rows: {
          threads: threads.length,
          turns: turns.length,
          eventLog: eventLog.length,
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown snapshot import error";
      return Response.json({ message }, { status: 500 });
    }
  }

  private async runJsonRpc(payload: string): Promise<JsonRpcEnvelope> {
    await this.ensureWasmReady();
    (globalThis as { codexPlatformCall?: (requestJson: string) => Promise<string> }).codexPlatformCall =
      async (requestJson: string) => {
        const request = JSON.parse(requestJson);
        const response = await this.platform.call(request);
        return JSON.stringify(response);
      };
    const envelopeJson = await this.wasm!.handle_json_rpc(payload);
    return JSON.parse(envelopeJson) as JsonRpcEnvelope;
  }

  private async ensureWasmReady(): Promise<void> {
    if (!wasmInitPromise) {
      wasmInitPromise = initWasm({ module_or_path: wasmModule });
    }
    await wasmInitPromise;
    if (!this.wasm) {
      this.wasm = new WasmAppServer();
    }
  }

  private broadcastNotifications(notifications: unknown[]): void {
    for (const notification of notifications) {
      const payload = JSON.stringify(notification);
      for (const socket of this.state.getWebSockets()) {
        try {
          socket.send(payload);
        } catch {
          this.removeSocket(socket);
        }
      }
    }
  }

  private socketById(connectionId: string): WebSocket | null {
    const existing = this.sockets.get(connectionId);
    if (existing) {
      return existing;
    }
    for (const socket of this.state.getWebSockets()) {
      try {
        const attachment = socket.deserializeAttachment() as
          | { connectionId?: string }
          | null;
        if (attachment?.connectionId === connectionId) {
          this.sockets.set(connectionId, socket);
          return socket;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private removeSocket(target: WebSocket): void {
    for (const [id, socket] of this.sockets.entries()) {
      if (socket === target) {
        this.sockets.delete(id);
      }
    }
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/healthz") {
      return new Response("ok", { status: 200 });
    }
    if (path === "/") {
      return new Response(uiHtml(), {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      });
    }
    if (path === "/api/sessions" && req.method === "GET") {
      try {
        const sessions = await listSessions(env);
        return Response.json({ sessions });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "unknown session list error";
        return Response.json({ message }, { status: 500 });
      }
    }
    if (path === "/api/sessions" && req.method === "POST") {
      try {
        let requestedSessionId: string | null = null;
        const hasBody = req.headers.get("content-length") !== "0";
        if (hasBody) {
          const payload = (await req.json()) as { sessionId?: unknown } | null;
          if (
            payload?.sessionId &&
            typeof payload.sessionId === "string" &&
            payload.sessionId.trim().length > 0
          ) {
            requestedSessionId = payload.sessionId;
          }
        }
        const sessionId = requestedSessionId ?? crypto.randomUUID();
        if (sessionId === REGISTRY_SESSION_ID) {
          return Response.json(
            { message: "reserved session id" },
            { status: 400 },
          );
        }
        await registerSession(env, sessionId);
        return Response.json({ sessionId });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "unknown session create error";
        return Response.json({ message }, { status: 500 });
      }
    }
    const forkMatch = path.match(/^\/api\/sessions\/([^/]+)\/fork$/);
    if (forkMatch && req.method === "POST") {
      try {
        const sourceSessionId = decodeURIComponent(forkMatch[1]);
        if (sourceSessionId === REGISTRY_SESSION_ID) {
          return Response.json(
            { message: "cannot fork reserved session" },
            { status: 400 },
          );
        }
        const payload = (await req.json().catch(() => ({}))) as {
          sessionId?: unknown;
        };
        const targetSessionId =
          typeof payload.sessionId === "string" && payload.sessionId.length > 0
            ? payload.sessionId
            : crypto.randomUUID();
        if (targetSessionId === REGISTRY_SESSION_ID) {
          return Response.json(
            { message: "reserved target session id" },
            { status: 400 },
          );
        }
        const sourceResponse = await sessionStub(env, sourceSessionId).fetch(
          "https://session/snapshot/export",
          {
            method: "GET",
          },
        );
        if (!sourceResponse.ok) {
          const body = await sourceResponse.text();
          return Response.json(
            {
              message: `source snapshot export failed: ${sourceResponse.status} ${body}`,
            },
            { status: 400 },
          );
        }
        const snapshotBody = await sourceResponse.text();
        const targetResponse = await sessionStub(env, targetSessionId).fetch(
          "https://session/snapshot/import",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: snapshotBody,
          },
        );
        if (!targetResponse.ok) {
          const body = await targetResponse.text();
          return Response.json(
            {
              message: `target snapshot import failed: ${targetResponse.status} ${body}`,
            },
            { status: 400 },
          );
        }
        await registerSession(env, sourceSessionId);
        await registerSession(env, targetSessionId, sourceSessionId);
        return Response.json({
          sessionId: targetSessionId,
          forkedFrom: sourceSessionId,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "unknown session fork error";
        return Response.json({ message }, { status: 500 });
      }
    }

    const segments = path.split("/").filter(Boolean);
    if (segments.length < 2 || segments[0] !== "session") {
      return new Response(
        "use / (UI), /api/sessions, or /session/<id>",
        { status: 404 },
      );
    }

    const sessionId = decodeURIComponent(segments[1]);
    if (sessionId === REGISTRY_SESSION_ID) {
      return new Response("reserved session id", { status: 403 });
    }
    await registerSession(env, sessionId);
    return sessionStub(env, sessionId).fetch(req);
  },
};
