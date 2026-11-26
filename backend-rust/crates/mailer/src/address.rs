//! RFC 5322 mailbox parsing with an ASCII-only address policy.

use crate::{
    header::{encode_unstructured, quote_if_needed},
    MailError,
};

/// One parsed mailbox: an optional display name plus a bare address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mailbox {
    /// Display name, already unquoted.
    pub name: Option<String>,
    /// Bare `local@domain` address.
    pub address: String,
}

impl Mailbox {
    /// Parse `Name <local@domain>` or a bare address.
    ///
    /// # Errors
    ///
    /// Rejects line breaks, control characters, multiple addresses in one
    /// string, non-ASCII local parts, and malformed domains.
    pub fn parse(field: &str, raw: &str) -> Result<Self, MailError> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err(invalid(field, "address is empty"));
        }
        if raw.len() > 320 {
            return Err(invalid(field, "address exceeds 320 bytes"));
        }
        if raw
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '\r' | '\n'))
        {
            return Err(invalid(field, "address contains a control character"));
        }

        let (name, address) = split_display(field, raw)?;
        validate_address(field, &address)?;
        Ok(Self { name, address })
    }

    /// Value for a `From`, `To`, `Cc`, or `Reply-To` header.
    #[must_use]
    pub fn header_value(&self) -> String {
        match &self.name {
            None => self.address.clone(),
            Some(name) => {
                let display = if name.is_ascii() {
                    quote_if_needed(name)
                } else {
                    encode_unstructured(name, false)
                };
                format!("{display} <{}>", self.address)
            }
        }
    }

    /// Bare address for the SMTP envelope.
    #[must_use]
    pub fn envelope(&self) -> &str {
        &self.address
    }
}

/// Validate a bare address that is about to enter an SMTP command.
pub(crate) fn validate_envelope(address: &str) -> Result<(), MailError> {
    validate_address("envelope", address)
}

fn split_display(field: &str, raw: &str) -> Result<(Option<String>, String), MailError> {
    if let Some(open) = raw.find('<') {
        if !raw.ends_with('>') {
            return Err(invalid(field, "missing closing `>`"));
        }
        if raw[..open].contains('>') || raw[open + 1..raw.len() - 1].contains('<') {
            return Err(invalid(field, "nested angle brackets"));
        }
        let name = raw[..open].trim();
        let address = raw[open + 1..raw.len() - 1].trim();
        let name = unquote_name(field, name)?;
        if address.is_empty() {
            return Err(invalid(field, "address between angle brackets is empty"));
        }
        return Ok((name, address.to_owned()));
    }

    if raw.contains('>') {
        return Err(invalid(field, "unexpected `>`"));
    }
    if raw.contains(',') {
        return Err(invalid(
            field,
            "multiple addresses must be sent as a vector",
        ));
    }
    Ok((None, raw.to_owned()))
}

fn unquote_name(field: &str, name: &str) -> Result<Option<String>, MailError> {
    if name.is_empty() {
        return Ok(None);
    }
    if !name.starts_with('"') {
        return Ok(Some(name.to_owned()));
    }
    if !name.ends_with('"') || name.len() < 2 {
        return Err(invalid(field, "unterminated quoted display name"));
    }

    let mut out = String::new();
    let mut chars = name[1..name.len() - 1].chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            let escaped = chars
                .next()
                .ok_or_else(|| invalid(field, "trailing escape in display name"))?;
            out.push(escaped);
        } else if ch == '"' {
            return Err(invalid(field, "unescaped quote in display name"));
        } else {
            out.push(ch);
        }
    }
    Ok(Some(out))
}

