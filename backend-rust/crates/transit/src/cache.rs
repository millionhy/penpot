//! Reader referent cache.
//!
//! Mirrors `com.cognitect.transit.caching.ReadCache` byte for byte, because the
//! writer's cache codes only resolve against a reader that advances its index
//! the same way:
//!
//! * `MIN_SIZE_CACHEABLE = 3` (so a referent is cacheable when `len > 3`),
//! * `BASE_CHAR_IDX = 48` (`'0'`), `CACHE_CODE_DIGITS = 44`,
//!   `MAX_CACHE_ENTRIES = 44 * 44 = 1936`,
//! * a cache code is `^` plus one char when `idx < 44`, and `^` plus
//!   `(44-based hi)(lo)` otherwise — `^0`…`^]`, then `^10` for index 44.
//!
//! Two behaviours are load bearing and easy to get wrong:
//!
//! 1. **Only cacheable referents advance the index.** A cache code that is
//!    *read* does not allocate a slot, so a stale/never-written slot yields
//!    `Nil` rather than an error (transit-js reads out of range and gets
//!    `undefined`, which the Penpot readers treat as nil).
//! 2. **A plain array rewinds the index** (`decodeArray` saves `cache.idx`
//!    before probing for the 2-element tagged form and restores it when the
//!    probe fails), otherwise the probe's cache write desynchronises every
//!    later reference in the document.

pub const MIN_SIZE_CACHEABLE: usize = 3;
pub const BASE_CHAR_IDX: u32 = 48;
pub const CACHE_CODE_DIGITS: u32 = 44;
pub const MAX_CACHE_ENTRIES: usize = (CACHE_CODE_DIGITS * CACHE_CODE_DIGITS) as usize;

/// Escape characters that mark a referent as transit syntax. A value is only
/// cached in non-key position when it starts with `~` followed by one of these.
pub fn esc_like_referent(s: &str) -> bool {
    let mut it = s.chars();
    it.next() == Some('~') && matches!(it.next(), Some(':' | '$' | '#'))
}

/// `caching.isCacheable` — a referent longer than `MIN_SIZE_CACHEABLE`, and
/// when it is not in map-key position it additionally has to look like transit
/// syntax (`~:`/`~$`/`~#`).
#[must_use]
pub fn is_cacheable(s: &str, as_map_key: bool) -> bool {
    if s.len() <= MIN_SIZE_CACHEABLE {
        return false;
    }
    if as_map_key {
        true
    } else {
        esc_like_referent(s)
    }
}

/// `caching.isCacheCode`: starts with `^` and is not the map marker `"^ "`.
#[must_use]
pub fn is_cache_code(s: &str) -> bool {
    let mut it = s.chars();
    it.next() == Some('^') && it.next() != Some(' ')
}

/// Decode a cache code back to its slot index (`caching.codeToIdx`).
fn code_to_idx(code: &str) -> Option<usize> {
    let mut chars = code.chars();
    if chars.next() != Some('^') {
        return None;
    }
    let first = chars.next()?;
    // char -> u32 is infallible; the subtraction is what can fail.
    let hi = u32::from(first).checked_sub(BASE_CHAR_IDX)?;
    match chars.next() {
        None => {
            if hi >= CACHE_CODE_DIGITS {
                None
            } else {
                usize::try_from(hi).ok()
            }
        }
        Some(second) => {
            let lo = u32::from(second).checked_sub(BASE_CHAR_IDX)?;
            if hi >= CACHE_CODE_DIGITS || lo >= CACHE_CODE_DIGITS || chars.next().is_some() {
                None
            } else {
                usize::try_from(hi * CACHE_CODE_DIGITS + lo).ok()
            }
        }
    }
}

#[derive(Debug)]
pub struct ReadCache<T> {
    idx: usize,
    entries: Vec<T>,
}

// Manual impl so `T` does not need `Default` (only `resize_with` is used).
impl<T> Default for ReadCache<T> {
    fn default() -> Self {
        Self {
            idx: 0,
            entries: Vec::new(),
        }
    }
}

impl<T: Clone> ReadCache<T> {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Current index; the caller stores it before a speculative probe and
    /// restores it with [`ReadCache::rewind`] (transit-js `decodeArray`).
    #[must_use]
    pub fn mark(&self) -> usize {
        self.idx
    }

    pub fn rewind(&mut self, to: usize) {
        self.idx = to;
    }

