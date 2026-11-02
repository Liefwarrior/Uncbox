//! One error type for the whole engine. Its text is what the person ends up reading (the page shows
//! the last line the engine printed), so it is a plain sentence, never a code or a stack.

use std::fmt;

#[derive(Debug, Clone)]
pub struct Error(String);

impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Error(message.into())
    }

    pub fn message(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(err: std::io::Error) -> Self {
        use std::io::ErrorKind::*;
        Error(match err.kind() {
            ConnectionRefused => "The server refused the connection.".to_string(),
            ConnectionReset | ConnectionAborted | BrokenPipe => "The connection to the server was lost.".to_string(),
            TimedOut | WouldBlock => "The server stopped responding.".to_string(),
            // Windows adds " (os error N)" to its own sentences; the number is no use to a person.
            _ => {
                let text = err.to_string();
                text.split(" (os error").next().unwrap_or(&text).to_string()
            }
        })
    }
}

#[cfg(windows)]
impl From<windows::core::Error> for Error {
    fn from(err: windows::core::Error) -> Self {
        Error(format!("{} (0x{:08X})", err.message().trim(), err.code().0 as u32))
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Adds a plain-English "what we were doing" in front of a lower-level failure.
pub trait Context<T> {
    fn context(self, doing: &str) -> Result<T>;
}

impl<T, E: fmt::Display> Context<T> for std::result::Result<T, E> {
    fn context(self, doing: &str) -> Result<T> {
        self.map_err(|e| Error(format!("{doing}: {e}")))
    }
}

/// Shorthand: `bail!("text {x}")` returns an `Error`.
#[macro_export]
macro_rules! bail {
    ($($arg:tt)*) => {
        return Err($crate::error::Error::new(format!($($arg)*)))
    };
}
