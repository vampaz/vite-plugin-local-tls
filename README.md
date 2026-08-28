# @vampaz/vite-plugin-local-tls

Local HTTPS routing for Vite dev and preview servers, with a stable, locally trusted URL for every Git checkout.

```text
https://<repo>.<branch>.localhost
```

The package has no runtime npm dependencies and supports concurrent clones and Git worktrees through one machine-wide, loopback-only TLS service.

## Requirements

- Node.js 22 or newer
- Vite 3 through 8
- OpenSSL on `PATH`
- A supported operating-system trust tool: macOS `security`, Windows `certutil`, or a Linux trust tool such as `update-ca-certificates`, `update-ca-trust`, or `trust`
- Git when deriving the repository and branch names automatically; without Git, provide `domain` or both `repo` and `branch`

## Install

```bash
npm install --save-dev @vampaz/vite-plugin-local-tls
```

Add the plugin to your Vite configuration:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import localTls from '@vampaz/vite-plugin-local-tls';

export default defineConfig({
  plugins: [localTls()],
});
```

Start Vite with your project's normal development script, for example:

```bash
npm run dev
```

The plugin registers Vite's actual bound port and prints both ends of the route:

```text
Local TLS upstream: http://127.0.0.1:5173
Local TLS URL: https://<repo>.<branch>.localhost
```

The first run may request administrator authorization to trust the local certificate authority and install the service that binds port 443. On macOS, service installation and idle updates use a native administrator dialog, including when the dev server starts in the background. If several Vite processes start together, they wait for the same authorization flow instead of opening competing prompts. An outdated compatible service keeps serving active routes without interruption and updates automatically on the next Vite start after it becomes idle. The updater never downgrades a newer compatible installed service.

Port 443 has one canonical startup-service identity on macOS, Linux, and Windows. Releases before this invariant could leave namespaced legacy startup services that competed for the same port after a reboot. The plugin now requires both a strictly validated ownership record and an exact generated launchd plist, systemd unit, or single Task Scheduler action. It adopts a compatible active legacy winner without interrupting routes; once every legacy route is idle, it preserves the existing CA and imported certificates, preferring an already-trusted valid CA when several exist. It promotes the highest compatible newer legacy runtime into the canonical service instead of downgrading it, disables the verified contenders, waits for the canonical service to answer with the compatible control protocol, and only then removes the old definitions. Unverified or tampered targets are reported by `doctor`; their presence blocks automatic convergence and manual service installation until they are inspected.

The same configuration supports Vite preview (`vite preview`); the route is registered after Vite selects the preview port.

## Generated URLs and concurrent checkouts

By default, the plugin reads the current Git checkout and builds the hostname from its repository and branch names. A regular clone, the primary checkout, and each linked worktree use their own current branch.

| Checkout                         | URL                                            |
| -------------------------------- | ---------------------------------------------- |
| Branch                           | `https://<repo>.<branch>.localhost`            |
| Detached HEAD                    | `https://<repo>.<short-sha>.localhost`         |
| Checkout with an `instanceLabel` | `https://<repo>.<branch>.<instance>.localhost` |

Generated repository, branch, and instance labels are lowercased, sanitized, and compacted into valid DNS labels. Separate branches and worktrees can run concurrently, even when Vite assigns different upstream ports.

If two processes claim the same exact hostname, the latest one wins. An older process cannot remove the newer route when it exits. Claims in a `domain` array are tracked independently, so replacing one hostname does not disturb its siblings.

Use an instance label when you need more than one server for the same branch:

```ts
localTls({ instanceLabel: 'instance-a' });
```

Use `domain` when the URL should not depend on Git metadata. For multiple domains, pass an array:

```ts
localTls({ domain: 'app.localhost' });
localTls({ domain: ['app.localhost', 'api.localhost'] });
```

## Configuration

### URL options

