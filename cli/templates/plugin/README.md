# {{name}}

A ddd plugin (`{{id}}`).

```bash
npm install
npm run types -- --server https://your-server   # or set DDD_SERVER
npm run check    # type-check
npm run build    # the installed layout, in dist/
```

- `manifest.json`: id, version, dependencies and capabilities.
- `src/index.tsx`: `activate(kernel)` runs when the plugin loads; named exports are what
  plugins depending on this one import as `plugin:{{id}}`.
- `src/style.css`: linked when the plugin activates.
- `types/`: `@kernel` and each dependency's `plugin:<id>`, as your server serves them.
  Refresh them after the server or `dependencies` change.
- `tools/`: the reference build from the ddd repository. Do not edit.
