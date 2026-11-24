//! One test per `defmethod` of `backend/src/app/http/errors.clj`.

use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use errors::{
    handle, handle_error, handle_exception, postgres_hint, Cause, ErrorCode, ErrorType, ExError,
    HttpError, HTTP_HEADERS_KEY, POSTGRES_DEFAULT_HINT, SCHEMA_EXPLAIN_KEY, SPEC_PROBLEMS_KEY,
    SPEC_SPEC_KEY, SPEC_VALUE_KEY,
};
use transit::{Map, Value};

fn kw(name: &str) -> Value {
    Value::kw(name)
}

fn data(entries: &[(&str, Value)]) -> Value {
    Value::map(entries.iter().map(|(key, value)| (kw(key), value.clone())))
}

fn error(entries: &[(&str, Value)]) -> HttpError {
    errors::handle(&Cause::error(data(entries)))
}

fn body(err: &HttpError) -> &Map {
    err.body
        .as_ref()
        .expect("response should have a body")
        .as_map()
        .expect("body should be a map")
}

fn field<'a>(err: &'a HttpError, key: &str) -> Option<&'a Value> {
    body(err).get_kw(key)
}

fn assert_kw(err: &HttpError, key: &str, expected: &str) {
    assert_eq!(
        field(err, key).and_then(Value::as_keyword),
        Some(expected),
        "field `{key}` should be :{expected}"
    );
}

#[test]
fn authentication_is_401_with_the_original_data() {
    let original = data(&[
        ("type", kw("authentication")),
        ("code", kw("invalid-token")),
        ("hint", Value::str("token expired")),
    ]);
    let response = handle(&Cause::error(original.clone()));
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(response.body, Some(original));
}

#[test]
fn authorization_is_403_with_the_original_data() {
    let original = data(&[("type", kw("authorization")), ("code", kw("denied"))]);
    let response = handle(&Cause::error(original.clone()));
    assert_eq!(response.status, StatusCode::FORBIDDEN);
    assert_eq!(response.body, Some(original));
}

#[test]
fn restriction_method_not_allowed_is_405() {
    let response = error(&[
        ("type", kw("restriction")),
        ("code", kw(ErrorCode::MethodNotAllowed.as_str())),
        ("hint", Value::str("only GET")),
    ]);
    assert_eq!(response.status, StatusCode::METHOD_NOT_ALLOWED);
    assert_kw(&response, "type", "restriction");
    assert_kw(&response, "code", "method-not-allowed");
}

#[test]
fn restriction_with_any_other_code_is_400() {
    let response = error(&[
        ("type", kw("restriction")),
        ("code", kw("demo-users")),
        ("hint", Value::str("not available")),
    ]);
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
}

#[test]
fn restriction_replaces_the_malli_explain_with_a_string() {
    let response = error(&[
        ("type", kw("restriction")),
        ("code", kw("blocked")),
        (
            SCHEMA_EXPLAIN_KEY,
            data(&[("value", Value::str("nope")), ("errors", Value::array([]))]),
        ),
    ]);
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert!(
        field(&response, SCHEMA_EXPLAIN_KEY).is_none(),
        "the raw malli explain must not leak"
    );
    assert!(field(&response, "explain")
        .and_then(Value::as_str)
        .is_some());
}

#[test]
fn rate_limit_is_429_with_retry_after_and_a_fixed_body() {
    let response = error(&[
        ("type", kw("rate-limit")),
        ("code", kw("too-many")),
        ("hint", Value::str("slow down")),
        ("ttl", Value::Integer(60)),
        (HTTP_HEADERS_KEY, data(&[("x-tenant", Value::str("acme"))])),
    ]);
    assert_eq!(response.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        response
            .headers
            .get("retry-after")
            .map(|v| v.to_str().unwrap()),
        Some("60")
    );
    assert_eq!(
        response
            .headers
            .get("x-tenant")
            .map(|v| v.to_str().unwrap()),
        Some("acme")
    );
    let body = body(&response);
    assert_eq!(body.len(), 4, "the rate-limit body is built key by key");
    assert_kw(&response, "type", "rate-limit");
    assert_kw(&response, "code", "too-many");
    assert_eq!(
        field(&response, "hint").and_then(Value::as_str),
        Some("slow down")
    );
    assert_eq!(field(&response, "ttl"), Some(&Value::Integer(60)));
}

