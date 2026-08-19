# Bundled runtime

Production builds should place the Apple Silicon Node runtime and the DSH
CLI bundle under this directory:

```text
runtime/
  node/bin/node
  dsh/apps/cli/lib/bin.js
```

The shell also supports `DSH_DESKTOP_NODE` and `DSH_DESKTOP_DSH_BIN` for
development and CI smoke tests. The runtime is intentionally not committed to
the repository.
