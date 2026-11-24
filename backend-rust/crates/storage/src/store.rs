//! Physical object-store boundary.

use std::{collections::HashSet, path::PathBuf, time::Duration};

use async_trait::async_trait;
use uuid::Uuid;

use crate::{BackendKind, Content, Result, StorageObject};

/// Presigned URL options.
#[derive(Debug, Clone)]
pub struct UrlOptions {
    /// URL lifetime.
    pub max_age: Duration,
    /// Signed response disposition.
    pub content_disposition: Option<String>,
}

impl Default for UrlOptions {
    fn default() -> Self {
        Self {
            max_age: Duration::from_mins(10),
            content_disposition: None,
        }
    }
}

/// Binary storage implementation.
#[async_trait]
pub trait ObjectStore: Send + Sync {
    /// Physical backend kind.
    fn backend_kind(&self) -> BackendKind;

    /// Write a blob under the object id.
    async fn put(&self, object: &StorageObject, content: &Content) -> Result<()>;

    /// Probe whether the blob exists.
    async fn exists(&self, id: Uuid) -> Result<bool>;

    /// Read the whole blob.
    async fn get_bytes(&self, id: Uuid) -> Result<Vec<u8>>;

    /// Produce a browser-facing URL.
    async fn url(&self, id: Uuid, options: &UrlOptions) -> Result<String>;

    /// Delete one blob. A missing blob is success.
    async fn delete(&self, id: Uuid) -> Result<()>;

    /// Delete many blobs and return the ids whose deletion failed.
    async fn delete_bulk(&self, ids: &[Uuid]) -> Result<HashSet<Uuid>>;

    /// Local path for filesystem-backed objects.
    fn local_path(&self, _id: Uuid) -> Option<PathBuf> {
        None
    }
}
