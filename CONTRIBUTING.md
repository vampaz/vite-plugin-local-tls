# Contributing

## Prerequisites

- Node.js 22 or newer
- npm
- Git
- OpenSSL
- Chromium for the Playwright suite

Caddy, mkcert, and Portless are not development or runtime prerequisites.

## Setup

```bash
git clone https://github.com/vampaz/vite-plugin-local-tls.git
cd vite-plugin-local-tls
npm install
npm run playwright:install
```

## Verification

Run focused tests while developing, then the relevant complete gates before opening a pull request:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run test
npm run test:e2e
npm run verify:package
```

The E2E harness uses an isolated high TLS port and temporary state; it does not stop or reconfigure another local proxy.

## Changesets

Every pull request that changes the published package needs a Changeset. Documentation, CI, or test-only work that cannot affect consumers may omit one.

```bash
npm run changeset
npm run changeset -- status
```

Choose `patch` for compatible fixes, `minor` for compatible features, and `major` for breaking changes. Write release notes for package users, not implementation notes. See [RELEASING.md](./RELEASING.md) for the complete release lifecycle.

The pull request and its eventual merge to `master` must both pass the `Tests` workflow. Contributors do not edit the package version or changelog manually; Changesets creates the `Version Packages` pull request after the feature Changesets reach `master`.

Do not run a local publish, create a release tag, or create a GitHub Release. After the one-time bootstrap documented in [RELEASING.md](./RELEASING.md), publication is owned exclusively by the successful-tests-only OIDC workflow.
