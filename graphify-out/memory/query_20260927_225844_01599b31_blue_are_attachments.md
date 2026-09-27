---
type: "query"
date: "2026-09-27T22:58:44.986933+00:00"
question: "blue are attachments"
contributor: "graphify"
outcome: "corrected"
correction: "Attachment references must target their wrapper document IDs with doc:// so the graph can connect them; the wrapper retains the attachment:// blob embed."
source_nodes: ["Graph", "WorkspaceIndex", "LinkTarget", "rewriteWikilinks()"]
---

# Q: blue are attachments

## Answer

Expanded from original query via vocab: [graph, attachment, attachments, edge, edges, indexer, index, reference, links, document, projection, workspace]. The graph builds edges only from document references in WorkspaceIndex.connections; attachment:// IDs are counted as blobs, not graph connections. The importer created wrapper documents but wrote source-note links directly to blob IDs. Version 1.4.2 now writes doc:// wrapper references and migrates attachment:// links produced by 1.4.x when the same vault is selected again.

## Outcome

- Signal: corrected
- Correction: Attachment references must target their wrapper document IDs with doc:// so the graph can connect them; the wrapper retains the attachment:// blob embed.

## Source Nodes

- Graph
- WorkspaceIndex
- LinkTarget
- rewriteWikilinks()