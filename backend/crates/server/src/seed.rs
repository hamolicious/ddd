//! First-run seeding: a few **deletable** welcome documents demonstrating
//! frontmatter, `fm.path`, task lists and a directive (SPEC §6.5).
//!
//! Runs once, after the first user registers, and only when the workspace has no
//! documents and no graveyard entries (so a workspace emptied on purpose stays
//! empty). Idempotent: guarded by a `meta` marker.
//!
//! Every welcome document is written as **plain markdown through the normal
//! create path** ([`crate::docstore::DocStore::create`]) — no back door into
//! Mongo, so the seeded documents are CRDT documents like any other from their
//! first byte, and they exercise the same parse/materialize path a user's first
//! document does.

use bson::{DateTime as BsonDateTime, doc};

use crate::db;
use crate::docstore::DocStoreError;
use crate::domain::{Actor, Id, is_valid_id};
use crate::error::AppResult;
use crate::state::AppState;

/// `_id` of the `meta` marker recording that seeding already happened.
pub const SEED_MARKER_ID: &str = "seed";

/// One welcome document.
pub struct WelcomeDoc {
    /// Stable id suffix so re-seeding cannot duplicate a document.
    pub slug: &'static str,
    /// Full markdown text, frontmatter included.
    pub text: &'static str,
}

/// The welcome set. Content is fixed text — it must parse cleanly through the
/// shared core and must not rely on any plugin being installed to be readable.
pub fn welcome_documents() -> Vec<WelcomeDoc> {
    vec![
        WelcomeDoc {
            slug: "welcome",
            text: WELCOME,
        },
        WelcomeDoc {
            slug: "tasks",
            text: TASKS,
        },
        WelcomeDoc {
            slug: "folders",
            text: FOLDERS,
        },
        WelcomeDoc {
            slug: "directives",
            text: DIRECTIVES,
        },
    ]
}

/// Seed the welcome documents if the workspace is untouched.
/// Returns how many documents were created (0 when seeding was skipped).
pub async fn seed_if_needed(state: &AppState, actor: &Actor) -> AppResult<usize> {
    if !state.config().seed_welcome_docs {
        return Ok(0);
    }
    if already_seeded(state).await? {
        return Ok(0);
    }

    let mut created = 0_usize;
    for welcome in welcome_documents() {
        let id = stable_id(welcome.slug);
        match state.docs.create(Some(id), welcome.text, actor).await {
            Ok(_) => created += 1,
            // Both mean "this one is already accounted for": a concurrent seed
            // won the race, or the document was deleted for good. Seeding must
            // never fail a registration over it.
            Err(DocStoreError::AlreadyExists(id)) => {
                tracing::debug!(document = %id, "welcome document already exists; skipping");
            }
            Err(DocStoreError::Graveyarded(id)) => {
                tracing::debug!(document = %id, "welcome document was purged; not re-seeding");
            }
            Err(err) => return Err(err.into()),
        }
    }

    mark_seeded(state, created).await?;
    tracing::info!(created, "seeded welcome documents");
    Ok(created)
}

/// `true` when seeding has already run (marker present) or the workspace is
/// non-empty.
///
/// The graveyard counts as "non-empty": a workspace whose documents were all
/// deleted on purpose must stay empty rather than sprouting welcome notes again.
pub async fn already_seeded(state: &AppState) -> AppResult<bool> {
    let marker = state
        .collections
        .raw(db::META)
        .find_one(doc! { "_id": SEED_MARKER_ID })
        .await?;
    if marker.is_some() {
        return Ok(true);
    }

    let documents = state
        .collections
        .documents()
        .count_documents(doc! {})
        .await?;
    if documents > 0 {
        return Ok(true);
    }

    let graveyard = state
        .collections
        .deleted_ids()
        .count_documents(doc! {})
        .await?;
    Ok(graveyard > 0)
}

/// Record that seeding happened, so an emptied workspace is never re-seeded.
async fn mark_seeded(state: &AppState, created: usize) -> AppResult<()> {
    state
        .collections
        .raw(db::META)
        .update_one(
            doc! { "_id": SEED_MARKER_ID },
            doc! { "$set": {
                "seeded_at": BsonDateTime::now(),
                "documents": created as i64,
            } },
        )
        .upsert(true)
        .await?;
    Ok(())
}

