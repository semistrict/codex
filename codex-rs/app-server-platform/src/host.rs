use async_trait::async_trait;
use serde_json::Value;

use crate::LogLevel;
use crate::Platform;
use crate::PlatformError;
use crate::PlatformRequest;
use crate::PlatformResponse;

#[async_trait(?Send)]
pub trait SessionStore {
    async fn sql_exec(&self, statement: &str, params: Vec<Value>) -> Result<u64, PlatformError>;
    async fn sql_query(
        &self,
        statement: &str,
        params: Vec<Value>,
    ) -> Result<(Vec<Value>, u64), PlatformError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessSpawnRequest {
    pub sandbox_name: String,
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessOutput {
    pub stdout: String,
    pub stderr: String,
    pub done: bool,
    pub exit_code: Option<i32>,
}

#[async_trait(?Send)]
pub trait WorkspaceClient {
    async fn process_spawn(&self, request: ProcessSpawnRequest) -> Result<String, PlatformError>;
    async fn process_write_stdin(
        &self,
        process_id: &str,
        data: String,
    ) -> Result<(), PlatformError>;
    async fn process_kill(
        &self,
        process_id: &str,
        signal: Option<i32>,
    ) -> Result<(), PlatformError>;
    async fn process_read_output(&self, _process_id: &str) -> Result<ProcessOutput, PlatformError> {
        Err(PlatformError::Message(
            "process output polling is unsupported by this host".to_string(),
        ))
    }
}

#[async_trait(?Send)]
pub trait ModelTransport {
    async fn http_request(
        &self,
        method: &str,
        url: String,
        headers: Vec<(String, String)>,
        body: Option<String>,
    ) -> Result<(u16, Vec<(String, String)>, String), PlatformError>;
}

#[async_trait(?Send)]
pub trait RuntimeHost {
    async fn env_get(&self, key: &str) -> Result<Option<String>, PlatformError>;
    async fn now_unix_seconds(&self) -> Result<i64, PlatformError>;
    async fn random_u64(&self) -> Result<String, PlatformError>;
    async fn log(
        &self,
        level: LogLevel,
        message: String,
        fields: Value,
    ) -> Result<(), PlatformError>;
}

#[derive(Debug, Clone)]
pub struct PlatformHost<P: Platform> {
    platform: P,
}

impl<P: Platform> PlatformHost<P> {
    pub fn new(platform: P) -> Self {
        Self { platform }
    }
}

#[async_trait(?Send)]
impl<P: Platform> SessionStore for PlatformHost<P> {
    async fn sql_exec(&self, statement: &str, params: Vec<Value>) -> Result<u64, PlatformError> {
        match self
            .platform
            .call(PlatformRequest::SqlExec {
                statement: statement.to_string(),
                params,
            })
            .await?
        {
            PlatformResponse::Sql { rows_written, .. } => Ok(rows_written),
            PlatformResponse::Ack => Ok(0),
            response => Err(PlatformError::Message(format!(
                "unexpected platform response for sql exec: {response:?}"
            ))),
        }
    }

    async fn sql_query(
        &self,
        statement: &str,
        params: Vec<Value>,
    ) -> Result<(Vec<Value>, u64), PlatformError> {
        match self
            .platform
            .call(PlatformRequest::SqlQuery {
                statement: statement.to_string(),
                params,
            })
            .await?
        {
            PlatformResponse::Sql { rows, rows_written } => Ok((rows, rows_written)),
            response => Err(PlatformError::Message(format!(
                "unexpected platform response for sql query: {response:?}"
            ))),
        }
    }
}

#[async_trait(?Send)]
impl<P: Platform> WorkspaceClient for PlatformHost<P> {
    async fn process_spawn(&self, request: ProcessSpawnRequest) -> Result<String, PlatformError> {
        match self
            .platform
            .call(PlatformRequest::ProcessSpawn {
                sandbox_name: request.sandbox_name,
                argv: request.argv,
                cwd: request.cwd,
                env: request.env,
            })
            .await?
        {
            PlatformResponse::ProcessSpawned { process_id } => Ok(process_id),
            response => Err(PlatformError::Message(format!(
                "unexpected platform response for process spawn: {response:?}"
            ))),
        }
    }

    async fn process_write_stdin(
        &self,
        process_id: &str,
        data: String,
    ) -> Result<(), PlatformError> {
        match self
            .platform
            .call(PlatformRequest::ProcessWriteStdin {
                process_id: process_id.to_string(),
                data,
            })
            .await?
        {
            PlatformResponse::Ack => Ok(()),
            response => Err(PlatformError::Message(format!(
                "unexpected platform response for process stdin: {response:?}"
            ))),
        }
    }

    async fn process_kill(
        &self,
        process_id: &str,
        signal: Option<i32>,
    ) -> Result<(), PlatformError> {
        match self
            .platform
            .call(PlatformRequest::ProcessKill {
                process_id: process_id.to_string(),
                signal,
            })
            .await?
        {
            PlatformResponse::Ack => Ok(()),
            response => Err(PlatformError::Message(format!(
                "unexpected platform response for process kill: {response:?}"
            ))),
        }
    }
}

#[async_trait(?Send)]
impl<P: Platform> ModelTransport for PlatformHost<P> {
    async fn http_request(
        &self,
        method: &str,
        url: String,
        headers: Vec<(String, String)>,
        body: Option<String>,
    ) -> Result<(u16, Vec<(String, String)>, String), PlatformError> {
        match self
            .platform
            .call(PlatformRequest::HttpRequest {
                method: method.to_string(),
                url,
                headers,
                body,
            })
            .await?
        {
            PlatformResponse::HttpResponse {
                status,
                headers,
                body,
            } => Ok((status, headers, body)),
            response => Err(PlatformError::Message(format!(
                "unexpected platform response for http request: {response:?}"
            ))),
        }
    }
}

#[async_trait(?Send)]
impl<P: Platform> RuntimeHost for PlatformHost<P> {
    async fn env_get(&self, key: &str) -> Result<Option<String>, PlatformError> {
        match self
            .platform
            .call(PlatformRequest::EnvGet {
                key: key.to_string(),
            })
            .await?
        {
            PlatformResponse::EnvValue { value } => Ok(value),
            response => Err(PlatformError::Message(format!(
                "unexpected platform response for env get: {response:?}"
            ))),
        }
    }

    async fn now_unix_seconds(&self) -> Result<i64, PlatformError> {
        match self
            .platform
            .call(PlatformRequest::ClockNowUnixSeconds)
            .await?
        {
            PlatformResponse::ClockNowUnixSeconds { now } => Ok(now),
            response => Err(PlatformError::Message(format!(
                "unexpected platform response for clock call: {response:?}"
            ))),
        }
    }

    async fn random_u64(&self) -> Result<String, PlatformError> {
        match self.platform.call(PlatformRequest::RandomU64).await? {
            PlatformResponse::RandomU64 { value } => Ok(value),
            response => Err(PlatformError::Message(format!(
                "unexpected platform response for random call: {response:?}"
            ))),
        }
    }

    async fn log(
        &self,
        level: LogLevel,
        message: String,
        fields: Value,
    ) -> Result<(), PlatformError> {
        match self
            .platform
            .call(PlatformRequest::Log {
                level,
                message,
                fields,
            })
            .await?
        {
            PlatformResponse::Ack => Ok(()),
            response => Err(PlatformError::Message(format!(
                "unexpected platform response for log call: {response:?}"
            ))),
        }
    }
}
