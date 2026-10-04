use serde::{Deserialize, Serialize};

use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

use crate::document::{normalize_input, parse_document};

use super::text::{FIELD_WEIGHTS, TextField};

pub const PREFIX_WEIGHT: f64 = 0.375;
pub const FUZZY_WEIGHT: f64 = 0.45;
pub const FUZZY_SHARE: f64 = 0.2;
pub const MAX_FUZZY_DISTANCE: usize = 6;
pub const MAX_FUZZY_CANDIDATES: u64 = 1000;
pub const MAX_EXPANSIONS_PER_TERM: usize = 64;
pub const MAX_VOCAB_ROWS: usize = 50_000;
const MAX_TOKEN_CHARS: usize = 64;

type FieldTokens = (f64, Vec<(String, Vec<char>)>);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FuzzySpec {
    pub terms: Vec<String>,
    pub fields: Vec<TextField>,
    pub max_distance: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FuzzyMatch {
    pub score: f64,
    pub terms: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FuzzyCandidate {
    pub title: String,
    #[serde(default)]
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Ranked {
    pub index: usize,
    pub score: f64,
    pub terms: Vec<String>,
}

pub fn fuzzy_terms(query: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (_, folded) in words(query) {
        if !out.contains(&folded) {
            out.push(folded);
        }
    }
    out
}

pub fn budget_for(length: usize, max_distance: usize) -> usize {
    ((length as f64 * FUZZY_SHARE).round() as usize)
        .max(usize::from(length >= 3))
        .min(max_distance)
        .min(MAX_FUZZY_DISTANCE)
}

pub fn fold_word(word: &str) -> String {
    word.nfd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .collect()
}

pub struct VocabularyFilter {
    pub low: String,
    pub high: String,
    pub shortest: usize,
    pub longest: usize,
    pub first: String,
    pub second: String,
}

pub fn vocabulary_filter(terms: &[String], max_distance: usize) -> Vec<VocabularyFilter> {
    terms
        .iter()
        .map(|term| {
            let length = term.chars().count();
            let budget = budget_for(length, max_distance);
            let mut chars = term.chars();
            let first = chars.next().map(String::from).unwrap_or_default();
            let second = chars
                .next()
                .map(String::from)
                .unwrap_or_else(|| first.clone());
            VocabularyFilter {
                low: term.clone(),
                high: format!("{term}\u{10FFFF}"),
                shortest: length.saturating_sub(budget),
                longest: length + budget,
                first,
                second,
            }
        })
        .collect()
}

pub fn expand_terms(terms: &[String], max_distance: usize, vocabulary: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for term in terms {
        let query: Vec<char> = term.chars().collect();
        let budget = budget_for(query.len(), max_distance);
        let mut close: Vec<(usize, usize, &String)> = Vec::new();
        for word in vocabulary {
            let candidate: Vec<char> = word.chars().collect();
            if candidate.starts_with(&query) {
                close.push((0, candidate.len(), word));
            } else if budget > 0
                && candidate.len().abs_diff(query.len()) <= budget
                && let Some(distance) = bounded_distance(&query, &candidate, budget)
            {
                close.push((distance, candidate.len(), word));
            }
        }
        close.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(b.2)));
        for (_, _, word) in close.into_iter().take(MAX_EXPANSIONS_PER_TERM) {
            if !out.contains(word) {
                out.push(word.clone());
            }
        }
    }
    out
}

fn words(text: &str) -> impl Iterator<Item = (&str, String)> + '_ {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(|word| {
            let folded = fold_word(&word.chars().take(MAX_TOKEN_CHARS).collect::<String>());
            (word, folded)
        })
}

