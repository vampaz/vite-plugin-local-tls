---
'@vampaz/vite-plugin-local-tls': minor
---

- **Behavior change:** automatic trust and service installation at Vite startup now require an attached terminal. When Vite runs detached, the plugin no longer opens authorization prompts; it refuses and prints the exact `vite-local-tls` command to run. Direct `vite-local-tls trust` and `vite-local-tls service install` commands are not subject to that gate and still authorize through the native macOS dialog, even while detached.
- Unanswered macOS authorization prompts now fail after 120 seconds with `The operating system authorization prompt timed out after 120 seconds` instead of waiting indefinitely.
- Warn once when the plaintext dev server is reachable from devices on your local network, pointing at the `server.host` setting.
- Port-443 bind conflicts now name the listening process: `lsof` on macOS and Linux, `Get-NetTCPConnection` plus `Get-Process` on Windows.
- Local URL resolution failures during startup are now logged at debug level instead of being discarded.
