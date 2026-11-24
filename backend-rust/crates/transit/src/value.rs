//! The transit value model.
//!
//! `Value` is deliberately hand rolled instead of layered on top of
//! `serde_json::Value`: transit distinguishes pairs that JSON collapses, and
//! the codec has to keep both apart in each direction (decisions #3/#4 in
//! `PLAN.md` §8, facts in §2.1):
//!
//! * `~:name` is a [`Value::Keyword`], `"name"` is a [`Value::Str`]. A command
//!   param map whose schema is `[:map-of :keyword …]` is rejected by the
//!   backend when the keys arrive as strings.
//! * a Clojure **vector** crosses the wire as `["~#list", […]]`
//!   ([`Value::List`]) while a bare JSON array is a transit **array**
//!   ([`Value::Array`]). Every collection answer of the backend (`get-teams`,
//!   `get-project-files`, …) arrives wrapped in `~#list`; a reader that maps
//!   both to one variant breaks the whole dashboard.
//!
//! `Map` and `Set` are insertion ordered, matching `clojure.lang.PersistentHashMap`
//! iteration of the writer and `lambdaisland LinkedMap`/`LinkedSet` on the
//! Penpot side.

use std::fmt::{self, Write as _};
use std::hash::Hash;

use indexmap::{IndexMap, IndexSet};
use uuid::Uuid;

/// A transit map: insertion ordered, later writes to an existing key keep the
/// original position (same rule as `LinkedHashMap`/`IndexMap`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Map {
    entries: IndexMap<Value, Value>,
}

impl Map {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Inserts `value` under `key`, replacing any previous entry in place.
    pub fn insert(&mut self, key: Value, value: Value) -> Option<Value> {
        self.entries.insert(key, value)
    }

    /// Appends a key/value pair taken off the wire. Duplicate keys collapse
    /// with the *first* key object kept, the way the JS `mapBuilder` does.
    pub fn push(&mut self, key: Value, value: Value) {
        self.entries.insert(key, value);
    }

    #[must_use]
    pub fn get(&self, key: &Value) -> Option<&Value> {
        self.entries.get(key)
    }

    /// Convenience lookup by keyword name (`~:foo`).
    #[must_use]
    pub fn get_kw(&self, name: &str) -> Option<&Value> {
        self.get(&Value::Keyword(name.to_owned()))
    }

    pub fn keys(&self) -> impl Iterator<Item = &Value> {
        self.entries.keys()
    }

    pub fn values(&self) -> impl Iterator<Item = &Value> {
        self.entries.values()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&Value, &Value)> {
        self.entries.iter()
    }

    #[must_use]
    pub fn into_entries(self) -> Vec<(Value, Value)> {
        self.entries.into_iter().collect()
    }
}

impl FromIterator<(Value, Value)> for Map {
    fn from_iter<T: IntoIterator<Item = (Value, Value)>>(iter: T) -> Self {
        Self {
            entries: iter.into_iter().collect(),
        }
    }
}

/// A transit set (`~#set` / `~#ordered-set`): insertion ordered, deduplicated.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Set {
    entries: IndexSet<Value>,
}

impl Set {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, value: Value) -> bool {
        self.entries.insert_full(value).1
    }

    #[must_use]
    pub fn contains(&self, value: &Value) -> bool {
        self.entries.contains(value)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &Value> {
        self.entries.iter()
    }

    #[must_use]
    pub fn into_vec(self) -> Vec<Value> {
        self.entries.into_iter().collect()
    }
}

impl FromIterator<Value> for Set {
    fn from_iter<T: IntoIterator<Item = Value>>(iter: T) -> Self {
        Self {
            entries: iter.into_iter().collect(),
        }
    }
}

/// The four path segment commands of `app.common.types.path.impl`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentKind {
    MoveTo,
    LineTo,
    CurveTo,
    ClosePath,
}

impl SegmentKind {
    fn from_code(code: i16) -> Option<Self> {
        match code {
            1 => Some(Self::MoveTo),
            2 => Some(Self::LineTo),
            3 => Some(Self::CurveTo),
            4 => Some(Self::ClosePath),
            _ => None,
        }
    }
}

