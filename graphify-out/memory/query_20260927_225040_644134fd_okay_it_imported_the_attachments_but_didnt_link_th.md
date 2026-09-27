---
type: "query"
date: "2026-09-27T22:50:40.466201+00:00"
question: "okay it imported the attachments but didnt link them"
contributor: "graphify"
outcome: "useful"
source_nodes: ["Resolver", "rewriteWikilinks()", "import.ts", "LinkTarget"]
---

# Q: okay it imported the attachments but didnt link them

## Answer

Expanded from original query via vocab: [attachment, wikilink, resolver, rewrite, import, target, path, archive, wrapper, splice, markdown, links]. The importer indexed attachment filenames with extensions only. Added a collision-safe attachment-stem fallback after normal document resolution, verified rerunning an already-imported vault rewrites extension-hidden embeds to attachment:// IDs, and built obsidian-importer 1.4.1.

## Outcome

- Signal: useful

## Source Nodes

- Resolver
- rewriteWikilinks()
- import.ts
- LinkTarget