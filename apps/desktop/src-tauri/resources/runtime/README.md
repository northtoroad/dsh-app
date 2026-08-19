# Bundled runtime

Production builds place the target-architecture Node runtime and the DSH CLI
bundle under this directory:

```text
runtime/
  node/
    bin/node
    LICENSE
  dsh/node_modules/@deepseek-ai/dsh/lib/bin.js
```

`scripts/stage-runtime.mjs` selects an arm64 or x64 Node distribution from the
requested Rust target, verifies the official Node checksum, and installs DSH
dependencies with the same target architecture. Generated runtime files are
not committed to the repository.

The shell also supports `DSH_DESKTOP_NODE` and `DSH_DESKTOP_DSH_BIN` for
development and CI smoke tests. The runtime is intentionally not committed to
the repository.