/// One decoded segment of a `penpot/path-data` blob.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PathSegment {
    pub kind: SegmentKind,
    pub x: f32,
    pub y: f32,
    pub c1x: f32,
    pub c1y: f32,
    pub c2x: f32,
    pub c2y: f32,
}

/// `~#penpot/path-data`: packed path segments, 28 little-endian bytes each.
///
/// Layout (from `app.common.types.path.impl`, read through `app.common.buffer`,
/// little-endian in the CLJS build): `+0` int16 command, `+4 c1x`, `+8 c1y`,
/// `+12 c2x`, `+16 c2y`, `+20 x`, `+24 y` — all float32. `move-to`/`line-to`
/// carry only `x y`, `curve-to` carries all six, `close-path` carries none.
///
/// The wire rep is the transit binary tag (`~b`, base64), which is what the
/// CLJS write handler ships and what `from-bytes` receives.
#[derive(Clone, PartialEq, Eq)]
pub struct PathData {
    bytes: Vec<u8>,
}

impl PathData {
    /// Bytes per segment on the wire.
    pub const SEGMENT_U8_SIZE: usize = 28;

    /// Bounds applied to coordinates on read, mirroring `normalize-coord`
    /// against `sm/max-safe-int` / `sm/min-safe-int`.
    pub const MAX_SAFE_COORD: f32 = 2_147_483_647.0;
    pub const MIN_SAFE_COORD: f32 = -2_147_483_648.0;

    #[must_use]
    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }

    #[must_use]
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    #[must_use]
    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }

    /// Number of whole segments carried by the buffer. A trailing partial
    /// segment is not counted (`count` is a floor division).
    #[must_use]
    pub fn count(&self) -> usize {
        self.bytes.len() / Self::SEGMENT_U8_SIZE
    }

    /// `read-segment`: a segment with an unknown command yields `None`, and
    /// [`PathData::segments`] skips it the way the CLJS seq does.
    #[must_use]
    pub fn segment(&self, index: usize) -> Option<PathSegment> {
        let offset = index.checked_mul(Self::SEGMENT_U8_SIZE)?;
        let rest = self.bytes.get(offset..)?;
        if rest.len() < Self::SEGMENT_U8_SIZE {
            return None;
        }
        let kind = SegmentKind::from_code(i16::from_le_bytes([rest[0], rest[1]]))?;
        let f32_ =
            |at: usize| f32::from_le_bytes([rest[at], rest[at + 1], rest[at + 2], rest[at + 3]]);
        // normalize-coord clamps into the safe-int bounds; f32::clamp keeps NaN
        // the way the if-chain did (only when both bounds are ordered, which
        // MIN/MAX are).
        let clamp = |v: f32| v.clamp(Self::MIN_SAFE_COORD, Self::MAX_SAFE_COORD);
        match kind {
            SegmentKind::ClosePath => Some(PathSegment {
                kind,
                x: 0.0,
                y: 0.0,
                c1x: 0.0,
                c1y: 0.0,
                c2x: 0.0,
                c2y: 0.0,
            }),
            SegmentKind::MoveTo | SegmentKind::LineTo => Some(PathSegment {
                kind,
                x: clamp(f32_(20)),
                y: clamp(f32_(24)),
                c1x: 0.0,
                c1y: 0.0,
                c2x: 0.0,
                c2y: 0.0,
            }),
            SegmentKind::CurveTo => Some(PathSegment {
                kind,
                x: clamp(f32_(20)),
                y: clamp(f32_(24)),
                c1x: clamp(f32_(4)),
                c1y: clamp(f32_(8)),
                c2x: clamp(f32_(12)),
                c2y: clamp(f32_(16)),
            }),
        }
    }

    #[must_use]
    pub fn segments(&self) -> Vec<PathSegment> {
        (0..self.count()).filter_map(|i| self.segment(i)).collect()
    }

    /// `to-string`: the SVG path form, with the raw float32 values appended
    /// exactly like the CLJS implementation does.
    #[must_use]
    pub fn to_svg(&self) -> String {
        let mut out = String::new();
        for seg in self.segments() {
            // Writing into a String cannot fail, so the fmt::Result is dropped.
            match seg.kind {
                SegmentKind::MoveTo => {
                    let _ = write!(out, "M{},{}", seg.x, seg.y);
                }
                SegmentKind::LineTo => {
                    let _ = write!(out, "L{},{}", seg.x, seg.y);
                }
                SegmentKind::CurveTo => {
                    let _ = write!(
                        out,
                        "C{},{},{},{},{},{}",
                        seg.c1x, seg.c1y, seg.c2x, seg.c2y, seg.x, seg.y
                    );
                }
                SegmentKind::ClosePath => out.push('Z'),
            }
        }
        out
    }
}