fn field_text(candidate: &FuzzyCandidate, field: TextField) -> String {
    match field {
        TextField::Title => candidate.title.clone(),
        TextField::Content => {
            let parsed = parse_document(&candidate.content);
            let normalized = normalize_input(&candidate.content);
            parsed.body_span.slice(&normalized).to_string()
        }
        TextField::Fm => {
            let parsed = parse_document(&candidate.content);
            let mut out = Vec::new();
            for entry in super::extract::fm_entries(&parsed.fm) {
                match entry.value {
                    crate::value::Value::Str(text) => out.push(text),
                    crate::value::Value::Int(n) => out.push(n.to_string()),
                    crate::value::Value::Float(f) => out.push(f.to_string()),
                    crate::value::Value::Bool(b) => out.push(b.to_string()),
                    _ => {}
                }
            }
            out.join(" ")
        }
    }
}

fn weight(query: &[char], token: &[char], budget: usize) -> f64 {
    if token == query {
        return 1.0;
    }
    let longer = token.len() as f64;
    if token.starts_with(query) {
        let distance = (token.len() - query.len()) as f64;
        return PREFIX_WEIGHT * longer / (longer + 0.3 * distance);
    }
    if budget == 0 || token.len().abs_diff(query.len()) > budget {
        return 0.0;
    }
    match bounded_distance(query, token, budget) {
        Some(distance) => FUZZY_WEIGHT * longer / (longer + distance as f64),
        None => 0.0,
    }
}

pub fn bounded_distance(a: &[char], b: &[char], budget: usize) -> Option<usize> {
    let width = b.len() + 1;
    let mut rows = vec![vec![0usize; width]; a.len() + 1];
    for (j, cell) in rows[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=a.len() {
        rows[i][0] = i;
        let mut row_min = rows[i][0];
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut best = (rows[i - 1][j - 1] + cost)
                .min(rows[i - 1][j] + 1)
                .min(rows[i][j - 1] + 1);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                best = best.min(rows[i - 2][j - 2] + 1);
            }
            rows[i][j] = best;
            row_min = row_min.min(best);
        }
        if row_min > budget {
            return None;
        }
    }
    let distance = rows[a.len()][b.len()];
    (distance <= budget).then_some(distance)
}

fn queries(spec: &FuzzySpec) -> Vec<(Vec<char>, usize)> {
    spec.terms
        .iter()
        .map(|term| {
            let chars: Vec<char> = term.chars().collect();
            let budget = budget_for(chars.len(), spec.max_distance);
            (chars, budget)
        })
        .collect()
}

fn score_with(
    queries: &[(Vec<char>, usize)],
    spec: &FuzzySpec,
    candidate: &FuzzyCandidate,
) -> Option<FuzzyMatch> {
    let fields: Vec<FieldTokens> = spec
        .fields
        .iter()
        .map(|field| {
            let boost = FIELD_WEIGHTS[match field {
                TextField::Title => 0,
                TextField::Content => 1,
                TextField::Fm => 2,
            }];
            let text = field_text(candidate, *field);
            let tokens = words(&text)
                .map(|(surface, folded)| (surface.to_string(), folded.chars().collect()))
                .collect();
            (boost, tokens)
        })
        .collect();
    let mut score = 0.0;
    let mut matched = 0usize;
    let mut terms: Vec<String> = Vec::new();
    for (query, budget) in queries {
        let mut best = 0.0;
        let mut surface: Option<&str> = None;
        for (boost, tokens) in &fields {
            for (word, token) in tokens {
                let found = boost * weight(query, token, *budget);
                if found > best {
                    best = found;
                    surface = Some(word);
                }
            }
        }
        if let Some(word) = surface {
            score += best;
            matched += 1;
            if !terms.iter().any(|known| known == word) {
                terms.push(word.to_string());
            }
        }
    }
    (matched > 0).then_some(FuzzyMatch {
        score: score * matched as f64,
        terms,
    })
}

pub fn score_candidate(spec: &FuzzySpec, candidate: &FuzzyCandidate) -> Option<FuzzyMatch> {
    score_with(&queries(spec), spec, candidate)
}

