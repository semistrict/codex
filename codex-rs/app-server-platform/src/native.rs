use async_trait::async_trait;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use crate::Platform;
use crate::PlatformError;
use crate::PlatformKind;
use crate::PlatformRequest;
use crate::PlatformResponse;

#[derive(Debug, Default, Clone, Copy)]
pub struct NativePlatform;

static RANDOM_COUNTER: AtomicU64 = AtomicU64::new(0);

#[async_trait(?Send)]
impl Platform for NativePlatform {
    fn kind(&self) -> PlatformKind {
        PlatformKind::Native
    }

    async fn call(&self, request: PlatformRequest) -> Result<PlatformResponse, PlatformError> {
        match request {
            PlatformRequest::ClockNowUnixSeconds => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|err| PlatformError::Message(format!("system clock error: {err}")))?
                    .as_secs();
                Ok(PlatformResponse::ClockNowUnixSeconds {
                    now: i64::try_from(now).unwrap_or(i64::MAX),
                })
            }
            PlatformRequest::RandomU64 => Ok(PlatformResponse::RandomU64 {
                value: {
                    let now_nanos = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_err(|err| {
                            PlatformError::Message(format!("system clock error: {err}"))
                        })?
                        .as_nanos();
                    let now = u64::try_from(now_nanos).unwrap_or(u64::MAX);
                    let counter = RANDOM_COUNTER.fetch_add(1, Ordering::Relaxed);
                    (now ^ counter.rotate_left(17) ^ 0x9E37_79B9_7F4A_7C15).to_string()
                },
            }),
            PlatformRequest::Log {
                level,
                message,
                fields,
            } => {
                let _ = (level, message, fields);
                Ok(PlatformResponse::Ack)
            }
            PlatformRequest::SqlExec { .. }
            | PlatformRequest::SqlQuery { .. }
            | PlatformRequest::WebSocketSend { .. }
            | PlatformRequest::WebSocketBroadcast { .. }
            | PlatformRequest::ProcessSpawn { .. }
            | PlatformRequest::ProcessWriteStdin { .. }
            | PlatformRequest::ProcessKill { .. }
            | PlatformRequest::BashExec { .. }
            | PlatformRequest::HttpRequest { .. }
            | PlatformRequest::EnvGet { .. } => Err(PlatformError::Unsupported {
                platform: PlatformKind::Native,
                request,
            }),
        }
    }
}
