---
'@vampaz/vite-plugin-local-tls': minor
---

Require an attached terminal for trust and service authorization (detached flows now refuse with the exact command to run), time out unanswered authorization prompts after 120 seconds, warn once when the plaintext dev server is reachable on the local network, name the conflicting process on Windows port-443 bind failures, and log previously swallowed local-URL resolution errors at debug level.