impl fmt::Debug for PathData {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "PathData({} segments, {} bytes)",
            self.count(),
            self.bytes.len()
        )
    }
}

/// `~z` special doubles (`app.common.types.special_symbol` / transit spec).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SpecialDouble {
    PositiveInfinity,
    NegativeInfinity,
    NotANumber,
}

impl SpecialDouble {
    #[must_use]
    pub fn rep(self) -> &'static str {
        match self {
            Self::PositiveInfinity => "INF",
            Self::NegativeInfinity => "-INF",
            Self::NotANumber => "NaN",
        }
    }

    #[must_use]
    pub fn from_rep(rep: &str) -> Option<Self> {
        match rep {
            "INF" => Some(Self::PositiveInfinity),
            "-INF" => Some(Self::NegativeInfinity),
            "NaN" => Some(Self::NotANumber),
            _ => None,
        }
    }
}

/// One entry of `~#cmap`: transit maps with composite (non stringable) keys.
pub type CmapEntry = (Value, Value);

/// A transit value.
#[derive(Clone, Debug, Default)]
pub enum Value {
    /// `~_` / JSON `null`.
    #[default]
    Nil,
    /// `~?t` / `~?f`, or a JSON boolean in value position.
    Bool(bool),
    /// A JSON integer, or the `~i` tag. The backend uses `~i` for integers in
    /// map-key position.
    Integer(i64),
    /// `~d` / a JSON float in value position.
    Double(f64),
    /// `~z`.
    Special(SpecialDouble),
    /// `~c` (JVM character).
    Char(char),
    /// `~n`: the rep is kept verbatim so a value the backend writes as a big
    /// integer re-encodes byte for byte. Use [`Value::as_i128`] to read it.
    BigInteger(String),
    /// `~f` (BigDecimal): rep kept verbatim, same reasoning as `BigInteger`.
    BigDecimal(String),
    /// `~:name`
    Keyword(String),
    /// `~$name`
    Symbol(String),
    /// A plain string.
    Str(String),
    /// `~b` (base64 on the wire).
    Binary(Vec<u8>),
    /// `~u`
    Uuid(Uuid),
    /// `~m`: epoch milliseconds (`java.time.Instant` / `OffsetDateTime` /
    /// `js/Date` all write through this tag).
    Instant(i64),
    /// `~t`: the verbose (ISO-8601) instant form.
    VerboseInstant(String),
    /// `~r`: transit's own URI tag.
    Uri(String),
    /// `~#duration` (JVM `java.time.Duration`, rep is milliseconds).
    Duration(i64),
    /// `~#list`: a Clojure **vector**.
    List(Vec<Value>),
    /// A bare JSON array (transit **array**). Not the same thing as
    /// [`Value::List`]; see the module docs.
    Array(Vec<Value>),
    /// `~#set`
    Set(Set),
    /// `~#ordered-set` (`lambdaisland LinkedSet`)
    OrderedSet(Set),
    /// A transit map: `["^ ", k1, v1, …]`.
    Map(Map),
    /// `~#ordered-map` (`lambdaisland LinkedMap`), carried by the same
    /// insertion-ordered container as `Map`.
    OrderedMap(Map),
    /// `~#cmap`: map with composite keys.
    Cmap(Vec<CmapEntry>),
    /// `~#'`: keeps the value so a reader applies its handler to the payload
    /// instead of the wrapper.
    Quoted(Box<Value>),
    /// `~#with-meta`: `[value meta]`.
    WithMeta { value: Box<Value>, meta: Box<Value> },
    /// `~#penpot/pointer` (`app.common.transit/Pointer`, rep `[id meta]`).
    Pointer {
        id: Box<Value>,
        meta: Option<Box<Value>>,
    },
    /// `~#penpot/path-data` (`app.common.types.path.impl`).
    PathData(PathData),
    /// `~#penpot/objects-map/v2` (`app.common.types.objects-map`): uuid →
    /// shape. Every value arrives as a **nested transit string** and is
    /// decoded through a dedicated reader so the outer referent cache stays
    /// intact.
    ObjectsMap(Map),
    /// Any other tagged value: `shape`, `point`, `matrix`, `rect`,
    /// `penpot/fills`, `uri` (Penpot's own handler id), unknown or future
    /// tags. `tag` excludes the `~#` marker.
    Tagged { tag: String, rep: Box<Value> },
}

