---
type: "query"
date: "2026-09-27T22:06:38.296573+00:00"
question: "what would it take to import attachments too?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["upload()", "createUploads()", "zip()", "Attachment", "SessionApi"]
---

# Q: what would it take to import attachments too?

## Answer

Expanded from original query via graph vocab: attachment, attachments, upload, plugin, capability, filesystem, binary, blob, archive, zip, reference, storage. The server already has authenticated resumable chunk uploads in routes/uploads.rs, GridFS attachment storage in routes/attachments.rs, and plugin access through kernel.session.fetch. The importer work is to expose non-Markdown ZIP entries lazily with safety limits, upload each through the existing API, persist source-path to attachment and wrapper-document identity for restart-safe deduplication, and rewrite Obsidian embeds and Markdown file links to attachment:// IDs. A clean implementation should expose a small upload service from the attachments base plugin instead of duplicating its private uploader. No database schema or new backend endpoint is required; exact crash-safe idempotency may warrant a server idempotency key or a durable importer checkpoint.

## Outcome

- Signal: useful

## Source Nodes

- upload()
- createUploads()
- zip()
- Attachment
- SessionApi