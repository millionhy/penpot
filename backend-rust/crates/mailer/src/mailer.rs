//! `worker::Mailer` adapter for the `sendmail` task.

use std::sync::Arc;

use async_trait::async_trait;
use chrono::Utc;
use config::Config;
use transit::{Map, Value};
use worker::{Mailer, ServiceError};

use crate::{
    address::Mailbox, Email, MailError, MimeDefaults, RenderedMessage, SmtpClient, SmtpConfig,
    SmtpTransport,
};

/// SMTP mailer with the feature-flag behaviour of `app.email/::sendmail`.
///
/// When `smtp` is off the mailer sends nothing. When `log-emails` is on it
/// writes a bounded summary to the log, even if no SMTP server is configured.
pub struct SmtpMailer {
    enabled: bool,
    config: Option<SmtpConfig>,
    config_error: Option<MailError>,
    log_emails: bool,
    transport: Arc<dyn SmtpTransport>,
}

impl SmtpMailer {
    /// Build from `PENPOT_*` configuration and the current flags.
    #[must_use]
    pub fn from_config(config: &Config) -> Self {
        let enabled = config.flags().contains("smtp");
        let log_emails = config.flags().contains("log-emails");
        let (smtp, error) = if enabled {
            match SmtpConfig::from_config(config) {
                Ok(smtp) => (Some(smtp), None),
                Err(error) => (None, Some(error)),
            }
        } else {
            (None, None)
        };
        Self {
            enabled,
            config: smtp,
            config_error: error,
            log_emails,
            transport: Arc::new(SmtpClient::new()),
        }
    }

    /// Build an enabled mailer around explicit settings.
    #[must_use]
    pub fn new(config: SmtpConfig) -> Self {
        Self {
            enabled: true,
            config: Some(config),
            config_error: None,
            log_emails: false,
            transport: Arc::new(SmtpClient::new()),
        }
    }

    /// A mailer that never opens a socket.
    #[must_use]
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            config: None,
            config_error: None,
            log_emails: false,
            transport: Arc::new(SmtpClient::new()),
        }
    }

    /// Replace the SMTP transport, normally with a fake in tests.
    #[must_use]
    pub fn with_transport(mut self, transport: Arc<dyn SmtpTransport>) -> Self {
        self.transport = transport;
        self
    }

    /// Enable or disable the `log-emails` behaviour.
    #[must_use]
    pub fn with_logging(mut self, log_emails: bool) -> Self {
        self.log_emails = log_emails;
        self
    }

    fn defaults(config: &SmtpConfig) -> Result<MimeDefaults, MailError> {
        Ok(MimeDefaults {
            from: config
                .default_from
                .as_deref()
                .map(|value| Mailbox::parse("smtp-default-from", value))
                .transpose()?,
            reply_to: config
                .default_reply_to
                .as_deref()
                .map(|value| Mailbox::parse("smtp-default-reply-to", value))
                .transpose()?,
        })
    }
}

#[async_trait]
impl Mailer for SmtpMailer {
    async fn send(&self, email: &Map) -> Result<(), ServiceError> {
        if self.enabled {
            let config = self.config.as_ref().ok_or_else(|| {
                let message = self.config_error.as_ref().map_or_else(
                    || "SMTP configuration is missing".to_owned(),
                    ToString::to_string,
                );
                ServiceError::new(message)
            })?;

            let parsed = Email::from_transit(email).map_err(service_error)?;
            let defaults = Self::defaults(config).map_err(service_error)?;
            let rendered = parsed
                .render(&defaults, Utc::now())
                .map_err(service_error)?;
            self.transport
                .deliver(config, &rendered)
                .await
                .map_err(service_error)?;
        }

        if self.log_emails {
            log_email(email);
        }
        Ok(())
    }
}

fn service_error(error: MailError) -> ServiceError {
    ServiceError::new(error.to_string())
}

fn log_email(email: &Map) {
    let id = email.get_kw("id").and_then(value_text).unwrap_or_default();
    let to = email.get_kw("to").map(display_value).unwrap_or_default();
    let subject = email
        .get_kw("subject")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let body = plain_body(email).map_or_else(String::new, |body| truncate(&body, 4096));

    tracing::info!(
        target: "penpot.email",
        id = %id,
        to = %to,
        subject = %truncate(subject, 512),
        body = %body,
        "email console dump"
    );
}

