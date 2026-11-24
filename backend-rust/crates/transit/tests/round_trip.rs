//! Property tests over the codec (M1 `DoD`: "round-trip 1000 例").
//!
//! Two shapes are excluded from strict value equality because the wire format
//! cannot carry them, and that is a fact about transit rather than about this
//! port:
//!
//! * [`Value::Quoted`] — `~#'` is a *write-side hint*. transit-js's read handler
//!   for it is identity, so a quoted value decodes to the value itself. Pinning
//!   that is [`quoted_is_a_write_side_hint`].
//! * [`Value::Double`] whose shortest representation has no fraction or exponent
//!   (`3.0` prints as `3`) — JSON has no int/float split, so it comes back as
//!   [`Value::Integer`]. Pinning that is [`text_is_stable_under_reparse`].

use proptest::prelude::*;
use transit::{decode, encode, json::fmt_f64, PathData, Set, Value, Writer};

fn arb_uuid() -> impl Strategy<Value = uuid::Uuid> {
    any::<[u8; 16]>().prop_map(uuid::Uuid::from_bytes)
}

/// Values whose wire form is exactly themselves.
fn arb_exact(depth: u32) -> BoxedStrategy<Value> {
    if depth == 0 {
        return arb_exact_leaf();
    }
    let nested = arb_exact(depth - 1);
    prop_oneof![
        arb_exact_leaf(),
        prop::collection::vec(nested.clone(), 0..6).prop_map(Value::List),
        prop::collection::vec(nested.clone(), 0..6).prop_map(Value::Array),
        prop::collection::vec(nested.clone(), 0..6).prop_map(|items| {
            let mut set = Set::new();
            for item in items {
                set.insert(item);
            }
            Value::Set(set)
        }),
        prop::collection::vec(
            (
                prop_oneof![
                    ".{1,20}".prop_map(Value::Keyword),
                    ".{1,20}".prop_map(Value::Str),
                    arb_uuid().prop_map(Value::Uuid),
                ],
                nested.clone(),
            ),
            0..6,
        )
        .prop_map(|pairs| Value::Map(pairs.into_iter().collect())),
        prop::collection::vec((".{1,12}".prop_map(Value::Keyword), nested.clone()), 0..6)
            .prop_map(|pairs| Value::OrderedMap(pairs.into_iter().collect())),
        // `probe/…` keeps generated tags clear of the real handler table, where
        // `~#uri` or `~#list` would (correctly) reinterpret the rep.
        ".{1,8}"
            .prop_map(|t| format!("probe/{t}"))
            .prop_map(|tag| { Value::tagged(tag, Value::Nil) }),
        (arb_uuid().prop_map(Value::Uuid), nested.clone()).prop_map(|(id, meta)| Value::Pointer {
            id: Box::new(id),
            // A nil meta decodes as "no meta", so never generate one.
            meta: Some(Box::new(if meta.is_nil() {
                Value::Bool(false)
            } else {
                meta
            })),
        }),
        prop::collection::vec(any::<u8>(), 0..4).prop_map(|bytes| {
            Value::PathData(PathData::from_bytes(
                bytes
                    .into_iter()
                    .flat_map(|b| [b; PathData::SEGMENT_U8_SIZE])
                    .collect(),
            ))
        }),
    ]
    .boxed()
}

fn arb_exact_leaf() -> BoxedStrategy<Value> {
    prop_oneof![
        Just(Value::Nil),
        any::<bool>().prop_map(Value::Bool),
        any::<i64>().prop_map(Value::Integer),
        ".{0,40}".prop_map(Value::Keyword),
        ".{0,40}".prop_map(Value::Symbol),
        ".{0,60}".prop_map(Value::Str),
        prop::collection::vec(any::<u8>(), 0..40).prop_map(Value::Binary),
        arb_uuid().prop_map(Value::Uuid),
        any::<i64>().prop_map(Value::Instant),
        any::<i64>().prop_map(Value::Duration),
        ".{0,30}".prop_map(|s| Value::Uri(format!("https://example.com/{s}"))),
        ".{0,20}".prop_map(Value::BigInteger),
        ".{0,20}".prop_map(Value::BigDecimal),
        Just(Value::Special(transit::SpecialDouble::NotANumber)),
        any::<char>().prop_map(Value::Char),
    ]
    .boxed()
}

