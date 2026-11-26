//! One-shot SMTP delivery with optional implicit TLS or STARTTLS.
//!
//! The SMTP target comes from operator configuration, not from task props, so
//! this client does not apply the webhook SSRF blocklist. Email addresses and
//! header values are validated before they reach a command, and the transport
//! is a trait so tests can replace the socket.

use std::{fmt, sync::Arc, time::Duration};

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use config::Config;
use rustls::{pki_types::ServerName, ClientConfig, RootCertStore};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
};
use tokio_rustls::TlsConnector;

use crate::{address::validate_envelope, MailError, RenderedMessage};

/// `JavaMail`'s default connection and read timeout.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

const MAX_REPLY_LINE: usize = 4 * 1024;
const MAX_REPLY_BYTES: usize = 64 * 1024;
const MAX_ERROR_DETAIL: usize = 300;
const MAX_COMMAND: usize = 998;

/// SMTP settings decoded from `PENPOT_SMTP_*`.
#[derive(Clone, PartialEq, Eq)]
pub struct SmtpConfig {
    /// SMTP server host.
    pub host: String,
    /// SMTP server port.
    pub port: u16,
    /// Use implicit TLS (`smtps`).
    pub ssl: bool,
    /// Issue STARTTLS before authentication and delivery.
    pub tls: bool,
    /// Optional SASL username.
    pub username: Option<String>,
    /// Optional SASL password.
    pub password: Option<String>,
    /// Sender used when an email has no `from`.
    pub default_from: Option<String>,
    /// Reply-to used when an email has no `reply-to`.
    pub default_reply_to: Option<String>,
    /// Connection and response timeout.
    pub timeout: Duration,
    /// Log protocol lines with credentials redacted.
    pub debug: bool,
}

impl fmt::Debug for SmtpConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SmtpConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("ssl", &self.ssl)
            .field("tls", &self.tls)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "<redacted>"))
            .field("default_from", &self.default_from)
            .field("default_reply_to", &self.default_reply_to)
            .field("timeout", &self.timeout)
            .field("debug", &self.debug)
            .finish()
    }
}

impl SmtpConfig {
    /// Build a plaintext configuration; tests usually start here.
    #[must_use]
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        Self {
            host: host.into(),
            port,
            ssl: false,
            tls: false,
            username: None,
            password: None,
            default_from: None,
            default_reply_to: None,
            timeout: DEFAULT_TIMEOUT,
            debug: false,
        }
    }

    /// Read `smtp-*` keys from the environment configuration.
    ///
    /// # Errors
    ///
    /// Returns [`MailError::MissingConfig`] without `smtp-host`, and
    /// [`MailError::InvalidConfig`] for an invalid port, host, or credential.
    pub fn from_config(config: &Config) -> Result<Self, MailError> {
        let host = config
            .str("smtp-host")
            .map(str::trim)
            .filter(|host| !host.is_empty())
            .ok_or(MailError::MissingConfig("smtp-host"))?;
        let ssl = config.bool("smtp-ssl").unwrap_or(false);
        let port = match config.i64("smtp-port") {
            Some(port) => u16::try_from(port).map_err(|_| {
                MailError::InvalidConfig("`smtp-port` must be between 1 and 65535".to_owned())
            })?,
            None if ssl => 465,
            None => 25,
        };
        if port == 0 {
            return Err(MailError::InvalidConfig(
                "`smtp-port` must be between 1 and 65535".to_owned(),
            ));
        }

        let username = config.str("smtp-username").map(str::to_owned);
        let password = config.str("smtp-password").map(str::to_owned);
        validate_credentials(username.as_deref(), password.as_deref())?;

        let result = Self {
            host: normalize_host(host)?,
            port,
            ssl,
            tls: config.bool("smtp-tls").unwrap_or(false),
            username,
            password,
            default_from: config.str("smtp-default-from").map(str::to_owned),
            default_reply_to: config.str("smtp-default-reply-to").map(str::to_owned),
            timeout: DEFAULT_TIMEOUT,
            debug: config.flags().contains("smtp-debug"),
        };
        result.validate()?;
        Ok(result)
    }

    /// Verify the settings before opening a socket.
    ///
    /// # Errors
    ///
    /// Rejects an empty or malformed host and control characters in
    /// credentials.
    pub fn validate(&self) -> Result<(), MailError> {
        if self.port == 0 {
            return Err(MailError::InvalidConfig(
                "`smtp-port` must be between 1 and 65535".to_owned(),
            ));
        }
        normalize_host(&self.host)?;
        validate_credentials(self.username.as_deref(), self.password.as_deref())
    }

    /// Set SASL credentials.
    #[must_use]
    pub fn with_credentials(
        mut self,
        username: impl Into<String>,
        password: impl Into<String>,
    ) -> Self {
        self.username = Some(username.into());
        self.password = Some(password.into());
        self
    }

    /// Select implicit TLS and/or STARTTLS.
    #[must_use]
    pub fn with_tls(mut self, ssl: bool, tls: bool) -> Self {
        self.ssl = ssl;
        self.tls = tls;
        self
    }

    /// Set the sender and reply-to defaults.
    #[must_use]
    pub fn with_defaults(mut self, from: impl Into<String>, reply_to: impl Into<String>) -> Self {
        self.default_from = Some(from.into());
        self.default_reply_to = Some(reply_to.into());
        self
    }

    /// Override the connection timeout.
    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

