//! Turn a Transit email map into an RFC 5322 message.

use std::fmt::Write as _;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, Utc};
use transit::{Map, Value};
use uuid::Uuid;

use crate::{
    address::Mailbox,
    header::{encode_unstructured, validate_name, validate_value, validate_written},
    MailError,
};

/// Upper bound accepted by the in-process renderer.
pub const MAX_MESSAGE_BYTES: usize = 25 * 1024 * 1024;

/// Default sender and reply-to taken from the SMTP configuration.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MimeDefaults {
    /// Used when the email has no `from`.
    pub from: Option<Mailbox>,
    /// Used when the email has no `reply-to`.
    pub reply_to: Option<Mailbox>,
}

/// Email body forms accepted by `app.email`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Body {
    /// A single `text/plain` part.
    Text(String),
    /// A `multipart/alternative` part with either or both bodies.
    Alternative {
        /// Plain text alternative.
        text: Option<String>,
        /// HTML alternative.
        html: Option<String>,
    },
}

impl Body {
    fn byte_len(&self) -> usize {
        match self {
            Self::Text(text) => text.len(),
            Self::Alternative { text, html } => {
                text.as_ref().map_or(0, String::len) + html.as_ref().map_or(0, String::len)
            }
        }
    }

    fn all_text(&self) -> String {
        match self {
            Self::Text(text) => text.clone(),
            Self::Alternative { text, html } => format!(
                "{}{}",
                text.as_deref().unwrap_or_default(),
                html.as_deref().unwrap_or_default()
            ),
        }
    }
}

/// One file attachment carried as UTF-8 text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    /// File name shown by the mail client.
    pub name: String,
    /// File contents.
    pub content: String,
}

/// Parsed `sendmail` task props.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Email {
    /// Template id, used only for logging.
    pub id: Option<String>,
    /// Primary recipients.
    pub to: Vec<Mailbox>,
    /// Carbon-copy recipients.
    pub cc: Vec<Mailbox>,
    /// Blind carbon-copy recipients; never written as a header.
    pub bcc: Vec<Mailbox>,
    /// Explicit sender.
    pub from: Option<Mailbox>,
    /// Explicit reply-to.
    pub reply_to: Option<Mailbox>,
    /// Subject line.
    pub subject: String,
    /// Character set used by every text part.
    pub charset: String,
    /// Extra headers.
    pub headers: Vec<(String, String)>,
    /// Value of `X-Penpot-Data`.
    pub extra_data: Option<String>,
    /// Message body.
    pub body: Body,
    /// File attachments.
    pub attachments: Vec<Attachment>,
}

/// A message ready for `DATA`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedMessage {
    /// Envelope sender address.
    pub from: String,
    /// Envelope recipient addresses (to + cc + bcc).
    pub recipients: Vec<String>,
    /// Headers, body, and MIME boundaries with CRLF line endings.
    pub data: String,
}

impl Email {
    /// Read the task props emitted by `app.email/send!`.
    ///
    /// # Errors
    ///
    /// Rejects missing or malformed recipients, subject, body, headers, and
    /// attachments.
    pub fn from_transit(map: &Map) -> Result<Self, MailError> {
        let to = parse_recipients(map, "to", true)?;
        let cc = parse_recipients(map, "cc", false)?;
        let bcc = parse_recipients(map, "bcc", false)?;
        let from = parse_optional_mailbox(map, "from")?;
        let reply_to = parse_optional_mailbox(map, "reply-to")?;

        let subject = map
            .get_kw("subject")
            .and_then(Value::as_str)
            .ok_or_else(|| MailError::InvalidBody("`subject` is mandatory".to_owned()))?
            .to_owned();
        validate_value("Subject", &subject)?;

        let charset = match map.get_kw("charset") {
            None | Some(Value::Nil) => "utf-8".to_owned(),
            Some(Value::Str(value)) => {
                validate_charset(value)?;
                value.clone()
            }
            Some(_) => {
                return Err(MailError::InvalidBody(
                    "`charset` must be a string".to_owned(),
                ));
            }
        };

        let headers = match map.get_kw("headers") {
            None | Some(Value::Nil) => Vec::new(),
            Some(value) => parse_headers(value)?,
        };

        let extra_data = match map.get_kw("extra-data") {
            None | Some(Value::Nil) => None,
            Some(value) => {
                let value = scalar_string("extra-data", value)?;
                validate_value("X-Penpot-Data", &value)?;
                Some(value)
            }
        };

        let body = match map.get_kw("body") {
            None | Some(Value::Nil) => {
                return Err(MailError::InvalidBody("`body` is mandatory".to_owned()));
            }
            Some(value) => parse_body(value)?,
        };

        let attachments = match map.get_kw("attachments") {
            None | Some(Value::Nil) => Vec::new(),
            Some(value) => parse_attachments(value)?,
        };

        let id = map.get_kw("id").and_then(|value| match value {
            Value::Str(value) | Value::Keyword(value) => Some(value.clone()),
            _ => None,
        });

        let email = Self {
            id,
            to,
            cc,
            bcc,
            from,
            reply_to,
            subject,
            charset,
            headers,
            extra_data,
            body,
            attachments,
        };
        email.check_size()?;
        Ok(email)
    }

