//! The query engine: the workspace's rows, their text index and the folder tree, and
//! [`Engine::run`], which answers a [`Plan`] over them.
//!
//! The one stateful thing in this crate, and still deterministic: the same rows and
//! the same plan give the same answer on the server and in the browser.

use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use super::QueryError;
use super::doc::Doc;
use super::plan::{Plan, Sort, decode_cursor, encode_cursor};
use super::snippet::{Snippet, snippet_for};
use super::text::{TEXT_INDEX_VERSION, TextHit, TextIndex};
use crate::filter::{
    FieldPath, FieldRef, Graph, SortKey, SortOrder, compare_by_key, evaluate_in, resolve_field,
};
use crate::value::Value;

/// Where a note lists its children: the `folders` plugin's machine section.
pub const DEFAULT_CHILDREN_FIELD: &str = "plugins.folders.children";

/// What a children list may prefix an id with.
const DOC_PREFIX: &str = "doc://";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Engine {
    version: u32,
    docs: HashMap<String, Doc>,
    text: TextIndex,
    children_field: FieldPath,
    /// Parent → its children, read from each parent's own list.
    #[serde(skip)]
    children: HashMap<String, Vec<String>>,
}

impl Default for Engine {
    fn default() -> Engine {
        Engine::new()
    }
}

/// One answer: a page of rows, and how many there are in all.
#[derive(Debug, Clone)]
pub struct Answer<'a> {
    pub rows: Vec<Found<'a>>,
    /// Every match, before paging.
    pub total: usize,
    /// Present while there is another page.
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Found<'a> {
    pub doc: &'a Doc,
    /// Present when the plan had text.
    pub hit: Option<Hit>,
}

/// Why a row matched the plan's text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Hit {
    pub score: f64,
    /// The indexed terms it matched, for highlighting.
    pub terms: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<Snippet>,
}

/// An [`Answer`] by id, for a caller that has the rows already (the browser) or
/// sends them on (the server): `{ ids, total, next_cursor?, hits: { id: Hit } }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Page {
    pub ids: Vec<String>,
    pub total: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub hits: HashMap<String, Hit>,
}

impl Answer<'_> {
    pub fn page(&self) -> Page {
        Page {
            ids: self.rows.iter().map(|found| found.doc.id.clone()).collect(),
            total: self.total,
            next_cursor: self.next_cursor.clone(),
            hits: self
                .rows
                .iter()
                .filter_map(|found| Some((found.doc.id.clone(), found.hit.clone()?)))
                .collect(),
        }
    }
}

impl Engine {
    pub fn new() -> Engine {
        Engine {
            version: TEXT_INDEX_VERSION,
            docs: HashMap::new(),
            text: TextIndex::new(),
            children_field: FieldPath::parse(DEFAULT_CHILDREN_FIELD).expect("a valid path"),
            children: HashMap::new(),
        }
    }

    /// Read children lists from another field than [`DEFAULT_CHILDREN_FIELD`].
    pub fn with_children_field(mut self, field: FieldPath) -> Engine {
        self.children_field = field;
        self.rebuild_tree();
        self
    }

    pub fn len(&self) -> usize {
        self.docs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.docs.is_empty()
    }

    pub fn get(&self, id: &str) -> Option<&Doc> {
        self.docs.get(id)
    }

    /// Add a row, or replace the one with its id.
    pub fn upsert(&mut self, doc: Doc) {
        self.text.upsert(&doc);
        let list = self.children_list(&doc);
        if list.is_empty() {
            self.children.remove(&doc.id);
        } else {
            self.children.insert(doc.id.clone(), list);
        }
        self.docs.insert(doc.id.clone(), doc);
    }

    pub fn upsert_all(&mut self, docs: impl IntoIterator<Item = Doc>) {
        for doc in docs {
            self.upsert(doc);
        }
    }

    /// Take a row out (a purge); nothing happens for an unknown id.
    pub fn remove(&mut self, id: &str) {
        if self.docs.remove(id).is_some() {
            self.text.remove(id);
            self.children.remove(id);
        }
    }

