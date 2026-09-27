---
type: "query"
date: "2026-09-27T22:20:58.629430+00:00"
question: "do it; keep it clean"
contributor: "graphify"
outcome: "useful"
source_nodes: ["Uploads", "UploadSession", "obsidian-importer/manifest.json", "WikilinkRewrite", "zip()"]
---

# Q: do it; keep it clean

## Answer

Expanded from graph vocabulary: attachment, attachments, upload, uploads, importer, archive, zip, service, resume, session, wrapper, wikilink. Implemented a clean cross-plugin boundary: attachments 1.1.0 now returns a resumable upload service, and obsidian-importer 1.4.0 declares that dependency. The ZIP reader exposes safe lazy attachment entries, the importer checkpoints upload session IDs in IndexedDB before sending bytes, creates wrapper documents with durable archive/source metadata, avoids duplicate uploads on retry, and rewrites Obsidian embeds plus local Markdown links to attachment URLs. Built and packaged both plugins; all web tests, typechecks, targeted server plugin tests, and archive checks passed.

## Outcome

- Signal: useful

## Source Nodes

- Uploads
- UploadSession
- obsidian-importer/manifest.json
- WikilinkRewrite
- zip()