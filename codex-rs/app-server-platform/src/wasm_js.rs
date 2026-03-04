use async_trait::async_trait;
use codex_client::HttpTransport;
use codex_client::Request as HttpRequest;
use codex_client::RequestCompression;
use codex_client::Response as HttpResponse;
use codex_client::StreamResponse;
use codex_client::TransportError;
use http::HeaderMap;
use http::HeaderName;
use http::HeaderValue;
use http::Method;
use http::StatusCode;
use js_sys::JSON;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use wasm_bindgen::JsValue;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::ModelTransport;
use crate::Platform;
use crate::PlatformContract;
use crate::PlatformError;
use crate::PlatformHost;
use crate::PlatformKind;
use crate::PlatformRequest;
use crate::PlatformResponse;
use crate::RuntimeHost;
use crate::SessionStore;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(catch, js_name = codexPlatformCall)]
    async fn codex_platform_call(request_json: String) -> Result<JsValue, JsValue>;
}

/// Cloudflare platform implementation backed by a JavaScript import.
#[derive(Debug, Default, Clone, Copy)]
pub struct CloudflareJsPlatform;

#[async_trait(?Send)]
impl Platform for CloudflareJsPlatform {
    fn kind(&self) -> PlatformKind {
        PlatformKind::Cloudflare
    }

    async fn call(&self, request: PlatformRequest) -> Result<PlatformResponse, PlatformError> {
        let request_json = serde_json::to_string(&request)
            .map_err(|err| PlatformError::Message(format!("serialize request failed: {err}")))?;
        let raw_response = codex_platform_call(request_json)
            .await
            .map_err(|err| PlatformError::Message(format!("js platform call failed: {err:?}")))?;
        let response_json = match raw_response.as_string() {
            Some(response_json) => response_json,
            None => JSON::stringify(&raw_response)
                .map_err(|err| {
                    PlatformError::Message(format!(
                        "stringify js platform response failed: {err:?}"
                    ))
                })?
                .as_string()
                .ok_or_else(|| {
                    PlatformError::Message(
                        "stringify js platform response produced non-string value".to_string(),
                    )
                })?,
        };
        serde_json::from_str::<PlatformResponse>(&response_json)
            .map_err(|err| PlatformError::Message(format!("parse platform response failed: {err}")))
    }
}

#[derive(Debug, Default, Clone, Copy)]
struct PlatformHttpTransport;

#[async_trait(?Send)]
impl HttpTransport for PlatformHttpTransport {
    async fn execute(&self, req: HttpRequest) -> Result<HttpResponse, TransportError> {
        let mut request_headers = req.headers;
        let body_json = req.body;
        if body_json.is_some() && !request_headers.contains_key(http::header::CONTENT_TYPE) {
            request_headers.insert(
                http::header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
        }

        let headers = request_headers
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value_str| (name.to_string(), value_str.to_string()))
            })
            .collect::<Vec<_>>();
        let body = body_json
            .map(|value| serde_json::to_string(&value).map_err(|err| err.to_string()))
            .transpose()
            .map_err(TransportError::Build)?;
        let url = req.url;
        let method = req.method.as_str().to_string();
        let (status, headers, body) = platform_host()
            .http_request(method.as_str(), url.clone(), headers, body)
            .await
            .map_err(|err| TransportError::Network(err.to_string()))?;
        let status = StatusCode::from_u16(status).map_err(|err| {
            TransportError::Build(format!("invalid status code from platform: {err}"))
        })?;
        let mut response_headers = HeaderMap::new();
        for (name, value) in headers {
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(name.as_bytes()),
                HeaderValue::from_str(&value),
            ) {
                response_headers.append(name, value);
            }
        }
        if !status.is_success() {
            return Err(TransportError::Http {
                status,
                url: Some(url),
                headers: Some(response_headers),
                body: Some(body),
            });
        }
        Ok(HttpResponse {
            status,
            headers: response_headers,
            body: body.into_bytes().into(),
        })
    }

    async fn stream(&self, _req: HttpRequest) -> Result<StreamResponse, TransportError> {
        Err(TransportError::Build(
            "stream transport is unsupported for platform wasm runtime".to_string(),
        ))
    }
}

