/**
 * Runtime-layer entry: `react-dom` — portals and `flushSync`. CommonJS, so the exports
 * are named explicitly (see `react.js`). The app owns the only React root; plugins use
 * `react-dom/client` only if they mount their own tree somewhere else.
 */

import ReactDOM from "react-dom";

export default ReactDOM;

export const {
  createPortal,
  flushSync,
  unstable_batchedUpdates,
  version,
} = ReactDOM;
