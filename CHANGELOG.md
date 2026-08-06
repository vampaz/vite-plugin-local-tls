# @vampaz/vite-plugin-local-tls

## 0.0.3

### Patch Changes

- bb9f3df: Use native macOS administrator authorization for startup-service installation, serialize privileged setup across simultaneous Vite processes, prevent replaced routes from triggering recovery authorization, and allow interactive authorization to complete without an arbitrary deadline.

## 0.0.2

### Patch Changes

- 85c9497: Fix interactive service authorization, reliably replace stale installed runtimes, and generate browser-compatible trusted certificates on macOS.

## 0.0.1

### Major Changes

- Initial standalone implementation of checkout-aware local HTTPS for Vite without a Caddy runtime dependency.
