import pino, { type Logger } from 'pino';

function resolveLevel(): string {
  return process.env.XYTE_LOG_LEVEL?.trim() || 'silent';
}

let _logger: Logger | undefined;

export function getLogger(): Logger {
  if (!_logger) {
    _logger = pino({ name: 'xyte-cli', level: resolveLevel() });
  }
  return _logger;
}

export function syncLoggerLevel(): void {
  if (_logger) {
    _logger.level = resolveLevel();
  }
}
