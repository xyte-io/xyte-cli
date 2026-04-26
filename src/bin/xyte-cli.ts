#!/usr/bin/env node

import { runCli } from '../cli/index';
import { toProblemDetails } from '../client/errors';
import { errorMessage, resolveCliErrorFormat } from '../utils/error-format';
import { redactSensitiveText } from '../utils/redact';

runCli().catch((error) => {
  if (process.env.XYTE_ERROR_FORMAT !== undefined && process.env.XYTE_CLI_ERROR_FORMAT === undefined) {
    process.stderr.write('Warning: XYTE_ERROR_FORMAT is deprecated, use XYTE_CLI_ERROR_FORMAT instead.\n');
  }
  let errorFormat: 'text' | 'json' = 'text';
  try {
    errorFormat = resolveCliErrorFormat(
      process.argv.slice(2),
      process.env.XYTE_CLI_ERROR_FORMAT ?? process.env.XYTE_ERROR_FORMAT
    );
  } catch {
    errorFormat = 'text';
  }
  if (errorFormat === 'json') {
    process.stderr.write(`${JSON.stringify(toProblemDetails(error), null, 2)}\n`);
    process.exit(1);
  }

  const message = errorMessage(error);
  process.stderr.write(`${redactSensitiveText(message)}\n`);
  process.exit(1);
});
