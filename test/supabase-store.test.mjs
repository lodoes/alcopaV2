import assert from 'node:assert/strict';
import test from 'node:test';

import { serializeLot } from '../supabase-store.mjs';

test('catalog serialization does not erase detail columns on upsert', () => {
  const lot = {
    id: 'lyon-1',
    merge_key: 'lyon-1',
    sale_id: '12371',
    marque: 'PEUGEOT',
    finition: 'BlueHDi 130',
  };
  const catalog = serializeLot(lot, false);
  const detailed = serializeLot(lot, true);

  assert.equal(Object.hasOwn(catalog, 'finition'), false);
  assert.equal(detailed.finition, 'BlueHDi 130');
  assert.equal(catalog.raw_json.finition, 'BlueHDi 130');
});
