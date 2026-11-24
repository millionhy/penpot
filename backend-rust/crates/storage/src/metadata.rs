//! Closed `storage_object.metadata` schema and its two wire encodings.

use std::collections::BTreeSet;

use serde_json::{Map as JsonMap, Value as JsonValue};
use uuid::Uuid;

use crate::{Result, StorageError};

/// Historical fallback bucket.
pub const DEFAULT_BUCKET: &str = "file-media-object";
/// Temporary export/download bucket.
pub const TEMPFILE_BUCKET: &str = "tempfile";
/// Chunked-upload chunk bucket.
pub const UPLOAD_SESSION_BUCKET: &str = "upload-session";

const BUCKET: &str = "bucket";
const CONTENT_TYPE: &str = "content-type";
const HASH: &str = "hash";
const PROFILE_ID: &str = "profile-id";
const ORGANIZATION_ID: &str = "organization-id";
const FILE_ID: &str = "file-id";
const ID: &str = "id";
const REFERENCE: &str = "reference";
const UPLOAD_ID: &str = "upload-id";
const CHUNK_INDEX: &str = "chunk-index";

/// One canonical Penpot logical bucket.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Bucket {
    /// Original file images and media thumbnails.
    FileMediaObject,
    /// Team font variants.
    TeamFontVariant,
    /// Frame and component thumbnails.
    FileObjectThumbnail,
    /// File-grid thumbnails.
    FileThumbnail,
    /// Profile and team photos.
    Profile,
    /// Organization logos.
    Organization,
    /// Temporary export/download files.
    Tempfile,
    /// Chunked-upload chunks.
    UploadSession,
    /// Encoded file-data blobs.
    FileData,
    /// Compatibility bucket for file-data fragments.
    FileDataFragment,
    /// Compatibility bucket for file changes.
    FileChange,
}

impl Bucket {
    /// Every canonical bucket, in the order used by `bucket-requirements`.
    pub const ALL: &'static [Self] = &[
        Self::FileMediaObject,
        Self::TeamFontVariant,
        Self::FileObjectThumbnail,
        Self::FileThumbnail,
        Self::Profile,
        Self::Organization,
        Self::Tempfile,
        Self::UploadSession,
        Self::FileData,
        Self::FileDataFragment,
        Self::FileChange,
    ];

    /// Canonical string spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FileMediaObject => DEFAULT_BUCKET,
            Self::TeamFontVariant => "team-font-variant",
            Self::FileObjectThumbnail => "file-object-thumbnail",
            Self::FileThumbnail => "file-thumbnail",
            Self::Profile => "profile",
            Self::Organization => "organization",
            Self::Tempfile => TEMPFILE_BUCKET,
            Self::UploadSession => UPLOAD_SESSION_BUCKET,
            Self::FileData => "file-data",
            Self::FileDataFragment => "file-data-fragment",
            Self::FileChange => "file-change",
        }
    }

    /// Parse a canonical bucket name.
    #[must_use]
    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|bucket| bucket.as_str() == name)
    }

    /// Extra metadata keys required by this bucket.
    #[must_use]
    pub fn requirements(self) -> &'static [&'static str] {
        match self {
            Self::Organization => &[ORGANIZATION_ID],
            Self::FileData => &[FILE_ID, ID],
            _ => &[],
        }
    }

    /// Direct `/assets/by-id` access policy.
    #[must_use]
    pub fn access(self, link_preview_enabled: bool) -> AssetAccess {
        match self {
            Self::FileMediaObject
            | Self::FileObjectThumbnail
            | Self::TeamFontVariant
            | Self::FileDataFragment
            | Self::Organization => AssetAccess::Public,
            Self::FileThumbnail if link_preview_enabled => AssetAccess::Public,
            _ => AssetAccess::Authenticated,
        }
    }

    fn deduplicable(self) -> bool {
        !matches!(self, Self::Tempfile | Self::UploadSession)
    }
}

impl std::fmt::Display for Bucket {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Whether direct object access needs a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetAccess {
    /// The bucket can be served without authentication.
    Public,
    /// A session or access token is required.
    Authenticated,
}

/// Wire family used for `storage_object.metadata`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MetadataEncoding {
    /// Legacy Transit JSON verbose.
    #[default]
    Transit,
    /// Plain JSON.
    Json,
}

/// Validated, normalized storage metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageMetadata {
    /// Logical object bucket.
    pub bucket: Bucket,
    /// Blob MIME type.
    pub content_type: String,
    /// Content hash, when already known.
    pub hash: Option<String>,
    /// Owner profile for temporary objects.
    pub profile_id: Option<Uuid>,
    /// Organization owner.
    pub organization_id: Option<Uuid>,
    /// File-data owner.
    pub file_id: Option<Uuid>,
    /// File-data row id.
    pub id: Option<Uuid>,
}

