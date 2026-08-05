# @vampaz/vite-plugin-local-tls

Zero-dependency local HTTPS routing for Vite dev and preview servers. It gives every Git checkout a stable, trusted HTTPS URL without installing, starting, configuring, or communicating with Caddy.

```text
https://fieldlock.master.localhost
https://fieldlock.fix-tracking.localhost
https://fieldlock.new-editor.localhost
```

The package has no runtime npm dependencies. Vite is a peer dependency; Node.js 22 or newer, Git, OpenSSL, and a supported operating-system trust tool are system requirements.

## Install

```bash
npm install --save-dev @vampaz/vite-plugin-local-tls
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import localTls from '@vampaz/vite-plugin-local-tls';

export default defineConfig({
  plugins: [localTls()],
});
```

Start Vite normally. The plugin derives `<repo>.<branch>.localhost`, starts or reuses one per-user loopback TLS service, registers Vite's actual bound port, and prints the public URL and upstream target. The first interactive run can ask the OS to trust the package's local CA and, when required, install the startup service that can bind port 443.

The same configuration works with Vite preview. Run your normal build command, then `vite preview`; the plugin's `configurePreviewServer` integration registers the preview server after it has selected a port.

## Checkout identity and ownership

A regular clone, the primary checkout, and every linked worktree use their own current Git branch. Branch names are sanitized into DNS labels, and detached HEADs use the short commit SHA. Explicit `repo` and `branch` values work when Git is unavailable.

Two different branches run concurrently without configuration. To run two copies of the same branch, give each a stable `instanceLabel`:

```ts
localTls({ instanceLabel: 'editor-a' });
```

That produces a URL such as `https://fieldlock.master.editor-a.localhost`. If two processes intentionally resolve the exact same hostname, ownership is latest-started-wins. The older Vite process keeps running but can no longer remove the newer route during cleanup.

Use one fixed domain or multiple domains when Git-derived names are not appropriate:

```ts
localTls({ domain: 'app.localhost' });

localTls({
  domain: ['app.localhost', 'api.localhost'],
});
```

Each hostname is claimed independently, so taking over `app.localhost` does not remove the older process's `api.localhost` route.

## Options

| Option               | Behavior                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `domain`             | One hostname or an array of explicit hostnames. Values are trimmed, lowercased, de-duplicated, and used instead of Git derivation.                                                  |
| `baseDomain`         | Suffix for `<repo>.<branch>.<baseDomain>`; defaults to `localhost`.                                                                                                                 |
| `loopbackDomain`     | Uses `localtest.me`, `lvh.me`, or `nip.io` instead of the default base domain.                                                                                                      |
| `repo`               | Overrides the detected repository label.                                                                                                                                            |
| `branch`             | Overrides the detected branch label.                                                                                                                                                |
| `instanceLabel`      | Adds a deterministic label after the branch for two copies of the same branch.                                                                                                      |
| `cors`               | Replaces the proxied response's CORS allow-origin value and adds the legacy allow-methods and allow-headers values without synthesizing an application response.                    |
| `controlSocket`      | Selects an alternate Unix control socket or Windows named pipe. It is not an HTTP endpoint.                                                                                         |
| `serviceNamespace`   | Isolates the service state and control-channel name. Use a namespace only when a deliberately separate service is required.                                                         |
| `serverName`         | Deprecated compatibility alias for `serviceNamespace`.                                                                                                                              |
| `caddyApiUrl`        | Deprecated compatibility no-op. It warns because the replacement has no HTTP Admin API; use `controlSocket` if a custom control channel is required.                                |
| `caddyAdminOrigin`   | Deprecated compatibility no-op. It warns because the replacement has no HTTP Admin API Origin policy.                                                                               |
| `internalTls`        | `true` forces the local CA. Local and loopback names also use local automation when omitted or `false`; a custom hostname with `false` requires an imported exact-host certificate. |
| `upstreamHostHeader` | Rewrites the `Host` header sent to Vite or middleware such as Wrangler/Miniflare.                                                                                                   |

The plugin defaults `server.host`, `server.allowedHosts`, `preview.host`, and `preview.allowedHosts` to `true`. When it resolves a hostname, it defaults Vite HMR to WSS on that hostname and public port 443. Explicit Vite values win.

## Pure helpers