impl Value {
    // -- constructors used by tests and callers --------------------------------

    #[must_use]
    pub fn kw(name: impl Into<String>) -> Self {
        Self::Keyword(name.into())
    }

    #[must_use]
    pub fn str(value: impl Into<String>) -> Self {
        Self::Str(value.into())
    }

    #[must_use]
    pub fn vector(items: impl IntoIterator<Item = Value>) -> Self {
        Self::List(items.into_iter().collect())
    }

    #[must_use]
    pub fn array(items: impl IntoIterator<Item = Value>) -> Self {
        Self::Array(items.into_iter().collect())
    }

    #[must_use]
    pub fn map(entries: impl IntoIterator<Item = (Value, Value)>) -> Self {
        Self::Map(entries.into_iter().collect())
    }

    #[must_use]
    pub fn ordered_map(entries: impl IntoIterator<Item = (Value, Value)>) -> Self {
        Self::OrderedMap(entries.into_iter().collect())
    }

    #[must_use]
    pub fn tagged(tag: impl Into<String>, rep: Value) -> Self {
        Self::Tagged {
            tag: tag.into(),
            rep: Box::new(rep),
        }
    }

    #[must_use]
    pub fn quoted(value: Value) -> Self {
        Self::Quoted(Box::new(value))
    }

    // -- predicates ----------------------------------------------------------

    #[must_use]
    pub fn is_nil(&self) -> bool {
        matches!(self, Self::Nil)
    }

    #[must_use]
    pub fn is_map(&self) -> bool {
        matches!(
            self,
            Self::Map(_) | Self::OrderedMap(_) | Self::ObjectsMap(_)
        )
    }

    /// True for the two collection forms a reader has to keep apart.
    #[must_use]
    pub fn is_vector(&self) -> bool {
        matches!(self, Self::List(_))
    }

    // -- accessors -----------------------------------------------------------

    /// Look a key up in any of the map-shaped variants.
    #[must_use]
    pub fn get(&self, key: &Value) -> Option<&Value> {
        match self {
            Self::Map(m) | Self::OrderedMap(m) | Self::ObjectsMap(m) => m.get(key),
            Self::Tagged { rep, .. } => rep.get(key),
            _ => None,
        }
    }

    #[must_use]
    pub fn get_kw(&self, name: &str) -> Option<&Value> {
        self.get(&Self::Keyword(name.to_owned()))
    }

    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Str(s) => Some(s),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_keyword(&self) -> Option<&str> {
        match self {
            Self::Keyword(s) => Some(s),
            _ => None,
        }
    }

    /// The map entries of any map-shaped variant, in insertion order.
    #[must_use]
    pub fn as_map(&self) -> Option<&Map> {
        match self {
            Self::Map(m) | Self::OrderedMap(m) | Self::ObjectsMap(m) => Some(m),
            _ => None,
        }
    }

