# @xyteai/cli — Infrastructure Handoff

**Version:** 0.8.0 | **License:** Apache-2.0 | **Node:** >=22 | **Package:** CommonJS
**Repo:** github.com/xyte-io/xyte-cli | **npm:** @xyteai/cli

---

## What It Is

A CLI + TUI + headless agent interface for managing Xyte tenants, devices, spaces, incidents, and operational workflows. It's published to npm as `@xyteai/cli` and also ships an AI-agent skill bundle for use inside Claude Code.

It can run in three modes:
- **CLI** — standard command-line tool (`xyte-cli ops inspect fleet`, `xyte-cli api call ...`)
- **TUI** — interactive terminal dashboard (`xyte-cli console`) with Blessed-based screens
- **Headless** — JSON-only output for agents (`xyte-cli console --headless`), emitting structured `HeadlessFrame` each tick

---

## Project Layout

```
src/
  bin/            Entry point (xyte-cli.ts → runCli)
  cli/            Commander program, global flags, CliContext
    commands/     Command modules: api, config, flow, logs, ops, setup, util
  client/         XyteClient factory + typed namespaces (organization, partner)
  config/         Settings resolution (layered), readiness checks, retry policy
  contracts/      Typed shapes: status, watch-frame, flow-run, problem-details
  http/           fetch-based transport with retry, timeout, OTel spans
  observability/  Pino logger, OpenTelemetry tracing wrapper
  secure/         Profile store (tenants), secret store (API keys), key-slot helpers
  spec/           Static endpoint catalog (public-endpoints.json)
  tui/            Blessed TUI: screens, headless renderer, scene serializer
  workflows/      Fleet insights, watch, flow runner, utility pipelines
  utils/          Config dir, redaction, JSON output, upgrade checker
tests/            ~70 test files (vitest)
docs/schemas/     JSON schemas (headless-frame.v1, inspect-fleet.v1, report.v1)
skills/xyte-cli/  Claude Code AI skill (SKILL.md + scripts)
.github/workflows/  CI, publish, release-assets, pages
```

---

## How It's Built

| Aspect | Details |
|--------|---------|
| Language | TypeScript, strict mode, ES2022 target |
| Module system | CommonJS (required by Blessed) |
| CLI framework | Commander v14 |
| TUI framework | Blessed |
| Validation | Zod v4 |
| Logging | Pino v10 |
| Tracing | @opentelemetry/api (no SDK bundled — consumers wire their own) |
| PDF reports | PDFKit |
| HTTP | Native fetch, no axios/got |
| Test framework | Vitest |
| Linting | ESLint + Prettier |

**Runtime deps are intentionally minimal** — 7 production dependencies.

---

## Configuration Architecture

Settings are layered, lowest to highest priority:

```
defaults → profile (active tenant) → user settings file → workspace file → env vars → CLI flags
```

**File locations (macOS):**
- User settings: `~/Library/Application Support/xyte-cli/settings.json`
- Workspace settings: `.xyte/config.json` in CWD
- Profile (tenants): same config dir, `profile.json` (schema version 2)
- Secrets: same config dir, `secrets.v1.json` (chmod 600, atomic writes)

Override config dir with `XYTE_CLI_CONFIG_DIR` env var.

**Tenant model:** Each tenant has a `TenantKeyRegistry` with named API key slots. A slot maps to a provider (`xyte-org` or `xyte-partner`). The active slot per provider is tracked in the profile. Actual API keys live in the secret store, keyed by `tenantId:provider:slotId`.

---

## API Integration

Two backend providers:

| Provider | Base URL | Auth scope |
|----------|----------|------------|
| `xyte-org` | `https://hub.xyte.io` | Organization API keys |
| `xyte-partner` | `https://entry.xyte.io` | Partner API keys |

**Endpoint catalog:** Static JSON at `src/spec/public-endpoints.json`. Each entry specifies method, base, path template, params, auth scope. Commands use `client.call(endpointKey, args)` or typed namespace methods.

**HTTP transport (`src/http/transport.ts`):**
- Native `fetch` with `AbortController` timeout (default 15s)
- Retries idempotent methods only (GET/HEAD/PUT/DELETE/OPTIONS)
- Default 2 retries, 250ms backoff
- Retries on: 5xx, AbortError, TypeError (network failure)
- Every request wrapped in an OTel span

**Auto-detection:** If `--provider` is omitted, the CLI probes both org and partner endpoints to figure out which provider a key belongs to.

---

## CI/CD Pipelines

All in `.github/workflows/`:

### ci.yml — Every push to main + PRs
- Matrix: Ubuntu / macOS / Windows, Node 22
- Steps: typecheck → test → build → `npm pack --dry-run`
- Separate jobs: pack-install smoke, `npm audit --audit-level=high`, upgrade smoke

### publish.yml — On semver tag push or manual dispatch
- Validates tag matches `package.json` version
- Runs full test suite again
- Publishes with `--provenance` (SLSA attestation)
- Requires `NPM_TOKEN` secret in the `ci` environment

