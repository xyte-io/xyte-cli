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
5. Remove `"private": true` from `/Users/porton/Projects/xyte-cli/package.json`.
6. Bump version in `/Users/porton/Projects/xyte-cli/package.json` (and lockfile if needed).
7. Publish:
   - `npm publish`

`publishConfig.access=public` is already configured, so first publish for the scoped package will be public.

## Rollback / Recovery

- If a bad version is published, prefer a fast patch release with a bumped patch version.
- To warn users away from a bad version, deprecate it:
  - `npm deprecate @xyte/cli@<bad-version> "<message>"`
- Avoid unpublish except where npm policy allows and only when absolutely necessary.
