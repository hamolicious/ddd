/**
 * lm/router.route@1.0.0: slot, owned by `router`.
 *
 * One route. `path` is a pattern with `:name` segments (`/doc/:id`); matches are passed to
 * the view as `params`. Hash-based, so the app works from `file://` in the shell with no
 * server rewrites. The more specific pattern matches first; seat order only breaks ties.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

/** The protocol this package describes. */
export type ProtocolId = "lm/router.route";
export type ProtocolVersion = "1.0.0";

export interface Route {
  readonly path: string;
  /** The `lm/main.view` id to render. */
  readonly view: string;
  /** Default-seat hint only; the wiring's seat order wins. */
  readonly order?: number;
}