| Option           | Description                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `domain`         | One hostname or an array of hostnames. Overrides generated checkout hostnames.                      |
| `repo`           | Repository label override.                                                                          |
| `branch`         | Branch label override.                                                                              |
| `instanceLabel`  | Optional label appended after the branch for multiple instances of one checkout.                    |
| `baseDomain`     | Base domain used for generated hostnames. Defaults to `localhost`.                                  |
| `loopbackDomain` | Selects `localtest.me`, `lvh.me`, or `nip.io` as the generated hostname's public loopback DNS base. |

`baseDomain` takes precedence over `loopbackDomain` when both are set.

### Proxy and service options

| Option               | Description                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cors`               | Sets the proxied response's allow-origin value, allows common HTTP methods, and sets allow-headers to `*`.                                                                    |
| `upstreamHostHeader` | Rewrites the HTTP `Host` header sent to Vite. The default preserves the public hostname. WebSocket upgrades use the same value.                                               |
| `internalTls`        | Controls certificate policy. Local and supported loopback names remain automated; see [Certificate policy](#certificate-policy).                                              |
| `serviceNamespace`   | Deprecated for the ordinary plugin runtime and ignored there; port 443 always uses canonical state. Retained for injected test infrastructure compatibility.                  |
| `controlSocket`      | Deprecated for the ordinary plugin runtime and ignored there; the canonical service has one private control channel. Retained for injected test infrastructure compatibility. |

The plugin supplies Vite defaults only when you have not set them yourself:

- `server.host`, `preview.host`, and their `allowedHosts` values are enabled for local routing.
- HMR defaults to WSS on the public hostname and port 443.
- Explicit Vite server, preview, and HMR settings always win.

Compatibility options from `vite-plugin-caddy-multiple-tls` remain accepted: `serverName` is a deprecated alias for the now-canonicalized `serviceNamespace`, while `caddyApiUrl` and `caddyAdminOrigin` are deprecated no-ops. The exported `resolveCaddyTlsDomains`, `resolveCaddyTlsUrl`, and `ViteCaddyTlsPluginOptions` names are also deprecated aliases. See the dedicated [migration guide](./MIGRATION.md) for details.

## Certificate policy

The plugin creates a per-user local certificate authority and generates certificates for exact hostnames only. It does not generate wildcard certificates.

- When `internalTls` is omitted or `true`, every hostname uses the local certificate authority.
- `.localhost` and supported loopback domains still use the local certificate authority when `internalTls` is `false`.
- A custom non-local hostname with `internalTls: false` requires an imported exact-host certificate.
- Imported certificates must be valid, contain the exact hostname SAN, and match their private key.
- The proxy never falls back to unencrypted HTTP.

Import and manage custom certificates with the CLI:

```bash
npm exec -- vite-local-tls cert import --hostname app.example.test --cert cert.pem --key key.pem --chain chain.pem
npm exec -- vite-local-tls cert list
npm exec -- vite-local-tls cert remove --hostname app.example.test
```

The `--chain` option is optional.

## URL helpers

Use the exported helpers when another tool needs the same URL without starting Vite or the TLS service:

```ts
import { resolveLocalTlsDomains, resolveLocalTlsUrl } from '@vampaz/vite-plugin-local-tls';

const domains = resolveLocalTlsDomains();
const url = resolveLocalTlsUrl();
```

`resolveLocalTlsDomains()` returns every resolved hostname, or `null` when no valid hostname can be resolved. `resolveLocalTlsUrl()` returns an HTTPS URL only when exactly one hostname resolves; it returns `null` for zero or multiple hostnames.

## CLI and diagnostics

Run the CLI through the locally installed package:

```bash
# Check prerequisites and current service state
npm exec -- vite-local-tls doctor
npm exec -- vite-local-tls proxy status

# Manage CA trust
npm exec -- vite-local-tls trust
npm exec -- vite-local-tls untrust

# Manage the proxy and startup service
npm exec -- vite-local-tls proxy start
npm exec -- vite-local-tls proxy stop
npm exec -- vite-local-tls service install
npm exec -- vite-local-tls service uninstall

