// Convenience re-export so callers import from `client/errors` rather than the
// internal `http/problem-mapper` module. If this re-export is ever removed,
// update the five import sites in bin/xyte-cli.ts, cli/index.ts, cli/commands/api.ts,
// workflows/watch.ts, and workflows/flow-runner.ts.
export { toProblemDetails } from '../http/problem-mapper';
