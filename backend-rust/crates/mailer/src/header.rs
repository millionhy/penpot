//! Header validation and RFC 2047 encoding.

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::MailError;

/// Leave room for folding and the field name inside the 998 octet limit.
const MAX_VALUE_BYTES: usize = 900;

/// Largest UTF-8 chunk that stays inside a 75 character encoded word.
const ENCODED_CHUNK_BYTES: usize = 45;

pub(crate) fn validate_name(name: &str) -> Result<(), MailError> {
    if name.is_empty() || name.len() > 78 {
        return Err(MailError::InvalidHeader {
            name: name.to_owned(),
            reason: "field name must contain 1 to 78 characters".to_owned(),
        });
    }
    if !name.bytes().all(|byte| {
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
                    | b'.'
                    | b'^'
                    | b'_'
                    | b'`'
                    | b'|'
                    | b'~'
            )
    }) {
        return Err(MailError::InvalidHeader {
            name: name.to_owned(),
            reason: "field name contains a character outside the RFC 5322 token set".to_owned(),
        });
    }
    Ok(())
}

pub(crate) fn validate_value(name: &str, value: &str) -> Result<(), MailError> {
    if value.len() > MAX_VALUE_BYTES {
        return Err(MailError::InvalidHeader {
            name: name.to_owned(),
            reason: format!("value exceeds {MAX_VALUE_BYTES} bytes"),
        });
    }
    if value.chars().any(|ch| ch.is_control() && ch != '\t') {
        return Err(MailError::InvalidHeader {
            name: name.to_owned(),
            reason: "value contains a control character".to_owned(),
        });
    }
    Ok(())
}

/// Validate a header value that this crate generated and may have folded.
///
/// Raw task props go through [`validate_value`], which rejects every line
/// break. Encoded words and long address lists are folded with CRLF plus
/// whitespace, which RFC 5322 allows; every other control character and every
/// physical line over the limit is still rejected.
pub(crate) fn validate_written(name: &str, value: &str) -> Result<(), MailError> {
    if value.len() > 64 * 1024 {
        return Err(MailError::InvalidHeader {
            name: name.to_owned(),
            reason: "value exceeds 64 KiB".to_owned(),
        });
    }
    for (index, line) in value.split("\r\n").enumerate() {
        if index > 0 && !line.starts_with([' ', '\t']) {
            return Err(MailError::InvalidHeader {
                name: name.to_owned(),
                reason: "folded line must start with whitespace".to_owned(),
            });
        }
        if line.len() > MAX_VALUE_BYTES {
            return Err(MailError::InvalidHeader {
                name: name.to_owned(),
                reason: format!("folded line exceeds {MAX_VALUE_BYTES} bytes"),
            });
        }
        if line.chars().any(|ch| ch.is_control() && ch != '\t') {
            return Err(MailError::InvalidHeader {
                name: name.to_owned(),
                reason: "value contains a control character".to_owned(),
            });
        }
    }
    Ok(())
}

/// Encode an unstructured header value (subject, display name).
///
/// ASCII values pass through unchanged. Everything else becomes one or more
/// RFC 2047 base64 words. `fold` inserts CRLF plus a space between words; use
/// it for standalone headers, not for a display name followed by an address.
#[must_use]
pub(crate) fn encode_unstructured(value: &str, fold: bool) -> String {
    if value.is_ascii() {
        return value.to_owned();
    }

    let mut words = Vec::new();
    let mut start = 0;
    while start < value.len() {
        let mut end = (start + ENCODED_CHUNK_BYTES).min(value.len());
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        let encoded = STANDARD.encode(&value.as_bytes()[start..end]);
        words.push(format!("=?UTF-8?B?{encoded}?="));
        start = end;
    }

    if fold {
        words.join("\r\n ")
    } else {
        words.join(" ")
    }
}

/// Quote an ASCII display name when it contains RFC 5322 specials.
#[must_use]
pub(crate) fn quote_if_needed(value: &str) -> String {
    let simple = value.bytes().all(|byte| {
        byte.is_ascii_alphanumeric()
            || matches!(byte, b' ' | b'-' | b'_' | b'.' | b'\'' | b'+' | b'!')
    });
    if simple {
        return value.to_owned();
    }

    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        if matches!(ch, '"' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_names_follow_the_token_set() {
        assert!(validate_name("X-Penpot-Data").is_ok());
        assert!(validate_name("Subject").is_ok());
        assert!(validate_name("Bad Name").is_err());
        assert!(validate_name("Bad:Name").is_err());
        assert!(validate_name("").is_err());
    }

    #[test]
    fn header_values_reject_line_breaks_and_controls() {
        assert!(validate_value("Subject", "hello").is_ok());
        assert!(validate_value("Subject", "hello\r\nBcc: victim@example.com").is_err());
        assert!(validate_value("Subject", "nul\0byte").is_err());
        assert!(validate_value("Subject", &"x".repeat(MAX_VALUE_BYTES + 1)).is_err());
    }

    #[test]
    fn ascii_subjects_stay_readable() {
        assert_eq!(encode_unstructured("Welcome", true), "Welcome");
    }

    #[test]
    fn non_ascii_subjects_use_rfc_2047_words() {
        let encoded = encode_unstructured("Cafe \u{00e9}", true);
        assert!(encoded.starts_with("=?UTF-8?B?"));
        assert!(encoded.ends_with("?="));
        assert!(!encoded.contains('\u{00e9}'));
    }

    #[test]
    fn generated_folding_is_allowed_but_bare_breaks_are_not() {
        let encoded = encode_unstructured(
            "A deliberately long non-ASCII subject that needs several encoded words: \
             \u{00e9}\u{00e9}\u{00e9}\u{00e9}\u{00e9}\u{00e9}\u{00e9}\u{00e9}",
            true,
        );
        assert!(encoded.contains("\r\n "));
        assert!(validate_written("Subject", &encoded).is_ok());
        assert!(validate_written("Subject", "one\r\ntwo").is_err());
        assert!(validate_written("Subject", "one\r\n two\r\nthree").is_err());
    }

    #[test]
    fn display_names_are_quoted_only_when_needed() {
        assert_eq!(quote_if_needed("Penpot"), "Penpot");
        assert_eq!(quote_if_needed("Penpot Team"), "Penpot Team");
        assert_eq!(quote_if_needed("Penpot, Inc."), "\"Penpot, Inc.\"");
        assert_eq!(quote_if_needed("say \"hi\""), "\"say \\\"hi\\\"\"");
    }
}
