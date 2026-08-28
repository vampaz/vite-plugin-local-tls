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

Administration is not exposed over TCP or HTTP. macOS and Linux use a per-user control socket inside a private runtime directory. Windows uses a username-scoped named pipe without enabling all-user read or write access. The ordinary plugin always uses the canonical control channel. An alternate `controlSocket` is limited to explicitly injected test infrastructure and manual CLI use; do not place it in a directory writable by another user or select a shared named pipe.

The proxy accepts only validated exact-host routes, attaches owner tokens to leases, and removes a route only when the current token still matches. A newer process can take over one hostname without granting the older process authority over the replacement or its sibling routes.

## DNS boundary

The default `.localhost` name stays local. `localtest.me`, `lvh.me`, and `nip.io` are public DNS services that resolve names to loopback addresses; they can be unavailable offline, filtered by a network, or return behavior outside this package's control. A hosts-file or resolver entry affects name resolution only and does not expand the daemon's loopback listener.

## Browser trust boundary

OS trust-store success does not guarantee that every browser surface uses that store. An embedded browser, application webview, automation runtime, or separately managed browser profile may use a separate trust store or certificate policy. Removing Caddy does not by itself fix those certificate rejections. Verify the exact CA fingerprint in the browser surface that fails; do not disable certificate validation as a workaround.

## System tools and services

Certificate authoring is delegated to the discovered `openssl` executable. Trust changes use the native platform tool: `security` on macOS; `update-ca-certificates`, `update-ca-trust`, or `trust` on Linux; and `certutil` on Windows or WSL. Review privilege prompts before accepting them.

Service installation creates exactly one canonical startup service because port 443 is machine-wide. A first installation writes no ownership record before an OS target exists. It publishes `installed` only after the exact target answers with the compatible protocol; a caught launch failure may publish `installing` only after revalidating that exact target, while an abrupt unrecorded interruption remains recognizable by the next canonical install. An update writes a durable pending record before replacing its verified previous owner, so interruption remains diagnosable and recoverable. Legacy discovery rejects symlinked namespace directories or records, invalid version metadata, unsafe recursive-deletion targets, missing definitions, and any launchd plist or systemd unit that differs from the complete expected generated definition. Windows additionally verifies the regular runtime-configuration file and requires exactly one Task Scheduler `Exec` action with the recorded `Command` and `Arguments`; expected text elsewhere in XML does not establish ownership. Automatic startup and the manual repair command both refuse persistent mutation while any discovered installation target is unverified. Canonical install, repair, and uninstall operations use the same cross-process mutation lock.

On macOS, the root-owned LaunchDaemon runs root-owned copies of Node and the bundled CLI, binds the low port, transfers generated-file ownership, clears supplementary groups, and drops its group and user IDs before exposing the control channel or accepting routes. Its `KeepAlive` policy uses `SuccessfulExit: false`: an owned service that loses port 443 exits successfully and does not enter a restart loop. Linux runs durable Node and CLI copies as the installing user with only `CAP_NET_BIND_SERVICE` and `Restart=on-failure`; the same successful conflict exit prevents a systemd loop. A Linux unit whose control socket is under `/run/user/<uid>` requires the matching systemd user-runtime-directory unit so its private parent exists before startup. Windows uses durable runtime copies in a current-user logon task. Start, update, convergence, and uninstall all repeat exact ownership validation immediately before system-manager mutation.

Automatic convergence mutates only verified package-owned legacy services. It rechecks active routes while holding the canonical installation lock and again through the daemon-side idle-stop handshake. Once the route registry is empty, shutdown also closes accepted client connections so an unregistered idle client cannot hold an update open. On macOS the privileged transaction temporarily disables old unconditional `KeepAlive` jobs and stages the prior canonical definition and runtime before mutation. Linux and Windows stage the prior runtime as well. Legacy targets remain recoverable but disabled until the canonical service answers with the compatible protocol; only then are their definitions deleted. If readiness or replacement fails, prior bytes are restored and at most one previously healthy owner is restarted in reverse transaction order; idle contenders stay disabled so rollback cannot recreate the boot collision. If restoration cannot be verified, every contender remains disabled. A compatible active service remains selected until its routes are idle. New installation records carry package and protocol versions: older compatible runtimes update only while idle, the highest compatible newer legacy runtime is promoted into the canonical service instead of being downgraded, and a new definition marker makes stopped current macOS and Linux services ineligible for overwrite by older releases.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability involving CA key exposure, control-channel authorization, certificate validation, route isolation, or service privilege boundaries. Report it privately through the repository's GitHub security advisory interface and include affected versions, platform, reproduction steps, and impact.