    /// Render headers and MIME parts.
    ///
    /// # Errors
    ///
    /// Returns [`MailError::MissingConfig`] when neither the email nor the
    /// defaults supply a sender, and [`MailError::TooLarge`] when the rendered
    /// message exceeds [`MAX_MESSAGE_BYTES`].
    pub fn render(
        &self,
        defaults: &MimeDefaults,
        now: DateTime<Utc>,
    ) -> Result<RenderedMessage, MailError> {
        let from = self
            .from
            .clone()
            .or_else(|| defaults.from.clone())
            .ok_or(MailError::MissingConfig("smtp-default-from"))?;
        let reply_to = self.reply_to.clone().or_else(|| defaults.reply_to.clone());

        let boundary = self.boundary();
        let alternative_boundary = self.alternative_boundary();

        let mut headers = Vec::new();
        headers.push(("From".to_owned(), from.header_value()));
        headers.push(("To".to_owned(), join_mailboxes(&self.to)));
        if !self.cc.is_empty() {
            headers.push(("Cc".to_owned(), join_mailboxes(&self.cc)));
        }
        if let Some(reply_to) = &reply_to {
            headers.push(("Reply-To".to_owned(), reply_to.header_value()));
        }
        headers.push((
            "Subject".to_owned(),
            encode_unstructured(&self.subject, true),
        ));
        headers.push(("Date".to_owned(), now.to_rfc2822()));
        headers.push(("Message-ID".to_owned(), message_id(&from)));
        headers.push(("MIME-Version".to_owned(), "1.0".to_owned()));
        for (name, value) in &self.headers {
            if is_reserved_header(name) {
                return Err(MailError::InvalidHeader {
                    name: name.clone(),
                    reason: "header is managed by the mailer".to_owned(),
                });
            }
            headers.push((name.clone(), value.clone()));
        }
        if let Some(extra_data) = &self.extra_data {
            headers.push(("X-Penpot-Data".to_owned(), extra_data.clone()));
        }

        let mut data = String::new();
        for (name, value) in &headers {
            validate_name(name)?;
            validate_written(name, value)?;
            let _ = write!(data, "{name}: {value}\r\n");
        }
        let _ = write!(
            data,
            "Content-Type: multipart/mixed; boundary=\"{boundary}\"\r\n\r\n"
        );

        let _ = write!(data, "--{boundary}\r\n");
        match &self.body {
            Body::Text(text) => push_text_part(&mut data, "text/plain", text, None, &self.charset),
            Body::Alternative { text, html } => {
                let _ = write!(
                    data,
                    "Content-Type: multipart/alternative; \
                     boundary=\"{alternative_boundary}\"\r\n\r\n"
                );
                if let Some(text) = text {
                    let _ = write!(data, "--{alternative_boundary}\r\n");
                    push_text_part(&mut data, "text/plain", text, None, &self.charset);
                }
                if let Some(html) = html {
                    let _ = write!(data, "--{alternative_boundary}\r\n");
                    push_text_part(&mut data, "text/html", html, None, &self.charset);
                }
                let _ = write!(data, "--{alternative_boundary}--\r\n");
            }
        }

        for attachment in &self.attachments {
            let _ = write!(data, "--{boundary}\r\n");
            push_text_part(
                &mut data,
                "text/plain",
                &attachment.content,
                Some(&attachment.name),
                &self.charset,
            );
        }
        let _ = write!(data, "--{boundary}--\r\n");

        if data.len() > MAX_MESSAGE_BYTES {
            return Err(MailError::TooLarge {
                limit: MAX_MESSAGE_BYTES,
            });
        }

        let mut recipients = Vec::with_capacity(self.to.len() + self.cc.len() + self.bcc.len());
        recipients.extend(self.to.iter().map(|mailbox| mailbox.address.clone()));
        recipients.extend(self.cc.iter().map(|mailbox| mailbox.address.clone()));
        recipients.extend(self.bcc.iter().map(|mailbox| mailbox.address.clone()));

        Ok(RenderedMessage {
            from: from.address,
            recipients,
            data,
        })
    }