fn normalize_host(host: &str) -> Result<String, MailError> {
    let host = host.trim();
    if host.is_empty() {
        return Err(MailError::InvalidConfig(
            "`smtp-host` must not be empty".to_owned(),
        ));
    }
    if !host.is_ascii() {
        return Err(MailError::InvalidConfig(
            "`smtp-host` must be an ASCII host or IP address".to_owned(),
        ));
    }
    if host.len() > 253 {
        return Err(MailError::InvalidConfig(
            "`smtp-host` exceeds 253 bytes".to_owned(),
        ));
    }
    if host.chars().any(|ch| {
        ch.is_control() || ch.is_whitespace() || matches!(ch, '/' | '\\' | '@' | ',' | ';')
    }) {
        return Err(MailError::InvalidConfig(
            "`smtp-host` contains an invalid character".to_owned(),
        ));
    }
    let host = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host);
    if host.is_empty() {
        return Err(MailError::InvalidConfig(
            "`smtp-host` must not be empty".to_owned(),
        ));
    }
    Ok(host.to_owned())
}

fn validate_credentials(username: Option<&str>, password: Option<&str>) -> Result<(), MailError> {
    for (name, value) in [("smtp-username", username), ("smtp-password", password)] {
        if let Some(value) = value {
            if value
                .chars()
                .any(|ch| ch.is_control() || matches!(ch, '\r' | '\n'))
            {
                return Err(MailError::InvalidConfig(format!(
                    "`{name}` contains a control character"
                )));
            }
        }
    }
    Ok(())
}

/// SMTP delivery boundary.
#[async_trait]
pub trait SmtpTransport: Send + Sync {
    /// Deliver one rendered message.
    ///
    /// # Errors
    ///
    /// Returns a classified connection, TLS, authentication, or protocol
    /// failure.
    async fn deliver(
        &self,
        config: &SmtpConfig,
        message: &RenderedMessage,
    ) -> Result<(), MailError>;
}

/// Production SMTP transport.
#[derive(Debug, Default, Clone, Copy)]
pub struct SmtpClient;

