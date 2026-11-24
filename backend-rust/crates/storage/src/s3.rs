//! S3-compatible object store built on `aws-sdk-s3`.
//!
//! Keys use the same UUID layout as the filesystem backend, with an optional
//! flat prefix. The default environment reader accepts both the current
//! `PENPOT_OBJECTS_STORAGE_S3_*` names and the legacy
//! `PENPOT_STORAGE_ASSETS_S3_*` names.

use std::collections::HashMap;

use async_trait::async_trait;
use aws_sdk_s3::{
    config::Region,
    error::DisplayErrorContext,
    primitives::ByteStream,
    types::{Delete, ObjectIdentifier},
    Client,
};
use uuid::Uuid;

use crate::{
    id_to_relative_path, BackendKind, Content, ContentSource, ObjectStore, Result, StorageError,
    StorageObject, UrlOptions,
};

/// S3 bucket, region, optional endpoint and key prefix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct S3Config {
    /// Bucket that holds object blobs.
    pub bucket: String,
    /// AWS region; defaults to `eu-central-1` like the Clojure backend.
    pub region: String,
    /// Custom endpoint for S3-compatible services.
    pub endpoint: Option<String>,
    /// Flat key prefix prepended to every UUID path.
    pub prefix: String,
}

impl S3Config {
    /// Build a config from Penpot environment variables.
    ///
    /// Returns `None` when no bucket is configured, matching the Clojure
    /// backend, which leaves the S3 backend unregistered in that case.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::Configuration`] when a bucket is set but empty.
    pub fn from_environment() -> Result<Option<Self>> {
        let bucket = env_first(&[
            "PENPOT_STORAGE_ASSETS_S3_BUCKET",
            "PENPOT_OBJECTS_STORAGE_S3_BUCKET",
        ]);
        let Some(bucket) = bucket else {
            return Ok(None);
        };
        if bucket.trim().is_empty() {
            return Err(StorageError::Configuration(
                "S3 bucket is configured but empty".to_owned(),
            ));
        }
        let region = env_first(&[
            "PENPOT_STORAGE_ASSETS_S3_REGION",
            "PENPOT_OBJECTS_STORAGE_S3_REGION",
        ])
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "eu-central-1".to_owned());
        let endpoint = env_first(&[
            "PENPOT_STORAGE_ASSETS_S3_ENDPOINT",
            "PENPOT_OBJECTS_STORAGE_S3_ENDPOINT",
        ])
        .filter(|value| !value.trim().is_empty());
        let prefix = env_first(&[
            "PENPOT_STORAGE_ASSETS_S3_PREFIX",
            "PENPOT_OBJECTS_STORAGE_S3_PREFIX",
        ])
        .unwrap_or_default();

        Ok(Some(Self {
            bucket,
            region,
            endpoint,
            prefix,
        }))
    }
}

/// S3 object store.
#[derive(Debug, Clone)]
pub struct S3Store {
    client: Client,
    config: S3Config,
}

impl S3Store {
    /// Build a store from an explicit config.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::Configuration`] when the bucket is empty.
    pub async fn new(config: S3Config) -> Result<Self> {
        if config.bucket.trim().is_empty() {
            return Err(StorageError::Configuration(
                "S3 bucket must not be empty".to_owned(),
            ));
        }

        let shared = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(Region::new(config.region.clone()))
            .load()
            .await;
        let mut builder = aws_sdk_s3::config::Builder::from(&shared);
        if let Some(endpoint) = &config.endpoint {
            builder = builder.endpoint_url(endpoint).force_path_style(true);
        }

        Ok(Self {
            client: Client::from_conf(builder.build()),
            config,
        })
    }

    /// Build a store from Penpot environment variables.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::Configuration`] when no bucket is configured or
    /// the configured bucket is empty.
    pub async fn from_environment() -> Result<Self> {
        let config = S3Config::from_environment()?
            .ok_or_else(|| StorageError::Configuration("no S3 bucket is configured".to_owned()))?;
        Self::new(config).await
    }

    /// Active config.
    #[must_use]
    pub fn config(&self) -> &S3Config {
        &self.config
    }

    /// Key for an object id.
    #[must_use]
    pub fn key(&self, id: Uuid) -> String {
        s3_key(&self.config.prefix, id)
    }

    async fn body(&self, id: Uuid, content: &Content) -> Result<ByteStream> {
        match content.source() {
            ContentSource::Bytes(bytes) => {
                Ok(ByteStream::from(bytes::Bytes::from_owner(bytes.clone())))
            }
            ContentSource::File(path) => ByteStream::from_path(path)
                .await
                .map_err(|error| backend_error("read-content", id, &error)),
        }
    }
}

#[async_trait]
impl ObjectStore for S3Store {
    fn backend_kind(&self) -> BackendKind {
        BackendKind::S3
    }

