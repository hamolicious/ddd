//! Full-text search: an inverted index over title, content and frontmatter values.
//!
//! The same index on both sides — natively on the server, in the browser's search
//! worker as wasm — so a search ranks identically online and offline. It replaced
//! MiniSearch (client) and Mongo `$text` (server), and keeps MiniSearch's behaviour
//! where people would notice:
//!
//! - **Tokens** are runs of letters and digits, lowercased. Everything else separates.
//! - **Fields** are boosted title ×3, frontmatter ×2, content ×1. Frontmatter is its
//!   scalar values only, never its keys, so `status` does not match every document
//!   that has a status.
//! - **Each query term matches** exactly, as a prefix of a longer term (×0.375), or
//!   within an edit distance of a fifth of its length (×0.45), the weights scaled down
//!   by how far the match is.
//! - **Scoring** is BM25+ (k 1.2, b 0.7, δ 0.5), summed over the query's terms, then
//!   multiplied by how many of them matched, so a document holding every word beats
//!   one that repeats a single word.

use std::collections::{BTreeMap, HashMap};
use std::ops::Bound;

use serde::{Deserialize, Serialize};

use super::doc::Doc;
use crate::value::Value;

/// The indexed fields, in posting order, and their boosts.
const BOOSTS: [f64; FIELD_COUNT] = [3.0, 1.0, 2.0];
const FIELD_COUNT: usize = 3;
const TITLE: usize = 0;
const CONTENT: usize = 1;
const FM: usize = 2;

const BM25_K: f64 = 1.2;
const BM25_B: f64 = 0.7;
const BM25_D: f64 = 0.5;
const PREFIX_WEIGHT: f64 = 0.375;
const FUZZY_WEIGHT: f64 = 0.45;
/// A query term's edit budget, as a share of its length.
const FUZZY_SHARE: f64 = 0.2;
const MAX_FUZZY_DISTANCE: usize = 6;
/// Longer tokens are cut: they are hashes and base64, not words anyone types.
const MAX_TOKEN_CHARS: usize = 64;
/// Query terms past this are ignored.
const MAX_QUERY_TERMS: usize = 32;
/// How deep frontmatter values are flattened.
const MAX_FM_DEPTH: usize = 6;

