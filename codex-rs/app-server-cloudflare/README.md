# codex-app-server-cloudflare

Cloudflare Worker adapter for a wasm `codex-app-server` runtime.

Architecture:

- `src/worker.ts` is the Worker router and Durable Object implementation (TypeScript).
- The Durable Object loads wasm exported from the Rust crate
  `codex-app-server-platform` (generated into `build/platform-wasm`).
- Platform operations (SQLite, websocket, process sandbox calls) are implemented
  in TypeScript via `platform/cloudflarePlatform.ts`.
- JSON-RPC is handled inside the wasm runtime through `WasmAppServer`.

## Run

Install dependencies and run from this directory.

```bash
npm install
```

API key auth:

```bash
npx wrangler dev --var OPENAI_API_KEY:$OPENAI_API_KEY --var OPENAI_MODEL:gpt-4.1-mini
```

ChatGPT auth (same auth shape as local Codex model requests):

```bash
npx wrangler dev \
  --var CHATGPT_ACCESS_TOKEN:$CHATGPT_ACCESS_TOKEN \
  --var CHATGPT_ACCOUNT_ID:$CHATGPT_ACCOUNT_ID \
  --var OPENAI_MODEL:gpt-5
```

Use your current local Codex ChatGPT auth automatically:

```bash
node ./scripts/dev-chatgpt-auth.js
```

If direct Worker egress to `chatgpt.com` is challenged in local dev, run the
local HTTP proxy in another shell and pass `MODEL_HTTP_PROXY_URL`:

```bash
node ./scripts/http-proxy.js
MODEL_HTTP_PROXY_URL=http://127.0.0.1:8789/http node ./scripts/dev-chatgpt-auth.js
```

Notes:

- When `CHATGPT_ACCESS_TOKEN` is set, wasm defaults model requests to
  `https://chatgpt.com/backend-api/codex/responses`.
- `CHATGPT_ACCOUNT_ID` is optional but recommended; if present it is sent as
  `ChatGPT-Account-ID`.
- `OPENAI_BASE_URL` still overrides the default endpoint for both auth modes.

Run the local JS smoke test in another shell:

```bash
node ./scripts/smoke-http.js
```

You can override host/session:

```bash
node ./scripts/smoke-http.js http://localhost:8787 my-session-id
```

## Browser UI

Open:

```bash
http://localhost:8787/
```

The page provides:

- listing existing sessions
- creating a new session
- forking the selected session
- sending chat turns against the selected session

For command execution (initial simple path), prefix the message with `!`:

- `!pwd`
- `!ls -la`
- `!echo hello`

These run through `just-bash` in the Durable Object runtime.
Set `JUST_BASH_TIMEOUT_MS` to override the default command timeout (30s).

The agent can also invoke `shell_command` through normal prompts (for example:
"Run `pwd` and return its exact output only.").

## Session HTTP API

List sessions:

```bash
curl -sS http://localhost:8787/api/sessions
```

Create a session:

```bash
curl -sS -X POST http://localhost:8787/api/sessions \
  -H 'content-type: application/json' \
  --data '{}'
```

Fork a session:

```bash
curl -sS -X POST http://localhost:8787/api/sessions/<source-session-id>/fork \
  -H 'content-type: application/json' \
  --data '{}'
```

Deploy:

```bash
npx wrangler deploy
```

The smoke test covers:

- initialization
- thread + turn flow
- websocket notifications
- SQLite verification through `/session/<id>/debug/sql`
- real assistant text generation (non-synthetic output)
