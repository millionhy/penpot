use std::{io::Cursor, path::Path};

use storage::{
    calculate_hash, calculate_hash_bytes, calculate_hash_reader, fs_object_url, fs_redirect_path,
    id_to_relative_path,
};
use uuid::Uuid;

#[test]
fn uuid_path_matches_the_clojure_byte_layout() {
    let id = Uuid::parse_str("00010203-0405-0607-0809-0a0b0c0d0e0f").unwrap();

    assert_eq!(
        id_to_relative_path(id),
        "00/01/02030405060708090a0b0c0d0e0f"
    );
}

#[test]
fn blake2b_256_matches_an_independent_digest() {
    assert_eq!(
        calculate_hash_bytes(b"content"),
        "blake2b:2d49316473cb68324b3f807c6d88c5618f6a422801f52ee3f6b3c29784504fc0"
    );
    assert_eq!(
        calculate_hash_bytes(b""),
        "blake2b:0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8"
    );
}

#[test]
fn hash_reader_and_cursor_match_byte_slice_hashing() {
    let expected = calculate_hash_bytes(b"hello");
    assert_eq!(
        calculate_hash_reader(Cursor::new(b"hello")).unwrap(),
        expected
    );
    assert!(calculate_hash(Path::new("tests/no-such-file")).is_err());
}

#[test]
fn fs_object_url_adds_one_separator() {
    let id = Uuid::parse_str("00010203-0405-0607-0809-0a0b0c0d0e0f").unwrap();
    let relative = "00/01/02030405060708090a0b0c0d0e0f";

    assert_eq!(
        fs_object_url(Path::new("/srv/penpot/assets"), id),
        format!("file:///srv/penpot/assets/{relative}")
    );
    assert_eq!(
        fs_object_url(Path::new("/srv/penpot/assets/"), id),
        format!("file:///srv/penpot/assets/{relative}")
    );
    assert_eq!(
        fs_redirect_path(Path::new("/srv/penpot/assets"), id),
        format!("/srv/penpot/assets/{relative}")
    );
}