/// Crockford base32, the ULID alphabet: no `I`, `L`, `O` or `U`.
const CROCKFORD: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// A deterministic ULID per welcome slug, so a second seeding run collides on
/// `_id` (→ [`DocStoreError::AlreadyExists`], skipped) instead of duplicating the
/// document. The timestamp half is all zeroes: the welcome notes sort as the
/// oldest documents in the workspace, which is exactly what they are.
fn stable_id(slug: &str) -> Id {
    let code: String = slug
        .to_ascii_uppercase()
        .chars()
        .filter(|c| CROCKFORD.contains(&(*c as u8)))
        .take(16)
        .collect();
    let id = format!("{code:0>26}");
    if is_valid_id(&id) {
        id
    } else {
        // Unreachable for the shipped slugs (the unit test pins that); minting a
        // random id is still better than refusing to seed.
        crate::domain::new_id()
    }
}

const WELCOME: &str = r#"---
title: Welcome to Life Manager
path: welcome
tags: [getting-started]
---

# Welcome to Life Manager

Everything here is **one markdown file**: YAML frontmatter at the top, markdown
in the middle, machine data in `%%%` sections at the bottom.

Open the properties panel to edit the frontmatter of this document, or just edit
the text directly — both write to the same place.

You can delete these welcome documents; nothing depends on them.
"#;

const TASKS: &str = r#"---
title: Tasks and lists
path: welcome
tags: [getting-started]
---

# Tasks and lists

- [ ] click a checkbox to toggle it
- [x] finished items look like this
- [ ] right-click (or long-press) a marker for more states

Task markers come from the client's plugin registry, so a workspace with extra
task-state plugins can show more than two states.
"#;

const FOLDERS: &str = r#"---
title: Folders come from frontmatter
path: welcome/examples
date: 2026-01-01
---

# Folders come from frontmatter

This document lives in `welcome/examples` because its `fm.path` says so. Folders
are a *view* over that field — moving a document rewrites one line of text.

There are no directories in the database.
"#;

/// Demonstrates both extension syntaxes of SPEC §6.6 and a `%%%` machine section
/// (SPEC §3.1). Both degrade to plain, readable text with no plugins installed.
const DIRECTIVES: &str = r#"---
title: Directives and machine sections
path: welcome/examples
tags: [getting-started]
---

# Directives and machine sections

Plugins add syntax through named directives, which stay readable as plain text
when the plugin that renders them is not installed:

:::note
This block is a directive. Without the plugin that claims `note`, it is just
these three lines of markdown.
:::

Inline directives work the same way: :emoji[sparkles] is a plugin's business.

Machine data lives in a fenced section at the end, one section per plugin, one
YAML key per line — hidden in read mode, collapsed in the editor.

%%% example
created-by: seed
demo: true
%%%
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn welcome_ids_are_valid_deterministic_ulids() {
        for welcome in welcome_documents() {
            let id = stable_id(welcome.slug);
            assert_eq!(id.len(), 26, "{} -> {id}", welcome.slug);
            assert!(is_valid_id(&id), "{} -> {id} is not a ULID", welcome.slug);
            assert_eq!(id, stable_id(welcome.slug), "ids must be deterministic");
        }
    }

    #[test]
    fn welcome_ids_are_distinct() {
        let mut ids: Vec<Id> = welcome_documents()
            .iter()
            .map(|welcome| stable_id(welcome.slug))
            .collect();
        let total = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), total, "welcome documents must not share an id");
    }

    #[test]
    fn slugs_with_letters_outside_the_alphabet_still_yield_a_ulid() {
        // `O`, `I`, `L` and `U` are not in Crockford base32 and are filtered out.
        let id = stable_id("out-of-alphabet");
        assert!(is_valid_id(&id));
    }

    #[test]
    fn the_welcome_set_demonstrates_the_documented_features() {
        let docs = welcome_documents();
        assert!(
            (3..=4).contains(&docs.len()),
            "SPEC §6.5: a few welcome documents"
        );
        let all: String = docs.iter().map(|doc| doc.text).collect();
        assert!(all.starts_with("---\n"), "frontmatter on the first line");
        assert!(all.contains("\npath: welcome/examples\n"), "fm.path");
        assert!(all.contains("- [ ] "), "a task list");
        assert!(all.contains("- [x] "), "a completed task");
        assert!(all.contains("\n:::note\n"), "a directive");
        assert!(all.contains("\n%%% example\n"), "a machine section");
    }

    #[test]
    fn every_welcome_document_opens_with_frontmatter() {
        for welcome in welcome_documents() {
            assert!(
                welcome.text.starts_with("---\n"),
                "{}: frontmatter opens only if `---` is the literal first line",
                welcome.slug
            );
            assert!(
                welcome.text.ends_with('\n'),
                "{}: keep a trailing newline",
                welcome.slug
            );
            assert!(
                !welcome.text.contains('\r'),
                "{}: seed text must be LF-only",
                welcome.slug
            );
        }
    }
}