#[test]
fn rate_limit_without_ttl_has_no_retry_after_and_nil_fields() {
    let response = error(&[("type", kw("rate-limit"))]);
    assert_eq!(response.status, StatusCode::TOO_MANY_REQUESTS);
    assert!(response.headers.get("retry-after").is_none());
    let body = body(&response);
    assert_eq!(body.len(), 4);
    assert_eq!(body.get_kw("code"), Some(&Value::Nil));
    assert_eq!(body.get_kw("hint"), Some(&Value::Nil));
    assert_eq!(body.get_kw("ttl"), Some(&Value::Nil));
}

#[test]
fn concurrency_limit_is_429_with_headers_and_no_body() {
    let response = error(&[
        ("type", kw("concurrency-limit")),
        (
            HTTP_HEADERS_KEY,
            data(&[("retry-after", Value::Integer(5))]),
        ),
    ]);
    assert_eq!(response.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        response
            .headers
            .get("retry-after")
            .map(|v| v.to_str().unwrap()),
        Some("5")
    );
    assert!(response.body.is_none(), "errors.clj sends no body here");
}

#[test]
fn validation_codes_are_400_and_strip_spec_and_malli_internals() {
    for code in [
        "spec-validation",
        "params-validation",
        "schema-validation",
        "data-validation",
    ] {
        let response = error(&[
            ("type", kw("validation")),
            ("code", kw(code)),
            (SPEC_PROBLEMS_KEY, Value::array([Value::str("problem")])),
            (SPEC_VALUE_KEY, Value::Integer(1)),
            (SPEC_SPEC_KEY, Value::str("spec")),
            (SCHEMA_EXPLAIN_KEY, data(&[("value", Value::Integer(1))])),
        ]);
        assert_eq!(response.status, StatusCode::BAD_REQUEST, "code {code}");
        for key in [
            SPEC_PROBLEMS_KEY,
            SPEC_VALUE_KEY,
            SPEC_SPEC_KEY,
            SCHEMA_EXPLAIN_KEY,
        ] {
            assert!(field(&response, key).is_none(), "{code} leaked {key}");
        }
        assert!(
            field(&response, "explain")
                .and_then(Value::as_str)
                .is_some(),
            "{code} should carry a rendered explain"
        );
    }
}

#[test]
fn validation_vern_conflict_is_409() {
    let response = error(&[
        ("type", kw("validation")),
        ("code", kw(ErrorCode::VernConflict.as_str())),
    ]);
    assert_eq!(response.status, StatusCode::CONFLICT);
    assert_kw(&response, "code", "vern-conflict");
}

#[test]
fn validation_request_body_too_large_is_413() {
    let response = error(&[
        ("type", kw("validation")),
        ("code", kw(ErrorCode::RequestBodyTooLarge.as_str())),
    ]);
    assert_eq!(response.status, StatusCode::PAYLOAD_TOO_LARGE);
}

#[test]
fn validation_invalid_image_is_400() {
    let response = error(&[
        ("type", kw("validation")),
        ("code", kw(ErrorCode::InvalidImage.as_str())),
        ("hint", Value::str("bad png")),
    ]);
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_eq!(
        field(&response, "hint").and_then(Value::as_str),
        Some("bad png")
    );
}

#[test]
fn unknown_validation_codes_default_to_400() {
    let response = error(&[("type", kw("validation")), ("code", kw("something-new"))]);
    assert_eq!(response.status, StatusCode::BAD_REQUEST);
    assert_kw(&response, "code", "something-new");
}

#[test]
fn assertion_data_validation_forces_server_error_and_assertion() {
    let response = error(&[
        ("type", kw("assertion")),
        ("code", kw(ErrorCode::DataValidation.as_str())),
        (SCHEMA_EXPLAIN_KEY, data(&[("value", Value::Integer(2))])),
        ("extra", Value::str("kept")),
    ]);
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_kw(&response, "type", "server-error");
    assert_kw(&response, "code", "assertion");
    assert!(field(&response, SCHEMA_EXPLAIN_KEY).is_none());
    assert!(field(&response, "explain")
        .and_then(Value::as_str)
        .is_some());
    assert_eq!(
        field(&response, "extra").and_then(Value::as_str),
        Some("kept")
    );
}

