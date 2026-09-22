# @vampaz/vite-plugin-local-tls

## 0.2.0

### Minor Changes

- 6193e57: - **Behavior change:** the automatic trust and initial service-install flow at Vite startup now requires an attached terminal. When Vite runs detached, that flow refuses and prints the exact `vite-local-tls` command to run. Direct `vite-local-tls trust` and `vite-local-tls service install` commands and idle service updates are not subject to that gate and can still authorize through the native macOS dialog while detached.
  - Unanswered macOS CA trust and untrust authorization prompts now fail after 120 seconds with `The operating system authorization prompt timed out after 120 seconds` instead of waiting indefinitely. Service installation and idle-update authorization prompts are not subject to this timeout.
  - Warn once when the plaintext dev server is reachable from devices on your local network, pointing at the `server.host` setting.
  - Port-443 bind conflicts now name the listening process: `lsof` on macOS and Linux, `Get-NetTCPConnection` plus `Get-Process` on Windows.
  - Local URL resolution failures during startup are now logged at debug level instead of being discarded.

## 0.1.2

### Patch Changes

- 2b587a0: Recover automatically when an earlier macOS service leaves the temporary runtime directory owned by root during a dependency update.

## 0.1.1

### Patch Changes

- d07ffd6: Keep a running Vite or Astro server retrying initial TLS route registration so completing a required startup-service update restores HTTPS without restarting the dev server.

## 0.1.0

### Minor Changes

- bd24d11: Make the port-443 startup service machine-wide, transactionally converge exact-verified legacy namespaced services on macOS, Linux, and Windows without interrupting active routes, preserve their CA and imported certificates, promote the highest compatible newer runtime rather than downgrading it, require a compatible readiness response before committing, recover stale reboot metadata, drain idle client connections during replacement, order Linux startup after its user runtime directory, and stop managed port conflicts from crash-looping.

## 0.0.8

### Patch Changes

- ce0bed7: Complete HTTP/2 HEAD responses and require effective macOS SSL trust for generated certificates.

## 0.0.7

### Patch Changes

- ed14e99: Update an outdated compatible service automatically when it is idle while leaving active routes uninterrupted.

## 0.0.6

### Patch Changes

- 8b8ea0d: Keep the shared proxy alive across HTTP/2 client resets, never replace a healthy compatible service during Vite startup, and keep retrying route recovery while Vite remains running.

## 0.0.5

### Patch Changes

- a4c6eed: Stage the macOS service CLI outside privacy-protected project folders before native administrator authorization.

## 0.0.4

### Patch Changes

- 8fae06e: Wait for startup state metadata when another process reaches a healthy control socket before its atomic state write completes.
- 25073aa: Allow background macOS dev servers to open the native administrator dialog during automatic local TLS service setup, and print npm-executable recovery commands when manual intervention is required.

## 0.0.3

### Patch Changes

- bb9f3df: Use native macOS administrator authorization for startup-service installation, serialize privileged setup across simultaneous Vite processes, prevent replaced routes from triggering recovery authorization, and allow interactive authorization to complete without an arbitrary deadline.

## 0.0.2

### Patch Changes

- 85c9497: Fix interactive service authorization, reliably replace stale installed runtimes, and generate browser-compatible trusted certificates on macOS.

## 0.0.1

### Major Changes

- Initial standalone implementation of checkout-aware local HTTPS for Vite without a Caddy runtime dependency.