impl StorageMetadata {
    /// Build metadata with the two required fields.
    #[must_use]
    pub fn new(bucket: Bucket, content_type: impl Into<String>) -> Self {
        Self {
            bucket,
            content_type: content_type.into(),
            hash: None,
            profile_id: None,
            organization_id: None,
            file_id: None,
            id: None,
        }
    }

    /// Set the content hash.
    #[must_use]
    pub fn with_hash(mut self, hash: impl Into<String>) -> Self {
        self.hash = Some(hash.into());
        self
    }

    /// Set the temporary-object owner.
    #[must_use]
    pub fn with_profile_id(mut self, profile_id: Uuid) -> Self {
        self.profile_id = Some(profile_id);
        self
    }

    /// Set the organization logo owner.
    #[must_use]
    pub fn with_organization_id(mut self, organization_id: Uuid) -> Self {
        self.organization_id = Some(organization_id);
        self
    }

    /// Set the file-data owner.
    #[must_use]
    pub fn with_file_id(mut self, file_id: Uuid) -> Self {
        self.file_id = Some(file_id);
        self
    }

    /// Set the file-data row id.
    #[must_use]
    pub fn with_id(mut self, id: Uuid) -> Self {
        self.id = Some(id);
        self
    }

    /// Validate the per-bucket required keys.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::InvalidMetadata`] when a required UUID is absent.
    pub fn validate(&self) -> Result<()> {
        match self.bucket {
            Bucket::Organization if self.organization_id.is_none() => {
                return missing_requirement(self.bucket, ORGANIZATION_ID);
            }
            Bucket::FileData if self.file_id.is_none() => {
                return missing_requirement(self.bucket, FILE_ID);
            }
            Bucket::FileData if self.id.is_none() => {
                return missing_requirement(self.bucket, ID);
            }
            _ => {}
        }
        Ok(())
    }

    /// Encode metadata in the requested family.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::InvalidMetadata`] when a bucket requirement is missing.
    pub fn encode(&self, encoding: MetadataEncoding) -> Result<String> {
        self.validate()?;
        Ok(match encoding {
            MetadataEncoding::Transit => encode_transit(self),
            MetadataEncoding::Json => encode_json(self),
        })
    }

    /// Decode either the legacy Transit verbose form or plain JSON.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::InvalidMetadata`] for malformed input, unknown
    /// keys or a missing bucket requirement.
    pub fn decode(raw: &str) -> Result<Self> {
        let metadata = if is_transit_encoded(raw) {
            decode_transit(raw)?
        } else {
            decode_json(raw)?
        };
        metadata.validate()?;
        Ok(metadata)
    }

    /// Decode an optional database value.
    ///
    /// # Errors
    ///
    /// Same as [`StorageMetadata::decode`].
    pub fn decode_optional(raw: Option<&str>) -> Result<Option<Self>> {
        raw.map(Self::decode).transpose()
    }

    /// True when this bucket may participate in hash deduplication.
    #[must_use]
    pub fn is_deduplicable(&self) -> bool {
        self.bucket.deduplicable()
    }
}

/// Legacy rows are Transit JSON verbose, whose first key is a keyword.
#[must_use]
pub fn is_transit_encoded(raw: &str) -> bool {
    raw.trim_start().starts_with("{\"~:")
}

fn missing_requirement<T>(bucket: Bucket, key: &str) -> Result<T> {
    Err(StorageError::InvalidMetadata {
        message: format!("bucket {bucket} is missing required key {key}"),
    })
}

fn invalid(message: impl Into<String>) -> StorageError {
    StorageError::InvalidMetadata {
        message: message.into(),
    }
}

fn encode_json(metadata: &StorageMetadata) -> String {
    let mut map = JsonMap::new();
    map.insert(
        BUCKET.to_owned(),
        JsonValue::String(metadata.bucket.to_string()),
    );
    map.insert(
        CONTENT_TYPE.to_owned(),
        JsonValue::String(metadata.content_type.clone()),
    );
    insert_json_optional(&mut map, HASH, metadata.hash.as_deref());
    insert_json_uuid(&mut map, PROFILE_ID, metadata.profile_id);
    insert_json_uuid(&mut map, ORGANIZATION_ID, metadata.organization_id);
    insert_json_uuid(&mut map, FILE_ID, metadata.file_id);
    insert_json_uuid(&mut map, ID, metadata.id);
    JsonValue::Object(map).to_string()
}

