//! Error type shared by every module. Errors are serialised to the frontend as
//! `{ code, message, field? }` so the UI can show field-level validation messages.

use serde::Serialize;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A user-supplied value failed validation. `field` names the offending input.
    #[error("{message}")]
    Validation { field: Option<String>, message: String },
    #[error("{0}")]
    NotFound(String),
    /// The request is valid but conflicts with existing data (duplicates, in-use rows...).
    #[error("{0}")]
    Conflict(String),
    /// The request cannot be honoured in the current state (e.g. database from a newer app).
    #[error("{0}")]
    Unsupported(String),
    #[error("Database error: {0}")]
    Db(rusqlite::Error),
    #[error("File error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Data format error: {0}")]
    Json(#[from] serde_json::Error),
}

impl Error {
    pub fn validation(field: &str, message: impl Into<String>) -> Self {
        Error::Validation { field: Some(field.to_string()), message: message.into() }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Error::Validation { .. } => "validation",
            Error::NotFound(_) => "not_found",
            Error::Conflict(_) => "conflict",
            Error::Unsupported(_) => "unsupported",
            Error::Db(_) => "database",
            Error::Io(_) => "io",
            Error::Json(_) => "format",
        }
    }
}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        if let rusqlite::Error::SqliteFailure(f, _) = &e {
            if f.code == rusqlite::ErrorCode::ConstraintViolation {
                return Error::Conflict(
                    "That change conflicts with existing data (a duplicate or a value that is still in use).".into(),
                );
            }
        }
        Error::Db(e)
    }
}

/// Wire format of an error as seen by the JavaScript side.
#[derive(Debug, Clone, Serialize)]
pub struct ApiError {
    pub code: &'static str,
    pub message: String,
    pub field: Option<String>,
}

impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        let field = match &e {
            Error::Validation { field, .. } => field.clone(),
            _ => None,
        };
        ApiError { code: e.code(), message: e.to_string(), field }
    }
}