    /// Items of any sequence-shaped variant (vector, array, or a set's
    /// backing order).
    #[must_use]
    pub fn items(&self) -> Option<Vec<&Value>> {
        match self {
            Self::List(v) | Self::Array(v) => Some(v.iter().collect()),
            Self::Set(s) | Self::OrderedSet(s) => Some(s.iter().collect()),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Integer(v) | Self::Instant(v) | Self::Duration(v) => Some(*v),
            Self::BigInteger(s) => s.parse().ok(),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_i128(&self) -> Option<i128> {
        match self {
            Self::Integer(v) => Some(i128::from(*v)),
            Self::BigInteger(s) => s.parse().ok(),
            _ => None,
        }
    }

    /// Lossy above 2^53, like every other i64 to f64 read of a JSON number.
    #[must_use]
    #[allow(
        clippy::cast_precision_loss,
        reason = "an i64 read as a double is expected to lose precision"
    )]
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Double(v) => Some(*v),
            Self::Integer(v) => Some(*v as f64),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_uuid(&self) -> Option<Uuid> {
        match self {
            Self::Uuid(v) => Some(*v),
            _ => None,
        }
    }

    /// The tag name of a tagged value, ignoring how it was written.
    #[must_use]
    pub fn tag(&self) -> Option<&str> {
        match self {
            Self::Tagged { tag, .. } => Some(tag),
            _ => None,
        }
    }
}

// Each arm must compare one variant against itself. clippy's match_same_arms
// wants them merged, but `Integer(a) | BigInteger(a)` would widen equality
// across variants and silently equate an integer with a big-int rep.
#[allow(clippy::match_same_arms)]
impl PartialEq for Value {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Nil, Self::Nil) => true,
            (Self::Bool(a), Self::Bool(b)) => a == b,
            (Self::Integer(a), Self::Integer(b)) => a == b,
            (Self::Double(a), Self::Double(b)) => a.to_bits() == b.to_bits(),
            (Self::Special(a), Self::Special(b)) => a == b,
            (Self::Char(a), Self::Char(b)) => a == b,
            (Self::BigInteger(a), Self::BigInteger(b)) => a == b,
            (Self::BigDecimal(a), Self::BigDecimal(b)) => a == b,
            (Self::Keyword(a), Self::Keyword(b)) => a == b,
            (Self::Symbol(a), Self::Symbol(b)) => a == b,
            (Self::Str(a), Self::Str(b)) => a == b,
            (Self::Binary(a), Self::Binary(b)) => a == b,
            (Self::Uuid(a), Self::Uuid(b)) => a == b,
            (Self::Instant(a), Self::Instant(b)) => a == b,
            (Self::VerboseInstant(a), Self::VerboseInstant(b)) => a == b,
            (Self::Uri(a), Self::Uri(b)) => a == b,
            (Self::Duration(a), Self::Duration(b)) => a == b,
            (Self::List(a), Self::List(b)) => a == b,
            (Self::Array(a), Self::Array(b)) => a == b,
            (Self::Set(a), Self::Set(b)) => a == b,
            (Self::OrderedSet(a), Self::OrderedSet(b)) => a == b,
            (Self::Map(a), Self::Map(b)) => a == b,
            (Self::OrderedMap(a), Self::OrderedMap(b)) => a == b,
            (Self::Cmap(a), Self::Cmap(b)) => a == b,
            (Self::Quoted(a), Self::Quoted(b)) => a == b,
            (
                Self::WithMeta {
                    value: av,
                    meta: am,
                },
                Self::WithMeta {
                    value: bv,
                    meta: bm,
                },
            ) => av == bv && am == bm,
            (Self::Pointer { id: aid, meta: am }, Self::Pointer { id: bid, meta: bm }) => {
                aid == bid && am == bm
            }
            (Self::PathData(a), Self::PathData(b)) => a == b,
            (Self::ObjectsMap(a), Self::ObjectsMap(b)) => a == b,
            (Self::Tagged { tag: at, rep: ar }, Self::Tagged { tag: bt, rep: br }) => {
                at == bt && ar == br
            }
            _ => false,
        }
    }
}

impl Eq for Value {}

