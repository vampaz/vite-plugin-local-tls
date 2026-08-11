# @vampaz/vite-plugin-local-tls

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
