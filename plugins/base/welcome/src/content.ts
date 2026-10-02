const id = (n: number): string => `000000000000000000000000W${String(n).padStart(2, "0")}`.slice(-26);

export const MARKER_ID = id(0);

export const IDS = {
  welcome: id(1),
  writing: id(2),
  tasks: id(3),
  properties: id(4),
  folders: id(5),
  embeds: id(6),
  files: id(7),
  finding: id(8),
  history: id(9),
  keyboard: id(10),
  directives: id(11),
} as const;

export interface TourNote {
  readonly id: string;
  readonly text: string;
  readonly parent?: string;
}

const link = (title: string, target: string): string => `[${title}](doc://${target})`;

export const TOUR: readonly TourNote[] = [
  {
    id: IDS.welcome,
    text: `---
title: Welcome to ddd
tags: [tour]
---

# Welcome to ddd

Every note is one markdown file. Everything you see is built from plugins, and each of
these notes shows one of them. Delete any of them when you are done; nothing depends on
them.

- ${link("Writing in markdown", IDS.writing)}
- ${link("Tasks and lists", IDS.tasks)}
- ${link("Properties", IDS.properties)}
- ${link("Folders are notes", IDS.folders)}
- ${link("Embedding notes", IDS.embeds)}
- ${link("Files and images", IDS.files)}
- ${link("Finding things", IDS.finding)}
- ${link("History and changes", IDS.history)}
- ${link("Keyboard and commands", IDS.keyboard)}
- ${link("Directives and machine sections", IDS.directives)}

Switch between **Read** and **Edit** with the tabs above a note (the round button on a
phone).
`,
  },
  {
    id: IDS.writing,
    parent: IDS.welcome,
    text: `---
title: Writing in markdown
tags: [tour]
---

# Writing in markdown

Open **Edit** to see the source of this note.

## Text

**Bold**, *italic*, ~~struck~~, \`code\`, and [a link](https://example.com).

> A quote, for the things worth keeping.

## Lists

1. Numbered
2. Lists
   - nest
   - too

## Code

\`\`\`js
const greeting = "hello";
\`\`\`

## Tables

| Feature | Where |
|---|---|
| Folders | the sidebar |
| History | the side panel |
| Commands | Ctrl/⌘ P |

---

A line like the one above separates sections.
`,
  },
  {
    id: IDS.tasks,
    parent: IDS.welcome,
    text: `---
title: Tasks and lists
tags: [tour]
---

# Tasks and lists

- [ ] Click a box to tick it
- [x] Ticked things fade
- [ ] Right-click a box (long-press on a phone) for more states
- [ ] Tasks can sit anywhere in a note
  - [ ] including under other tasks

Ticking works in **Read** mode too: the note changes, and every device sees it.
`,
  },
  {
    id: IDS.properties,
    parent: IDS.welcome,
    text: `---
title: Properties
tags: [tour, example]
status: in progress
priority: 2
due: 2026-12-31
done: false
people: [Alex, Sam]
---

# Properties

The block at the top of a note (between the \`---\` lines, in **Edit**) holds its
properties. **Read** shows them as the table above this text.

- \`title\` names the note
- \`tags\`, dates, numbers, yes/no and lists all work

Filter and sort the note list by any of them.
`,
  },
  {
    id: IDS.folders,
    parent: IDS.welcome,
    text: `---
title: Folders are notes
tags: [tour]
---

# Folders are notes

This note sits inside **Welcome to ddd** in the sidebar: any note can hold other
notes, and one that does is a folder.

- Drag a note onto another in the sidebar to put it inside
- Drag it onto the top or bottom edge of a note to put it next to that one
- A note's ⋯ menu moves, renames or deletes it
`,
  },
  {
    id: IDS.embeds,
    parent: IDS.welcome,
    text: `---
title: Embedding notes
tags: [tour]
---

# Embedding notes

A link to another note: ${link("Tasks and lists", IDS.tasks)}.

The same with a \`!\` in front shows the note right here:

![](doc://${IDS.tasks})

Settings → Markdown sets how many levels deep embeds go.
`,
  },
  {
    id: IDS.files,
    parent: IDS.welcome,
    text: `---
title: Files and images
tags: [tour]
---

# Files and images

- **Paste** or **drop** a file into a note in **Edit** to upload it
- Or type \`/attach\` to pick one
- Images, PDFs, audio, video and text files show right in the note
- A file's menu switches it between a preview and a link, or turns it into a note of its
  own

Settings → Attachments picks what each file type pastes as, and which viewer shows it.
Admin → Orphan files lists files no note uses any more.
`,
  },
  {
    id: IDS.finding,
    parent: IDS.welcome,
    text: `---
title: Finding things
tags: [tour]
---

# Finding things

- **Search** above the note list finds words in titles and text, offline too
- The **funnel** filters by any property; the **sort** button orders by one
- **Trash** keeps deleted notes for 30 days; restore them from there
- A folder in the sidebar shows only its notes
`,
  },
  {
    id: IDS.history,
    parent: IDS.welcome,
    text: `---
title: History and changes
tags: [tour]
---

# History and changes

Every edit is kept. Open the **side panel** with its button: top right on a computer, in
the bottom toolbar on a phone.

- Each change shows who made it, when, and what it added and removed
- The **eye** shows a change as a diff, or the whole note as it was then
- **Revert** undoes one change and keeps everything after it
- The **camera** takes a snapshot you can restore later

Try it: edit this line, then look at the side panel.
`,
  },
  {
    id: IDS.keyboard,
    parent: IDS.welcome,
    text: `---
title: Keyboard and commands
tags: [tour]
---

# Keyboard and commands

- **Ctrl/⌘ P** opens the command palette: every action, searchable
- **Hard refresh (clear app cache)** in the palette reloads the app fresh from the server,
  if it seems stuck on an old version. You stay signed in and keep your notes
- Type **/** in **Edit** for things to insert
- Settings → Keybindings changes any shortcut
- Settings → Toolbar arranges the buttons in the top and bottom bars, separately for a
  computer and a phone
- Settings → Appearance switches between light and dark
`,
  },
  {
    id: IDS.directives,
    parent: IDS.welcome,
    text: `---
title: Directives and machine sections
tags: [tour]
---

# Directives and machine sections

Plugins can add their own syntax. It stays readable as plain text when the plugin is
not installed:

:::note
This block is a directive. Without a plugin that shows \`note\` blocks, it is just
these lines of markdown.
:::

Plugins keep their own data at the end of a note, in a section like the one below.
**Read** hides it; **Edit** folds it away.

%%% welcome
seeded: true
%%%
`,
  },
];

export const MARKER_TEXT = `---
title: Welcome tour
machine: true
---

The welcome plugin offered its tour here once; this note keeps it from doing so again.
`;
