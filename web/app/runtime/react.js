/**
 * Runtime-layer entry: **React 18**. One copy for the kernel and every plugin — two
 * would break hooks, context and `instanceof` across every plugin boundary.
 *
 * The named exports are listed explicitly rather than re-exported with `export *`,
 * because React ships as CommonJS: `export * from "react"` produces a module with *no*
 * named exports at all (the bundler cannot know them statically), and the failure looks
 * like "useState is not exported by react" from inside somebody else's plugin. The
 * destructuring below is the one form that is both correct and obvious.
 *
 * Adding a React export to this list is a kernel-contract change in the same sense as
 * any other runtime-layer change — see SPEC §6.4.
 */

import React from "react";

export default React;

export const {
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version,
} = React;