# Remove generated state; add --ca to include CA files
npm exec -- vite-local-tls clean
npm exec -- vite-local-tls clean --ca
```

Manual certificate and proxy commands accept `--namespace <name>` for isolated state and `--control-socket <path>` for an alternate private control channel. Persistent `service install` is deliberately canonical-only and rejects `--namespace`; `service uninstall --namespace <legacy-name>` remains available for explicit legacy cleanup. Run `npm exec -- vite-local-tls --help` for the complete command reference.

`doctor` reports the canonical installation, its update state, owned legacy records, active route counts, recorded and live protocol versions, corrupt or incomplete records, and a repair command only when every target was probed and is idle. A normal plugin start performs the same read-only inventory before deciding whether to adopt, converge, update, or leave a target untouched. Canonical install, repair, and uninstall operations share one cross-process mutation lock, so simultaneous projects cannot authorize competing changes.

## Platform and DNS notes

The TLS proxy listens only on `127.0.0.1` and `::1`. It does not expose a LAN-listening mode, an HTTP administration endpoint, or a network certificate-signing API. If another process owns port 443, the plugin reports the conflict and leaves that process untouched. A managed service exits successfully on this conflict so launchd and systemd do not crash-loop; a later plugin start retries on demand after the port is available.

On Linux, the persistent systemd service runs as the installing user and receives only `CAP_NET_BIND_SERVICE`. When its private control socket is under `/run/user/<uid>`, the unit requires systemd's matching user-runtime-directory unit so the socket parent exists before the daemon starts, including before the first interactive login. CI can instead grant its disposable Node process that capability and run the packed port-443 proof ephemerally; the test never creates or enables a boot-persistent service.

The default `*.localhost` names do not depend on public DNS. Some Linux resolvers do not map arbitrary `*.localhost` names to loopback; use `loopbackDomain` when necessary:

```ts
localTls({ loopbackDomain: 'localtest.me' });
```

`localtest.me`, `lvh.me`, and `nip.io` are public DNS services. They may be unavailable offline or filtered by the current network.

Trusting the CA at the operating-system level does not guarantee that every embedded browser, webview, automation runtime, or managed browser profile uses that trust store. If one browser surface still rejects the certificate, verify the exact CA fingerprint in that surface instead of disabling certificate validation.

See [Security](./SECURITY.md) for the complete trust, network, service, and control-channel boundaries.

## Troubleshooting

- Run `npm exec -- vite-local-tls doctor` first to inspect system requirements and service health.
- If `doctor` reports legacy startup services with active routes, stop those Vite processes and start any updated project again. Idle owned contenders converge automatically.
- On Linux, run Vite or lifecycle commands in an interactive terminal when administrator authorization is required. macOS uses a native administrator dialog even when the dev server starts in the background.
- If an idle service cannot update automatically because authorization is unavailable, stop active Vite routes and run `npm exec -- vite-local-tls service install` from an interactive terminal.
- If port 443 is occupied, identify and stop or reconfigure that process yourself; the plugin will not terminate it.
- If the wrong server owns a hostname, choose a unique `domain` or `instanceLabel`, or restart the intended server so it makes the latest claim.
- If a custom non-local hostname fails with `internalTls: false`, import a matching certificate before starting Vite.

## Uninstall completely

Stop every Vite process using the plugin, then remove the service, trust, and state in this order:

```bash
npm exec -- vite-local-tls proxy stop
npm exec -- vite-local-tls service uninstall
npm exec -- vite-local-tls untrust
npm exec -- vite-local-tls clean --ca
```

`proxy stop` refuses to stop while routes are active. `clean --ca` refuses to remove CA files until the exact CA fingerprint is no longer trusted.

Finally, remove the package from the project:

```bash
npm uninstall @vampaz/vite-plugin-local-tls
```

## Project documentation

- [Migration from `vite-plugin-caddy-multiple-tls`](./MIGRATION.md)
- [Security model and vulnerability reporting](./SECURITY.md)
- [Contributing](./CONTRIBUTING.md)
- [RELEASING.md](./RELEASING.md)

## License

[MIT](./LICENSE)
