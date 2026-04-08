import pino, { type Logger } from 'pino';

function resolveLevel(): string {
  return process.env.XYTE_LOG_LEVEL?.trim() || 'silent';
}

export function getLogger(): Logger {
  return pino({
    name: 'xyte-cli',
    level: resolveLevel()
  });
}