#[test]
fn assertion_spec_validation_forces_server_error_and_assertion() {
    let response = error(&[
        ("type", kw("assertion")),
        ("code", kw(ErrorCode::SpecValidation.as_str())),
        (SPEC_PROBLEMS_KEY, Value::array([Value::str("problem")])),
        (SPEC_VALUE_KEY, Value::Integer(3)),
        (SPEC_SPEC_KEY, Value::str("spec")),
    ]);
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_kw(&response, "type", "server-error");
    assert_kw(&response, "code", "assertion");
    for key in [SPEC_PROBLEMS_KEY, SPEC_VALUE_KEY, SPEC_SPEC_KEY] {
        assert!(field(&response, key).is_none(), "leaked {key}");
    }
}

#[test]
fn generic_assertion_strips_internal_fields_and_forces_the_code() {
    let response = error(&[
        ("type", kw("assertion")),
        ("code", kw("whatever")),
        ("state", Value::str("secret")),
        ("path", Value::array([Value::str("a")])),
        ("context", data(&[("sql", Value::str("select 1"))])),
        ("hint", Value::str("kept")),
    ]);
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_kw(&response, "type", "server-error");
    assert_kw(&response, "code", "assertion");
    for key in ["state", "path", "context"] {
        assert!(field(&response, key).is_none(), "leaked {key}");
    }
    assert_eq!(
        field(&response, "hint").and_then(Value::as_str),
        Some("kept")
    );
}

#[test]
fn not_found_is_404_with_the_original_data() {
    let original = data(&[("type", kw("not-found")), ("code", kw("file-not-found"))]);
    let response = handle(&Cause::error(original.clone()));
    assert_eq!(response.status, StatusCode::NOT_FOUND);
    assert_eq!(response.body, Some(original));
}

#[test]
fn nitrate_unavailable_is_503_without_internal_details() {
    let response = error(&[
        ("type", kw("nitrate-unavailable")),
        ("uri", Value::str("http://nitrate:1234")),
    ]);
    assert_eq!(response.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body(&response).len(), 1);
    assert_kw(&response, "type", "nitrate-unavailable");
}

#[test]
fn nitrate_not_configured_is_503_without_internal_details() {
    let response = error(&[
        ("type", kw("nitrate-not-configured")),
        ("hint", Value::str("set PENPOT_NITRATE_URI")),
    ]);
    assert_eq!(response.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body(&response).len(), 1);
    assert_kw(&response, "type", "nitrate-not-configured");
}

#[test]
fn internal_keeps_an_existing_code_and_strips_internal_fields() {
    let response = error(&[
        ("type", kw("internal")),
        ("code", kw("storage-failed")),
        ("state", Value::str("secret")),
        ("path", Value::array([])),
        ("context", data(&[])),
    ]);
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_kw(&response, "type", "server-error");
    assert_kw(&response, "code", "storage-failed");
    for key in ["state", "path", "context"] {
        assert!(field(&response, key).is_none(), "leaked {key}");
    }
}

#[test]
fn internal_defaults_the_code_to_unhandled() {
    let response = error(&[("type", kw("internal"))]);
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_kw(&response, "code", "unhandled");
}

#[test]
fn an_unknown_error_type_lands_on_the_unhandled_exception_branch() {
    let response = error(&[
        ("type", kw("something-new")),
        ("state", Value::str("secret")),
    ]);
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_kw(&response, "type", "server-error");
    assert_kw(&response, "code", "unhandled");
    assert!(field(&response, "state").is_none());
}

#[test]
fn postgres_statement_timeout_is_504() {
    let response = handle(&Cause::postgres("57014"));
    assert_eq!(response.status, StatusCode::GATEWAY_TIMEOUT);
    assert_kw(&response, "type", "server-error");
    assert_kw(&response, "code", "statement-timeout");
    assert_eq!(
        field(&response, "hint").and_then(Value::as_str),
        Some("The operation took too long and was cancelled")
    );
}

#[test]
fn postgres_idle_in_transaction_timeout_is_504() {
    let response = handle(&Cause::postgres("25P03"));
    assert_eq!(response.status, StatusCode::GATEWAY_TIMEOUT);
    assert_kw(&response, "code", "idle-in-transaction-timeout");
    assert_eq!(
        field(&response, "hint").and_then(Value::as_str),
        Some("The transaction was idle too long and was cancelled")
    );
}