The Caddy-neutral helpers use the same checkout and normalization rules without starting infrastructure:

```ts
import { resolveLocalTlsDomains, resolveLocalTlsUrl } from '@vampaz/vite-plugin-local-tls';

const url = resolveLocalTlsUrl({ baseDomain: 'localhost' });
const domains = resolveLocalTlsDomains({
  domain: ['app.localhost', 'api.localhost'],
});
```

`resolveLocalTlsUrl()` returns `null` when zero or multiple domains resolve. `resolveLocalTlsDomains()` returns every resolved hostname or `null`.

Existing migrations may keep `resolveCaddyTlsDomains`, `resolveCaddyTlsUrl`, and `ViteCaddyTlsPluginOptions`; they are deprecated aliases with the same results. This allows the package import to be replaced before adopting the Caddy-neutral names.

## Certificates and commands

The service creates one per-user CA and issues certificates only for exact hostnames that an active Vite process is registering. Useful commands are available through the installed `vite-local-tls` executable; for a local dev dependency, prefix them with `npm exec --`.

```bash
npm exec -- vite-local-tls doctor
npm exec -- vite-local-tls trust
npm exec -- vite-local-tls untrust

npm exec -- vite-local-tls proxy status
npm exec -- vite-local-tls proxy start
npm exec -- vite-local-tls proxy stop

npm exec -- vite-local-tls service install
npm exec -- vite-local-tls service uninstall

npm exec -- vite-local-tls cert import --hostname app.example.test --cert cert.pem --key key.pem --chain chain.pem
npm exec -- vite-local-tls cert list
npm exec -- vite-local-tls cert remove --hostname app.example.test
```

For a custom non-local hostname with `internalTls: false`, import a certificate whose key and exact SAN match the hostname before starting Vite. The `--chain` argument is optional.

Add `--namespace <name>` to any command that operates on a non-default `serviceNamespace`. Add `--control-socket <path>` when the plugin uses a matching custom `controlSocket`.

## DNS and Linux

`*.localhost` is the safest default, but some Linux resolvers do not map every subdomain automatically. Add the exact printed hostname to `/etc/hosts`, configure a local resolver, or select a supported `loopbackDomain`:

```ts
localTls({ loopbackDomain: 'localtest.me' });
```

`localtest.me`, `lvh.me`, and `nip.io` rely on public DNS and can fail offline or on restricted networks. Hosts files do not support wildcard entries.

## Troubleshooting and diagnostics

Run `npm exec -- vite-local-tls doctor` to inspect OpenSSL, the platform trust tool, CA state, service compatibility, and active-route count.

- Missing OpenSSL or trust tooling fails startup explicitly; the plugin never downgrades to HTTP.
- If port 443 has an unrelated listener, the plugin reports the conflict and leaves that process untouched.
- If a hostname opens the newest matching Vite process, add `instanceLabel` or an explicit `domain`.
- If custom-certificate startup fails, verify the certificate/key pair and exact hostname SAN, then run `vite-local-tls cert import` again.
- If a browser still rejects the certificate after OS trust succeeds, see the embedded-browser boundary in [SECURITY.md](./SECURITY.md).

## Uninstall

Stop all Vite processes using the service, then remove only package-owned resources:

```bash
npm exec -- vite-local-tls proxy stop
npm exec -- vite-local-tls service uninstall
npm exec -- vite-local-tls untrust
npm exec -- vite-local-tls clean --ca
npm uninstall @vampaz/vite-plugin-local-tls
```

`proxy stop` refuses while routes are active. `clean --ca` refuses while the CA is still trusted. The service uninstaller verifies ownership before removing a launchd definition, systemd unit, or Windows scheduled task.

Migrating from the Caddy plugin? Read [MIGRATION.md](./MIGRATION.md). Security boundaries and reporting instructions are in [SECURITY.md](./SECURITY.md).

## Contributing and releases

Development setup and Changeset requirements are in [CONTRIBUTING.md](./CONTRIBUTING.md). The tested `Version Packages` pull request, npm OIDC publication, provenance, and one-time bootstrap process are documented in [RELEASING.md](./RELEASING.md).

## Development

```bash
npm install
npm run typecheck
npm run lint
npm run format:check
npm run test
npm run test:e2e
```

## License

MIT
