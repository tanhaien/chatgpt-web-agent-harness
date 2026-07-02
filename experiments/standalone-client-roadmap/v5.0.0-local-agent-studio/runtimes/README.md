# Bundled Runtime Layout

Release packages can include a Node.js runtime here so customers do not need to
install Node manually.

Expected layout:

```text
runtimes/
  node/
    win32-x64/node.exe
    win32-arm64/node.exe
    darwin-x64/node
    darwin-arm64/node
    linux-x64/node
    linux-arm64/node
```

The desktop launcher resolves Node in this order:

1. `LCA_NODE_PATH`
2. packaged runtime under Electron `resources/runtimes/node/<platform>-<arch>/`
3. source-tree runtime under `runtimes/node/<platform>-<arch>/`
4. system `node`

Use `npm run runtime:verify` to inspect the selected runtime. Use
`npm run runtime:verify -- --require-bundled` in release CI after placing the
runtime files.