pub fn rank(spec: &FuzzySpec, candidates: &[FuzzyCandidate]) -> Vec<Ranked> {
    let queries = queries(spec);
    let mut ranked: Vec<Ranked> = candidates
        .iter()
        .enumerate()
        .filter_map(|(index, candidate)| {
            score_with(&queries, spec, candidate).map(|found| Ranked {
                index,
                score: found.score,
                terms: found.terms,
            })
        })
        .collect();
    ranked.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| a.index.cmp(&b.index))
    });
    ranked
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(title: &str, body: &str) -> FuzzyCandidate {
        FuzzyCandidate {
            title: title.into(),
            content: format!("# {title}\n\n{body}\n"),
        }
    }

    fn spec(query: &str) -> FuzzySpec {
        FuzzySpec {
            terms: fuzzy_terms(query),
            fields: vec![TextField::Title, TextField::Content, TextField::Fm],
            max_distance: MAX_FUZZY_DISTANCE,
        }
    }

    #[test]
    fn transpositions_and_missing_letters_count_as_one_edit() {
        let found = rank(
            &spec("teh qick borwn"),
            &[
                candidate("The quick brown fox", ""),
                candidate("Groceries", "milk"),
            ],
        );
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].index, 0);
        assert_eq!(found[0].terms, vec!["The", "quick", "brown"]);
    }

    #[test]
    fn titles_outrank_bodies_and_more_terms_outrank_fewer() {
        let found = rank(
            &spec("milk"),
            &[candidate("Notes", "milk"), candidate("Milk", "notes")],
        );
        assert_eq!(
            found.iter().map(|r| r.index).collect::<Vec<_>>(),
            vec![1, 0]
        );
        let found = rank(
            &spec("milk bread"),
            &[
                candidate("A", "milk milk milk"),
                candidate("B", "milk bread"),
            ],
        );
        assert_eq!(found[0].index, 1);
    }

    #[test]
    fn the_distance_budget_grows_with_the_word() {
        assert!(rank(&spec("zebra"), &[candidate("Work", "quarterly report")]).is_empty());
        assert_eq!(
            rank(&spec("reprt"), &[candidate("Work", "quarterly report")]).len(),
            1
        );
        let strict = FuzzySpec {
            max_distance: 0,
            ..spec("reprt")
        };
        assert!(rank(&strict, &[candidate("Work", "quarterly report")]).is_empty());
    }

    #[test]
    fn vocabulary_words_close_to_each_term_are_expanded() {
        let vocabulary: Vec<String> = [
            "sub", "subway", "sbu", "milk", "silk", "mile", "zebra", "brown",
        ]
        .iter()
        .map(|w| w.to_string())
        .collect();
        assert_eq!(
            expand_terms(&fuzzy_terms("sbu"), MAX_FUZZY_DISTANCE, &vocabulary),
            vec!["sbu", "sub"]
        );
        assert_eq!(
            expand_terms(&fuzzy_terms("mlik"), MAX_FUZZY_DISTANCE, &vocabulary),
            vec!["milk"]
        );
        assert!(
            expand_terms(&fuzzy_terms("su"), MAX_FUZZY_DISTANCE, &vocabulary)
                .contains(&"subway".to_string())
        );
        assert!(expand_terms(&fuzzy_terms("qqqq"), MAX_FUZZY_DISTANCE, &vocabulary).is_empty());
    }

    #[test]
    fn accents_fold_on_both_sides() {
        assert_eq!(fuzzy_terms("Brûlée"), vec!["brulee"]);
        let found = rank(&spec("brulee"), &[candidate("Crème brûlée", "")]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].terms, vec!["brûlée"]);
        assert_eq!(
            expand_terms(
                &fuzzy_terms("brûlée"),
                MAX_FUZZY_DISTANCE,
                &["brulee".to_string()]
            ),
            vec!["brulee"]
        );
    }

    #[test]
    fn one_row_scores_the_same_alone_as_in_a_ranking() {
        let all = [candidate("Milk", ""), candidate("Notes", "buy milk")];
        let ranked = rank(&spec("milk"), &all);
        for found in &ranked {
            let alone = score_candidate(&spec("milk"), &all[found.index]).unwrap();
            assert_eq!(alone.score, found.score);
            assert_eq!(alone.terms, found.terms);
        }
        assert!(score_candidate(&spec("milk"), &candidate("Groceries", "bread")).is_none());
    }
}
