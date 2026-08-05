# Releasing

Normal releases are automated through Changesets, GitHub Actions, and npm trusted publishing. A maintainer does not run `npm publish`, create a tag, or create a GitHub Release locally.

## Repository and npm prerequisites

Before enabling releases:

1. In GitHub repository settings, open Actions → General → Workflow permissions and enable **Allow GitHub Actions to create and approve pull requests**. Grant the workflow read/write repository permissions.
2. Confirm npm owns the exact package `@vampaz/vite-plugin-local-tls` under the intended maintainers.
3. Configure the npm trusted publisher with GitHub owner `vampaz`, repository `vite-plugin-local-tls`, and workflow filename `release.yml`. Allow `npm publish`. Do not select an npm environment unless the workflow deliberately gains the identical GitHub environment.
4. Confirm token publishing is disabled after the one-time bootstrap credential has been revoked.

The workflow requests `contents: write`, `pull-requests: write`, and `id-token: write`; it does not use a long-lived npm token.

## Changeset requirements

Every pull request that changes published behavior, code, types, CLI output, package contents, or user-facing documentation must include a Changeset:

```bash
npm run changeset
npm run changeset -- status
```

Select the semantic impact deliberately:

- `patch`: compatible bug fix or small user-visible correction.
- `minor`: backward-compatible feature or meaningful capability.
- `major`: breaking API, behavior, requirement, or migration.

CI-only and test-only changes may use an empty Changeset when no published artifact can change. Do not edit `package.json` version or `CHANGELOG.md` by hand for a normal release.

## Normal release lifecycle

1. Open a feature pull request with its Changeset. The `Tests` workflow runs the unit/package job and reusable E2E job.
2. Merge only after `Tests` succeeds. The exact merged commit runs `Tests` again on `master`.
3. A successful current-`master` Tests run triggers `release.yml`. Failed, cancelled, pull-request-only, forked, stale, or superseded runs cannot publish.
4. When unreleased Changesets exist, `changesets/action@v1` creates or updates the **Version Packages** pull request. It applies the semantic versions, updates `CHANGELOG.md`, and consumes the Changesets.
5. Review and merge the Version Packages pull request. Its merged commit must pass the complete `Tests` workflow a second time.
6. Only that successful `master` run triggers the publication path. Changesets publishes through npm OIDC with provenance, pushes the matching `@vampaz/vite-plugin-local-tls@<version>` tag, creates the GitHub Release, and updates npm's `latest` dist-tag.
7. Run the published-release verifier and confirm version, dist-tag, `gitHead`, provenance, Git tag, GitHub Release, and clean consumer installation all identify the same tested commit.

Release concurrency cancels an older duplicate run. The workflow checks out `github.event.workflow_run.head_sha` and compares it with current `origin/master` before Changesets can run.

## One-time 0.0.1 bootstrap

The package name does not exist until the first publication, so npm cannot configure a package-scoped trusted publisher beforehand. The bootstrap is the only exception to the normal flow and remains blocked until the user explicitly approves publication.

After all acceptance checks pass, recheck the npm name and GitHub identity, build the exact dry-run artifact, and publish `0.0.1` once with a short-lived granular credential. Never commit or save that credential as a GitHub secret. Pause while the user confirms the exact trusted-publisher settings above, verify OIDC publication capability, revoke the bootstrap credential, and disable token publishing.

The first stable `1.0.0` must then use a `major` Changeset and the normal Version Packages pull request. There is no second local publication, manual tag, or manual GitHub Release.

## Verification

Before merging a Version Packages pull request:

```bash
npm run verify:release-dry-run
npm run test
npm run test:e2e
npm run verify:workflows
```

After publication:

```bash
npm run verify:published -- @vampaz/vite-plugin-local-tls@<version>
```

## Rollback policy

npm versions and release tags are immutable release records. Do not force-move a tag, rewrite a GitHub Release to point at another commit, or reuse a version. For a bad release, stop rollout guidance, deprecate the affected npm version when appropriate, and ship a corrective Changeset through the complete Tests and Version Packages flow. Use a `patch` for a compatible correction or a `major` when restoring safety requires a breaking change.
