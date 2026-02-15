# Release Guide

This project is prepared for manual npm publishing of `@xyte/cli`.

## Prerequisites

- npm account has publish rights for the `@xyte` scope.
- Scope visibility is set so public packages are allowed.
- You are logged in: `npm whoami`.

## Manual Release Steps

1. Install dependencies:
   - `npm ci`
2. Verify types:
   - `npm run typecheck`
3. Run tests:
   - `npm test`
4. Validate package contents:
   - `npm pack --dry-run`
5. Bump version in `/Users/porton/Projects/xyte-cli/package.json` (and lockfile if needed).
6. Publish:
   - `npm publish`

`publishConfig.access=public` is already configured, so first publish for the scoped package will be public.

## Helper Script

Use the repo script when delegating deploy actions:

- `npm run release:publish:cli` - publish only `@xyte/cli`
- `npm run release:publish:pages` - trigger GitHub Pages workflow only
- `npm run release:publish` - publish npm package, then trigger GitHub Pages workflow

## GitHub Actions Publish (Recommended)

`/Users/porton/Projects/xyte-cli/.github/workflows/publish.yml` publishes `@xyte/cli` using npm trusted publishing (OIDC provenance).

One-time npm setup (admin):

1. In npm package settings for `@xyte/cli`, configure a Trusted Publisher:
   - Provider: GitHub Actions
   - Repository: `xyte-io/xyte-cli`
   - Workflow file: `.github/workflows/publish.yml`

Run a release:

1. Ensure `package.json` version matches the release tag.
2. Push a semver tag (`0.1.0` or `v0.1.0`) OR run workflow `Publish CLI` manually with `tag` input.
3. The workflow validates tag/version match, runs install/build checks, and publishes to npm.

## Rollback / Recovery

- If a bad version is published, prefer a fast patch release with a bumped patch version.
- To warn users away from a bad version, deprecate it:
  - `npm deprecate @xyte/cli@<bad-version> "<message>"`
- Avoid unpublish except where npm policy allows and only when absolutely necessary.
