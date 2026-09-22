---
'@vampaz/vite-plugin-local-tls': minor
---

- **Behavior change:** the automatic trust and initial service-install flow at Vite startup now requires an attached terminal. When Vite runs detached, that flow refuses and prints the exact `vite-local-tls` command to run. Direct `vite-local-tls trust` and `vite-local-tls service install` commands and idle service updates are not subject to that gate and can still authorize through the native macOS dialog while detached.
- Unanswered macOS CA trust and untrust authorization prompts now fail after 120 seconds with `The operating system authorization prompt timed out after 120 seconds` instead of waiting indefinitely. Service installation and idle-update authorization prompts are not subject to this timeout.
- Warn once when the plaintext dev server is reachable from devices on your local network, pointing at the `server.host` setting.
- Port-443 bind conflicts now name the listening process: `lsof` on macOS and Linux, `Get-NetTCPConnection` plus `Get-Process` on Windows.
- Local URL resolution failures during startup are now logged at debug level instead of being discarded.
