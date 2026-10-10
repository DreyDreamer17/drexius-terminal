//! Unified, serializable error type. Every Tauri command returns `AppResult<T>`
//! so the frontend receives a structured `{ kind, message }` object.

use serde::{ser::SerializeStruct, Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("vault is locked")]
    VaultLocked,
    #[error("invalid master password")]
    BadMasterPassword,
    #[error("host not found: {0}")]
    HostNotFound(String),
    #[error("session not found: {0}")]
    SessionNotFound(String),
    #[error("unknown host key — fingerprint SHA256:{fingerprint}")]
    UnknownHostKey { fingerprint: String },
    #[error("HOST KEY MISMATCH — possible MITM attack! expected {expected}, got {actual}")]
    HostKeyMismatch { expected: String, actual: String },
    #[error("authentication failed")]
    AuthFailed,
    #[error("network: {0}")]
    Network(String),
    #[error("ssh: {0}")]
    Ssh(#[from] ssh2::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("database: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("crypto: {0}")]
    Crypto(String),
    #[error("{0}")]
    Other(String),
}

impl AppError {
    fn kind(&self) -> &'static str {
        match self {
            AppError::VaultLocked => "vaultLocked",
            AppError::BadMasterPassword => "badMasterPassword",
            AppError::HostNotFound(_) => "hostNotFound",
            AppError::SessionNotFound(_) => "sessionNotFound",
            AppError::UnknownHostKey { .. } => "unknownHostKey",
            AppError::HostKeyMismatch { .. } => "hostKeyMismatch",
            AppError::AuthFailed => "authFailed",
            AppError::Network(_) => "network",
            AppError::Ssh(_) => "ssh",
            AppError::Io(_) => "io",
            AppError::Db(_) => "db",
            AppError::Crypto(_) => "crypto",
            AppError::Other(_) => "other",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("AppError", 3)?;
        st.serialize_field("kind", self.kind())?;
        st.serialize_field("message", &self.to_string())?;
        if let AppError::UnknownHostKey { fingerprint } = self {
            st.serialize_field("fingerprint", fingerprint)?;
        } else {
            st.serialize_field("fingerprint", &Option::<String>::None)?;
        }
        st.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
