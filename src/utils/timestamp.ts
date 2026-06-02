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
