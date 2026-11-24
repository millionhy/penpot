//! UUID-derived object paths shared by the filesystem and S3 backends.

use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::StorageObject;

/// `app.storage.impl/id->path`: two directory fragments, then fourteen name fragments.
#[must_use]
pub fn id_to_relative_path(id: Uuid) -> String {
    let hex = hex::encode(id.as_bytes());
    format!("{}/{}/{}", &hex[0..2], &hex[2..4], &hex[4..])
}

/// Relative path for a logical object.
#[must_use]
pub fn object_to_relative_path(object: &StorageObject) -> String {
    id_to_relative_path(object.id)
}

/// Absolute filesystem path for an object.
#[must_use]
pub fn fs_object_path(directory: &Path, id: Uuid) -> PathBuf {
    directory.join(id_to_relative_path(id))
}

/// `file://` URL used by `get-object-url` for the filesystem backend.
#[must_use]
pub fn fs_object_url(directory: &Path, id: Uuid) -> String {
    let base = slash_path(directory);
    let separator = if base.ends_with('/') { "" } else { "/" };
    let prefix = if base.starts_with('/') {
        "file://"
    } else {
        "file:///"
    };
    format!("{prefix}{base}{separator}{}", id_to_relative_path(id))
}

/// Path value registered for `x-accel-redirect`; the HTTP layer is not wired here.
#[must_use]
pub fn fs_redirect_path(directory: &Path, id: Uuid) -> String {
    let base = slash_path(directory);
    let separator = if base.ends_with('/') { "" } else { "/" };
    format!("{base}{separator}{}", id_to_relative_path(id))
}

fn slash_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
