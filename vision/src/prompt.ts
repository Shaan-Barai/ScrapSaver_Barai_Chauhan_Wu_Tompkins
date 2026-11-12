/**
 * Menu text sanitizing for prompts. Menu names/descriptions are untrusted
 * input: control characters are stripped and lengths capped before they are
 * embedded as JSON data in a prompt (localize.ts, calibration.ts, overlay.ts).
 */

import type { MenuItem } from './contracts.js';

const MAX_NAME_LEN = 120;
const MAX_DESCRIPTION_LEN = 300;
const MAX_ITEM_ID_LEN = 128;

/** Strip control chars / backticks and cap length. Untrusted text becomes plain data. */
export function sanitizeMenuText(raw: string, maxLen: number): string {
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

export interface SanitizedMenuItem {
  itemId: string;
  name: string;
  description?: string;
}

export function sanitizeMenuItems(items: MenuItem[]): SanitizedMenuItem[] {
  return items.map((item) => {
    const description = item.description === undefined ? undefined : sanitizeMenuText(item.description, MAX_DESCRIPTION_LEN);
    return {
      itemId: sanitizeMenuText(item.itemId, MAX_ITEM_ID_LEN),
      name: sanitizeMenuText(item.displayName, MAX_NAME_LEN),
      ...(description !== undefined && description !== '' ? { description } : {}),
    };
  });
}