impl SmtpClient {
    /// Build a client.
    #[must_use]
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl SmtpTransport for SmtpClient {
    async fn deliver(
        &self,
        config: &SmtpConfig,
        message: &RenderedMessage,
    ) -> Result<(), MailError> {
        config.validate()?;
        validate_envelope(&message.from)?;
        if message.recipients.is_empty() {
            return Err(MailError::InvalidBody(
                "email has no envelope recipients".to_owned(),
            ));
        }
        for recipient in &message.recipients {
            validate_envelope(recipient)?;
        }

        let mut session = Session::open(config).await?;
        let greeting = session.read_reply().await?;
        expect(&greeting, "greeting", &[220])?;

        let mut capabilities = session.ehlo().await?;
        if config.tls && !config.ssl {
            if !capabilities.starttls {
                return Err(MailError::Tls(
                    "server does not advertise STARTTLS while `smtp-tls` is enabled".to_owned(),
                ));
            }
            let reply = session.command("STARTTLS", "STARTTLS", "STARTTLS").await?;
            expect(&reply, "STARTTLS", &[220])?;
            session.upgrade_tls(config).await?;
            capabilities = session.ehlo().await?;
        }

        if let Some(username) = &config.username {
            authenticate(&mut session, config, username, &capabilities).await?;
        }

        let mail_from = format!("MAIL FROM:<{}>", message.from);
        let reply = session.command("MAIL FROM", &mail_from, &mail_from).await?;
        if !(200..300).contains(&reply.code) {
            return Err(protocol("MAIL FROM", &reply));
        }

        for recipient in &message.recipients {
            let rcpt_to = format!("RCPT TO:<{recipient}>");
            let reply = session.command("RCPT TO", &rcpt_to, &rcpt_to).await?;
            if !(200..300).contains(&reply.code) {
                return Err(protocol("RCPT TO", &reply));
            }
        }

        let reply = session.command("DATA", "DATA", "DATA").await?;
        expect(&reply, "DATA", &[354])?;
        session
            .write_all(dot_stuff(&message.data).as_bytes())
            .await?;
        let reply = session.read_reply().await?;
        if !(200..300).contains(&reply.code) {
            return Err(protocol("message body", &reply));
        }

        if let Ok(reply) = session.command("QUIT", "QUIT", "QUIT").await {
            let _ = reply;
        }
        Ok(())
    }
}

async fn authenticate(
    session: &mut Session,
    config: &SmtpConfig,
    username: &str,
    capabilities: &Capabilities,
) -> Result<(), MailError> {
    let password = config.password.as_deref().unwrap_or("");
    if capabilities.has_auth("PLAIN") {
        let payload = STANDARD.encode(format!("\0{username}\0{password}"));
        let reply = session
            .command(
                "AUTH",
                &format!("AUTH PLAIN {payload}"),
                "AUTH PLAIN <redacted>",
            )
            .await?;
        if (200..300).contains(&reply.code) {
            return Ok(());
        }
        return Err(MailError::Auth(format!(
            "server rejected PLAIN credentials with {}",
            reply.code
        )));
    }
    if capabilities.has_auth("LOGIN") {
        let reply = session
            .command("AUTH LOGIN", "AUTH LOGIN", "AUTH LOGIN")
            .await?;
        expect(&reply, "AUTH LOGIN", &[334])?;
        let reply = session
            .command(
                "AUTH username",
                &STANDARD.encode(username),
                "AUTH <username>",
            )
            .await?;
        expect(&reply, "AUTH username", &[334])?;
        let reply = session
            .command(
                "AUTH password",
                &STANDARD.encode(password),
                "AUTH <password>",
            )
            .await?;
        if (200..300).contains(&reply.code) {
            return Ok(());
        }
        return Err(MailError::Auth(format!(
            "server rejected LOGIN credentials with {}",
            reply.code
        )));
    }
    Err(MailError::Auth(
        "server does not advertise AUTH PLAIN or AUTH LOGIN".to_owned(),
    ))
}

trait SmtpStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T> SmtpStream for T where T: AsyncRead + AsyncWrite + Unpin + Send {}
type BoxStream = Box<dyn SmtpStream>;

struct Session {
    stream: Option<BoxStream>,
    buffer: Vec<u8>,
    timeout: Duration,
    debug: bool,
}

impl Session {
    async fn open(config: &SmtpConfig) -> Result<Self, MailError> {
        let host = normalize_host(&config.host)?;
        let connect = TcpStream::connect((host.as_str(), config.port));
        let stream = tokio::time::timeout(config.timeout, connect)
            .await
            .map_err(|_| MailError::Connect("connection timed out".to_owned()))?
            .map_err(|error| MailError::Connect(error.to_string()))?;
        stream
            .set_nodelay(true)
            .map_err(|error| MailError::Io(error.to_string()))?;

        let stream: BoxStream = Box::new(stream);
        let stream = if config.ssl {
            tls_connect(stream, &host, config.timeout).await?
        } else {
            stream
        };
        Ok(Self {
            stream: Some(stream),
            buffer: Vec::new(),
            timeout: config.timeout,
            debug: config.debug,
        })
    }

