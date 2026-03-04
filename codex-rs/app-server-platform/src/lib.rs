mod host;
mod native;
mod platform;
#[cfg(target_arch = "wasm32")]
mod wasm_js;

pub use host::ModelTransport;
pub use host::PlatformHost;
pub use host::ProcessOutput;
pub use host::ProcessSpawnRequest;
pub use host::RuntimeHost;
pub use host::SessionStore;
pub use host::WorkspaceClient;
pub use native::NativePlatform;
pub use platform::LogLevel;
pub use platform::Platform;
pub use platform::PlatformCapability;
pub use platform::PlatformContract;
pub use platform::PlatformError;
pub use platform::PlatformKind;
pub use platform::PlatformRequest;
pub use platform::PlatformResponse;
#[cfg(target_arch = "wasm32")]
pub use wasm_js::CloudflareJsPlatform;

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn request_round_trip_json() {
        let request = PlatformRequest::SqlExec {
            statement: "INSERT INTO events(type) VALUES (?)".to_string(),
            params: vec![serde_json::json!("thread.started")],
        };
        let serialized = serde_json::to_string(&request).expect("serialize request");
        let deserialized =
            serde_json::from_str::<PlatformRequest>(&serialized).expect("deserialize request");
        assert_eq!(request, deserialized);
    }

    #[test]
    fn contract_lists_native_and_cloudflare() {
        let contract = PlatformContract::default();
        assert_eq!(
            contract.platforms,
            vec![PlatformKind::Native, PlatformKind::Cloudflare]
        );
    }
}