/// Bump when tokenizing or the stored shape changes: a persisted index with another
/// version is rebuilt rather than loaded.
pub const TEXT_INDEX_VERSION: u32 = 1;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TextIndex {
    /// Slot → document id; `None` for a freed slot.
    slots: Vec<Option<String>>,
    free: Vec<u32>,
    #[serde(skip)]
    by_id: HashMap<String, u32>,
    /// Per slot: each field's length in tokens.
    lengths: Vec<[u32; FIELD_COUNT]>,
    /// Per slot: its distinct terms, to take its postings out again.
    doc_terms: Vec<Vec<String>>,
    /// Sum of every live slot's field lengths.
    totals: [u64; FIELD_COUNT],
    live: u32,
    /// Sorted, so a prefix is a range.
    terms: BTreeMap<String, Postings>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Postings {
    /// Slot → occurrences per field.
    docs: HashMap<u32, [u32; FIELD_COUNT]>,
    /// Documents holding the term, per field.
    df: [u32; FIELD_COUNT],
}

/// One document a search found.
#[derive(Debug, Clone, PartialEq)]
pub struct TextHit {
    pub id: String,
    pub score: f64,
    /// The indexed terms it matched on, for highlighting.
    pub terms: Vec<String>,
}

/// The tokens of `text`, lowercased.
pub fn tokenize(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .map(|token| {
            token
                .chars()
                .take(MAX_TOKEN_CHARS)
                .flat_map(char::to_lowercase)
                .collect()
        })
}

/// Frontmatter's scalar values, keys in order, as one string.
fn flatten_fm(value: &Value, out: &mut Vec<String>, depth: usize) {
    if depth > MAX_FM_DEPTH {
        return;
    }
    match value {
        Value::Null => {}
        Value::Str(text) => out.push(text.clone()),
        Value::Int(number) => out.push(number.to_string()),
        Value::Float(number) => out.push(number.to_string()),
        Value::Bool(flag) => out.push(flag.to_string()),
        Value::List(items) => items
            .iter()
            .for_each(|item| flatten_fm(item, out, depth + 1)),
        Value::Map(map) => map
            .values()
            .for_each(|item| flatten_fm(item, out, depth + 1)),
    }
}

impl TextIndex {
    pub fn new() -> TextIndex {
        TextIndex::default()
    }

    /// Documents indexed.
    pub fn len(&self) -> usize {
        self.live as usize
    }

    pub fn is_empty(&self) -> bool {
        self.live == 0
    }

    /// Add a document, or replace what is indexed for it.
    pub fn upsert(&mut self, doc: &Doc) {
        self.remove(&doc.id);

        let mut fm = Vec::new();
        for value in doc.fm.values() {
            flatten_fm(value, &mut fm, 1);
        }
        let fields: [String; FIELD_COUNT] = {
            let mut fields: [String; FIELD_COUNT] = Default::default();
            fields[TITLE] = doc.title.clone();
            fields[CONTENT] = doc.content.clone();
            fields[FM] = fm.join(" ");
            fields
        };

        let mut counts: BTreeMap<String, [u32; FIELD_COUNT]> = BTreeMap::new();
        let mut lengths = [0u32; FIELD_COUNT];
        for (field, text) in fields.iter().enumerate() {
            for token in tokenize(text) {
                lengths[field] += 1;
                counts.entry(token).or_default()[field] += 1;
            }
        }

        let slot = match self.free.pop() {
            Some(slot) => {
                self.slots[slot as usize] = Some(doc.id.clone());
                self.lengths[slot as usize] = lengths;
                slot
            }
            None => {
                self.slots.push(Some(doc.id.clone()));
                self.lengths.push(lengths);
                self.doc_terms.push(Vec::new());
                (self.slots.len() - 1) as u32
            }
        };
        self.by_id.insert(doc.id.clone(), slot);
        for (field, length) in lengths.iter().enumerate() {
            self.totals[field] += u64::from(*length);
        }
        self.live += 1;

        let mut owned = Vec::with_capacity(counts.len());
        for (term, tf) in counts {
            let postings = self.terms.entry(term.clone()).or_default();
            for (df, count) in postings.df.iter_mut().zip(tf) {
                *df += u32::from(count > 0);
            }
            postings.docs.insert(slot, tf);
            owned.push(term);
        }
        self.doc_terms[slot as usize] = owned;
    }

    /// Take a document out; nothing happens for one that is not indexed.
    pub fn remove(&mut self, id: &str) {
        let Some(slot) = self.by_id.remove(id) else {
            return;
        };
        let index = slot as usize;
        for term in std::mem::take(&mut self.doc_terms[index]) {
            let Some(postings) = self.terms.get_mut(&term) else {
                continue;
            };
            if let Some(tf) = postings.docs.remove(&slot) {
                for (df, count) in postings.df.iter_mut().zip(tf) {
                    *df -= u32::from(count > 0);
                }
            }
            if postings.docs.is_empty() {
                self.terms.remove(&term);
            }
        }
        for (field, length) in self.lengths[index].iter().enumerate() {
            self.totals[field] -= u64::from(*length);
        }
        self.lengths[index] = [0; FIELD_COUNT];
        self.slots[index] = None;
        self.free.push(slot);
        self.live -= 1;
    }

    /// Rebuild what serialization leaves out. Call after deserializing.
    pub fn reindex(&mut self) {
        self.by_id = self
            .slots
            .iter()
            .enumerate()
            .filter_map(|(slot, id)| id.as_ref().map(|id| (id.clone(), slot as u32)))
            .collect();
    }

    /// Every document matching any of the query's terms, best first (ties by id).
    pub fn search(&self, query: &str) -> Vec<TextHit> {
        let mut query_terms: Vec<String> = Vec::new();
        for term in tokenize(query) {
            if !query_terms.contains(&term) {
                query_terms.push(term);
            }
        }
        query_terms.truncate(MAX_QUERY_TERMS);
        if query_terms.is_empty() || self.live == 0 {
            return Vec::new();
        }

        struct Found {
            score: f64,
            matched: u64,
            terms: Vec<String>,
        }
        let mut found: HashMap<u32, Found> = HashMap::new();
        let averages: [f64; FIELD_COUNT] = std::array::from_fn(|field| {
            (self.totals[field] as f64 / f64::from(self.live)).max(1.0)
        });

        for (position, query_term) in query_terms.iter().enumerate() {
            for (term, weight) in self.expand(query_term) {
                let Some(postings) = self.terms.get(term) else {
                    continue;
                };
                for (slot, tf) in &postings.docs {
                    let mut score = 0.0;
                    for field in 0..FIELD_COUNT {
                        if tf[field] == 0 {
                            continue;
                        }
                        score += BOOSTS[field]
                            * self.bm25(
                                tf[field],
                                postings.df[field],
                                self.lengths[*slot as usize][field],
                                averages[field],
                            );
                    }
                    if score == 0.0 {
                        continue;
                    }
                    let entry = found.entry(*slot).or_insert_with(|| Found {
                        score: 0.0,
                        matched: 0,
                        terms: Vec::new(),
                    });
                    entry.score += weight * score;
                    entry.matched |= 1 << position;
                    if !entry.terms.iter().any(|known| known == term) {
                        entry.terms.push(term.clone());
                    }
                }
            }
        }

        let mut hits: Vec<TextHit> = found
            .into_iter()
            .filter_map(|(slot, found)| {
                let id = self.slots[slot as usize].clone()?;
                let mut terms = found.terms;
                terms.sort();
                Some(TextHit {
                    id,
                    score: found.score * f64::from(found.matched.count_ones()),
                    terms,
                })
            })
            .collect();
        hits.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.id.cmp(&b.id)));
        hits
    }

    /// The indexed terms a query term stands for, each with its weight.
    fn expand<'a>(&'a self, query_term: &str) -> Vec<(&'a String, f64)> {
        let mut out: Vec<(&String, f64)> = Vec::new();
        let length = query_term.chars().count();

        // Exact, and every longer term it begins.
        for (term, _) in self
            .terms
            .range::<str, _>((Bound::Included(query_term), Bound::Unbounded))
        {
            if !term.starts_with(query_term) {
                break;
            }
            if term == query_term {
                out.push((term, 1.0));
            } else {
                let longer = term.chars().count();
                let distance = (longer - length) as f64;
                out.push((
                    term,
                    PREFIX_WEIGHT * longer as f64 / (longer as f64 + 0.3 * distance),
                ));
            }
        }

        let budget = ((length as f64 * FUZZY_SHARE).round() as usize).min(MAX_FUZZY_DISTANCE);
        if budget == 0 {
            return out;
        }
        let query: Vec<char> = query_term.chars().collect();
        for term in self.terms.keys() {
            if term.starts_with(query_term) {
                continue;
            }
            let candidate: Vec<char> = term.chars().collect();
            if candidate.len().abs_diff(query.len()) > budget {
                continue;
            }
            if let Some(distance) = bounded_levenshtein(&query, &candidate, budget) {
                let longer = candidate.len() as f64;
                out.push((term, FUZZY_WEIGHT * longer / (longer + distance as f64)));
            }
        }
        out
    }

    fn bm25(&self, tf: u32, df: u32, length: u32, average: f64) -> f64 {
        let n = f64::from(self.live);
        let df = f64::from(df);
        let tf = f64::from(tf);
        let idf = (1.0 + (n - df + 0.5) / (df + 0.5)).ln();
        let norm = BM25_K * (1.0 - BM25_B + BM25_B * f64::from(length) / average);
        idf * (BM25_D + tf * (BM25_K + 1.0) / (tf + norm))
    }
}

