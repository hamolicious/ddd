/**
 * Runtime-layer entry: the automatic JSX runtime every plugin's TSX compiles to.
 * CommonJS, so the three exports are named explicitly (see `react.js`).
 */

import jsxRuntime from "react/jsx-runtime";

export const { Fragment, jsx, jsxs } = jsxRuntime;
