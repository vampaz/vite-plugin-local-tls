# Security

## Local trust boundary

`@vampaz/vite-plugin-local-tls` creates a per-user certificate authority. The CA private key can mint certificates trusted by that user's configured trust store, so treat the package state directory as sensitive. On Unix-like systems, state directories use mode `0700`, private keys use `0600`, and the control socket uses `0600`.

The daemon generates a leaf only for an exact hostname currently being registered through its control channel. It does not expose a network certificate-signing API and does not generate wildcard certificates. Imported certificates must have a matching private key, be currently valid, and contain the exact hostname SAN before they are copied into private storage.

Remove trust before deleting CA files:

```bash
npm exec -- vite-local-tls untrust
npm exec -- vite-local-tls clean --ca
```

The commands verify the exact certificate fingerprint. `clean --ca` refuses while that fingerprint is still trusted.

## Network and control boundaries

The public TLS proxy binds only to `127.0.0.1` and `::1`. It has no LAN-listening mode. Port 443 may require an installed startup service or platform authorization; the plugin never kills or replaces an unrelated listener occupying port 443.

Administration is not exposed over TCP or HTTP. macOS and Linux use a per-user control socket inside a private runtime directory. Windows uses a username- and namespace-scoped named pipe without enabling all-user read or write access. A custom `controlSocket` moves this boundary: do not place it in a directory writable by another user or select a shared named pipe.

The proxy accepts only validated exact-host routes, attaches owner tokens to leases, and removes a route only when the current token still matches. A newer process can take over one hostname without granting the older process authority over the replacement or its sibling routes.

## DNS boundary

The default `.localhost` name stays local. `localtest.me`, `lvh.me`, and `nip.io` are public DNS services that resolve names to loopback addresses; they can be unavailable offline, filtered by a network, or return behavior outside this package's control. A hosts-file or resolver entry affects name resolution only and does not expand the daemon's loopback listener.

## Browser trust boundary

OS trust-store success does not guarantee that every browser surface uses that store. An embedded browser, application webview, automation runtime, or separately managed browser profile may use a separate trust store or certificate policy. Removing Caddy does not by itself fix those certificate rejections. Verify the exact CA fingerprint in the browser surface that fails; do not disable certificate validation as a workaround.

## System tools and services

Certificate authoring is delegated to the discovered `openssl` executable. Trust changes use the native platform tool: `security` on macOS; `update-ca-certificates`, `update-ca-trust`, or `trust` on Linux; and `certutil` on Windows or WSL. Review privilege prompts before accepting them.

Service installation writes only definitions carrying the package ownership marker. Uninstall verifies that marker or the exact recorded Windows task command before removal. State and service namespaces are sanitized and collision-resistant.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability involving CA key exposure, control-channel authorization, certificate validation, route isolation, or service privilege boundaries. Report it privately through the repository's GitHub security advisory interface and include affected versions, platform, reproduction steps, and impact.