/// Everything `arb_exact` covers plus doubles, whose shortest form can be
/// integral and therefore decodes back as an integer.
fn arb_any(depth: u32) -> BoxedStrategy<Value> {
    prop_oneof![
        arb_exact(depth),
        any::<f64>().prop_map(|d| {
            let v = d / 3.0;
            Value::Double(if v.is_finite() { v } else { 0.5 })
        }),
    ]
    .boxed()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1000))]

    /// The invariant the milestone rests on: encode produces text the reader takes
    /// back to the same value.
    #[test]
    fn round_trip_preserves_the_value(value in arb_exact(3)) {
        let text = encode(&value);
        let back = decode(&text)?;
        prop_assert_eq!(&back, &value, "value changed through encode/decode: {}", text);
        let text2 = encode(&back);
        prop_assert_eq!(&text, &text2, "encode is not stable");
    }

    /// For the shapes the wire cannot carry exactly, the weaker but still
    /// load-bearing claim holds: the *text* is a fixed point, so a value that
    /// travels through two hops of backend does not keep drifting.
    #[test]
    fn text_is_stable_under_reparse(value in arb_any(3)) {
        let first = encode(&value);
        let back = decode(&first)?;
        let second = encode(&back);
        prop_assert_eq!(&first, &second, "second hop changed the bytes");
    }

    /// The referent cache is per document: `encode` clears it after each write,
    /// so a writer reused across one connection's answers must not leak cache
    /// codes from one document into the next.
    #[test]
    fn a_reused_writer_produces_identical_documents(value in arb_exact(3)) {
        let mut writer = Writer::new();
        let first = writer.encode(&value);
        let second = writer.encode(&value);
        prop_assert_eq!(&first, &second, "a reused writer drifted");
    }

    #[test]
    fn keywords_and_strings_never_collide(k in ".{1,20}", s in ".{1,20}") {
        let doc = Value::Map(
            vec![(Value::kw(&k), Value::Integer(1)), (Value::str(&s), Value::Integer(2))]
                .into_iter().collect(),
        );
        let text = encode(&doc);
        let back = decode(&text)?;
        prop_assert_eq!(&back, &doc, "keyword/string keys must stay distinguishable: {}", text);
    }

    #[test]
    fn vectors_and_arrays_never_collide(items in prop::collection::vec(any::<i64>(), 0..5)) {
        let values: Vec<Value> = items.into_iter().map(Value::Integer).collect();
        let vector = Value::List(values.clone());
        let array = Value::Array(values);
        let vt = encode(&vector);
        let at = encode(&array);
        prop_assert_ne!(decode(&vt)?, decode(&at)?, "`~#list` and a bare array collapsed");
        prop_assert!(matches!(decode(&vt)?, Value::List(_)));
        prop_assert!(matches!(decode(&at)?, Value::Array(_)));
    }

    /// Doubles print like `JSON.stringify`; when the shortest form is integral
    /// the value comes back as an integer, but the text never changes twice.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        clippy::float_cmp,
        reason = "a decoded Integer means the shortest form fit in i64; the check is on the f64 value"
    )]
    #[test]
    fn double_text_matches_js_formatting(d in any::<f64>()) {
        let v = d / 3.0;
        prop_assume!(v.is_finite() && v != 0.0);
        let doc = Value::Double(v);
        let text = encode(&doc);
        let back = decode(&text)?;
        let again = encode(&back);
        prop_assert_eq!(&text, &again, "double text drifted");
        if let Value::Integer(i) = &back {
            // Integral shortest form: the number text must carry no '.'/exponent.
            let body = fmt_f64(v);
            prop_assert!(!body.contains('.') && !body.contains('e'), "misread {} as integer", body);
            // JS prints the shortest decimal that round-trips, which can be a
            // neighbouring integer spelling of the exact f64 value.
            prop_assert_eq!(*i as f64, v, "integer value drifted");
        }
    }

    /// `~#'` only tells the writer to quote; reading it yields the payload.
    #[test]
    fn quoted_is_a_write_side_hint(value in arb_exact_leaf()) {
        let quoted = Value::quoted(value.clone());
        let text = encode(&quoted);
        prop_assert!(text.starts_with("[\"~#'\""), "expected a quoted doc, got {}", text);
        let back = decode(&text)?;
        prop_assert_eq!(&back, &value, "the quote wrapper must disappear on read");
    }
}
