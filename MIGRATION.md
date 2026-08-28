# Migrating from vite-plugin-caddy-multiple-tls

`@vampaz/vite-plugin-local-tls` preserves the checkout-aware URLs, Vite integration, takeover semantics, proxy behavior, and certificate-policy outcomes of `vite-plugin-caddy-multiple-tls`, but replaces Caddy with a package-owned loopback TLS service and private control channel.

## Replace the package and import

```bash
npm uninstall vite-plugin-caddy-multiple-tls
npm install --save-dev @vampaz/vite-plugin-local-tls
```

```ts
// Before
import caddyTls from 'vite-plugin-caddy-multiple-tls';

// After
import localTls from '@vampaz/vite-plugin-local-tls';
```

Replace `caddyTls(options)` with `localTls(options)`. The new plugin keeps dev-server and Vite preview support, defaults Vite host/allowed-host values the same way, registers the actual auto-selected port, and keeps WSS HMR isolated by public hostname.

## Helper mapping

| Before                   | After                    |
| ------------------------ | ------------------------ |
| `resolveCaddyTlsDomains` | `resolveLocalTlsDomains` |
| `resolveCaddyTlsUrl`     | `resolveLocalTlsUrl`     |

The old helper names remain available as deprecated aliases, so changing only the package import works. The new names are canonical. Both retain normalization, Git checkout and linked-worktree detection, detached-HEAD handling, DNS-label compaction, loopback-domain handling, and `null` for a missing or non-singular URL. `ViteCaddyTlsPluginOptions` likewise remains available as a deprecated alias for `LocalTlsPluginOptions`.

## Option mapping

| Old option           | New option or outcome                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain`             | Preserved as `domain`.                                                                                                                       |
| `baseDomain`         | Preserved as `baseDomain`.                                                                                                                   |
| `loopbackDomain`     | Preserved as `loopbackDomain`.                                                                                                               |
| `repo`               | Preserved as `repo`.                                                                                                                         |
| `branch`             | Preserved as `branch`.                                                                                                                       |
| `instanceLabel`      | Preserved as `instanceLabel`.                                                                                                                |
| `cors`               | Preserved as `cors`.                                                                                                                         |
| `internalTls`        | Preserved as `internalTls`, with the observable certificate outcomes described below.                                                        |
| `upstreamHostHeader` | Preserved as `upstreamHostHeader`.                                                                                                           |
| `caddyApiUrl`        | Accepted as a deprecated no-op with a warning because no HTTP Admin API exists.                                                              |
| `serverName`         | Accepted as a deprecated alias for `serviceNamespace`; both are ignored by the ordinary runtime because port 443 uses one canonical service. |
| `caddyAdminOrigin`   | Accepted as a deprecated no-op with a warning because no HTTP administration API or Origin policy exists.                                    |

No old public option name is rejected. `serverName`, `serviceNamespace`, and `controlSocket` no longer split the ordinary port-443 runtime because multiple boot-persistent owners can collide after a restart. Explicitly injected infrastructure from the testing export can still isolate a non-production daemon and control channel. The two HTTP Admin API settings cannot affect the Caddyless backend, so they produce explicit migration warnings instead of disappearing silently.

## Certificate-policy mapping

- `internalTls: true` forces a certificate from the plugin's trusted local CA for local, loopback, and custom names.
- When `internalTls` is omitted, local, loopback, and custom names use the plugin's local CA, matching the prior default observable result.
- `internalTls: false` still permits default local automation for `.localhost` and supported loopback domains.
- A custom non-local hostname with `internalTls: false` must use an imported exact-host certificate. Import it before Vite starts:

```bash
npm exec -- vite-local-tls cert import --hostname app.example.test --cert cert.pem --key key.pem --chain chain.pem
```

Failure is explicit when no matching import exists. The plugin does not reproduce Caddy's public ACME platform and never falls back to HTTP.

## Ownership and output

Hostname ownership remains latest-started-wins. Claims are independent per hostname, an older owner cannot delete a newer route, sibling domains survive partial takeover, and disconnect or crash cleanup releases only the dead lease.

The old Caddy banner and route-administration output are replaced with backend-neutral lines:

```text
Local TLS upstream: http://127.0.0.1:5173
Local TLS URL: https://project.branch.localhost
```

Every resolved public URL is printed. The upstream line uses Vite's actual bound host and port.

## Operational replacement

The package does not install, start, configure, or communicate with Caddy. Remove any Caddy bootstrap code that existed only for this plugin. The local TLS service starts automatically when prerequisites and privileges permit; these commands expose the replacement lifecycle:

```bash
npm exec -- vite-local-tls doctor
npm exec -- vite-local-tls trust
npm exec -- vite-local-tls proxy status
npm exec -- vite-local-tls service install
```

The installed service uses durable copies of Node and the bundled CLI outside the consumer checkout. On macOS it binds the low port through a root-owned LaunchDaemon and drops to the installing user before opening its control channel. Linux grants only the low-port capability to the user service. Windows keeps the task, CA state, and control channel under the current user.

Earlier package releases could derive persistent service identities from `serviceNamespace`. Updated projects discover those owned legacy services. A compatible service with active routes is reused without interruption. Once the legacy services are idle, the plugin preserves their validated CA and imported exact-host certificates, preferring an already-trusted legacy CA when more than one valid authority exists. It promotes the highest compatible newer legacy runtime into the canonical service, disables the verified contenders, and waits for that canonical service to answer with the compatible control protocol before deleting old definitions and runtime copies. A failed update restores the prior runtime bytes and at most one previously healthy macOS, Linux, or Windows owner; idle contenders stay disabled so rollback cannot recreate the boot collision. If restoration itself cannot be verified, every contender remains disabled. Newer compatible installed service versions are never downgraded, and the new ownership marker prevents older releases from overwriting a stopped current macOS or Linux definition. Any corrupt, incomplete, or non-exact installation target blocks automatic convergence and the manual repair install until it is inspected with `doctor`.

The private control channel replaces Caddy Admin API requests and the cross-process ownership files built around them. It is not reachable over TCP. Do not translate an old `caddyApiUrl` value into an HTTP address. Alternate `controlSocket` values are for manual commands or explicitly injected non-production infrastructure, not the ordinary plugin runtime.

If Caddy is still running on port 443, this plugin reports the unrelated listener and leaves it untouched. Stop or reconfigure Caddy yourself only after confirming no other project needs it.

## Removing old infrastructure

After every project has migrated and no other workflow uses Caddy, remove the old package and any project-specific Caddy startup configuration. This repository never stops or uninstalls Caddy for you.

To later remove the new service and CA, stop all Vite routes and run:

```bash
npm exec -- vite-local-tls proxy stop
npm exec -- vite-local-tls service uninstall
npm exec -- vite-local-tls untrust
npm exec -- vite-local-tls clean --ca
```
