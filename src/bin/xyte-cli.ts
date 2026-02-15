#!/usr/bin/env node

import { runCli } from '../cli/index';
import { toProblemDetails } from '../contracts/problem';
import { resolveCliErrorFormat } from '../utils/error-format';

runCli().catch((error) => {
  const errorFormat = resolveCliErrorFormat(process.argv.slice(2), process.env.XYTE_ERROR_FORMAT);
  if (errorFormat === 'json') {
    process.stderr.write(`${JSON.stringify(toProblemDetails(error), null, 2)}\n`);
    process.exit(1);
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
