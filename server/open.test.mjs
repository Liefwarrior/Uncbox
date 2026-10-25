// The named pages the dashboard can ask the server to open. Only fixed addresses, plus a plain item number for Wowhead.

import { describe, expect, it } from 'vitest';
import { pageFor } from './open.mjs';

describe('pageFor: wowhead-item', () => {
  it('opens the Classic Wowhead page of an item number', () => {
    expect(pageFor('wowhead-item', { itemId: 2589 })).toBe('https://www.wowhead.com/classic/item=2589');
    expect(pageFor('wowhead-item', { itemId: '19019' })).toBe('https://www.wowhead.com/classic/item=19019');
  });

  it('refuses anything that is not a plain number, so nothing else can ride in the address', () => {
    for (const itemId of [undefined, null, '', 'abc', '12/../x', '1;2', -5, 1.5, '123456789', '2589?x=1']) {
      expect(pageFor('wowhead-item', { itemId }), String(itemId)).toBeNull();
    }
  });

  it('still knows nothing about other names', () => {
    expect(pageFor('somewhere-else', { itemId: 2589 })).toBeNull();
  });
});
