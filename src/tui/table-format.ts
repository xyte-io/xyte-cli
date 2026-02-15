export type EllipsisMode = 'middle' | 'end';

export function sanitizePrintable(value: unknown): string {
  if (value === undefined || value === null) {
    return 'n/a';
  }
  const text = String(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001F\u007F]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return text || 'n/a';
}

export function ellipsizeEnd(value: unknown, maxChars: number): string {
  const text = sanitizePrintable(value);
  if (maxChars <= 0) {
    return '';
  }
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars === 1) {
    return '…';
  }
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

export function ellipsizeMiddle(value: unknown, maxChars: number): string {
  const text = sanitizePrintable(value);
  if (maxChars <= 0) {
    return '';
  }
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars < 3) {
    return ellipsizeEnd(text, maxChars);
  }
  const body = maxChars - 1;
  const head = Math.ceil(body / 2);
  const tail = body - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

export function shortId(value: unknown, keep: { head: number; tail: number } = { head: 6, tail: 4 }): string {
  const text = sanitizePrintable(value);
  const min = keep.head + keep.tail + 1;
  if (text.length <= min) {
    return text;
  }
  return `${text.slice(0, keep.head)}…${text.slice(text.length - keep.tail)}`;
}

export function formatBoolTag(value: unknown): 'yes' | 'no' {
  if (typeof value === 'boolean') {
    return value ? 'yes' : 'no';
  }
  const normalized = sanitizePrintable(value).toLowerCase();
  return ['yes', 'true', '1', 'active', 'on'].includes(normalized) ? 'yes' : 'no';
}

export function fitCell(value: unknown, width: number, mode: EllipsisMode = 'end'): string {
  const text = sanitizePrintable(value);
  if (width <= 0) {
    return '';
  }
  if (text.length <= width) {
    return text;
  }
  if (mode === 'middle') {
    return ellipsizeMiddle(text, width);
  }
  return ellipsizeEnd(text, width);
}