    async fn ehlo(&mut self) -> Result<Capabilities, MailError> {
        let reply = self
            .command("EHLO", "EHLO localhost", "EHLO localhost")
            .await?;
        expect(&reply, "EHLO", &[250])?;
        Ok(Capabilities::parse(&reply.lines))
    }

    async fn upgrade_tls(&mut self, config: &SmtpConfig) -> Result<(), MailError> {
        if !self.buffer.is_empty() {
            return Err(MailError::Tls(
                "server sent data after the STARTTLS reply".to_owned(),
            ));
        }
        let stream = self
            .stream
            .take()
            .ok_or_else(|| MailError::Io("connection is closed".to_owned()))?;
        let host = normalize_host(&config.host)?;
        let stream = tls_connect(stream, &host, config.timeout).await?;
        self.stream = Some(stream);
        Ok(())
    }

    async fn command(
        &mut self,
        _stage: &str,
        command: &str,
        logged: &str,
    ) -> Result<Reply, MailError> {
        if command.len() > MAX_COMMAND
            || command
                .chars()
                .any(|ch| matches!(ch, '\r' | '\n') || ch.is_control())
        {
            return Err(MailError::Protocol {
                stage: "command".to_owned(),
                detail: "command contains a line break or is too long".to_owned(),
            });
        }
        if self.debug {
            tracing::debug!(target: "penpot.smtp", command = logged, "smtp command");
        }
        self.write_all(format!("{command}\r\n").as_bytes()).await?;
        let reply = self.read_reply().await?;
        if self.debug {
            tracing::debug!(
                target: "penpot.smtp",
                code = reply.code,
                "smtp reply"
            );
        }
        Ok(reply)
    }

    async fn write_all(&mut self, bytes: &[u8]) -> Result<(), MailError> {
        let stream = self
            .stream
            .as_mut()
            .ok_or_else(|| MailError::Io("connection is closed".to_owned()))?;
        tokio::time::timeout(self.timeout, stream.write_all(bytes))
            .await
            .map_err(|_| MailError::Io("write timed out".to_owned()))?
            .map_err(|error| MailError::Io(error.to_string()))?;
        tokio::time::timeout(self.timeout, stream.flush())
            .await
            .map_err(|_| MailError::Io("flush timed out".to_owned()))?
            .map_err(|error| MailError::Io(error.to_string()))?;
        Ok(())
    }

    async fn read_reply(&mut self) -> Result<Reply, MailError> {
        let mut lines = Vec::new();
        let mut total = 0usize;
        loop {
            let line = self.read_line().await?;
            total = total.saturating_add(line.len() + 2);
            if total > MAX_REPLY_BYTES {
                return Err(MailError::Protocol {
                    stage: "reply".to_owned(),
                    detail: "server reply exceeds the size cap".to_owned(),
                });
            }
            lines.push(line);
            let reply = parse_reply_lines(&lines)?;
            if reply.complete {
                return Ok(reply.reply);
            }
        }
    }

