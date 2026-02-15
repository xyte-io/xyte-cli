# TODO - xyte-cli continuation

## A. Lock product surface
- [x] Keep package identity: `@xyte/cli`
- [x] Keep single executable: `xyte-cli`
- [x] Remove any compatibility/alias behavior not part of current feature set

## B. Remove compatibility code (hard delete)
- [x] Remove deprecated CLI commands: `auth set-key`, `auth clear-key`
- [x] Remove related helper code used only by those commands
- [x] Remove legacy keychain account fallback logic
- [x] Remove legacy readiness fallback probing
- [x] Replace `XYTE_SDK_KEY` with `XYTE_CLI_KEY`
- [x] Replace `XYTE_SDK_KEYCHAIN_BACKEND` with `XYTE_CLI_KEYCHAIN_BACKEND`
- [x] Remove compatibility wording from errors/help text

## C. Finalize no-Network surface
- [x] Ensure no `discover` command group exists
- [x] Ensure no `network` TUI screen/tab/path exists
- [x] Ensure headless renderer no longer includes any network branch
- [x] Ensure scene/types/tests no longer reference network screen

## D. Finalize provider-first Config screen
- [x] Keep panes: provider health / provider slots / actions
- [x] Keep hotkeys: `a e u t x n c r`
- [x] Ensure selected provider drives slot list deterministically
- [x] Ensure slot test updates `lastValidatedAt`

## E. Update tests to current-only behavior
- [x] Update CLI tests to `xyte-cli` command identity
- [x] Add install flow tests for `install --skills` and `--no-setup`
- [x] Remove compatibility tests and compatibility expectations
- [x] Update TUI tab/navigation tests to no-network tab order
- [x] Update headless tests to no-network tab metadata
- [x] Update scene-formatting tests for provider-first config schema

## F. Clean docs and skill package
- [x] Remove legacy wrapper section from README
- [x] Update README quickstart to `xyte-cli` only
- [x] Update skill references and scripts to current env vars and paths
- [x] Remove compatibility language from skill and references

## G. Validate
- [x] `npm run typecheck`
- [x] `npm test` (all tests green)
- [x] `npm pack` and verify package contents
- [x] Verify install flow manually in temp workspace:
- [x] `npm i -g <packed-tarball>`
- [x] `xyte-cli install --skills --no-setup`
- [x] skill exists at `.claude/skills/xyte-cli`

## H. Fix skill guidance for installed users (global invocation only)
- [x] Update `/Users/porton/Projects/xyte-cli/skills/xyte-cli/SKILL.md` so agent instructions use only `xyte-cli ...` commands.
- [x] Remove agent-facing references to repo-local/source entrypoints (`npx`, `tsx`, `src/*`, `dist/*`, `bin/*`) from `/Users/porton/Projects/xyte-cli/skills/xyte-cli/SKILL.md`.
- [x] Remove agent-facing repo-path guidance and absolute workstation paths from `/Users/porton/Projects/xyte-cli/skills/xyte-cli/SKILL.md`.
- [x] Keep scripts in `/Users/porton/Projects/xyte-cli/skills/xyte-cli/scripts/` for maintainers only; do not present them as primary agent execution flow.
- [x] Fix command correctness examples in `/Users/porton/Projects/xyte-cli/skills/xyte-cli/SKILL.md` (do not show `tenant list --format`; it is invalid).
- [x] Update `/Users/porton/Projects/xyte-cli/skills/xyte-cli/agents/openai.yaml` prompt text to reflect direct `xyte-cli` usage only.
- [x] Update `/Users/porton/Projects/xyte-cli/skills/xyte-cli/references/endpoints.md` to remove script-driven utility execution guidance for agents.
- [x] Verify `/Users/porton/Projects/xyte-cli/skills/xyte-cli/references/headless-contract.md` and `/Users/porton/Projects/xyte-cli/skills/xyte-cli/references/tui-flows.md` remain global-invocation only.

## I. Validation for skill-only fix
- [x] Run `npm test`.
- [x] Search skill bundle for banned patterns and confirm none are agent-facing: `npx tsx`, `src/cli.ts`, `/Users/porton/Projects/xyte-cli`.
- [x] Search skill bundle for incorrect example: `tenant list --format`.
- [x] Run install smoke for multi-provider copy path:
- [x] `xyte-cli install --skills --scope project --agents all --no-setup`
- [x] Verify installed skill docs in provider folders contain global `xyte-cli` instructions only.

## Public APIs / Interfaces / Types
- [x] No CLI/API/type/schema changes.
- [x] Docs/skill guidance only.

## Acceptance Scenarios
- [x] Fresh installed user can rely on skill docs and invoke `xyte-cli` directly without source-tree assumptions.
- [x] Agent guidance no longer nudges models toward local dev entrypoints.
- [x] Skill examples only include currently supported command options.

## Assumptions
- [x] Package remains unpublished for now, so no backward compatibility work is required.
- [x] Goal is strict current behavior for installed usage, not migration support.