fn validate_address(field: &str, address: &str) -> Result<(), MailError> {
    if !address.is_ascii() {
        return Err(invalid(
            field,
            "non-ASCII addresses require SMTPUTF8, which this client does not send",
        ));
    }
    if address.len() > 254 {
        return Err(invalid(field, "address exceeds 254 bytes"));
    }
    let (local, domain) = address
        .rsplit_once('@')
        .ok_or_else(|| invalid(field, "address has no `@`"))?;
    if local.is_empty() {
        return Err(invalid(field, "local part is empty"));
    }
    if local.len() > 64 {
        return Err(invalid(field, "local part exceeds 64 bytes"));
    }
    if local.starts_with('.') || local.ends_with('.') || local.contains("..") {
        return Err(invalid(field, "local part has an empty dot-separated atom"));
    }
    if !local.bytes().all(|byte| {
        byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'!' | b'#'
                    | b'$'
                    | b'%'
                    | b'&'
                    | b'\''
                    | b'*'
                    | b'+'
                    | b'-'
                    | b'/'
                    | b'='
                    | b'?'
                    | b'^'
                    | b'_'
                    | b'`'
                    | b'{'
                    | b'|'
                    | b'}'
                    | b'~'
                    | b'.'
            )
    }) {
        return Err(invalid(field, "local part contains an invalid character"));
    }

    if domain.is_empty() || domain.len() > 253 {
        return Err(invalid(field, "domain is empty or too long"));
    }
    for label in domain.split('.') {
        if label.is_empty() {
            return Err(invalid(field, "domain has an empty label"));
        }
        if label.len() > 63 {
            return Err(invalid(field, "domain label exceeds 63 bytes"));
        }
        if label.starts_with('-') || label.ends_with('-') {
            return Err(invalid(field, "domain label starts or ends with `-`"));
        }
        if !label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err(invalid(field, "domain contains an invalid character"));
        }
    }

    Ok(())
}

fn invalid(field: &str, reason: impl Into<String>) -> MailError {
    MailError::InvalidAddress {
        field: field.to_owned(),
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_and_display_addresses_parse() {
        let bare = Mailbox::parse("to", "user@example.com").expect("bare");
        assert_eq!(bare.name, None);
        assert_eq!(bare.address, "user@example.com");

        let named = Mailbox::parse("to", "Penpot Team <team@example.com>").expect("named");
        assert_eq!(named.name.as_deref(), Some("Penpot Team"));
        assert_eq!(named.header_value(), "Penpot Team <team@example.com>");
    }

    #[test]
    fn quoted_display_names_unquote_and_render_safely() {
        let mailbox = Mailbox::parse("to", "\"Penpot, Inc.\" <team@example.com>").expect("quoted");
        assert_eq!(mailbox.name.as_deref(), Some("Penpot, Inc."));
        assert_eq!(
            mailbox.header_value(),
            "\"Penpot, Inc.\" <team@example.com>"
        );
    }

    #[test]
    fn non_ascii_display_names_are_encoded() {
        let mailbox = Mailbox::parse("to", "P\u{00e9}npot <team@example.com>").expect("unicode");
        assert!(mailbox.header_value().contains("=?UTF-8?B?"));
        assert!(mailbox.header_value().ends_with("<team@example.com>"));
    }

    #[test]
    fn line_breaks_and_multiple_addresses_are_rejected() {
        assert!(Mailbox::parse("to", "a@example.com\r\nBcc: b@example.com").is_err());
        assert!(Mailbox::parse("to", "a@example.com, b@example.com").is_err());
        assert!(Mailbox::parse("to", "<a@example.com").is_err());
    }

    #[test]
    fn malformed_addresses_are_rejected() {
        for address in [
            "",
            "user",
            "@example.com",
            "user@",
            "user@@example.com",
            ".user@example.com",
            "user.@example.com",
            "user..name@example.com",
            "user name@example.com",
            "user@-example.com",
            "user@example-.com",
            "user@example..com",
            "us\u{00e9}r@example.com",
        ] {
            assert!(
                Mailbox::parse("to", address).is_err(),
                "{address:?} should be rejected"
            );
        }
    }

    #[test]
    fn envelope_validation_rejects_smtp_metacharacters() {
        assert!(validate_envelope("user@example.com").is_ok());
        assert!(validate_envelope("user@example.com>\r\nRCPT TO:<x@y").is_err());
    }
}
