import pino, { type Logger } from 'pino';

function resolveLevel(): string {
  return process.env.XYTE_LOG_LEVEL?.trim() || 'silent';
}

let singleton: Logger | undefined;

export function getLogger(): Logger {
  if (!singleton) {
    singleton = pino({
      name: 'xyte-cli',
      level: resolveLevel()
    });
  }
  return singleton;
}