### release-assets.yml — Same trigger as publish
- Generates SBOM via `@cyclonedx/cyclonedx-npm`
- Attaches `.tgz` + SBOM + checksums to a GitHub Release

### pages.yml — Push to main
- Deploys `docs/` to GitHub Pages

---

## How to Release

1. Bump version in `package.json`
2. Commit as `chore(release): X.Y.Z`
3. Tag: `git tag vX.Y.Z && git push --tags`
4. CI validates, tests, publishes to npm, creates GitHub Release with SBOM

Or manually: `npm run release:publish` runs `scripts/publish.mjs all`.

The `prepublishOnly` hook (typecheck → test → build → pack-install smoke) will block a broken publish locally.

---

## Testing

**Framework:** Vitest, Node environment. ~70 test files.

**What's covered:**
- CLI integration: creates in-process CLI with memory stores and mocked fetch
- HTTP transport: retry logic, error parsing, timeouts
- Settings parsing, error formatting, redaction
- Profile/secret store schema migrations
- TUI screens, navigation, headless rendering, scene serialization
- Workflow runners: flows, fleet insights, watch deltas
- Contract/golden tests
- Smoke tests: pack-install (installs from tarball, runs `xyte-cli --output json`)

**Run locally:**
```bash
npm test                    # vitest run
npm run test:watch          # vitest in watch mode
npm run test:commit         # typecheck + test + pack-install smoke (pre-commit gate)
```

---

## Key Design Decisions to Know About

**Output mode (`--output auto|json|text`):** Default is `auto` — JSON when piped, human text in a terminal. Every command respects this. There's also `--strict-json` for agent consumers who need native `JSON.stringify` without the safe wrapper (which handles BigInt and circular refs).

**Error output:** Errors can be emitted as RFC 7807 ProblemDetails JSON (via `--error-format json`) or plain text. All error output goes through `redactSensitiveText()` — regex-based redaction of Bearer tokens, URL params, and key=value pairs.

**Action logging (NDJSON):** Opt-in via `--log-actions` or settings. Logs session/command lifecycle events to `<configDir>/logs/cli-actions.ndjson` with rotation and hardened file permissions.

**Flows:** A deterministic multi-step execution engine. `plan` previews steps, `apply` executes. Built-in flows for setup readiness, incident watching, triage, remediation, daily reports. Users can define custom flows stored in `<configDir>/flows/`.

**CliContext:** Single dependency bundle passed to every command handler. Contains I/O streams, stores, prompt helpers, settings resolver, and client factory. Tests inject memory-backed stores through this same interface.

---

## Secrets & Security Posture

- API keys stored in `secrets.v1.json` with `chmod 600` + atomic rename writes
- Config directory created with `0700` permissions
- Action logs written with `0600` permissions
- Sensitive data redacted in all error output and log entries
- `npm audit --audit-level=high` runs in CI
- npm provenance (SLSA) attestation on every publish
- SBOM (CycloneDX) attached to every GitHub Release

---

## Environment Variables

The CLI reads ~20 env vars, all prefixed `XYTE_CLI_*` (with some legacy `XYTE_*` aliases). Key ones:

| Variable | Purpose |
|----------|---------|
| `XYTE_CLI_CONFIG_DIR` | Override config directory |
| `XYTE_CLI_OUTPUT_MODE` | Default output mode |
| `XYTE_CLI_ERROR_FORMAT` | Error format (text/json) |
| `XYTE_CLI_HTTP_RETRY_ATTEMPTS` | Retry count |
| `XYTE_CLI_HTTP_TIMEOUT_MS` | Request timeout |
| `XYTE_CLI_LOG_ACTIONS` | Enable action logging |

Full mapping in `src/config/settings.ts`.

---

## Day-to-Day Operations

```bash
# Dev
npm install
npm run build              # clean + tsc
npm run typecheck           # tsc --noEmit
npm test                    # vitest
npm run lint                # eslint
npm run lint:fix

# Run locally without building
npx tsx src/bin/xyte-cli.ts <command>

# Install globally from source
npm run install:global      # build + npm link
npm run reinstall:global

# Smoke tests
npm run smoke:pack-install  # pack → install in temp dir → run
npm run test:commit         # full pre-commit gate
```

---

## What to Watch Out For

1. **Blessed is unmaintained.** It works but don't expect fixes upstream. The TUI wraps it enough that swapping it later is feasible (screens use a `TuiScreen` interface, rendering goes through a scene layer).

2. **Node >=22 is required.** Native fetch, structuredClone, and other modern APIs are used directly.

3. **The endpoint catalog is static.** `public-endpoints.json` must be updated manually when backend APIs change. There's a `drift-overrides.json` for known deviations.

4. **Secrets store has no encryption at rest.** It relies on filesystem permissions (`chmod 600`). Fine for a CLI tool, but something to know.

5. **OpenTelemetry is wired but inert by default.** No SDK is bundled. Consumers need to register their own tracer provider to get spans exported anywhere.

---

*Generated 2026-04-06 from the v0.8.0 codebase.*
