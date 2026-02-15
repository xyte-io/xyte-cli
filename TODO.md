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