#[test]
fn postgres_errors_use_the_hint_table() {
    for (state, expected) in [
        ("23505", "A conflicting entry already exists"),
        ("23503", "The referenced item does not exist"),
        ("23502", "A required field is missing"),
        ("23514", "The value violates a data integrity constraint"),
        ("42P01", POSTGRES_DEFAULT_HINT),
    ] {
        let response = handle(&Cause::postgres(state));
        assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_kw(&response, "code", "database-error");
        assert_eq!(
            field(&response, "hint").and_then(Value::as_str),
            Some(expected),
            "state {state}"
        );
        assert_eq!(postgres_hint(state), expected);
    }
}

#[test]
fn io_exception_is_500() {
    let response = handle(&Cause::io("broken pipe"));
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body(&response).len(), 2);
    assert_kw(&response, "type", "server-error");
    assert_kw(&response, "code", "io-exception");
}

#[test]
fn an_exception_without_data_is_unexpected() {
    let response = handle(&Cause::other("index out of bounds"));
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body(&response).len(), 2);
    assert_kw(&response, "type", "server-error");
    assert_kw(&response, "code", "unexpected");
}

#[test]
fn an_empty_ex_data_map_is_unhandled_not_unexpected() {
    let response = handle(&Cause::error(data(&[])));
    assert_kw(&response, "code", "unhandled");
    assert_eq!(body(&response).len(), 2);
}

#[test]
fn wrapped_causes_are_unwrapped() {
    let cause = Cause::wrapped(Cause::wrapped(Cause::postgres("57014")));
    let response = handle(&cause);
    assert_eq!(response.status, StatusCode::GATEWAY_TIMEOUT);
    assert_kw(&response, "code", "statement-timeout");
}

#[test]
fn a_failed_transaction_prefers_the_handling_cause() {
    let error = ExError::new(data(&[("reason", kw("transaction"))]))
        .with_transaction(Cause::postgres("25P03"), Cause::io("connection closed"));
    let response = handle_error(&error);
    assert_eq!(response.status, StatusCode::GATEWAY_TIMEOUT);
    assert_kw(&response, "code", "idle-in-transaction-timeout");
}

#[test]
fn handle_exception_only_dispatches_exceptions() {
    let response = handle_exception(&Cause::postgres("23505"));
    assert_kw(&response, "code", "database-error");
}

#[test]
fn into_response_labels_verbose_transit() {
    let response = error(&[("type", kw("validation")), ("code", kw("invalid-image"))]);
    let encoded = transit::encode_verbose(response.body.as_ref().unwrap());
    assert!(
        encoded.starts_with(r#"{"~:type":"~:validation""#),
        "unexpected body: {encoded}"
    );

    let http = response.into_response();
    assert_eq!(http.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        http.headers()
            .get(header::CONTENT_TYPE)
            .map(|value| value.to_str().unwrap()),
        Some("application/transit+json")
    );
}

#[test]
fn error_type_and_code_round_trip() {
    for kind in [
        ErrorType::Authentication,
        ErrorType::Authorization,
        ErrorType::Restriction,
        ErrorType::RateLimit,
        ErrorType::ConcurrencyLimit,
        ErrorType::Validation,
        ErrorType::Assertion,
        ErrorType::NotFound,
        ErrorType::NitrateUnavailable,
        ErrorType::NitrateNotConfigured,
        ErrorType::Internal,
        ErrorType::ServerError,
    ] {
        assert_eq!(ErrorType::from_kw(kind.as_str()), Some(kind));
    }
    for code in [
        ErrorCode::MethodNotAllowed,
        ErrorCode::SpecValidation,
        ErrorCode::ParamsValidation,
        ErrorCode::SchemaValidation,
        ErrorCode::DataValidation,
        ErrorCode::VernConflict,
        ErrorCode::RequestBodyTooLarge,
        ErrorCode::InvalidImage,
        ErrorCode::Assertion,
        ErrorCode::Unhandled,
        ErrorCode::Unexpected,
        ErrorCode::StatementTimeout,
        ErrorCode::IdleInTransactionTimeout,
        ErrorCode::DatabaseError,
        ErrorCode::IoException,
    ] {
        assert_eq!(ErrorCode::from_kw(code.as_str()), Some(code));
    }
}
