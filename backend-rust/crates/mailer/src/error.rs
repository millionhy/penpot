//! Errors raised while parsing an email or talking to an SMTP server.

/// One failure in the `sendmail` path.
///
/// Messages never include the SMTP password. Server replies are truncated
/// before they are stored, so a hostile or broken server cannot flood
/// `task.error`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MailError {
    /// A sender, recipient, or reply-to address is malformed.
    #[error("invalid `{field}` address: {reason}")]
    InvalidAddress {
        /// Email property that held the address.
        field: String,
        /// Why the address was rejected.
        reason: String,
    },

    /// A header name or value cannot be written safely.
    #[error("invalid header `{name}`: {reason}")]
    InvalidHeader {
        /// Header name, or the closest printable form.
        name: String,
        /// Why the header was rejected.
        reason: String,
    },

    /// The task props do not describe a sendable email.
    #[error("invalid email body: {0}")]
    InvalidBody(String),

    /// `smtp` is enabled but a required setting is absent.
    #[error("missing SMTP configuration: {0}")]
    MissingConfig(&'static str),

    /// A configured SMTP value is unusable.
    #[error("invalid SMTP configuration: {0}")]
    InvalidConfig(String),

    /// The TCP connection could not be opened or timed out.
    #[error("SMTP connection failed: {0}")]
    Connect(String),

    /// TLS setup or certificate validation failed.
    #[error("SMTP TLS failed: {0}")]
    Tls(String),

    /// The server replied outside the SMTP protocol.
    #[error("SMTP protocol error during {stage}: {detail}")]
    Protocol {
        /// Protocol step, for example `MAIL FROM`.
        stage: String,
        /// Truncated server reply.
        detail: String,
    },

    /// Authentication was required but could not be completed.
    #[error("SMTP authentication failed: {0}")]
    Auth(String),

    /// The rendered message exceeds the delivery cap.
    #[error("message exceeds the {limit} byte limit")]
    TooLarge {
        /// Maximum accepted message size.
        limit: usize,
    },

    /// Socket I/O failed after the connection was open.
    #[error("SMTP I/O failed: {0}")]
    Io(String),
}
