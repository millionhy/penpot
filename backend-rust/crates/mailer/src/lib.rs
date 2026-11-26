//! SMTP delivery for the Penpot `sendmail` task.
//!
//! The Clojure backend builds a Jakarta Mail message inside
//! `app.email/::sendmail`. This crate mirrors that path without Jakarta Mail:
//!
//! * task props are read from Transit and validated before any socket opens;
//! * addresses are ASCII-only and header values reject CR/LF injection;
//! * MIME boundaries are random and never collide with body text;
//! * the SMTP client supports implicit TLS (`smtps`) and required STARTTLS,
//!   with certificate validation through the platform trust store;
//! * `SmtpTransport` is a trait, so the PostgreSQL adapter or tests can replace
//!   the network without touching message construction.
//!
//! The SMTP host comes from operator configuration, never from email props, so
//! the webhook SSRF blocklist does not apply here.

mod address;
mod error;
mod header;
mod mailer;
mod mime;
mod smtp;

pub use address::Mailbox;
pub use error::MailError;
pub use mailer::{render_email, SmtpMailer};
pub use mime::{Attachment, Body, Email, MimeDefaults, RenderedMessage, MAX_MESSAGE_BYTES};
pub use smtp::{dot_stuff, SmtpClient, SmtpConfig, SmtpTransport, DEFAULT_TIMEOUT};