/// JSON contract that JavaScript hosts must satisfy.
#[wasm_bindgen]
pub fn platform_contract_json() -> String {
    match serde_json::to_string_pretty(&PlatformContract::default()) {
        Ok(json) => json,
        Err(err) => format!("{{\"error\":\"{err}\"}}"),
    }
}

/// Helper exported for smoke-testing the host bridge from JavaScript.
#[wasm_bindgen]
pub async fn platform_round_trip(request_json: String) -> Result<String, JsValue> {
    let request = serde_json::from_str::<PlatformRequest>(&request_json)
        .map_err(|err| JsValue::from_str(&format!("invalid platform request: {err}")))?;
    let response = CloudflareJsPlatform
        .call(request)
        .await
        .map_err(|err| JsValue::from_str(&err.to_string()))?;
    serde_json::to_string(&response)
        .map_err(|err| JsValue::from_str(&format!("serialize platform response failed: {err}")))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsonRpcRequest {
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Deserialize)]
struct NextIdRow {
    #[serde(rename = "nextId")]
    next_id: i64,
}

#[derive(Debug, Deserialize)]
struct CountRow {
    count: i64,
}

#[derive(Debug, Deserialize)]
struct NextSeqRow {
    #[serde(rename = "nextSeq")]
    next_seq: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ThreadRecord {
    id: String,
    preview: String,
    model_provider: String,
    created_at: i64,
    updated_at: i64,
    source_kind: String,
    cwd: Option<String>,
    model: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TurnRecord {
    id: String,
    thread_id: String,
    seq: i64,
    status: String,
    created_at: i64,
    completed_at: Option<i64>,
}

#[derive(Default)]
#[wasm_bindgen]
pub struct WasmAppServer {
    initialized: bool,
}

#[wasm_bindgen]
impl WasmAppServer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self { initialized: false }
    }

    /// Handles one JSON-RPC request payload.
    ///
    /// Returns a JSON envelope:
    /// `{ "response": <jsonrpc-response>, "notifications": [<jsonrpc-notification>...] }`
    #[wasm_bindgen]
    pub async fn handle_json_rpc(&mut self, payload: String) -> Result<String, JsValue> {
        let parsed = serde_json::from_str::<JsonRpcRequest>(&payload);
        let (response, notifications) = match parsed {
            Ok(request) => {
                let request_id = request.id.clone();
                match self.handle_request(request).await {
                    Ok(result) => result,
                    Err(err) => (
                        error_response(request_id, -32001, format!("internal error: {err}")),
                        Vec::new(),
                    ),
                }
            }
            Err(err) => (
                error_response(None, -32700, format!("invalid JSON-RPC payload: {err}")),
                Vec::new(),
            ),
        };
        serde_json::to_string(&serde_json::json!({
            "response": response,
            "notifications": notifications,
        }))
        .map_err(|err| JsValue::from_str(&format!("serialize json-rpc envelope failed: {err}")))
    }
}

