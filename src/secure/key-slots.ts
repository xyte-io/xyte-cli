import { createHash } from 'node:crypto';

import type { ApiKeySlotMeta } from '../types/profile';

export const DEFAULT_SLOT_ID = 'default';

export function makeKeyFingerprint(secret: string): string {
  return `sha256:${createHash('sha256').update(secret).digest('hex').slice(0, 12)}`;
}

export function slugifySlotName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || DEFAULT_SLOT_ID;
}

export function buildSlotId(name: string, existingSlotIds: Set<string>): string {
  const base = slugifySlotName(name);
  if (!existingSlotIds.has(base)) {
    return base;
  }

  let counter = 2;
  while (existingSlotIds.has(`${base}-${counter}`)) {
    counter += 1;
  }
  return `${base}-${counter}`;
}

export function matchesSlotRef(slot: ApiKeySlotMeta, slotRef: string): boolean {
  const needle = slotRef.trim().toLowerCase();
  if (!needle) {
    return false;
  }
  return slot.slotId.toLowerCase() === needle || slot.name.toLowerCase() === needle;
}

export function ensureSlotName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Slot name must not be empty.');
  }
  return trimmed;
}
