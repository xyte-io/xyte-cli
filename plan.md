# XYTE CLI 0.1.0 Stabilization Plan (Simplified)

## Summary
Two surgical adjustments to harden reliability and close remaining gaps without expanding scope:

1. Make secret-store errors actionable and precise.
2. Prove skill install is truly usable in a fresh environment, not just copied.
3. Align docs/agent guidance with the actual external-live flow.

## Phase 1 — Secret Store Error Clarity (No API changes)

- Update `/Users/porton/Projects/xyte-cli/src/secure/secret-store.ts`:
  - Keep `ENOENT` behavior as empty store.
  - Split `readData` error handling into:
    - malformed JSON / invalid schema → explicit corrupt-file message,
    - permission/I/O failures (`EACCES`, `EPERM`, etc.) → explicit permission/path issue message,
    - unknown non-parse errors → explicit read/write failure message.
  - Do not change serialization format (`secrets.v1.json`) or key format (`tenant:provider:slot`).
  - Keep file mode behavior (POSIX `0600`) and atomic temp-file write.

- Update `/Users/porton/Projects/xyte-cli/tests/secret-store.test.ts`:
  - Add tests for permission-like error path expectation (mocked read throwing non-ENOENT error).
  - Keep existing ENOENT/corrupt/round-trip tests.

## Phase 2 — Smoke Gate as Real New-User + Skill Usability Check

- Update `/Users/porton/Projects/xyte-cli/scripts/smoke_external_user_live.mjs`:
  - Keep existing install/setup/read-endpoint sequence.
  - Add one smoke command after `install --skills ...` that verifies a skill bundle is actionable (not just present), e.g.:
    - use an installed skill command path or manifest-driven agent entry command.
  - Keep step count and failure behavior unchanged (hard fail, cleanup, clear messages).

- Update `/Users/porton/Projects/xyte-cli/tests/smoke-script.test.ts`:
  - Assert the added skill-usage command runs in the expected sequence.
  - Keep command-order assertions focused and minimal.

## Phase 3 — Docs and Prompt Alignment (Pre-commit Readiness)

- Update:
  - `/Users/porton/Projects/xyte-cli/README.md`
  - `/Users/porton/Projects/xyte-cli/skills/xyte-cli/SKILL.md`
  - `/Users/porton/Projects/xyte-cli/skills/xyte-cli/agents/openai.yaml`
  - `/Users/porton/Projects/xyte-cli/docs/index.html`
- Clarify:
  - `XYTE_CLI_KEY` is mandatory, `XYTE_E2E_TENANT` optional (`default`).
  - `npm run test:commit` order and why it still fails late without key.
  - External user validation now includes fresh install, skill install, setup, persisted key reuse, and live endpoint check.
  - Suggested agent path: install + non-interactive setup + key reuse + real call.

## Public API / Type Changes

- No new public API changes in this re-plan.
- Keep names:
  - `createSecretStore`, `MemorySecretStore`, `FileSecretStore`, `SecretStore` unchanged.
- Keep existing external endpoint additions unchanged.

## Tests and Acceptance

Existing suite:
- `npm run typecheck`
- `npm test`
- `npm run smoke:external-live`

Acceptance:
- `npm run smoke:external-live` fails without `XYTE_CLI_KEY`.
- Missing `XYTE_CLI_KEY` fails at start of smoke step.
- Fresh environment can install package, install skill bundles, run setup once, then setup status is `ready`, and `call ... --output-mode envelope --strict-json` succeeds.
- New smoke test confirms skill usability command runs in isolated run.