impl WasmAppServer {
    async fn handle_request(
        &mut self,
        request: JsonRpcRequest,
    ) -> Result<(Value, Vec<Value>), PlatformError> {
        match request.method.as_str() {
            "initialize" => {
                self.initialized = true;
                let result = serde_json::json!({
                    "serverInfo": {
                        "name": "codex-app-server-wasm",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                    "capabilities": {
                        "experimentalApi": true,
                    }
                });
                Ok((success_response(request.id, result), Vec::new()))
            }
            "thread/start" => {
                if !self.initialized {
                    return Ok((
                        error_response(request.id, -32000, "Not initialized".to_string()),
                        Vec::new(),
                    ));
                }

                let now = now_unix_seconds().await?;
                let thread_id = allocate_id("thr").await?;
                let preview = request
                    .params
                    .get("preview")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let source_kind = request
                    .params
                    .get("sourceKind")
                    .and_then(Value::as_str)
                    .unwrap_or("cloudflare")
                    .to_string();
                let cwd = request
                    .params
                    .get("cwd")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let model = request
                    .params
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let model_provider = request
                    .params
                    .get("modelProvider")
                    .and_then(Value::as_str)
                    .unwrap_or("openai")
                    .to_string();

                sql_exec(
                    "INSERT INTO threads(
                        id, preview, status, source_kind, cwd, model, model_provider, created_at, updated_at, archived_at
                     ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, NULL);",
                    vec![
                        Value::String(thread_id.clone()),
                        Value::String(preview.clone()),
                        Value::String(source_kind.clone()),
                        value_or_null(cwd.clone()),
                        value_or_null(model.clone()),
                        Value::String(model_provider.clone()),
                        Value::from(now),
                        Value::from(now),
                    ],
                )
                .await?;

                let thread = ThreadRecord {
                    id: thread_id,
                    preview,
                    model_provider,
                    created_at: now,
                    updated_at: now,
                    source_kind,
                    cwd,
                    model,
                };

                append_event(thread.id.as_str(), None, "thread.started", &thread, now).await?;

                let response =
                    success_response(request.id, serde_json::json!({ "thread": thread.clone() }));
                let notifications = vec![serde_json::json!({
                    "jsonrpc": "2.0",
                    "method": "thread/started",
                    "params": { "thread": thread }
                })];
                Ok((response, notifications))
            }
            "thread/list" => {
                if !self.initialized {
                    return Ok((
                        error_response(request.id, -32000, "Not initialized".to_string()),
                        Vec::new(),
                    ));
                }

                let cursor = request
                    .params
                    .get("cursor")
                    .and_then(Value::as_str)
                    .and_then(|value| value.parse::<i64>().ok())
                    .unwrap_or(0);
                let raw_limit = request
                    .params
                    .get("limit")
                    .and_then(Value::as_i64)
                    .unwrap_or(20);
                let limit = raw_limit.clamp(1, 100);

                let (rows, _) = sql_query(
                    "SELECT
                        id,
                        preview,
                        model_provider AS modelProvider,
                        created_at AS createdAt,
                        updated_at AS updatedAt,
                        source_kind AS sourceKind,
                        cwd,
                        model
                     FROM threads
                     WHERE archived_at IS NULL
                     ORDER BY updated_at DESC
                     LIMIT ?
                     OFFSET ?;",
                    vec![Value::from(limit), Value::from(cursor)],
                )
                .await?;
                let threads: Vec<ThreadRecord> = rows
                    .into_iter()
                    .map(serde_json::from_value)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|err| PlatformError::Message(format!("invalid thread row: {err}")))?;
                let next_cursor = if i64::try_from(threads.len()).ok() == Some(limit) {
                    Some((cursor + limit).to_string())
                } else {
                    None
                };
                let result = serde_json::json!({
                    "data": threads,
                    "nextCursor": next_cursor,
                });
                Ok((success_response(request.id, result), Vec::new()))
            }
            "turn/start" => {
                if !self.initialized {
                    return Ok((
                        error_response(request.id, -32000, "Not initialized".to_string()),
                        Vec::new(),
                    ));
                }

                let Some(thread_id) = request.params.get("threadId").and_then(Value::as_str) else {
                    return Ok((
                        error_response(
                            request.id,
                            -32602,
                            "missing required param threadId".to_string(),
                        ),
                        Vec::new(),
                    ));
                };

                let (count_rows, _) = sql_query(
                    "SELECT COUNT(*) AS count FROM threads WHERE id = ? AND archived_at IS NULL;",
                    vec![Value::String(thread_id.to_string())],
                )
                .await?;
                let count = count_rows
                    .first()
                    .cloned()
                    .map(serde_json::from_value::<CountRow>)
                    .transpose()
                    .map_err(|err| PlatformError::Message(format!("invalid count row: {err}")))?
                    .map(|row| row.count)
                    .unwrap_or(0);
                if count == 0 {
                    return Ok((
                        error_response(
                            request.id,
                            -32602,
                            format!("unknown threadId: {thread_id}"),
                        ),
                        Vec::new(),
                    ));
                }

                let now = now_unix_seconds().await?;
                let turn_id = allocate_id("turn").await?;
                let user_message = extract_user_message_text(&request.params);
                let assistant_text =
                    if let Some(command) = extract_just_bash_command(user_message.as_str()) {
                        run_just_bash_command(command.as_str(), &request.params).await?
                    } else {
                        generate_assistant_text(&request.params, user_message.as_str()).await?
                    };
                let (seq_rows, _) = sql_query(
                    "SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM turns WHERE thread_id = ?;",
                    vec![Value::String(thread_id.to_string())],
                )
                .await?;
                let seq = seq_rows
                    .first()
                    .cloned()
                    .map(serde_json::from_value::<NextSeqRow>)
                    .transpose()
                    .map_err(|err| PlatformError::Message(format!("invalid seq row: {err}")))?
                    .map(|row| row.next_seq)
                    .unwrap_or(1);

                sql_exec(
                    "INSERT INTO turns(
                        id, thread_id, seq, status, input_json, created_at, completed_at
                     ) VALUES (?, ?, ?, 'completed', ?, ?, ?);",
                    vec![
                        Value::String(turn_id.clone()),
                        Value::String(thread_id.to_string()),
                        Value::from(seq),
                        Value::String(request.params.to_string()),
                        Value::from(now),
                        Value::from(now),
                    ],
                )
                .await?;
                sql_exec(
                    "UPDATE threads SET updated_at = ? WHERE id = ?;",
                    vec![Value::from(now), Value::String(thread_id.to_string())],
                )
                .await?;

                let turn = TurnRecord {
                    id: turn_id,
                    thread_id: thread_id.to_string(),
                    seq,
                    status: "completed".to_string(),
                    created_at: now,
                    completed_at: Some(now),
                };
                let output = serde_json::json!({
                    "type": "message",
                    "role": "assistant",
                    "text": assistant_text,
                });
                append_event(
                    thread_id,
                    Some(turn.id.as_str()),
                    "turn.started",
                    &turn,
                    now,
                )
                .await?;
                append_event(
                    thread_id,
                    Some(turn.id.as_str()),
                    "turn.completed",
                    &turn,
                    now,
                )
                .await?;
                append_event(
                    thread_id,
                    Some(turn.id.as_str()),
                    "assistant.message",
                    &output,
                    now,
                )
                .await?;

                let notifications = vec![
                    serde_json::json!({
                        "jsonrpc": "2.0",
                        "method": "turn/started",
                        "params": {
                            "threadId": thread_id,
                            "turn": turn.clone(),
                        }
                    }),
                    serde_json::json!({
                        "jsonrpc": "2.0",
                        "method": "item/completed",
                        "params": {
                            "threadId": thread_id,
                            "turnId": turn.id,
                            "item": {
                                "type": "assistantMessage",
                                "content": [{
                                    "type": "text",
                                    "text": output["text"],
                                }]
                            }
                        }
                    }),
                    serde_json::json!({
                        "jsonrpc": "2.0",
                        "method": "turn/completed",
                        "params": {
                            "threadId": thread_id,
                            "turn": turn.clone(),
                            "output": output.clone(),
                        }
                    }),
                ];
                Ok((
                    success_response(
                        request.id,
                        serde_json::json!({ "turn": turn, "output": output }),
                    ),
                    notifications,
                ))
            }
            _ => Ok((
                error_response(
                    request.id,
                    -32601,
                    format!("method not found: {}", request.method),
                ),
                Vec::new(),
            )),
        }
    }
}