    /// `ReadCache.write`: stash the decoded referent in the next slot. A
    /// referent that is not cacheable must not reach here.
    pub fn write(&mut self, value: T) -> T {
        if self.idx == MAX_CACHE_ENTRIES {
            self.idx = 0;
        }
        if self.entries.len() < self.idx + 1 {
            // The index only ever advances one slot per write, so this branch is
            // hit at most once; `value` fills any gap left by an index restart.
            self.entries.resize(self.idx + 1, value.clone());
        }
        self.entries[self.idx] = value.clone();
        self.idx += 1;
        value
    }

    /// `ReadCache.read`: an unwritten slot yields `None` (transit-js hands back
    /// `undefined`; callers decide how to treat that).
    #[must_use]
    pub fn read(&self, code: &str) -> Option<T> {
        code_to_idx(code).and_then(|idx| self.entries.get(idx).cloned())
    }

    /// `ReadCache.clear` — the reader resets between documents. Index only:
    /// stale entries stay in the vector but are overwritten as it refills.
    pub fn clear(&mut self) {
        self.idx = 0;
    }
}

/// Encode a slot index as the cache code the transit writer emits.
#[must_use]
pub fn idx_to_code(idx: usize) -> String {
    let idx = u32::try_from(idx).unwrap_or(0);
    let hi = idx / CACHE_CODE_DIGITS;
    let lo = idx % CACHE_CODE_DIGITS;
    let lo_ch = char::from_u32(lo + BASE_CHAR_IDX).unwrap_or('0');
    if hi == 0 {
        format!("^{lo_ch}")
    } else {
        let hi_ch = char::from_u32(hi + BASE_CHAR_IDX).unwrap_or('0');
        format!("^{hi_ch}{lo_ch}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::Value;

    type RC = ReadCache<Value>;

    #[test]
    fn cacheable_only_in_key_position_for_plain_strings() {
        assert!(is_cacheable("name000", true));
        assert!(!is_cacheable("name000", false));
        assert!(is_cacheable("~:name", false));
        assert!(is_cacheable("~$name", false));
        assert!(is_cacheable("~#list", false));
        assert!(!is_cacheable(
            "~u00000000-0000-0000-0000-000000000000",
            false
        ));
        assert!(!is_cacheable("~m1700000000000", false));
    }

    #[test]
    fn short_referents_are_never_cached() {
        // The boundary is `len > MIN_SIZE_CACHEABLE(3)`, so 4 chars is enough.
        assert!(!is_cacheable("~:a", true));
        assert!(!is_cacheable("abc", true));
        assert!(
            !is_cacheable("abcd", false),
            "plain string in value position"
        );
        assert!(is_cacheable("abcd", true), "plain string as map key");
        assert!(is_cacheable("~:ab", false), "4 chars and looks like syntax");
        assert!(is_cacheable("~:abc", false));
    }

    #[test]
    fn map_marker_is_not_a_cache_code() {
        assert!(!is_cache_code("^ "));
        assert!(is_cache_code("^0"));
        assert!(is_cache_code("^10"));
    }

    #[test]
    fn codes_round_trip_through_44_digits() {
        // Slot chars are BASE_CHAR_IDX(48) + digit, so a single-char code runs
        // `^0`…`^9`, `^:`, `^;`… up to index 43 = `^[`, then two-char codes
        // start again at index 44 = `^10`.
        assert_eq!(idx_to_code(0), "^0");
        assert_eq!(idx_to_code(9), "^9");
        assert_eq!(idx_to_code(10), "^:");
        assert_eq!(idx_to_code(43), "^[");
        assert_eq!(idx_to_code(44), "^10");
        assert_eq!(idx_to_code(1935), "^[[");
        for idx in 0..MAX_CACHE_ENTRIES {
            assert_eq!(code_to_idx(&idx_to_code(idx)), Some(idx), "idx {idx}");
        }
        assert_eq!(code_to_idx("^"), None);
        assert_eq!(code_to_idx("^ "), None);
        assert_eq!(code_to_idx("^]"), None, "digit 45 is out of range");
    }

    #[test]
    fn reading_an_unset_slot_yields_none() {
        let cache = RC::new();
        assert_eq!(cache.read("^5"), None);
    }

    #[test]
    fn rewind_drops_speculative_writes() {
        let mut cache = RC::new();
        let mark = cache.mark();
        cache.write(Value::kw("probe"));
        assert_eq!(cache.mark(), mark + 1);
        cache.rewind(mark);
        cache.write(Value::kw("real"));
        assert_eq!(cache.read("^0"), Some(Value::kw("real")));
    }
}