fn insert_json_optional(map: &mut JsonMap<String, JsonValue>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        map.insert(key.to_owned(), JsonValue::String(value.to_owned()));
    }
}

fn insert_json_uuid(map: &mut JsonMap<String, JsonValue>, key: &str, value: Option<Uuid>) {
    if let Some(value) = value {
        map.insert(key.to_owned(), JsonValue::String(value.to_string()));
    }
}

fn encode_transit(metadata: &StorageMetadata) -> String {
    use transit::{Map, Value};

    let mut map = Map::new();
    map.insert(Value::kw(BUCKET), Value::str(metadata.bucket.as_str()));
    map.insert(
        Value::kw(CONTENT_TYPE),
        Value::str(metadata.content_type.clone()),
    );
    insert_transit_str(&mut map, HASH, metadata.hash.as_deref());
    insert_transit_uuid(&mut map, PROFILE_ID, metadata.profile_id);
    insert_transit_uuid(&mut map, ORGANIZATION_ID, metadata.organization_id);
    insert_transit_uuid(&mut map, FILE_ID, metadata.file_id);
    insert_transit_uuid(&mut map, ID, metadata.id);
    transit::encode_verbose(&Value::Map(map))
}

fn insert_transit_str(map: &mut transit::Map, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        map.insert(transit::Value::kw(key), transit::Value::str(value));
    }
}

fn insert_transit_uuid(map: &mut transit::Map, key: &str, value: Option<Uuid>) {
    if let Some(value) = value {
        map.insert(transit::Value::kw(key), transit::Value::Uuid(value));
    }
}

fn decode_json(raw: &str) -> Result<StorageMetadata> {
    let value: JsonValue =
        serde_json::from_str(raw).map_err(|error| invalid(format!("invalid JSON: {error}")))?;
    let JsonValue::Object(mut map) = value else {
        return Err(invalid("expected a JSON object"));
    };

    let bucket = normalize_json_bucket(&mut map)?;
    let content_type = required_json_string(&map, CONTENT_TYPE)?.to_owned();

    let metadata = StorageMetadata {
        bucket,
        content_type,
        hash: optional_json_string(&map, HASH)?,
        profile_id: optional_json_uuid(&map, PROFILE_ID)?,
        organization_id: optional_json_uuid(&map, ORGANIZATION_ID)?,
        file_id: optional_json_uuid(&map, FILE_ID)?,
        id: optional_json_uuid(&map, ID)?,
    };
    reject_unknown_json_keys(&map)?;
    Ok(metadata)
}

fn decode_transit(raw: &str) -> Result<StorageMetadata> {
    let value = transit::decode(raw)
        .map_err(|error| invalid(format!("invalid transit metadata: {error}")))?;
    let entries = transit_entries(&value)?;
    let bucket = normalize_transit_bucket(&entries)?;
    let content_type = required_transit_string(&entries, CONTENT_TYPE)?.to_owned();

    let metadata = StorageMetadata {
        bucket,
        content_type,
        hash: optional_transit_string(&entries, HASH)?,
        profile_id: optional_transit_uuid(&entries, PROFILE_ID)?,
        organization_id: optional_transit_uuid(&entries, ORGANIZATION_ID)?,
        file_id: optional_transit_uuid(&entries, FILE_ID)?,
        id: optional_transit_uuid(&entries, ID)?,
    };
    reject_unknown_transit_keys(&entries)?;
    Ok(metadata)
}

fn normalize_json_bucket(map: &mut JsonMap<String, JsonValue>) -> Result<Bucket> {
    let mut bucket = match map.remove(BUCKET) {
        Some(value) => json_bucket_value(value)?,
        None => String::new(),
    };
    let reference = map.remove(REFERENCE);
    if bucket.is_empty() {
        if let Some(value) = reference {
            bucket = json_bucket_value(value)?;
        }
    }
    map.remove(UPLOAD_ID);
    map.remove(CHUNK_INDEX);
    if bucket.is_empty() {
        DEFAULT_BUCKET.clone_into(&mut bucket);
    }
    parse_bucket(&bucket)
}

fn json_bucket_value(value: JsonValue) -> Result<String> {
    match value {
        JsonValue::String(value) => Ok(value),
        JsonValue::Object(mut map) => {
            let Some(JsonValue::String(name)) = map.remove("~:name") else {
                return Err(invalid("bucket must be a string or keyword"));
            };
            Ok(name)
        }
        _ => Err(invalid("bucket must be a string or keyword")),
    }
}

fn normalize_transit_bucket(entries: &[(String, transit::Value)]) -> Result<Bucket> {
    let mut bucket = optional_transit_bucket(entries, BUCKET)?.unwrap_or_default();
    if bucket.is_empty() {
        bucket = optional_transit_bucket(entries, REFERENCE)?.unwrap_or_default();
    }
    if bucket.is_empty() {
        DEFAULT_BUCKET.clone_into(&mut bucket);
    }
    parse_bucket(&bucket)
}

