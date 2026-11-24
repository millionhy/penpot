//! Object content and Penpot's BLAKE2b-256 content hash.

use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};

use blake2::{
    digest::{consts::U32, Digest},
    Blake2b,
};

use crate::{Result, StorageError};

/// Prefix used by every Penpot content hash.
pub const HASH_PREFIX: &str = "blake2b:";

/// Bytes or a file that can be written to an object store.
#[derive(Debug, Clone)]
pub enum ContentSource {
    /// In-memory bytes.
    Bytes(Arc<[u8]>),
    /// A file that is read at write time.
    File(PathBuf),
}

/// Blob content plus an optional caller-supplied hash.
#[derive(Debug, Clone)]
pub struct Content {
    source: ContentSource,
    precomputed_hash: Option<String>,
}

impl Content {
    /// Build content from owned bytes.
    #[must_use]
    pub fn bytes(bytes: Vec<u8>) -> Self {
        Self {
            source: ContentSource::Bytes(Arc::from(bytes)),
            precomputed_hash: None,
        }
    }

    /// Build content from a string's UTF-8 bytes.
    #[must_use]
    pub fn text(text: impl Into<String>) -> Self {
        Self::bytes(text.into().into_bytes())
    }

    /// Build content backed by a file.
    #[must_use]
    pub fn from_path(path: impl Into<PathBuf>) -> Self {
        Self {
            source: ContentSource::File(path.into()),
            precomputed_hash: None,
        }
    }

    /// Attach a caller-calculated hash (`wrap-with-hash`).
    #[must_use]
    pub fn with_hash(mut self, hash: impl Into<String>) -> Self {
        self.precomputed_hash = Some(hash.into());
        self
    }

    /// The caller-supplied hash, when present.
    #[must_use]
    pub fn precomputed_hash(&self) -> Option<&str> {
        self.precomputed_hash.as_deref()
    }

    /// The content byte source.
    #[must_use]
    pub fn source(&self) -> &ContentSource {
        &self.source
    }

    /// Byte length.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::Io`] if a file cannot be inspected.
    pub fn size(&self) -> Result<i64> {
        match &self.source {
            ContentSource::Bytes(bytes) => i64::try_from(bytes.len())
                .map_err(|_| StorageError::ContentHash("content is too large".to_owned())),
            ContentSource::File(path) => {
                let length = std::fs::metadata(path)
                    .map_err(|error| crate::error::io_error("stat", path, &error))?
                    .len();
                i64::try_from(length)
                    .map_err(|_| StorageError::ContentHash("content is too large".to_owned()))
            }
        }
    }

    /// Read the full content.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::Io`] when a file cannot be read.
    pub fn read_bytes(&self) -> Result<Vec<u8>> {
        match &self.source {
            ContentSource::Bytes(bytes) => Ok(bytes.to_vec()),
            ContentSource::File(path) => {
                std::fs::read(path).map_err(|error| crate::error::io_error("read", path, &error))
            }
        }
    }

    /// Return the precomputed hash or calculate it now.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] when the file cannot be read or the hasher
    /// cannot be initialized.
    pub fn hash(&self) -> Result<String> {
        if let Some(hash) = &self.precomputed_hash {
            return Ok(hash.clone());
        }
        match &self.source {
            ContentSource::Bytes(bytes) => Ok(calculate_hash_bytes(bytes)),
            ContentSource::File(path) => calculate_hash(path),
        }
    }
}

/// Calculate the Penpot hash for a byte slice.
#[must_use]
pub fn calculate_hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Blake2b::<U32>::new();
    hasher.update(bytes);
    format!("{HASH_PREFIX}{}", hex::encode(hasher.finalize()))
}

/// Calculate the Penpot hash from a reader.
///
/// # Errors
///
/// Returns [`StorageError::ContentHash`] when the reader fails.
pub fn calculate_hash_reader(mut reader: impl Read) -> Result<String> {
    let mut hasher = Blake2b::<U32>::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| StorageError::ContentHash(error.to_string()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{HASH_PREFIX}{}", hex::encode(hasher.finalize())))
}

/// Calculate the Penpot hash for a file.
///
/// # Errors
///
/// Returns [`StorageError::Io`] when the file cannot be opened or read.
pub fn calculate_hash(path: &Path) -> Result<String> {
    let file = File::open(path).map_err(|error| crate::error::io_error("open", path, &error))?;
    calculate_hash_reader(file)
}
