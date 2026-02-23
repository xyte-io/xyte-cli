function identifier(value: unknown): string {
  if (value === undefined || value === null) {
    return 'n/a';
  }
  return String(value);
}

function formatTwoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function parseTimestamp(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  const trimmed = value.trim();
  const normalized = trimmed.replace(/\s+/, 'T');
  const parts = normalized.match(
    /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i
  );

  if (parts) {
    const date = parts[1];
    const hour = parts[2] ?? '00';
    const minute = parts[3] ?? '00';
    const second = parts[4] ?? '00';
    const fraction = parts[5] ? `.${parts[5].slice(0, 3).padEnd(3, '0')}` : '';
    const zoneRaw = parts[6] ?? 'Z';
    const zone = /^[+-]\d{4}$/.test(zoneRaw)
      ? `${zoneRaw.slice(0, 3)}:${zoneRaw.slice(3)}`
      : /^[+-]\d{2}$/.test(zoneRaw)
        ? `${zoneRaw}:00`
        : zoneRaw;
    const iso = `${date}T${hour}:${minute}:${second}${fraction}${zone}`;
    const parsedIso = new Date(iso);
    if (!Number.isNaN(parsedIso.getTime())) {
      return parsedIso;
    }
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed) && !/(Z|[+-]\d{2}(?::?\d{2})?)$/i.test(trimmed)) {
    const asUtc = new Date(`${trimmed}Z`);
    if (!Number.isNaN(asUtc.getTime())) {
      return asUtc;
    }
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const asDateUtc = new Date(`${trimmed}T00:00:00Z`);
    if (!Number.isNaN(asDateUtc.getTime())) {
      return asDateUtc;
    }
  }

  const direct = new Date(trimmed);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  return undefined;
}

export function formatUtcForReport(value: unknown): string {
  const parsed = parseTimestamp(value);
  if (!parsed) {
    return identifier(value);
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