fn plain_body(email: &Map) -> Option<String> {
    match email.get_kw("body") {
        Some(Value::Str(body)) => Some(body.clone()),
        Some(value) => {
            let map = value.as_map()?;
            for (key, value) in map.iter() {
                let matches = match key {
                    Value::Str(key) | Value::Keyword(key) => key == "text/plain",
                    _ => false,
                };
                if matches {
                    return value.as_str().map(str::to_owned);
                }
            }
            None
        }
        None => None,
    }
}

fn display_value(value: &Value) -> String {
    match value {
        Value::Str(value) => value.clone(),
        Value::List(values) | Value::Array(values) => values
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(", "),
        other => value_text(other).unwrap_or_default(),
    }
}

fn value_text(value: &Value) -> Option<String> {
    match value {
        Value::Str(value) | Value::Keyword(value) => Some(value.clone()),
        _ => None,
    }
}

fn truncate(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_owned();
    }
    let mut out = value.chars().take(limit).collect::<String>();
    out.push_str("...");
    out
}

/// Render one email without delivering it.
///
/// # Errors
///
/// Propagates parsing, validation, and rendering errors.
pub fn render_email(email: &Map, config: &SmtpConfig) -> Result<RenderedMessage, MailError> {
    let parsed = Email::from_transit(email)?;
    let defaults = SmtpMailer::defaults(config)?;
    parsed.render(&defaults, Utc::now())
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    use async_trait::async_trait;
    use transit::Value;

    use super::*;

    #[derive(Default)]
    struct RecordingTransport {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl SmtpTransport for RecordingTransport {
        async fn deliver(
            &self,
            _config: &SmtpConfig,
            _message: &RenderedMessage,
        ) -> Result<(), MailError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn email() -> Map {
        [
            (Value::kw("id"), Value::str("register")),
            (Value::kw("to"), Value::str("user@example.com")),
            (Value::kw("subject"), Value::str("Welcome")),
            (Value::kw("body"), Value::str("Hello")),
        ]
        .into_iter()
        .collect()
    }

    #[tokio::test]
    async fn disabled_mailer_does_not_touch_the_transport() {
        let recording = Arc::new(RecordingTransport::default());
        let transport: Arc<dyn SmtpTransport> = recording.clone();
        let mailer = SmtpMailer::disabled().with_transport(transport);
        mailer.send(&email()).await.expect("no-op");
        assert_eq!(recording.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn logging_only_mailer_does_not_touch_the_transport() {
        let recording = Arc::new(RecordingTransport::default());
        let transport: Arc<dyn SmtpTransport> = recording.clone();
        let mailer = SmtpMailer::disabled()
            .with_transport(transport)
            .with_logging(true);
        mailer.send(&email()).await.expect("logged");
        assert_eq!(recording.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn enabled_mailer_delivers_the_rendered_message() {
        let recording = Arc::new(RecordingTransport::default());
        let transport: Arc<dyn SmtpTransport> = recording.clone();
        let config = SmtpConfig::new("smtp.example.com", 25)
            .with_defaults("Penpot <no-reply@example.com>", "Help <help@example.com>");
        let mailer = SmtpMailer::new(config).with_transport(transport);
        mailer.send(&email()).await.expect("sent");
        assert_eq!(recording.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn missing_host_is_reported_on_send() {
        let config = Config::from_env([("PENPOT_FLAGS", "enable-smtp")]).expect("config");
        let mailer = SmtpMailer::from_config(&config);
        let error = mailer.send(&email()).await.expect_err("missing host");
        assert!(error.message().contains("smtp-host"));
    }

    #[tokio::test]
    async fn invalid_email_is_reported_without_a_socket() {
        let recording = Arc::new(RecordingTransport::default());
        let transport: Arc<dyn SmtpTransport> = recording.clone();
        let config = SmtpConfig::new("smtp.example.com", 25)
            .with_defaults("Penpot <no-reply@example.com>", "Help <help@example.com>");
        let mailer = SmtpMailer::new(config).with_transport(transport);
        let mut invalid = email();
        invalid.insert(Value::kw("to"), Value::str("not-an-address"));
        let error = mailer.send(&invalid).await.expect_err("invalid");
        assert!(error.message().contains("invalid `to` address"));
        assert_eq!(recording.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn render_uses_the_configured_defaults() {
        let config = SmtpConfig::new("smtp.example.com", 25)
            .with_defaults("Penpot <no-reply@example.com>", "Help <help@example.com>");
        let rendered = render_email(&email(), &config).expect("render");
        assert_eq!(rendered.from, "no-reply@example.com");
        assert_eq!(rendered.recipients, vec!["user@example.com"]);
    }
}
