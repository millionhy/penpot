//! `get-builtin-templates` (M20).
//!
//! `app.setup.templates` loads `app/onboarding.edn` from the backend resource
//! path and `app.rpc.commands.management` projects every entry to `id` and
//! `name`. The Rust port reads the same file at build time so the list cannot
//! drift from the Clojure backend, and parses the small EDN shape with a
//! strict reader: only the vector-of-maps form the file uses is accepted.

use std::sync::Arc;

use transit::Value;

use crate::params::ParamSchema;
use crate::registry::{Command, HandlerFuture, Registry};
use crate::response::CommandResult;

const ONBOARDING_EDN: &str = include_str!("../../../../../backend/resources/app/onboarding.edn");

/// One `schema:template` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub file_uri: String,
}

/// `get-builtin-templates` over a fixed template list.
pub struct TemplatesCommands {
    templates: Arc<Vec<Template>>,
}

impl TemplatesCommands {
    #[must_use]
    pub fn new(templates: Vec<Template>) -> Self {
        Self {
            templates: Arc::new(templates),
        }
    }

    /// Parse the embedded `onboarding.edn`.
    ///
    /// # Errors
    ///
    /// The reader message when the file does not match the template shape.
    pub fn from_embedded() -> Result<Self, String> {
        Ok(Self::new(parse_templates(ONBOARDING_EDN)?))
    }

    pub fn register(&self, registry: &mut Registry) {
        let templates = Arc::clone(&self.templates);
        registry.register(
            Command::new("get-builtin-templates", move |_ctx| {
                templates_response(Arc::clone(&templates))
            })
            .params(ParamSchema::new([])),
        );
    }
}

fn templates_response(templates: Arc<Vec<Template>>) -> HandlerFuture {
    Box::pin(async move {
        Ok(CommandResult::ok(Value::vector(templates.iter().map(
            |row| {
                Value::map([
                    (Value::kw("id"), Value::str(row.id.clone())),
                    (Value::kw("name"), Value::str(row.name.clone())),
                ])
            },
        ))))
    })
}

/// Read the vector-of-maps the onboarding file contains. The real file only
/// holds string values, so anything else is rejected instead of guessed at.
///
/// # Errors
///
/// The reader message when the text is not a vector of template maps with
/// string `:id`, `:name` and `:file-uri` values.
pub fn parse_templates(text: &str) -> Result<Vec<Template>, String> {
    let mut parser = Parser::new(text);
    parser.skip();
    parser.expect(b'[')?;
    let mut out = Vec::new();
    loop {
        parser.skip();
        match parser.peek() {
            Some(b']') => {
                parser.bump();
                break;
            }
            Some(b'{') => out.push(parser.map()?),
            Some(other) => return Err(format!("expected `{{`, found `{}`", other as char)),
            None => return Err("unterminated template vector".to_owned()),
        }
    }
    parser.skip();
    if parser.peek().is_some() {
        return Err("trailing data after template vector".to_owned());
    }
    Ok(out)
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            bytes: text.as_bytes(),
            pos: 0,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn bump(&mut self) {
        self.pos += 1;
    }

    fn skip(&mut self) {
        while matches!(self.peek(), Some(byte) if byte.is_ascii_whitespace() || byte == b',') {
            self.bump();
        }
    }

    fn expect(&mut self, expected: u8) -> Result<(), String> {
        self.skip();
        match self.peek() {
            Some(byte) if byte == expected => {
                self.bump();
                Ok(())
            }
            Some(byte) => Err(format!(
                "expected `{}`, found `{}`",
                expected as char, byte as char
            )),
            None => Err(format!(
                "expected `{}`, found end of file",
                expected as char
            )),
        }
    }

    fn map(&mut self) -> Result<Template, String> {
        self.expect(b'{')?;
        let mut id = None;
        let mut name = None;
        let mut file_uri = None;
        loop {
            self.skip();
            match self.peek() {
                Some(b'}') => {
                    self.bump();
                    break;
                }
                Some(b':') => {
                    let key = self.keyword()?;
                    let value = self.string()?;
                    match key.as_str() {
                        "id" => id = Some(value),
                        "name" => name = Some(value),
                        "file-uri" => file_uri = Some(value),
                        _ => {}
                    }
                }
                Some(other) => {
                    return Err(format!("expected a keyword, found `{}`", other as char))
                }
                None => return Err("unterminated template map".to_owned()),
            }
        }
        Ok(Template {
            id: id.ok_or_else(|| "template is missing `:id`".to_owned())?,
            name: name.ok_or_else(|| "template is missing `:name`".to_owned())?,
            file_uri: file_uri.ok_or_else(|| "template is missing `:file-uri`".to_owned())?,
        })
    }

    fn keyword(&mut self) -> Result<String, String> {
        self.expect(b':')?;
        let start = self.pos;
        while matches!(self.peek(), Some(byte) if byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            self.bump();
        }
        if start == self.pos {
            return Err("empty keyword".to_owned());
        }
        Ok(text_at(self.bytes, start, self.pos))
    }

    fn string(&mut self) -> Result<String, String> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            let Some(byte) = self.peek() else {
                return Err("unterminated string".to_owned());
            };
            self.bump();
            match byte {
                b'"' => return Ok(out),
                b'\\' => {
                    let Some(escaped) = self.peek() else {
                        return Err("unterminated escape".to_owned());
                    };
                    self.bump();
                    match escaped {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'n' => out.push('\n'),
                        b't' => out.push('\t'),
                        other => {
                            return Err(format!("unsupported escape `\\{}`", other as char));
                        }
                    }
                }
                other => out.push(other as char),
            }
        }
    }
}

fn text_at(bytes: &[u8], start: usize, end: usize) -> String {
    String::from_utf8_lossy(&bytes[start..end]).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_embedded_onboarding_file_parses() {
        let templates = parse_templates(ONBOARDING_EDN).expect("onboarding.edn");
        assert_eq!(templates.len(), 15);
        assert_eq!(templates[0].id, "tokens-starter-kit");
        assert_eq!(templates[0].name, "Design tokens starter kit");
        assert!(templates[0].file_uri.starts_with("https://"));
        assert!(templates.iter().all(|row| !row.name.is_empty()));
    }

    #[test]
    fn template_ids_are_unique() {
        let templates = parse_templates(ONBOARDING_EDN).expect("onboarding.edn");
        let mut ids: Vec<&str> = templates.iter().map(|row| row.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), templates.len());
    }

    #[test]
    fn a_missing_field_is_rejected() {
        let error = parse_templates(r#"[{:id "a" :name "A"}]"#).expect_err("no file uri");
        assert!(error.contains("file-uri"));
    }

    #[test]
    fn malformed_input_is_rejected() {
        assert!(parse_templates("[{").is_err());
        assert!(parse_templates("[{:id 1}]").is_err());
        assert!(parse_templates(r#"[{:id "a" :name "A" :file-uri "u"}] trailing"#).is_err());
    }
}
