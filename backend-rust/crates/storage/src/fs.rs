//! Filesystem object store.

use std::{collections::HashSet, path::PathBuf};

use async_trait::async_trait;
use uuid::Uuid;

use crate::{
    fs_object_path, fs_object_url, BackendKind, Content, ContentSource, ObjectStore, Result,
    StorageError, StorageObject, UrlOptions,
};

/// Filesystem backend rooted at one directory.
///
/// Blobs are written to a temporary file in the same directory and renamed
/// into place, replacing any existing blob atomically.
#[derive(Debug, Clone)]
pub struct FsStore {
    directory: PathBuf,
}

impl FsStore {
    /// Build a store for `directory`.
    ///
    /// Penpot configures an absolute directory (`/opt/data/objects`); the
    /// value is used as given, so a relative path resolves against the
    /// process working directory.
    #[must_use]
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
        }
    }

    /// Configured root directory.
    #[must_use]
    pub fn directory(&self) -> &std::path::Path {
        &self.directory
    }

    /// Absolute path for an object id.
    #[must_use]
    pub fn object_path(&self, id: Uuid) -> PathBuf {
        fs_object_path(&self.directory, id)
    }

    async fn write_temp(&self, path: &std::path::Path, content: &Content) -> Result<()> {
        match content.source() {
            ContentSource::Bytes(bytes) => tokio::fs::write(path, bytes)
                .await
                .map_err(|error| crate::error::io_error("write", path, &error)),
            ContentSource::File(source) => tokio::fs::copy(source, path)
                .await
                .map(|_| ())
                .map_err(|error| crate::error::io_error("copy", path, &error)),
        }
    }
}

#[async_trait]
impl ObjectStore for FsStore {
    fn backend_kind(&self) -> BackendKind {
        BackendKind::Fs
    }

    async fn put(&self, object: &StorageObject, content: &Content) -> Result<()> {
        let full = self.object_path(object.id);
        let parent = full
            .parent()
            .expect("UUID-derived object paths always have a parent");
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| crate::error::io_error("create-dir", parent, &error))?;

        let temp = parent.join(format!(".tmp-{}", Uuid::new_v4()));
        if let Err(error) = self.write_temp(&temp, content).await {
            let _ = tokio::fs::remove_file(&temp).await;
            return Err(error);
        }

        if let Err(error) = tokio::fs::rename(&temp, &full).await {
            let _ = tokio::fs::remove_file(&temp).await;
            return Err(crate::error::io_error("rename", &full, &error));
        }
        Ok(())
    }

    async fn exists(&self, id: Uuid) -> Result<bool> {
        let path = self.object_path(id);
        match tokio::fs::metadata(&path).await {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(crate::error::io_error("stat", &path, &error)),
        }
    }

    async fn get_bytes(&self, id: Uuid) -> Result<Vec<u8>> {
        let path = self.object_path(id);
        match tokio::fs::read(&path).await {
            Ok(bytes) => Ok(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Err(StorageError::ObjectNotFound(id))
            }
            Err(error) => Err(crate::error::io_error("read", &path, &error)),
        }
    }

    async fn url(&self, id: Uuid, _options: &UrlOptions) -> Result<String> {
        Ok(fs_object_url(&self.directory, id))
    }

    async fn delete(&self, id: Uuid) -> Result<()> {
        let path = self.object_path(id);
        match tokio::fs::remove_file(&path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(crate::error::io_error("delete", &path, &error)),
        }
    }

    async fn delete_bulk(&self, ids: &[Uuid]) -> Result<HashSet<Uuid>> {
        let mut failed = HashSet::new();
        for id in ids {
            let path = self.object_path(*id);
            if let Err(error) = tokio::fs::remove_file(&path).await {
                if error.kind() != std::io::ErrorKind::NotFound {
                    failed.insert(*id);
                }
            }
        }
        Ok(failed)
    }

    fn local_path(&self, id: Uuid) -> Option<PathBuf> {
        Some(self.object_path(id))
    }
}