    fn check_size(&self) -> Result<(), MailError> {
        let attachment_bytes = self
            .attachments
            .iter()
            .map(|attachment| attachment.name.len() + attachment.content.len())
            .sum::<usize>();
        let total = self.body.byte_len().saturating_add(attachment_bytes);
        if total > MAX_MESSAGE_BYTES {
            return Err(MailError::TooLarge {
                limit: MAX_MESSAGE_BYTES,
            });
        }
        Ok(())
    }

    fn boundary(&self) -> String {
        let mut searchable = self.body.all_text();
        for attachment in &self.attachments {
            searchable.push_str(&attachment.content);
        }
        loop {
            let candidate = format!("=_penpot_{}", Uuid::new_v4().simple());
            if !searchable.contains(&candidate) {
                return candidate;
            }
        }
    }

    fn alternative_boundary(&self) -> String {
        let searchable = self.body.all_text();
        loop {
            let candidate = format!("=_penpot_alt_{}", Uuid::new_v4().simple());
            if !searchable.contains(&candidate) {
                return candidate;
            }
        }
    }
}

fn parse_recipients(map: &Map, field: &str, required: bool) -> Result<Vec<Mailbox>, MailError> {
    match map.get_kw(field) {
        None | Some(Value::Nil) if required => {
            Err(MailError::InvalidBody(format!("`{field}` is mandatory")))
        }
        None | Some(Value::Nil) => Ok(Vec::new()),
        Some(Value::Str(value)) => Ok(vec![Mailbox::parse(field, value)?]),
        Some(Value::List(values) | Value::Array(values)) => values
            .iter()
            .map(|value| {
                let address = value.as_str().ok_or_else(|| {
                    MailError::InvalidBody(format!("`{field}` entries must be strings"))
                })?;
                Mailbox::parse(field, address)
            })
            .collect(),
        Some(_) => Err(MailError::InvalidBody(format!(
            "`{field}` must be a string or a vector of strings"
        ))),
    }
}

fn parse_optional_mailbox(map: &Map, field: &str) -> Result<Option<Mailbox>, MailError> {
    match map.get_kw(field) {
        None | Some(Value::Nil) => Ok(None),
        Some(Value::Str(value)) => Ok(Some(Mailbox::parse(field, value)?)),
        Some(_) => Err(MailError::InvalidBody(format!(
            "`{field}` must be a string"
        ))),
    }
}

fn parse_body(value: &Value) -> Result<Body, MailError> {
    if let Some(text) = value.as_str() {
        return Ok(Body::Text(text.to_owned()));
    }
    let map = value
        .as_map()
        .ok_or_else(|| MailError::InvalidBody("`body` must be a string or a map".to_owned()))?;

    let text = body_part(map, "text/plain")?;
    let html = body_part(map, "text/html")?;
    if text.is_none() && html.is_none() {
        return Err(MailError::InvalidBody(
            "body map needs `text/plain` or `text/html`".to_owned(),
        ));
    }

    Ok(Body::Alternative { text, html })
}

fn body_part(map: &Map, key: &str) -> Result<Option<String>, MailError> {
    for (name, value) in map.iter() {
        let matches = match name {
            Value::Str(name) | Value::Keyword(name) => name == key,
            _ => false,
        };
        if matches {
            return match value {
                Value::Str(value) => Ok(Some(value.clone())),
                Value::Nil => Ok(None),
                _ => Err(MailError::InvalidBody(format!(
                    "body part `{key}` must be a string"
                ))),
            };
        }
    }
    Ok(None)
}