fn success_response(id: Option<Value>, result: Value) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "result": result,
    })
}

fn error_response(id: Option<Value>, code: i64, message: String) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "error": {
            "code": code,
            "message": message,
        }
    })
}

fn extract_user_message_text(params: &Value) -> String {
    params
        .get("input")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("Hello from Cloudflare")
        .to_string()
}

fn extract_just_bash_command(user_message: &str) -> Option<String> {
    let trimmed = user_message.trim();
    trimmed
        .strip_prefix('!')
        .map(str::trim)
        .filter(|command| !command.is_empty())
        .map(str::to_string)
}

async fn default_just_bash_timeout_ms() -> Result<u64, PlatformError> {
    Ok(env_get("JUST_BASH_TIMEOUT_MS")
        .await?
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(30_000))
}

async fn execute_bash_command(
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<(String, String, i32), PlatformError> {
    let response = CloudflareJsPlatform
        .call(PlatformRequest::BashExec {
            command,
            cwd,
            env: Vec::new(),
            timeout_ms,
        })
        .await?;
    let PlatformResponse::BashExecResult {
        stdout,
        stderr,
        exit_code,
    } = response
    else {
        return Err(PlatformError::Message(format!(
            "unexpected platform response for bashExec: {response:?}"
        )));
    };
    Ok((stdout, stderr, exit_code))
}

async fn run_just_bash_command(command: &str, params: &Value) -> Result<String, PlatformError> {
    let cwd = params
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::to_string);
    let timeout_ms = default_just_bash_timeout_ms().await?;
    let (stdout, stderr, exit_code) =
        execute_bash_command(command.to_string(), cwd, Some(timeout_ms)).await?;

    let mut parts = vec![format!("$ {command}")];
    if !stdout.trim().is_empty() {
        parts.push(stdout.trim_end().to_string());
    }
    if !stderr.trim().is_empty() {
        parts.push(format!("stderr:\n{}", stderr.trim_end()));
    }
    if exit_code != 0 {
        parts.push(format!("exit code: {exit_code}"));
    }
    Ok(parts.join("\n"))
}