    /// The engine as JSON, to load again with [`Engine::from_json_str`] instead of
    /// re-indexing every row.
    pub fn to_json_string(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// `None` for anything [`Engine::to_json_string`] did not write, or wrote with
    /// another index version: the caller rebuilds from the rows.
    pub fn from_json_str(input: &str) -> Option<Engine> {
        let mut engine: Engine = serde_json::from_str(input).ok()?;
        if engine.version != TEXT_INDEX_VERSION {
            return None;
        }
        engine.text.reindex();
        engine.rebuild_tree();
        Some(engine)
    }

    /// Answer a plan.
    pub fn run(&self, plan: &Plan) -> Result<Answer<'_>, QueryError> {
        plan.validate()?;
        let offset = match &plan.cursor {
            Some(cursor) => decode_cursor(cursor, plan.fingerprint())?,
            None => plan.offset.unwrap_or(0) as usize,
        };

        let hits: Option<HashMap<String, TextHit>> = (!plan.text.trim().is_empty()).then(|| {
            self.text
                .search(&plan.text)
                .into_iter()
                .map(|hit| (hit.id.clone(), hit))
                .collect()
        });
        let candidates: Box<dyn Iterator<Item = &Doc>> = match &hits {
            Some(hits) => Box::new(hits.keys().filter_map(|id| self.docs.get(id))),
            None => Box::new(self.docs.values()),
        };

        let graph = RunGraph {
            engine: self,
            cache: RefCell::new(HashMap::new()),
        };
        let mut matched: Vec<&Doc> = Vec::new();
        for doc in candidates {
            if !plan.trash.admits(doc.deleted) {
                continue;
            }
            if let Some(filter) = &plan.filter
                && !evaluate_in(filter, &doc.row(), Some(&graph))?
            {
                continue;
            }
            matched.push(doc);
        }

        let score = |doc: &Doc| {
            hits.as_ref()
                .and_then(|hits| hits.get(&doc.id))
                .map_or(0.0, |hit| hit.score)
        };
        let sort = effective_sort(plan, hits.is_some());
        matched.sort_by(|a, b| {
            for key in &sort {
                let ordering = match key {
                    Sort::Relevance => score(b).total_cmp(&score(a)),
                    Sort::Field(key) => compare_by_key(&a.row(), &b.row(), key),
                };
                if ordering != Ordering::Equal {
                    return ordering;
                }
            }
            a.id.cmp(&b.id)
        });

        let total = matched.len();
        let end = offset.saturating_add(plan.page_size()).min(total);
        let next_cursor = (end < total).then(|| encode_cursor(end, plan.fingerprint()));
        let rows = matched
            .get(offset.min(total)..end)
            .unwrap_or_default()
            .iter()
            .map(|doc| Found {
                doc,
                hit: hits
                    .as_ref()
                    .and_then(|hits| hits.get(&doc.id))
                    .map(|hit| Hit {
                        score: hit.score,
                        terms: hit.terms.clone(),
                        snippet: if plan.snippets {
                            snippet_for(&doc.content, &hit.terms)
                        } else {
                            None
                        },
                    }),
            })
            .collect();
        Ok(Answer {
            rows,
            total,
            next_cursor,
        })
    }

    /// Does row `id` match the plan's filter and trash scope? Text and paging aside:
    /// what a live query asks of a changed row to know whether to run again.
    pub fn admits(&self, plan: &Plan, id: &str) -> Result<bool, QueryError> {
        let Some(doc) = self.docs.get(id) else {
            return Ok(false);
        };
        if !plan.trash.admits(doc.deleted) {
            return Ok(false);
        }
        let graph = RunGraph {
            engine: self,
            cache: RefCell::new(HashMap::new()),
        };
        match &plan.filter {
            Some(filter) => Ok(evaluate_in(filter, &doc.row(), Some(&graph))?),
            None => Ok(true),
        }
    }

    fn children_list(&self, doc: &Doc) -> Vec<String> {
        match resolve_field(&doc.row(), &self.children_field) {
            FieldRef::Present(Value::List(items)) => items
                .iter()
                .filter_map(Value::as_str)
                .map(|id| id.strip_prefix(DOC_PREFIX).unwrap_or(id).to_string())
                .filter(|id| !id.is_empty())
                .collect(),
            _ => Vec::new(),
        }
    }

    fn rebuild_tree(&mut self) {
        let children: HashMap<String, Vec<String>> = self
            .docs
            .values()
            .map(|doc| (doc.id.clone(), self.children_list(doc)))
            .filter(|(_, list)| !list.is_empty())
            .collect();
        self.children = children;
    }

    fn descendants(&self, of: &str) -> HashSet<String> {
        let mut seen = HashSet::new();
        let mut queue = vec![of.to_string()];
        while let Some(parent) = queue.pop() {
            for child in self.children.get(&parent).into_iter().flatten() {
                if seen.insert(child.clone()) {
                    queue.push(child.clone());
                }
            }
        }
        seen
    }
}

/// No sort named: best match while there is text, then last updated.
fn effective_sort(plan: &Plan, has_text: bool) -> Vec<Sort> {
    let updated = Sort::Field(SortKey {
        field: FieldPath::parse("updated_at").expect("a valid path"),
        order: SortOrder::Desc,
    });
    let sort: Vec<Sort> = if plan.sort.is_empty() {
        if has_text {
            vec![Sort::Relevance, updated]
        } else {
            vec![updated]
        }
    } else {
        plan.sort.clone()
    };
    sort.into_iter()
        .filter(|key| has_text || *key != Sort::Relevance)
        .collect()
}

/// The folder tree for one run, with each parent's set worked out once.
struct RunGraph<'a> {
    engine: &'a Engine,
    cache: RefCell<HashMap<(String, bool), HashSet<String>>>,
}

impl Graph for RunGraph<'_> {
    fn is_child(&self, id: &str, of: &str, deep: bool) -> bool {
        let mut cache = self.cache.borrow_mut();
        let set = cache.entry((of.to_string(), deep)).or_insert_with(|| {
            if deep {
                self.engine.descendants(of)
            } else {
                self.engine
                    .children
                    .get(of)
                    .into_iter()
                    .flatten()
                    .cloned()
                    .collect()
            }
        });
        set.contains(id)
    }

    fn is_parent(&self, id: &str, of: &str) -> bool {
        self.engine
            .children
            .get(id)
            .is_some_and(|children| children.iter().any(|child| child == of))
    }
}
