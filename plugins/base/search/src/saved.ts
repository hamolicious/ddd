/**
 * A search saved to a note.
 *
 * The note carries the search in one frontmatter key, `saved-search`, holding the same
 * query string the list's URL does (`spec.ts`) — `q=milk&where=…`. One key, not one per
 * part, so updating a saved search is one splice and a half-applied edit cannot exist.
 * Frontmatter rather than a `%%%` section because it is the user's: they can see it, copy
 * the note, or delete the line to turn the note back into a plain one.
 *
 * Its `type` says which views show it; the view plugins offer the `document.mode`s that
 * claim it (`_shared/saved-view.ts`).
 */

export {
  SAVED_SEARCH_KEY,
  isSavedSearch,
  savedSearchNoteText,
  savedSearchOf,
  savedSearchTitle,
} from "../../_shared/saved-view.js";
