# @vampaz/vite-plugin-local-tls

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