fn value_or_null(value: Option<String>) -> Value {
    value.map(Value::String).unwrap_or(Value::Null)
}

fn platform_host() -> PlatformHost<CloudflareJsPlatform> {
    PlatformHost::new(CloudflareJsPlatform)
}

async fn env_get(key: &str) -> Result<Option<String>, PlatformError> {
    platform_host().env_get(key).await
}

fn responses_endpoint(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.ends_with("/responses") {
        trimmed.to_string()
    } else if trimmed.ends_with("/v1") || trimmed.ends_with("/backend-api/codex") {
        format!("{trimmed}/responses")
    } else {
        format!("{trimmed}/v1/responses")
    }
}

#[derive(Debug, Clone)]
struct ModelAuthContext {
    bearer_token: String,
    account_id: Option<String>,
    base_url: String,
}

async fn model_auth_context() -> Result<ModelAuthContext, PlatformError> {
    if let Some(chatgpt_token) = env_get("CHATGPT_ACCESS_TOKEN").await? {
        let base_url = env_get("OPENAI_BASE_URL")
            .await?
            .unwrap_or_else(|| "https://chatgpt.com/backend-api/codex".to_string());
        let account_id = env_get("CHATGPT_ACCOUNT_ID").await?;
        return Ok(ModelAuthContext {
            bearer_token: chatgpt_token,
            account_id,
            base_url,
        });
    }

    let api_key = env_get("OPENAI_API_KEY").await?.ok_or_else(|| {
        PlatformError::Message(
            "missing auth: set CHATGPT_ACCESS_TOKEN or OPENAI_API_KEY".to_string(),
        )
    })?;
    let base_url = env_get("OPENAI_BASE_URL")
        .await?
        .unwrap_or_else(|| "https://api.openai.com".to_string());
    Ok(ModelAuthContext {
        bearer_token: api_key,
        account_id: None,
        base_url,
    })
}