fn parse_headers(value: &Value) -> Result<Vec<(String, String)>, MailError> {
    let map = value
        .as_map()
        .ok_or_else(|| MailError::InvalidBody("`headers` must be a map".to_owned()))?;
    let mut headers = Vec::with_capacity(map.len());
    for (name, value) in map.iter() {
        let name = match name {
            Value::Str(name) | Value::Keyword(name) => name.clone(),
            _ => {
                return Err(MailError::InvalidBody(
                    "header names must be strings or keywords".to_owned(),
                ));
            }
        };
        validate_name(&name)?;
        let value = scalar_string(&name, value)?;
        validate_value(&name, &value)?;
        headers.push((name, value));
    }
    Ok(headers)
}

fn parse_attachments(value: &Value) -> Result<Vec<Attachment>, MailError> {
    let map = value
        .as_map()
        .ok_or_else(|| MailError::InvalidBody("`attachments` must be a map".to_owned()))?;
    let mut attachments = Vec::with_capacity(map.len());
    for (name, content) in map.iter() {
        let name = name
            .as_str()
            .ok_or_else(|| MailError::InvalidBody("attachment names must be strings".to_owned()))?;
        let content = content.as_str().ok_or_else(|| {
            MailError::InvalidBody("attachment contents must be strings".to_owned())
        })?;
        validate_value("attachment filename", name)?;
        attachments.push(Attachment {
            name: name.to_owned(),
            content: content.to_owned(),
        });
    }
    Ok(attachments)
}

fn scalar_string(field: &str, value: &Value) -> Result<String, MailError> {
    match value {
        Value::Str(value) | Value::Uri(value) => Ok(value.clone()),
        Value::Keyword(value) => Ok(format!(":{value}")),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Integer(value) => Ok(value.to_string()),
        Value::Double(value) => Ok(value.to_string()),
        Value::Nil => Ok(String::new()),
        _ => Err(MailError::InvalidBody(format!(
            "`{field}` must be a scalar value"
        ))),
    }
}

fn validate_charset(value: &str) -> Result<(), MailError> {
    if value.is_empty()
        || value.len() > 40
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(MailError::InvalidBody(
            "`charset` must be a short MIME token".to_owned(),
        ));
    }
    Ok(())
}

fn is_reserved_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "bcc"
            | "cc"
            | "content-disposition"
            | "content-transfer-encoding"
            | "content-type"
            | "date"
            | "from"
            | "message-id"
            | "mime-version"
            | "reply-to"
            | "subject"
            | "to"
            | "x-penpot-data"
    )
}

fn join_mailboxes(mailboxes: &[Mailbox]) -> String {
    let mut out = String::new();
    let mut line_length = 0usize;
    for (index, mailbox) in mailboxes.iter().enumerate() {
        let value = mailbox.header_value();
        if index > 0 {
            if line_length + value.len() + 2 > 76 {
                out.push_str(",\r\n ");
                line_length = 1;
            } else {
                out.push_str(", ");
                line_length += 2;
            }
        }
        out.push_str(&value);
        line_length += value.len();
    }
    out
}

fn message_id(from: &Mailbox) -> String {
    let domain = from
        .address
        .rsplit_once('@')
        .map_or("penpot.local", |(_, domain)| domain);
    format!("<{}@{domain}>", Uuid::new_v4())
}

fn push_text_part(
    out: &mut String,
    content_type: &str,
    content: &str,
    filename: Option<&str>,
    charset: &str,
) {
    let _ = write!(out, "Content-Type: {content_type}; charset={charset}");
    if let Some(filename) = filename {
        let _ = write!(out, "; {}", content_parameter("name", filename));
    }
    out.push_str("\r\nContent-Transfer-Encoding: base64\r\n");
    if let Some(filename) = filename {
        let _ = write!(
            out,
            "Content-Disposition: attachment; {}\r\n",
            content_parameter("filename", filename)
        );
    }
    out.push_str("\r\n");
    out.push_str(&wrap_base64(&STANDARD.encode(content.as_bytes())));
    out.push_str("\r\n");
}

fn content_parameter(name: &str, value: &str) -> String {
    let plain = value.is_ascii()
        && !value.contains('"')
        && !value.contains('\\')
        && value.chars().all(|ch| !ch.is_control());
    if plain {
        format!("{name}=\"{value}\"")
    } else {
        format!("{name}*=UTF-8''{}", percent_encode(value))
    }
}