    async fn read_line(&mut self) -> Result<String, MailError> {
        loop {
            if let Some(position) = self.buffer.iter().position(|byte| *byte == b'\n') {
                let mut line: Vec<u8> = self.buffer.drain(..=position).collect();
                while matches!(line.last().copied(), Some(b'\n' | b'\r')) {
                    line.pop();
                }
                if line.len() > MAX_REPLY_LINE {
                    return Err(MailError::Protocol {
                        stage: "reply".to_owned(),
                        detail: "server reply line is too long".to_owned(),
                    });
                }
                return Ok(String::from_utf8_lossy(&line).into_owned());
            }
            if self.buffer.len() > MAX_REPLY_BYTES {
                return Err(MailError::Protocol {
                    stage: "reply".to_owned(),
                    detail: "server reply exceeds the size cap".to_owned(),
                });
            }

            let stream = self
                .stream
                .as_mut()
                .ok_or_else(|| MailError::Io("connection is closed".to_owned()))?;
            let mut chunk = [0_u8; 1024];
            let read = tokio::time::timeout(self.timeout, stream.read(&mut chunk))
                .await
                .map_err(|_| MailError::Io("read timed out".to_owned()))?
                .map_err(|error| MailError::Io(error.to_string()))?;
            if read == 0 {
                return Err(MailError::Io(
                    "server closed the connection before a complete reply".to_owned(),
                ));
            }
            self.buffer.extend_from_slice(&chunk[..read]);
        }
    }
}

async fn tls_connect(
    stream: BoxStream,
    host: &str,
    timeout: Duration,
) -> Result<BoxStream, MailError> {
    let mut roots = RootCertStore::empty();
    let native = rustls_native_certs::load_native_certs();
    for certificate in native.certs {
        let _ = roots.add(certificate);
    }
    if roots.is_empty() {
        return Err(MailError::Tls(
            "no trusted root certificates are available".to_owned(),
        ));
    }

    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let connector = TlsConnector::from(Arc::new(config));
    let server_name = ServerName::try_from(host.to_owned())
        .map_err(|error| MailError::Tls(format!("invalid TLS server name: {error}")))?;
    let stream = tokio::time::timeout(timeout, connector.connect(server_name, stream))
        .await
        .map_err(|_| MailError::Tls("TLS handshake timed out".to_owned()))?
        .map_err(|error| MailError::Tls(error.to_string()))?;
    Ok(Box::new(stream))
}

#[derive(Debug)]
struct Reply {
    code: u16,
    lines: Vec<String>,
}

impl Reply {
    fn detail(&self) -> String {
        let text = self
            .lines
            .iter()
            .map(|line| line.get(4..).unwrap_or(line).trim())
            .map(|line| {
                line.chars()
                    .map(|ch| if ch.is_control() { ' ' } else { ch })
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join(" ");
        truncate(&text)
    }
}

struct PartialReply {
    reply: Reply,
    complete: bool,
}

fn parse_reply_lines(lines: &[String]) -> Result<PartialReply, MailError> {
    let mut code = None;
    for line in lines {
        if line.len() < 3 {
            return Err(MailError::Protocol {
                stage: "reply".to_owned(),
                detail: "server reply is shorter than three digits".to_owned(),
            });
        }
        let prefix = line.get(..3).ok_or_else(|| MailError::Protocol {
            stage: "reply".to_owned(),
            detail: "server reply does not start with three ASCII digits".to_owned(),
        })?;
        let parsed = prefix.parse::<u16>().map_err(|_| MailError::Protocol {
            stage: "reply".to_owned(),
            detail: "server reply does not start with a status code".to_owned(),
        })?;
        if let Some(code) = code {
            if code != parsed {
                return Err(MailError::Protocol {
                    stage: "reply".to_owned(),
                    detail: "multiline reply changes status code".to_owned(),
                });
            }
        } else {
            code = Some(parsed);
        }
    }

    let last = lines.last().expect("non-empty reply");
    let separator = last.as_bytes().get(3).copied();
    let complete = last.len() == 3 || separator == Some(b' ');
    if !complete && separator != Some(b'-') {
        return Err(MailError::Protocol {
            stage: "reply".to_owned(),
            detail: "server reply has an invalid separator".to_owned(),
        });
    }

    Ok(PartialReply {
        reply: Reply {
            code: code.expect("at least one line"),
            lines: lines.to_vec(),
        },
        complete,
    })
}

fn expect(reply: &Reply, stage: &str, codes: &[u16]) -> Result<(), MailError> {
    if codes.contains(&reply.code) {
        Ok(())
    } else {
        Err(protocol(stage, reply))
    }
}

fn protocol(stage: &str, reply: &Reply) -> MailError {
    MailError::Protocol {
        stage: stage.to_owned(),
        detail: format!("{} {}", reply.code, reply.detail()),
    }
}

fn truncate(value: &str) -> String {
    if value.chars().count() <= MAX_ERROR_DETAIL {
        return value.to_owned();
    }
    let mut out = value.chars().take(MAX_ERROR_DETAIL).collect::<String>();
    out.push_str("...");
    out
}

#[derive(Debug, Default)]
struct Capabilities {
    starttls: bool,
    auth: Vec<String>,
}

impl Capabilities {
    fn parse(lines: &[String]) -> Self {
        let mut capabilities = Self::default();
        for line in lines {
            let text = line
                .get(4..)
                .unwrap_or_default()
                .trim()
                .to_ascii_uppercase();
            if text == "STARTTLS" {
                capabilities.starttls = true;
            }
            let mechanisms = text
                .strip_prefix("AUTH ")
                .or_else(|| text.strip_prefix("AUTH="));
            if let Some(mechanisms) = mechanisms {
                capabilities
                    .auth
                    .extend(mechanisms.split_whitespace().map(str::to_owned));
            }
        }
        capabilities
    }

    fn has_auth(&self, mechanism: &str) -> bool {
        self.auth.iter().any(|candidate| candidate == mechanism)
    }
}

/// Normalize newlines and dot-stuff a message for the SMTP `DATA` phase.
#[must_use]
pub fn dot_stuff(data: &str) -> String {
    let normalized = data.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = normalized.trim_end_matches('\n');
    let mut out = String::with_capacity(trimmed.len() + 8);
    for line in trimmed.split('\n') {
        if line.starts_with('.') {
            out.push('.');
        }
        out.push_str(line);
        out.push_str("\r\n");
    }
    out.push_str(".\r\n");
    out
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::TcpListener,
    };

    use super::*;

    fn message() -> RenderedMessage {
        RenderedMessage {
            from: "no-reply@example.com".to_owned(),
            recipients: vec!["user@example.com".to_owned()],
            data: "Subject: Hi\r\n\r\nBody\r\n".to_owned(),
        }
    }

    #[test]
    fn multiline_replies_require_one_status_code() {
        let lines = vec![
            "250-test".to_owned(),
            "250-AUTH PLAIN LOGIN".to_owned(),
            "250 STARTTLS".to_owned(),
        ];
        let parsed = parse_reply_lines(&lines).expect("reply");
        assert!(parsed.complete);
        assert_eq!(parsed.reply.code, 250);

        let lines = vec!["250-test".to_owned(), "550 nope".to_owned()];
        assert!(parse_reply_lines(&lines).is_err());

        let lines = vec!["\u{00e9}\u{00e9}".to_owned()];
        assert!(parse_reply_lines(&lines).is_err());
    }

    #[test]
    fn capabilities_are_case_insensitive() {
        let lines = vec![
            "250-localhost".to_owned(),
            "250-STARTTLS".to_owned(),
            "250-auth plain login".to_owned(),
        ];
        let capabilities = Capabilities::parse(&lines);
        assert!(capabilities.starttls);
        assert!(capabilities.has_auth("PLAIN"));
        assert!(capabilities.has_auth("LOGIN"));
        assert!(!capabilities.has_auth("CRAM-MD5"));
    }

    #[test]
    fn dot_stuffing_preserves_blank_lines_and_escapes_leading_dots() {
        assert_eq!(dot_stuff("a\r\n\r\n.b\r\n"), "a\r\n\r\n..b\r\n.\r\n");
        assert_eq!(dot_stuff(""), "\r\n.\r\n");
    }

    #[test]
    fn config_defaults_are_applied_from_the_environment() {
        let config = Config::from_env([
            ("PENPOT_SMTP_HOST", "smtp.example.com"),
            ("PENPOT_SMTP_PORT", "587"),
            ("PENPOT_SMTP_TLS", "true"),
            ("PENPOT_SMTP_USERNAME", "user"),
            ("PENPOT_SMTP_PASSWORD", "secret"),
            ("PENPOT_FLAGS", "enable-smtp-debug"),
        ])
        .expect("config");
        let smtp = SmtpConfig::from_config(&config).expect("smtp");
        assert_eq!(smtp.host, "smtp.example.com");
        assert_eq!(smtp.port, 587);
        assert!(smtp.tls);
        assert!(smtp.debug);
        assert_eq!(smtp.username.as_deref(), Some("user"));
        assert_eq!(
            smtp.default_from.as_deref(),
            Some("Penpot <no-reply@example.com>")
        );
    }

    #[test]
    fn implicit_tls_defaults_to_port_465() {
        let config = Config::from_env([
            ("PENPOT_SMTP_HOST", "smtp.example.com"),
            ("PENPOT_SMTP_SSL", "true"),
        ])
        .expect("config");
        let smtp = SmtpConfig::from_config(&config).expect("smtp");
        assert_eq!(smtp.port, 465);
        assert!(smtp.ssl);
    }

    #[test]
    fn debug_output_redacts_the_password() {
        let config = SmtpConfig::new("localhost", 25).with_credentials("user", "secret");
        let debug = format!("{config:?}");
        assert!(!debug.contains("secret"));
        assert!(debug.contains("<redacted>"));
    }

    #[tokio::test]
    async fn plaintext_conversation_authenticates_and_sends_the_message() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.expect("accept");
            let (read, mut write) = socket.into_split();
            let mut reader = BufReader::new(read);
            let mut transcript = Vec::new();

            write
                .write_all(b"220 test ESMTP\r\n")
                .await
                .expect("greeting");
            transcript.push(read_line(&mut reader).await);
            write
                .write_all(b"250-test\r\n250-AUTH PLAIN\r\n250 SIZE 1048576\r\n")
                .await
                .expect("ehlo");
            transcript.push(read_line(&mut reader).await);
            write.write_all(b"235 2.7.0 ok\r\n").await.expect("auth");
            transcript.push(read_line(&mut reader).await);
            write.write_all(b"250 2.1.0 ok\r\n").await.expect("mail");
            transcript.push(read_line(&mut reader).await);
            write.write_all(b"250 2.1.5 ok\r\n").await.expect("rcpt");
            transcript.push(read_line(&mut reader).await);
            write.write_all(b"354 go\r\n").await.expect("data");

            let mut data = Vec::new();
            loop {
                let line = read_line(&mut reader).await;
                let done = line == ".\r\n";
                data.push(line);
                if done {
                    break;
                }
            }
            write.write_all(b"250 queued\r\n").await.expect("queued");
            transcript.push(read_line(&mut reader).await);
            write.write_all(b"221 bye\r\n").await.expect("quit");

            (transcript, data.join(""))
        });

