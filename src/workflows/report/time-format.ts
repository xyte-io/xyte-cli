import { safeString } from '../../utils/json';
import { parseTimestamp } from '../../utils/timestamp';

export { parseTimestamp };

function formatTwoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function formatUtcForReport(value: unknown): string {
  const parsed = parseTimestamp(value);
  if (!parsed) {
    return safeString(value);
  }

  const month = MONTHS_SHORT[parsed.getUTCMonth()];
  const day = formatTwoDigits(parsed.getUTCDate());
  const year = parsed.getUTCFullYear();
  const hh = formatTwoDigits(parsed.getUTCHours());
  const mm = formatTwoDigits(parsed.getUTCMinutes());
  return `${month} ${day}, ${year} ${hh}:${mm} UTC`;
}

export function formatRelativeAgeFromHours(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0.5) {
    return 'just now';
  }

  const wholeHours = Math.max(0, Math.round(hours));
  if (wholeHours < 24) {
    return `${wholeHours}h ago`;
  }

  const days = Math.floor(wholeHours / 24);
  const remainderHours = wholeHours % 24;
  if (remainderHours === 0) {
    return `${days}d ago`;
  }
  return `${days}d ${remainderHours}h ago`;
}

export function formatWindowLabel(windowHours: number): string {
  const normalized = Number.isFinite(windowHours) && windowHours > 0 ? Math.round(windowHours) : 24;
  if (normalized === 1) {
    return 'Last hour';
  }
  if (normalized <= 24) {
    return `Last ${normalized} hours`;
  }

  const daysExact = normalized / 24;
  if (Number.isInteger(daysExact)) {
    const days = Math.max(1, daysExact);
    if (days === 1) {
      return 'Last day';
    }
    if (days % 7 === 0) {
      const weeks = days / 7;
      if (weeks === 1) {
        return 'Last week';
      }
      return `Last ${weeks} weeks`;
    }
    return `Last ${days} days`;
  }

  return `Last ${normalized} hours`;
}
