# DeepSeek Harness Desktop

This directory contains the macOS Apple Silicon Tauri v2 shell. It starts a
local DSH Node sidecar on an ephemeral loopback port, waits for `GET /` to
return `200`, and then points the WebView at the existing DSH Web UI.

## Development

Install the JavaScript dependencies once. The npm DSH runtime ships the `web`
profile, which the desktop shell uses by default. If you are using a DSH
source checkout that includes the custom `desktop` profile, set
`DSH_DESKTOP_PROFILE=desktop`.

For a source-checkout runtime, provide the two development paths used by the
sidecar launcher:

```sh
pnpm install
export DSH_DESKTOP_NODE=/path/to/node
export DSH_DESKTOP_DSH_BIN=/path/to/deepseek-harness/apps/cli/lib/bin.js
pnpm --dir apps/desktop dev
```

When `@deepseek-ai/dsh` is installed in this workspace, the shell discovers
its `lib/bin.js` and the `node` executable automatically.

The `predev`/`prebuild` hook generates the macOS app icons from
`app-icon.svg` using the Tauri CLI.

For a self-contained release build, the `prebuild` hook automatically stages
the current Apple Silicon Node binary and an npm production DSH runtime before
packaging. To use a local DSH source tree instead, set:

```sh
export DSH_DESKTOP_NODE=/path/to/aarch64/node
export DSH_DESKTOP_DSH_ROOT=/path/to/deepseek-harness
pnpm --dir apps/desktop build
```

`DSH_DESKTOP_DSH_PACKAGE` can override the npm package spec used for the
bundled runtime.

## Apple Silicon package

```sh
pnpm --dir apps/desktop build
```

This produces an `aarch64-apple-darwin` `.app` and `.dmg`. Signing and
notarization are intentionally controlled by the invoking CI environment.
