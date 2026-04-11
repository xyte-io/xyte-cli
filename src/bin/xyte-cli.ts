#!/usr/bin/env node

import { runCli } from '../cli/index';
import { toProblemDetails } from '../client/errors';
import { errorMessage, resolveCliErrorFormat } from '../utils/error-format';
import { redactSensitiveText } from '../utils/redact';

runCli().catch((error) => {
  const errorFormat = resolveCliErrorFormat(
    process.argv.slice(2),
    process.env.XYTE_CLI_ERROR_FORMAT ?? process.env.XYTE_ERROR_FORMAT
  );
  if (errorFormat === 'json') {
    process.stderr.write(`${JSON.stringify(toProblemDetails(error), null, 2)}\n`);
    process.exit(1);
  }

  const message = errorMessage(error);
  process.stderr.write(`${redactSensitiveText(message)}\n`);
  process.exit(1);
});