#[allow(
    clippy::match_same_arms,
    reason = "per-variant arms; merging would hash two variants alike"
)]
impl std::hash::Hash for Value {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        // Discriminant first so `Integer(1)` and `Double(1.0)` do not collide.
        std::mem::discriminant(self).hash(state);
        match self {
            Self::Nil => {}
            Self::Bool(v) => v.hash(state),
            Self::Integer(v) => v.hash(state),
            Self::Double(v) => v.to_bits().hash(state),
            Self::Special(v) => v.hash(state),
            Self::Char(v) => v.hash(state),
            Self::BigInteger(v)
            | Self::BigDecimal(v)
            | Self::Keyword(v)
            | Self::Symbol(v)
            | Self::Str(v)
            | Self::Uri(v)
            | Self::VerboseInstant(v) => v.hash(state),
            Self::Binary(v) => v.hash(state),
            Self::Uuid(v) => v.hash(state),
            Self::Instant(v) | Self::Duration(v) => v.hash(state),
            Self::List(v) | Self::Array(v) => v.hash(state),
            Self::Set(v) | Self::OrderedSet(v) => hash_set(v, state),
            Self::Map(v) | Self::OrderedMap(v) | Self::ObjectsMap(v) => hash_map(v, state),
            Self::Cmap(v) => v.iter().for_each(|(k, val)| {
                k.hash(state);
                val.hash(state);
            }),
            Self::Quoted(v) => v.hash(state),
            Self::WithMeta { value, meta } => {
                value.hash(state);
                meta.hash(state);
            }
            Self::Pointer { id, meta } => {
                id.hash(state);
                meta.hash(state);
            }
            Self::PathData(v) => v.as_bytes().hash(state),
            Self::Tagged { tag, rep } => {
                tag.hash(state);
                rep.hash(state);
            }
        }
    }
}

fn hash_map<H: std::hash::Hasher>(map: &Map, state: &mut H) {
    map.len().hash(state);
    for (k, v) in map.iter() {
        k.hash(state);
        v.hash(state);
    }
}

fn hash_set<H: std::hash::Hasher>(set: &Set, state: &mut H) {
    set.len().hash(state);
    for v in set.iter() {
        v.hash(state);
    }
}

#[allow(
    clippy::match_same_arms,
    reason = "the Display text differs by variant even when the body is the same"
)]
impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Nil => write!(f, "nil"),
            Self::Bool(v) => write!(f, "{v}"),
            Self::Integer(v) => write!(f, "{v}"),
            Self::Double(v) => write!(f, "{v}"),
            Self::Special(v) => write!(f, "{}", v.rep()),
            Self::Char(v) => write!(f, "{v}"),
            Self::BigInteger(v) | Self::BigDecimal(v) => write!(f, "{v}"),
            Self::Keyword(v) => write!(f, ":{v}"),
            Self::Symbol(v) => write!(f, "{v}"),
            Self::Str(v) => write!(f, "{v}"),
            Self::Binary(v) => write!(f, "<{} bytes>", v.len()),
            Self::Uuid(v) => write!(f, "{v}"),
            Self::Instant(v) => write!(f, "{v}ms"),
            Self::VerboseInstant(v) => write!(f, "{v}"),
            Self::Uri(v) => write!(f, "{v}"),
            Self::Duration(v) => write!(f, "{v}ms"),
            Self::List(v) | Self::Array(v) => write!(f, "{v:?}"),
            Self::Set(v) | Self::OrderedSet(v) => write!(f, "{:?}", v.iter().collect::<Vec<_>>()),
            Self::Map(_) | Self::OrderedMap(_) | Self::ObjectsMap(_) => write!(f, "<map>"),
            Self::Cmap(_) => write!(f, "<cmap>"),
            Self::Quoted(v) => write!(f, "'{v}"),
            Self::WithMeta { value, .. } => write!(f, "{value}"),
            Self::Pointer { id, .. } => write!(f, "pointer({id})"),
            Self::PathData(v) => write!(f, "{}", v.to_svg()),
            Self::Tagged { tag, rep } => write!(f, "{tag}:{rep:?}"),
        }
    }
}