        let config = SmtpConfig::new("127.0.0.1", address.port())
            .with_credentials("user", "secret")
            .with_timeout(Duration::from_secs(5));
        SmtpClient::new()
            .deliver(&config, &message())
            .await
            .expect("delivery");

        let (transcript, data) = server.await.expect("server");
        assert!(transcript[0].starts_with("EHLO "));
        assert!(transcript[1].starts_with("AUTH PLAIN "));
        assert_eq!(transcript[2], "MAIL FROM:<no-reply@example.com>\r\n");
        assert_eq!(transcript[3], "RCPT TO:<user@example.com>\r\n");
        assert_eq!(transcript[4], "DATA\r\n");
        assert_eq!(transcript[5], "QUIT\r\n");
        assert!(data.contains("Subject: Hi\r\n\r\nBody\r\n"));
        assert!(data.ends_with(".\r\n"));
        assert!(!transcript.join("").contains("secret"));
    }

    #[tokio::test]
    async fn starttls_is_required_when_configured() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.expect("accept");
            let (read, mut write) = socket.into_split();
            let mut reader = BufReader::new(read);
            write
                .write_all(b"220 test ESMTP\r\n")
                .await
                .expect("greeting");
            let _ = read_line(&mut reader).await;
            write.write_all(b"250 test\r\n").await.expect("ehlo");
            let _ = read_line(&mut reader).await;
        });

        let config = SmtpConfig::new("127.0.0.1", address.port())
            .with_tls(false, true)
            .with_timeout(Duration::from_secs(5));
        let error = SmtpClient::new()
            .deliver(&config, &message())
            .await
            .expect_err("no starttls");
        assert!(matches!(error, MailError::Tls(_)));
        let _ = server.await;
    }

    #[tokio::test]
    async fn recipient_rejection_stops_before_data() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.expect("accept");
            let (read, mut write) = socket.into_split();
            let mut reader = BufReader::new(read);
            write
                .write_all(b"220 test ESMTP\r\n")
                .await
                .expect("greeting");
            let _ = read_line(&mut reader).await;
            write.write_all(b"250 test\r\n").await.expect("ehlo");
            let _ = read_line(&mut reader).await;
            write.write_all(b"250 ok\r\n").await.expect("mail");
            let _ = read_line(&mut reader).await;
            write
                .write_all(b"550 no such user\r\n")
                .await
                .expect("rcpt");
        });

        let config =
            SmtpConfig::new("127.0.0.1", address.port()).with_timeout(Duration::from_secs(5));
        let error = SmtpClient::new()
            .deliver(&config, &message())
            .await
            .expect_err("rejected");
        match error {
            MailError::Protocol { stage, detail } => {
                assert_eq!(stage, "RCPT TO");
                assert!(detail.contains("550"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
        let _ = server.await;
    }

    async fn read_line<R>(reader: &mut BufReader<R>) -> String
    where
        R: tokio::io::AsyncRead + Unpin,
    {
        let mut line = String::new();
        reader.read_line(&mut line).await.expect("read line");
        line
    }

    #[tokio::test]
    #[ignore = "requires PENPOT_TEST_SMTP_HOST and a disposable inbox"]
    async fn live_smtp_delivery() {
        let host = std::env::var("PENPOT_TEST_SMTP_HOST").expect("PENPOT_TEST_SMTP_HOST");
        let port = std::env::var("PENPOT_TEST_SMTP_PORT")
            .expect("PENPOT_TEST_SMTP_PORT")
            .parse::<u16>()
            .expect("numeric PENPOT_TEST_SMTP_PORT");
        let from = std::env::var("PENPOT_TEST_SMTP_FROM").expect("PENPOT_TEST_SMTP_FROM");
        let to = std::env::var("PENPOT_TEST_SMTP_TO").expect("PENPOT_TEST_SMTP_TO");

        let mut config = SmtpConfig::new(host, port)
            .with_tls(
                std::env::var("PENPOT_TEST_SMTP_SSL").is_ok_and(|value| value == "true"),
                std::env::var("PENPOT_TEST_SMTP_TLS").is_ok_and(|value| value == "true"),
            )
            .with_timeout(Duration::from_secs(15));
        if let (Ok(username), Ok(password)) = (
            std::env::var("PENPOT_TEST_SMTP_USERNAME"),
            std::env::var("PENPOT_TEST_SMTP_PASSWORD"),
        ) {
            config = config.with_credentials(username, password);
        }

        let message = RenderedMessage {
            from,
            recipients: vec![to],
            data:
                "Subject: Penpot backend-rust SMTP live test\r\n\r\nIf you see this, M17 works.\r\n"
                    .to_owned(),
        };
        SmtpClient::new()
            .deliver(&config, &message)
            .await
            .expect("live delivery");
    }
}