fn extract_response_text(response_json: &Value) -> Option<String> {
    if let Some(text) = response_json.get("output_text").and_then(Value::as_str) {
        return Some(text.to_string());
    }

    if let Some(output_items) = response_json.get("output").and_then(Value::as_array) {
        let mut parts: Vec<String> = Vec::new();
        for output_item in output_items {
            let Some(content_items) = output_item.get("content").and_then(Value::as_array) else {
                continue;
            };
            for content_item in content_items {
                let text_opt = content_item
                    .get("text")
                    .and_then(Value::as_str)
                    .or_else(|| {
                        content_item
                            .get("text")
                            .and_then(|text| text.get("value"))
                            .and_then(Value::as_str)
                    });
                if let Some(text) = text_opt {
                    parts.push(text.to_string());
                }
            }
        }
        if !parts.is_empty() {
            return Some(parts.join("\n"));
        }
    }

    None
}

#[derive(Debug, Clone)]
struct PendingToolCall {
    call_id: String,
    name: String,
    arguments: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellToolArgs {
    command: Option<String>,
    cmd: Option<String>,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Default)]
struct ResponsesStepResult {
    text: Option<String>,
    tool_calls: Vec<PendingToolCall>,
}

fn parse_sse_events(body: &str) -> Vec<Value> {
    body.lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter(|payload| *payload != "[DONE]")
        .filter_map(|payload| serde_json::from_str::<Value>(payload).ok())
        .collect()
}

fn parse_function_call_item(item: &Value) -> Option<PendingToolCall> {
    if item.get("type").and_then(Value::as_str) != Some("function_call") {
        return None;
    }
    let call_id = item
        .get("call_id")
        .and_then(Value::as_str)
        .or_else(|| item.get("id").and_then(Value::as_str))
        .map(str::to_string)?;
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string)?;
    let arguments = item
        .get("arguments")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| item.get("arguments").map(Value::to_string))
        .unwrap_or_else(|| "{}".to_string());
    Some(PendingToolCall {
        call_id,
        name,
        arguments,
    })
}

fn extract_tool_calls_from_response(response_json: &Value) -> Vec<PendingToolCall> {
    let mut seen = HashSet::new();
    let mut calls = Vec::new();
    if let Some(items) = response_json.get("output").and_then(Value::as_array) {
        for item in items {
            if let Some(call) = parse_function_call_item(item)
                && seen.insert(call.call_id.clone())
            {
                calls.push(call);
            }
        }
    }
    calls
}

fn extract_tool_calls_from_events(events: &[Value]) -> Vec<PendingToolCall> {
    let mut seen = HashSet::new();
    let mut calls = Vec::new();
    for event in events {
        if event.get("type").and_then(Value::as_str) == Some("response.output_item.done")
            && let Some(item) = event.get("item")
            && let Some(call) = parse_function_call_item(item)
            && seen.insert(call.call_id.clone())
        {
            calls.push(call);
            continue;
        }
        if event.get("type").and_then(Value::as_str) == Some("response.completed")
            && let Some(response_items) = event
                .get("response")
                .and_then(|response| response.get("output"))
                .and_then(Value::as_array)
        {
            for item in response_items {
                if let Some(call) = parse_function_call_item(item)
                    && seen.insert(call.call_id.clone())
                {
                    calls.push(call);
                }
            }
        }
    }
    calls
}

fn extract_response_text_from_events(events: &[Value]) -> Option<String> {
    for event in events {
        if event.get("type").and_then(Value::as_str) == Some("response.completed")
            && let Some(response) = event.get("response")
            && let Some(text) = extract_response_text(response)
            && !text.trim().is_empty()
        {
            return Some(text);
        }
    }
    None
}