fn percent_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'!' | b'#' | b'$' | b'&' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~'
            )
        {
            out.push(char::from(*byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

fn wrap_base64(encoded: &str) -> String {
    let mut out = String::with_capacity(encoded.len() + encoded.len() / 76 * 2);
    for (index, chunk) in encoded.as_bytes().chunks(76).enumerate() {
        if index > 0 {
            out.push_str("\r\n");
        }
        out.push_str(&String::from_utf8_lossy(chunk));
    }
    out
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone as _;
    use transit::Value;

    use super::*;

    fn defaults() -> MimeDefaults {
        MimeDefaults {
            from: Some(
                Mailbox::parse("from", "Penpot <no-reply@example.com>").expect("default from"),
            ),
            reply_to: Some(
                Mailbox::parse("reply-to", "Help <help@example.com>").expect("default reply"),
            ),
        }
    }

    fn map(entries: Vec<(&str, Value)>) -> Map {
        entries
            .into_iter()
            .map(|(key, value)| (Value::kw(key), value))
            .collect()
    }

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 26, 12, 0, 0)
            .single()
            .expect("fixed time")
    }

    #[test]
    fn text_email_renders_headers_and_mime_parts() {
        let email = Email::from_transit(&map(vec![
            ("to", Value::str("user@example.com")),
            ("subject", Value::str("Welcome")),
            ("body", Value::str("Hello")),
            ("id", Value::str("register")),
        ]))
        .expect("email");

        let rendered = email.render(&defaults(), now()).expect("rendered");
        assert!(rendered
            .data
            .starts_with("From: Penpot <no-reply@example.com>\r\n"));
        assert!(rendered.data.contains("To: user@example.com\r\n"));
        assert!(rendered
            .data
            .contains("Reply-To: Help <help@example.com>\r\n"));
        assert!(rendered.data.contains("Subject: Welcome\r\n"));
        assert!(rendered.data.contains("MIME-Version: 1.0\r\n"));
        assert!(rendered
            .data
            .contains("Content-Type: multipart/mixed; boundary="));
        assert!(rendered
            .data
            .contains("Content-Type: text/plain; charset=utf-8"));
        assert!(rendered.data.contains(&STANDARD.encode("Hello")));
        assert_eq!(rendered.from, "no-reply@example.com");
        assert_eq!(rendered.recipients, vec!["user@example.com"]);
    }

    #[test]
    fn alternative_body_and_attachments_keep_their_structure() {
        let body = Value::map(vec![
            (Value::str("text/plain"), Value::str("plain")),
            (Value::str("text/html"), Value::str("<b>html</b>")),
        ]);
        let attachments = Value::map(vec![(Value::str("report.txt"), Value::str("attachment"))]);
        let email = Email::from_transit(&map(vec![
            ("to", Value::vector([Value::str("a@example.com")])),
            ("cc", Value::str("b@example.com")),
            ("bcc", Value::str("secret@example.com")),
            ("subject", Value::str("Report")),
            ("body", body),
            ("attachments", attachments),
        ]))
        .expect("email");

        let rendered = email.render(&defaults(), now()).expect("rendered");
        assert!(rendered.data.contains("multipart/alternative"));
        assert!(rendered
            .data
            .contains("Content-Type: text/html; charset=utf-8"));
        assert!(rendered
            .data
            .contains("Content-Disposition: attachment; filename=\"report.txt\""));
        assert!(rendered.data.contains(&STANDARD.encode("attachment")));
        assert!(!rendered.data.contains("secret@example.com"));
        assert_eq!(
            rendered.recipients,
            vec!["a@example.com", "b@example.com", "secret@example.com"]
        );
    }

    #[test]
    fn custom_headers_and_extra_data_are_written() {
        let headers = Value::map(vec![(Value::kw("X-Trace"), Value::str("abc"))]);
        let email = Email::from_transit(&map(vec![
            ("to", Value::str("user@example.com")),
            ("subject", Value::str("Hi")),
            ("body", Value::str("Body")),
            ("headers", headers),
            ("extra-data", Value::str("{\"id\":1}")),
        ]))
        .expect("email");

        let rendered = email.render(&defaults(), now()).expect("rendered");
        assert!(rendered.data.contains("X-Trace: abc\r\n"));
        assert!(rendered.data.contains("X-Penpot-Data: {\"id\":1}\r\n"));
    }

    #[test]
    fn header_injection_is_rejected() {
        let error = Email::from_transit(&map(vec![
            ("to", Value::str("user@example.com")),
            ("subject", Value::str("Hi\r\nBcc: victim@example.com")),
            ("body", Value::str("Body")),
        ]))
        .expect_err("injection");
        assert!(matches!(error, MailError::InvalidHeader { .. }));

        let headers = Value::map(vec![(Value::str("Bad\r\nName"), Value::str("value"))]);
        let error = Email::from_transit(&map(vec![
            ("to", Value::str("user@example.com")),
            ("subject", Value::str("Hi")),
            ("body", Value::str("Body")),
            ("headers", headers),
        ]))
        .expect_err("header injection");
        assert!(matches!(error, MailError::InvalidHeader { .. }));
    }

    #[test]
    fn missing_recipient_and_body_are_rejected() {
        let error = Email::from_transit(&map(vec![
            ("subject", Value::str("Hi")),
            ("body", Value::str("Body")),
        ]))
        .expect_err("missing to");
        assert!(matches!(error, MailError::InvalidBody(_)));

        let error = Email::from_transit(&map(vec![
            ("to", Value::str("user@example.com")),
            ("subject", Value::str("Hi")),
        ]))
        .expect_err("missing body");
        assert!(matches!(error, MailError::InvalidBody(_)));
    }

    #[test]
    fn non_ascii_subject_is_encoded() {
        let email = Email::from_transit(&map(vec![
            ("to", Value::str("user@example.com")),
            ("subject", Value::str("Bienvenue \u{00e0} Penpot")),
            ("body", Value::str("Body")),
        ]))
        .expect("email");
        let rendered = email.render(&defaults(), now()).expect("rendered");
        assert!(rendered.data.contains("Subject: =?UTF-8?B?"));
        assert!(!rendered.data.contains("Bienvenue \u{00e0}"));
    }

    #[test]
    fn long_non_ascii_subject_folds_without_being_rejected() {
        let email = Email::from_transit(&map(vec![
            ("to", Value::str("user@example.com")),
            (
                "subject",
                Value::str(
                    "A deliberately long non-ASCII subject that needs several encoded words: \
                     \u{00e9}\u{00e9}\u{00e9}\u{00e9}\u{00e9}\u{00e9}\u{00e9}\u{00e9}",
                ),
            ),
            ("body", Value::str("Body")),
        ]))
        .expect("email");
        let rendered = email.render(&defaults(), now()).expect("rendered");
        assert!(rendered.data.contains("Subject: =?UTF-8?B?"));
        assert!(rendered.data.contains("?=\r\n =?UTF-8?B?"));
    }

    #[test]
    fn long_recipient_lists_fold_between_addresses() {
        let recipients = (0..20)
            .map(|index| Value::str(format!("user{index}@example.com")))
            .collect::<Vec<_>>();
        let email = Email::from_transit(&map(vec![
            ("to", Value::vector(recipients)),
            ("subject", Value::str("Hi")),
            ("body", Value::str("Body")),
        ]))
        .expect("email");
        let rendered = email.render(&defaults(), now()).expect("rendered");
        assert!(rendered.data.contains(",\r\n "));
        for line in rendered.data.split("\r\n") {
            assert!(line.len() <= 900, "header line too long: {line}");
        }
        assert_eq!(rendered.recipients.len(), 20);
    }

    #[test]
    fn message_id_uses_the_sender_domain() {
        let id = message_id(&Mailbox::parse("from", "a@penpot.example").expect("mailbox"));
        assert!(id.starts_with('<'));
        assert!(id.ends_with("@penpot.example>"));
    }

    #[test]
    fn percent_encoding_covers_non_ascii_filenames() {
        assert_eq!(
            percent_encode("r\u{00e9}sum\u{00e9}.pdf"),
            "r%C3%A9sum%C3%A9.pdf"
        );
        assert_eq!(
            content_parameter("filename", "a b.txt"),
            "filename=\"a b.txt\""
        );
        assert_eq!(
            content_parameter("filename", "r\u{00e9}sum\u{00e9}.pdf"),
            "filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"
        );
    }
}