/// Edit distance between `a` and `b` if it is at most `budget`.
fn bounded_levenshtein(a: &[char], b: &[char], budget: usize) -> Option<usize> {
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    let mut current = vec![0; b.len() + 1];
    for (i, left) in a.iter().enumerate() {
        current[0] = i + 1;
        let mut row_min = current[0];
        for (j, right) in b.iter().enumerate() {
            let cost = usize::from(left != right);
            current[j + 1] = (previous[j] + cost)
                .min(previous[j + 1] + 1)
                .min(current[j] + 1);
            row_min = row_min.min(current[j + 1]);
        }
        if row_min > budget {
            return None;
        }
        std::mem::swap(&mut previous, &mut current);
    }
    let distance = previous[b.len()];
    (distance <= budget).then_some(distance)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::Map;

    fn doc(id: &str, title: &str, content: &str) -> Doc {
        Doc {
            id: id.into(),
            title: title.into(),
            content: content.into(),
            fm: Map::new(),
            plugins: Map::new(),
            created_at: None,
            updated_at: None,
            deleted_at: None,
            deleted: false,
        }
    }

    fn ids(hits: &[TextHit]) -> Vec<&str> {
        hits.iter().map(|hit| hit.id.as_str()).collect()
    }

    #[test]
    fn tokens_are_lowercased_runs_of_letters_and_digits() {
        let tokens: Vec<String> = tokenize("Hello, Wörld! foo_bar 2026-09").collect();
        assert_eq!(tokens, ["hello", "wörld", "foo", "bar", "2026", "09"]);
    }

    #[test]
    fn exact_prefix_and_fuzzy_terms_match() {
        let mut index = TextIndex::new();
        index.upsert(&doc("1", "Groceries", "milk and bread"));
        index.upsert(&doc("2", "Work", "quarterly report"));
        assert_eq!(ids(&index.search("milk")), ["1"]);
        assert_eq!(ids(&index.search("groc")), ["1"]);
        assert_eq!(ids(&index.search("reprt")), ["2"], "one edit away");
        assert!(
            index.search("reprot").is_empty(),
            "two edits is past a six-letter budget"
        );
        assert!(index.search("zebra").is_empty());
    }

    #[test]
    fn the_title_outranks_the_content() {
        let mut index = TextIndex::new();
        index.upsert(&doc("a", "Notes", "milk"));
        index.upsert(&doc("b", "Milk", "notes"));
        assert_eq!(ids(&index.search("milk")), ["b", "a"]);
    }

    #[test]
    fn matching_more_words_ranks_higher() {
        let mut index = TextIndex::new();
        index.upsert(&doc("a", "", "milk milk milk milk"));
        index.upsert(&doc("b", "", "milk bread"));
        assert_eq!(ids(&index.search("milk bread")), ["b", "a"]);
    }

    #[test]
    fn frontmatter_values_are_searchable_but_keys_are_not() {
        let mut index = TextIndex::new();
        let mut tagged = doc("1", "", "");
        tagged
            .fm
            .insert("status".into(), Value::Str("waiting".into()));
        tagged.fm.insert(
            "tags".into(),
            Value::List(vec![Value::Str("errand".into())]),
        );
        index.upsert(&tagged);
        assert_eq!(ids(&index.search("errand")), ["1"]);
        assert!(index.search("status").is_empty());
    }

    #[test]
    fn replacing_and_removing_keep_the_index_exact() {
        let mut index = TextIndex::new();
        index.upsert(&doc("1", "", "milk"));
        index.upsert(&doc("1", "", "bread"));
        assert!(index.search("milk").is_empty());
        assert_eq!(index.len(), 1);
        index.remove("1");
        assert!(index.search("bread").is_empty());
        assert!(index.terms.is_empty());
        assert_eq!(index.totals, [0; FIELD_COUNT]);
        index.upsert(&doc("2", "", "bread"));
        assert_eq!(ids(&index.search("bread")), ["2"]);
        assert_eq!(index.slots.len(), 1, "the freed slot is reused");
    }

    #[test]
    fn a_serialized_index_answers_the_same() {
        let mut index = TextIndex::new();
        index.upsert(&doc("1", "Groceries", "milk"));
        let mut loaded: TextIndex =
            serde_json::from_str(&serde_json::to_string(&index).unwrap()).unwrap();
        loaded.reindex();
        assert_eq!(loaded.search("milk"), index.search("milk"));
        loaded.remove("1");
        assert!(loaded.is_empty());
    }

    #[test]
    fn levenshtein_respects_its_budget() {
        let chars = |s: &str| s.chars().collect::<Vec<_>>();
        assert_eq!(
            bounded_levenshtein(&chars("report"), &chars("reprot"), 2),
            Some(2)
        );
        assert_eq!(
            bounded_levenshtein(&chars("report"), &chars("reprot"), 1),
            None
        );
        assert_eq!(
            bounded_levenshtein(&chars("kitten"), &chars("sitting"), 3),
            Some(3)
        );
    }
}