fn extract_sse_output_text(body: &str) -> Option<String> {
    let mut text = String::new();
    for line in body.lines() {
        let Some(json_payload) = line.strip_prefix("data: ") else {
            continue;
        };
        let Ok(event) = serde_json::from_str::<Value>(json_payload) else {
            continue;
        };
        let event_type = event.get("type").and_then(Value::as_str);
        if event_type == Some("response.output_text.delta")
            && let Some(delta) = event.get("delta").and_then(Value::as_str)
        {
            text.push_str(delta);
            continue;
        }
        if event_type == Some("response.refusal.delta")
            && let Some(delta) = event.get("delta").and_then(Value::as_str)
        {
            text.push_str(delta);
            continue;
        }
        if text.is_empty()
            && event_type == Some("response.output_text.done")
            && let Some(done_text) = event.get("text").and_then(Value::as_str)
        {
            text.push_str(done_text);
            continue;
        }
        if text.is_empty()
            && event_type == Some("response.refusal.done")
            && let Some(done_text) = event.get("refusal").and_then(Value::as_str)
        {
            text.push_str(done_text);
            continue;
        }
        if text.is_empty()
            && event_type == Some("response.completed")
            && let Some(items) = event
                .get("response")
                .and_then(|value| value.get("output"))
                .and_then(Value::as_array)
        {
            for item in items {
                let Some(content) = item.get("content").and_then(Value::as_array) else {
                    continue;
                };
                for part in content {
                    if let Some(done_text) = part.get("text").and_then(Value::as_str) {
                        text.push_str(done_text);
                    }
                }
            }
        }
    }
    if text.is_empty() { None } else { Some(text) }
}

fn shell_tool_schema() -> Value {
    serde_json::json!([
        {
            "type": "function",
            "name": "shell_command",
            "description": "Execute a bash command in the workspace and return stdout, stderr, and exitCode.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The bash command to execute."
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Optional working directory."
                    },
                    "timeoutMs": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 120000
                    }
                },
                "required": ["command"],
                "additionalProperties": false
            }
        }
    ])
}

async fn execute_responses_step(
    auth_context: &ModelAuthContext,
    request_body: Value,
) -> Result<ResponsesStepResult, PlatformError> {
    let bearer_token = auth_context.bearer_token.clone();
    let authorization = HeaderValue::from_str(format!("Bearer {bearer_token}").as_str())
        .map_err(|err| PlatformError::Message(format!("invalid authorization header: {err}")))?;
    let mut request = HttpRequest::new(Method::POST, responses_endpoint(&auth_context.base_url));
    request
        .headers
        .insert(http::header::AUTHORIZATION, authorization);
    if let Some(account_id) = auth_context.account_id.clone()
        && let Ok(account_header) = HeaderValue::from_str(&account_id)
    {
        request.headers.insert("ChatGPT-Account-ID", account_header);
    }
    request.compression = RequestCompression::None;
    request = request.with_json(&request_body);

    let response = PlatformHttpTransport
        .execute(request)
        .await
        .map_err(|err| PlatformError::Message(format!("model request failed: {err}")))?;
    let response_body = String::from_utf8(response.body.to_vec()).map_err(|err| {
        PlatformError::Message(format!("decode model response body failed: {err}"))
    })?;

    if let Ok(response_json) = serde_json::from_str::<Value>(&response_body) {
        if response_json.get("error").is_some() || response_json.get("detail").is_some() {
            return Err(PlatformError::Message(format!(
                "model error response: {response_json}"
            )));
        }
        return Ok(ResponsesStepResult {
            text: extract_response_text(&response_json),
            tool_calls: extract_tool_calls_from_response(&response_json),
        });
    }

    let events = parse_sse_events(&response_body);
    Ok(ResponsesStepResult {
        text: extract_response_text_from_events(&events)
            .or_else(|| extract_sse_output_text(&response_body)),
        tool_calls: extract_tool_calls_from_events(&events),
    })
}

