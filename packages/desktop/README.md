# Desktop host packages

`desktop-shell` defines the small host-side service boundary used by the DSH
runtime. `desktop-shell-tcp` is its loopback TCP provider: it reads the bridge
port/token injected by the Tauri shell, authenticates with a per-launch hello
frame, and forwards notifications and file reveal requests as JSON lines.

When the bridge environment is absent the provider is a no-op, preserving the
same `desktop` profile for terminal/browser use.
