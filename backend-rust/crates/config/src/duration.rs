//! Duration parsing for `PENPOT_*` values.
//!
//! Clojure reads these through `common.time/duration`, which prepends `PT` and
//! calls `java.time.Duration/parse`. Config strings are therefore ISO-8601
//! time components: `15m`, `3h`, `168h`. Rust's `std::time::Duration` has no
//! parser, so this module accepts the concrete forms Penpot uses (including
//! combined values such as `1h30m` and a fractional component) and rejects
//! anything else instead of guessing.

use std::time::Duration;

use thiserror::Error;

/// Errors from [`parse_duration`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DurationError {
    #[error("duration is empty")]
    Empty,
    #[error("expected a number at `{0}`")]
    ExpectedNumber(String),
    #[error("expected a unit after `{0}`")]
    ExpectedUnit(String),
    #[error("unknown duration unit `{0}`")]
    UnknownUnit(String),
    #[error("duration is out of range")]
    OutOfRange,
}

/// Parse a Penpot config duration such as `15m`, `3h`, `168h`, or `1h30m`.
///
/// Units are `ms`, `s`, `m`, `h`, and `d`. Values are non-negative; a bare
/// number is rejected because Java's `Duration.parse("PT15")` is not a valid
/// duration either.
///
/// # Errors
///
/// [`DurationError`] when the text is not a sequence of number/unit pairs or
/// the total does not fit in [`Duration`].
pub fn parse_duration(input: &str) -> Result<Duration, DurationError> {
    let text = input.trim();
    if text.is_empty() {
        return Err(DurationError::Empty);
    }

    let mut rest = text;
    let mut seconds = 0.0_f64;
    let mut parsed_any = false;

    while !rest.is_empty() {
        let number_end = rest
            .find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .unwrap_or(rest.len());
        if number_end == 0 {
            return Err(DurationError::ExpectedNumber(rest.to_owned()));
        }
        let number: f64 = rest[..number_end]
            .parse()
            .map_err(|_| DurationError::ExpectedNumber(rest[..number_end].to_owned()))?;

        rest = &rest[number_end..];
        let unit_end = rest
            .find(|c: char| !c.is_ascii_alphabetic())
            .unwrap_or(rest.len());
        if unit_end == 0 {
            return Err(DurationError::ExpectedUnit(rest.to_owned()));
        }
        let unit = rest[..unit_end].to_ascii_lowercase();
        rest = &rest[unit_end..];

        let factor = match unit.as_str() {
            "ms" => 0.001,
            "s" => 1.0,
            "m" => 60.0,
            "h" => 3_600.0,
            "d" => 86_400.0,
            _ => return Err(DurationError::UnknownUnit(unit)),
        };
        seconds += number * factor;
        parsed_any = true;
    }

    if !parsed_any {
        return Err(DurationError::Empty);
    }

    Duration::try_from_secs_f64(seconds).map_err(|_| DurationError::OutOfRange)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_units_used_by_penpot_config() {
        assert_eq!(parse_duration("15m"), Ok(Duration::from_secs(900)));
        assert_eq!(parse_duration("3h"), Ok(Duration::from_secs(10_800)));
        assert_eq!(parse_duration("168h"), Ok(Duration::from_secs(604_800)));
        assert_eq!(parse_duration("24h"), Ok(Duration::from_secs(86_400)));
        assert_eq!(parse_duration("30s"), Ok(Duration::from_secs(30)));
        assert_eq!(parse_duration("500ms"), Ok(Duration::from_millis(500)));
    }

    #[test]
    fn parses_combinations_and_fractions() {
        assert_eq!(parse_duration("1h30m"), Ok(Duration::from_secs(5_400)));
        assert_eq!(parse_duration("1.5h"), Ok(Duration::from_secs(5_400)));
    }

    #[test]
    fn rejects_bare_numbers_and_unknown_units() {
        assert_eq!(
            parse_duration("15"),
            Err(DurationError::ExpectedUnit(String::new()))
        );
        assert_eq!(
            parse_duration("15w"),
            Err(DurationError::UnknownUnit("w".to_owned()))
        );
        assert!(matches!(
            parse_duration("-1h"),
            Err(DurationError::ExpectedNumber(_))
        ));
        assert_eq!(parse_duration(""), Err(DurationError::Empty));
    }
}