    async fn put(&self, object: &StorageObject, content: &Content) -> Result<()> {
        let body = self.body(object.id, content).await?;
        self.client
            .put_object()
            .bucket(&self.config.bucket)
            .key(self.key(object.id))
            .content_type(&object.metadata.content_type)
            .body(body)
            .send()
            .await
            .map(|_| ())
            .map_err(|error| backend_error("put", object.id, &DisplayErrorContext(&error)))
    }

    async fn exists(&self, id: Uuid) -> Result<bool> {
        match self
            .client
            .head_object()
            .bucket(&self.config.bucket)
            .key(self.key(id))
            .send()
            .await
        {
            Ok(_) => Ok(true),
            Err(error)
                if error.as_service_error().is_some_and(
                    aws_sdk_s3::operation::head_object::HeadObjectError::is_not_found,
                ) =>
            {
                Ok(false)
            }
            Err(error) => Err(backend_error("head", id, &DisplayErrorContext(&error))),
        }
    }

    async fn get_bytes(&self, id: Uuid) -> Result<Vec<u8>> {
        match self
            .client
            .get_object()
            .bucket(&self.config.bucket)
            .key(self.key(id))
            .send()
            .await
        {
            Ok(output) => output
                .body
                .collect()
                .await
                .map(|data| data.into_bytes().to_vec())
                .map_err(|error| backend_error("read-body", id, &error)),
            Err(error)
                if error.as_service_error().is_some_and(
                    aws_sdk_s3::operation::get_object::GetObjectError::is_no_such_key,
                ) =>
            {
                Err(StorageError::ObjectNotFound(id))
            }
            Err(error) => Err(backend_error("get", id, &DisplayErrorContext(&error))),
        }
    }

    async fn url(&self, id: Uuid, options: &UrlOptions) -> Result<String> {
        let presigning_config =
            aws_sdk_s3::presigning::PresigningConfig::expires_in(options.max_age)
                .map_err(|error| backend_error("presign-config", id, &error))?;
        let mut request = self
            .client
            .get_object()
            .bucket(&self.config.bucket)
            .key(self.key(id));
        if let Some(disposition) = &options.content_disposition {
            request = request.response_content_disposition(disposition);
        }
        let presigned = request
            .presigned(presigning_config)
            .await
            .map_err(|error| backend_error("presign", id, &DisplayErrorContext(&error)))?;
        Ok(presigned.uri().to_owned())
    }

    async fn delete(&self, id: Uuid) -> Result<()> {
        match self
            .client
            .delete_object()
            .bucket(&self.config.bucket)
            .key(self.key(id))
            .send()
            .await
        {
            Ok(_) => Ok(()),
            Err(error) => Err(backend_error("delete", id, &DisplayErrorContext(&error))),
        }
    }

    async fn delete_bulk(&self, ids: &[Uuid]) -> Result<std::collections::HashSet<Uuid>> {
        let mut failed = std::collections::HashSet::new();
        for chunk in ids.chunks(S3_DELETE_BATCH) {
            let mut key_to_id = HashMap::with_capacity(chunk.len());
            let mut objects = Vec::with_capacity(chunk.len());
            for id in chunk {
                let key = self.key(*id);
                key_to_id.insert(key.clone(), *id);
                objects.push(
                    ObjectIdentifier::builder()
                        .key(key)
                        .build()
                        .map_err(|error| backend_error("delete-bulk-key", *id, &error))?,
                );
            }
            let delete = Delete::builder()
                .set_objects(Some(objects))
                .build()
                .map_err(|error| backend_error("delete-bulk-request", Uuid::nil(), &error))?;
            let Ok(output) = self
                .client
                .delete_objects()
                .bucket(&self.config.bucket)
                .delete(delete)
                .send()
                .await
            else {
                // A request-level failure leaves every key in the chunk
                // unverified, which the collector treats as a failed delete.
                failed.extend(chunk.iter().copied());
                continue;
            };
            for error in output.errors() {
                if let Some(id) = error.key.as_deref().and_then(|key| key_to_id.get(key)) {
                    failed.insert(*id);
                }
            }
        }
        Ok(failed)
    }
}

/// S3 accepts at most 1000 keys per `DeleteObjects` request.
const S3_DELETE_BATCH: usize = 1000;

/// Key for an object id: the prefix is concatenated literally, then the
/// shared UUID path follows.
#[must_use]
pub fn s3_key(prefix: &str, id: Uuid) -> String {
    format!("{prefix}{}", id_to_relative_path(id))
}

fn env_first(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| std::env::var(name).ok())
}

fn backend_error(
    operation: &'static str,
    object_id: Uuid,
    error: &impl std::fmt::Display,
) -> StorageError {
    StorageError::Backend {
        operation,
        object_id,
        message: error.to_string(),
    }
}
