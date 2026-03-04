# codex-app-server-platform

Platform contract layer for app-server runtimes.

This crate defines:

- `Platform` trait: the host contract app-server logic calls into.
- `PlatformRequest` / `PlatformResponse`: serialized operation surface.
- `PlatformKind`: `native` and `cloudflare`.
- `PlatformContract`: capabilities the runtime expects from a host environment.
- wasm bridge exports:
  - `platform_contract_json()`
  - `platform_round_trip(request_json)`
  and expects a JS import named `codexPlatformCall(request_json)`.

The goal is to keep app-server logic portable:

- `native` platform implementation can run in Rust on local OS.
- `cloudflare` platform can be implemented in TypeScript against Durable Objects.

For wasm runtimes, model HTTP calls are issued via `codex-client` request/transport
abstractions with a host-provided `HttpTransport` implementation, rather than
assuming reqwest/tokio networking in wasm.

The wasm runtime supports both model auth modes:

- API key mode: `OPENAI_API_KEY` (default base URL `https://api.openai.com`)
- ChatGPT mode: `CHATGPT_ACCESS_TOKEN` (default base URL
  `https://chatgpt.com/backend-api/codex`, optional `CHATGPT_ACCOUNT_ID` header)