async fn execute_tool_call(
    tool_call: &PendingToolCall,
    params: &Value,
) -> Result<String, PlatformError> {
    if !matches!(
        tool_call.name.as_str(),
        "shell_command" | "shell" | "bash" | "just_bash"
    ) {
        return Ok(serde_json::json!({
            "error": format!("unsupported tool: {}", tool_call.name),
        })
        .to_string());
    }

    let args = serde_json::from_str::<ShellToolArgs>(&tool_call.arguments).unwrap_or_default();
    let command = args.command.or(args.cmd).ok_or_else(|| {
        PlatformError::Message(format!(
            "tool call {} missing command argument",
            tool_call.call_id
        ))
    })?;
    let cwd = args.cwd.or_else(|| {
        params
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    let timeout_ms = args
        .timeout_ms
        .or(Some(default_just_bash_timeout_ms().await?));
    let (stdout, stderr, exit_code) = execute_bash_command(command, cwd, timeout_ms).await?;
    serde_json::to_string(&serde_json::json!({
        "stdout": stdout,
        "stderr": stderr,
        "exitCode": exit_code,
    }))
    .map_err(|err| PlatformError::Message(format!("serialize tool output failed: {err}")))
}

async fn generate_assistant_text(
    params: &Value,
    user_message: &str,
) -> Result<String, PlatformError> {
    let auth_context = model_auth_context().await?;
    let model = params
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or(env_get("OPENAI_MODEL").await?)
        .unwrap_or_else(|| "gpt-4.1-mini".to_string());
    let mut input_items = vec![serde_json::json!({
        "role": "user",
        "content": [
            {
                "type": "input_text",
                "text": user_message
            }
        ]
    })];

    for _ in 0..8 {
        let request_body = serde_json::json!({
            "model": model.clone(),
            "instructions": "You are Codex. Use the shell_command tool whenever command execution is needed and ground your answer in the tool output.",
            "input": input_items,
            "tools": shell_tool_schema(),
            "tool_choice": "auto",
            "parallel_tool_calls": false,
            "store": false,
            "stream": true
        });
        let step = execute_responses_step(&auth_context, request_body).await?;
        if let Some(text) = step.text
            && !text.trim().is_empty()
        {
            return Ok(text);
        }
        if step.tool_calls.is_empty() {
            return Err(PlatformError::Message(
                "model response had no assistant text and no tool calls".to_string(),
            ));
        }

        for tool_call in &step.tool_calls {
            input_items.push(serde_json::json!({
                "type": "function_call",
                "call_id": tool_call.call_id,
                "name": tool_call.name,
                "arguments": tool_call.arguments,
            }));
            let output = execute_tool_call(tool_call, params).await?;
            input_items.push(serde_json::json!({
                "type": "function_call_output",
                "call_id": tool_call.call_id,
                "output": output,
            }));
        }
    }

    Err(PlatformError::Message(
        "model tool loop exceeded maximum steps".to_string(),
    ))
}

async fn now_unix_seconds() -> Result<i64, PlatformError> {
    platform_host().now_unix_seconds().await
}

async fn allocate_id(prefix: &str) -> Result<String, PlatformError> {
    let (rows, _) = sql_query(
        "UPDATE id_sequence SET next_id = next_id + 1 RETURNING next_id AS nextId;",
        Vec::new(),
    )
    .await?;
    let next_row = rows
        .first()
        .cloned()
        .map(serde_json::from_value::<NextIdRow>)
        .transpose()
        .map_err(|err| PlatformError::Message(format!("invalid next id row: {err}")))?;
    let next_id = next_row.map(|row| row.next_id).unwrap_or(1);
    Ok(format!("{prefix}_{next_id}"))
}

async fn append_event<T: Serialize>(
    thread_id: &str,
    turn_id: Option<&str>,
    event_type: &str,
    body: &T,
    created_at: i64,
) -> Result<(), PlatformError> {
    sql_exec(
        "INSERT INTO event_log(thread_id, turn_id, event_type, body_json, created_at)
         VALUES (?, ?, ?, ?, ?);",
        vec![
            Value::String(thread_id.to_string()),
            turn_id
                .map(|id| Value::String(id.to_string()))
                .unwrap_or(Value::Null),
            Value::String(event_type.to_string()),
            Value::String(serde_json::to_string(body).map_err(|err| {
                PlatformError::Message(format!("serialize event body failed: {err}"))
            })?),
            Value::from(created_at),
        ],
    )
    .await
}

async fn sql_exec(statement: &str, params: Vec<Value>) -> Result<(), PlatformError> {
    platform_host()
        .sql_exec(statement, params)
        .await
        .map(|_| ())
}

async fn sql_query(
    statement: &str,
    params: Vec<Value>,
) -> Result<(Vec<Value>, u64), PlatformError> {
    platform_host().sql_query(statement, params).await
}
