use async_trait::async_trait;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlatformKind {
    Native,
    Cloudflare,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlatformCapability {
    Sqlite,
    WebSocket,
    SandboxProcess,
    Clock,
    Random,
    Logging,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformContract {
    pub platforms: Vec<PlatformKind>,
    pub required_capabilities: Vec<PlatformCapability>,
}

impl Default for PlatformContract {
    fn default() -> Self {
        Self {
            platforms: vec![PlatformKind::Native, PlatformKind::Cloudflare],
            required_capabilities: vec![
                PlatformCapability::Sqlite,
                PlatformCapability::WebSocket,
                PlatformCapability::SandboxProcess,
                PlatformCapability::Clock,
                PlatformCapability::Random,
                PlatformCapability::Logging,
            ],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PlatformRequest {
    SqlExec {
        statement: String,
        params: Vec<Value>,
    },
    SqlQuery {
        statement: String,
        params: Vec<Value>,
    },
    WebSocketSend {
        #[serde(rename = "connectionId")]
        connection_id: String,
        #[serde(rename = "payloadJson")]
        payload_json: String,
    },
    WebSocketBroadcast {
        #[serde(rename = "payloadJson")]
        payload_json: String,
    },
    ProcessSpawn {
        #[serde(rename = "sandboxName")]
        sandbox_name: String,
        argv: Vec<String>,
        cwd: Option<String>,
        env: Vec<(String, String)>,
    },
    ProcessWriteStdin {
        #[serde(rename = "processId")]
        process_id: String,
        data: String,
    },
    ProcessKill {
        #[serde(rename = "processId")]
        process_id: String,
        signal: Option<i32>,
    },
    BashExec {
        command: String,
        cwd: Option<String>,
        env: Vec<(String, String)>,
        #[serde(rename = "timeoutMs")]
        timeout_ms: Option<u64>,
    },
    HttpRequest {
        method: String,
        url: String,
        headers: Vec<(String, String)>,
        body: Option<String>,
    },
    EnvGet {
        key: String,
    },
    ClockNowUnixSeconds,
    RandomU64,
    Log {
        level: LogLevel,
        message: String,
        fields: Value,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PlatformResponse {
    Ack,
    Sql {
        rows: Vec<Value>,
        #[serde(rename = "rowsWritten")]
        rows_written: u64,
    },
    ProcessSpawned {
        #[serde(rename = "processId")]
        process_id: String,
    },
    ProcessOutput {
        stdout: String,
        stderr: String,
        done: bool,
        #[serde(rename = "exitCode")]
        exit_code: Option<i32>,
    },
    BashExecResult {
        stdout: String,
        stderr: String,
        #[serde(rename = "exitCode")]
        exit_code: i32,
    },
    HttpResponse {
        status: u16,
        headers: Vec<(String, String)>,
        body: String,
    },
    EnvValue {
        value: Option<String>,
    },
    ClockNowUnixSeconds {
        now: i64,
    },
    RandomU64 {
        value: String,
    },
}

#[derive(Debug, Error)]
pub enum PlatformError {
    #[error("platform `{platform:?}` does not support request `{request:?}`")]
    Unsupported {
        platform: PlatformKind,
        request: PlatformRequest,
    },
    #[error("platform request failed: {0}")]
    Message(String),
}

#[async_trait(?Send)]
pub trait Platform {
    fn kind(&self) -> PlatformKind;

    async fn call(&self, request: PlatformRequest) -> Result<PlatformResponse, PlatformError>;
}