fn parse_bucket(name: &str) -> Result<Bucket> {
    Bucket::from_name(name).ok_or_else(|| invalid(format!("unknown storage bucket {name}")))
}

fn transit_entries(value: &transit::Value) -> Result<Vec<(String, transit::Value)>> {
    let Some(map) = value.as_map() else {
        return Err(invalid("expected a map in storage metadata"));
    };
    map.iter()
        .map(|(key, value)| {
            let key = match key {
                transit::Value::Keyword(key) | transit::Value::Str(key) => key.clone(),
                _ => return Err(invalid("metadata keys must be strings or keywords")),
            };
            Ok((key, value.clone()))
        })
        .collect()
}

fn required_json_string<'a>(map: &'a JsonMap<String, JsonValue>, key: &str) -> Result<&'a str> {
    map.get(key)
        .and_then(JsonValue::as_str)
        .ok_or_else(|| invalid(format!("{key} must be a string")))
}

fn optional_json_string(map: &JsonMap<String, JsonValue>, key: &str) -> Result<Option<String>> {
    match map.get(key) {
        None => Ok(None),
        Some(JsonValue::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(invalid(format!("{key} must be a string"))),
    }
}

fn optional_json_uuid(map: &JsonMap<String, JsonValue>, key: &str) -> Result<Option<Uuid>> {
    match map.get(key) {
        None => Ok(None),
        Some(JsonValue::String(value)) => Uuid::parse_str(value)
            .map(Some)
            .map_err(|_| invalid(format!("{key} must be a UUID"))),
        Some(_) => Err(invalid(format!("{key} must be a UUID"))),
    }
}

fn reject_unknown_json_keys(map: &JsonMap<String, JsonValue>) -> Result<()> {
    let known = BTreeSet::from([CONTENT_TYPE, HASH, PROFILE_ID, ORGANIZATION_ID, FILE_ID, ID]);
    if let Some(key) = map.keys().find(|key| !known.contains(key.as_str())) {
        return Err(invalid(format!("unknown metadata key {key}")));
    }
    Ok(())
}

fn required_transit_string<'a>(
    entries: &'a [(String, transit::Value)],
    key: &str,
) -> Result<&'a str> {
    entries
        .iter()
        .find(|(name, _)| name == key)
        .and_then(|(_, value)| value.as_str())
        .ok_or_else(|| invalid(format!("{key} must be a string")))
}

fn optional_transit_string(
    entries: &[(String, transit::Value)],
    key: &str,
) -> Result<Option<String>> {
    match find_transit(entries, key) {
        None => Ok(None),
        Some(transit::Value::Str(value)) => Ok(Some(value.clone())),
        Some(_) => Err(invalid(format!("{key} must be a string"))),
    }
}

fn optional_transit_bucket(
    entries: &[(String, transit::Value)],
    key: &str,
) -> Result<Option<String>> {
    match find_transit(entries, key) {
        None => Ok(None),
        Some(transit::Value::Str(value) | transit::Value::Keyword(value)) => {
            Ok(Some(value.clone()))
        }
        Some(_) => Err(invalid(format!("{key} must be a string or keyword"))),
    }
}

fn optional_transit_uuid(entries: &[(String, transit::Value)], key: &str) -> Result<Option<Uuid>> {
    match find_transit(entries, key) {
        None => Ok(None),
        Some(transit::Value::Uuid(value)) => Ok(Some(*value)),
        Some(transit::Value::Str(value)) => Uuid::parse_str(value)
            .map(Some)
            .map_err(|_| invalid(format!("{key} must be a UUID"))),
        Some(_) => Err(invalid(format!("{key} must be a UUID"))),
    }
}

fn find_transit<'a>(
    entries: &'a [(String, transit::Value)],
    key: &str,
) -> Option<&'a transit::Value> {
    entries
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value)
}

fn reject_unknown_transit_keys(entries: &[(String, transit::Value)]) -> Result<()> {
    let known = BTreeSet::from([
        BUCKET,
        CONTENT_TYPE,
        HASH,
        PROFILE_ID,
        ORGANIZATION_ID,
        FILE_ID,
        ID,
        REFERENCE,
        UPLOAD_ID,
        CHUNK_INDEX,
    ]);
    if let Some((key, _)) = entries
        .iter()
        .find(|(key, _)| !known.contains(key.as_str()))
    {
        return Err(invalid(format!("unknown metadata key {key}")));
    }
    Ok(())
}
