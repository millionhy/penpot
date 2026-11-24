//! Malformed input must produce a structured error, never a panic and never an
//! infinite loop (M1 `DoD`: "畸形输入返回结构化错误、零 panic").

use transit::{decode, Value};

fn fails(input: &str) -> String {
    match decode(input) {
        Ok(v) => panic!("expected an error for {input:?}, got {v:?}"),
        Err(e) => e.to_string(),
    }
}

fn ok(input: &str) -> Value {
    decode(input).unwrap_or_else(|e| panic!("expected {input:?} to decode, got {e}"))
}

#[test]
fn truncated_json_is_an_error() {
    for input in [
        "",
        "  ",
        "[",
        "[\"^ \"",
        "[\"^ \",\"~:a\"",
        "[\"^ \",\"~:a\",",
        "[\"~#list\"",
        "\"unterminated",
        "[1,",
        "{\"a\"",
        "{\"a\":",
        "nul",
        "tru",
        "[1] extra",
        "[1][2]",
    ] {
        let _ = fails(input);
    }
}

#[test]
fn invalid_json_structures_are_errors() {
    // A map with an odd number of entries after the marker.
    let msg = fails("[\"^ \",\"~:a\",1,\"~:b\"]");
    assert!(msg.contains("even number"), "unexpected message: {msg}");

    // `~#with-meta` needs [value, meta].
    let msg = fails("[\"~#with-meta\",[1]]");
    assert!(msg.contains("with-meta"), "unexpected message: {msg}");

    // `~#ordered-map` needs a flat, even array.
    let msg = fails("[\"~#ordered-map\",[\"~:a\"]]");
    assert!(msg.contains("even"), "unexpected message: {msg}");

    // `~#cmap` uses the same flat, even array.
    let msg = fails("[\"~#cmap\",[\"~#list\",[[1,2],\"x\",3]]]");
    assert!(msg.contains("even"), "unexpected message: {msg}");

    // A set rep has to be an array.
    let msg = fails("[\"~#set\",1]");
    assert!(msg.contains("array"), "unexpected message: {msg}");

    // `~#penpot/objects-map/v2` has to be a map.
    let msg = fails("[\"~#penpot/objects-map/v2\",[1,2]]");
    assert!(msg.contains("map"), "unexpected message: {msg}");
}

#[test]
fn bad_scalar_reps_degrade_instead_of_panicking() {
    // An unparsable UUID / instant / double falls back to a tagged value holding
    // the offending rep, so the caller can still see what arrived.
    let v = ok("\"~u.not-a-uuid\"");
    assert_eq!(v.tag(), Some("u"), "expected the raw rep kept: {v:?}");

    let v = ok("\"~m.not-millis\"");
    assert_eq!(v.tag(), Some("m"));

    // Bad base64 keeps the rep rather than guessing at bytes.
    let v = ok("\"~b!!!!\"");
    assert_eq!(v.tag(), Some("b"));

    // A verbose tagged UUID with a non-string rep is a hard error.
    let msg = fails("[\"~#uuid\",1]");
    assert!(msg.contains("string"), "unexpected message: {msg}");
}

#[test]
fn hostile_nesting_is_refused_not_crashed() {
    // 5000 levels of nested arrays: serde_json refuses to build the tree.
    let deep = format!("{}{}", "[".repeat(5000), "]".repeat(5000));
    let msg = fails(&deep);
    assert!(
        msg.contains("recursion") || msg.contains("depth") || msg.contains("nest"),
        "expected a depth error, got: {msg}"
    );

    // A depth just under the cap must still work.
    let ok_deep = format!("{}{}", "[".repeat(40), "]".repeat(40));
    let _ = ok(&ok_deep);
}

#[test]
fn weird_but_valid_input_decodes_to_something() {
    // These come from hostile producers or hand-edged wire shapes; none of them
    // may panic, and each keeps the tag name it carried.
    let _ = ok("\"~\"");
    let _ = ok("[\"^ \",\"^\",1]");
    let _ = ok("[\"^ \",\"^^\",1]");
    let _ = ok("[\"~#\",1]");
    let _ = ok("\"~#\"");
    let _ = ok("\"~~~\"");
    let _ = ok("[\"~#list\",[\"~#list\",[\"~#list\",[]]]]");
    let _ = ok("[\"^ \",\"a\",\"~:b\"]");
    let _ = ok("[1,2,3,4,5,6,7,8,9,10]");
    let _ = ok("[\"^ \",\"~:a\",[\"^ \",\"~:a\",[\"^ \"]]]");
    let _ = ok("99999999999999999999999999999");
    let _ = ok("-18446744073709551615");
    let _ = ok("[\"~#set\",[1,1,1,1]]");
    let _ = ok("[\"~#cmap\",[\"~#list\",[[1,2],\"x\"]]]");
    // A pointer needs [id, meta]; an empty array is malformed, not a pointer.
    let _ = fails("[\"~#penpot/pointer\",[]]");
    let _ = ok("[\"~#penpot/path-data\",\"~bAA\"]");
    let _ = ok("[\"~#penpot/objects-map/v2\",[\"^ \",\"~:a\",\"[\\\"~#shape\\\",[\\\"^ \\\"]]\"]]");
    // Raw control characters are not valid inside a JSON string.
    let _ = fails("\"\u{001f} raw control inside a string\"");
    let _ = ok("[\"~#'\",\"~#'\",\"~:a\"]");
}

#[test]
fn unicode_edge_cases_do_not_panic() {
    // Rust strings cannot hold an unpaired surrogate, so the JSON parser
    // rejects it. The contract here is a structured error, not a panic.
    let _ = fails("\"a\\ud800b\"");
    let _ = ok("\"\\ud83d\\ude00\""); // paired emoji
    let _ = ok("\"\\u0000\"");
    let _ = fails("\"\\uXYZW\"");
    let _ = fails("\"\\u00\"");
}

#[test]
fn whitespace_and_separators_are_tolerated_like_json() {
    assert_eq!(ok(" [ 1 , 2 ] "), ok("[1,2]"));
    assert!(matches!(ok(" null "), Value::Nil));
}
