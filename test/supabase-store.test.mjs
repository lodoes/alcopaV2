import assert from 'node:assert/strict';
import test from 'node:test';

import { serializeLot } from '../supabase-store.mjs';

test('Alcopa serialization preserves detail and Interencheres-owned columns', () => {
  const lot = {
    id: 'lyon-1',
    merge_key: 'lyon-1',
    sale_id: '12371',
    marque: 'PEUGEOT',
    finition: 'BlueHDi 130',
    prix_adjudication_eur: 12_500,
    statut: 'adjuge',
    url_interencheres: 'https://www.interencheres.com/lot-42.html',
  };
  const catalog = serializeLot(lot, false);
  const detailed = serializeLot(lot, true);

  assert.equal(Object.hasOwn(catalog, 'finition'), false);
  assert.equal(detailed.finition, 'BlueHDi 130');
  for (const column of ['prix_adjudication_eur', 'statut', 'url_interencheres']) {
    assert.equal(Object.hasOwn(catalog, column), false);
    assert.equal(Object.hasOwn(detailed, column), false);
  }
  assert.equal(catalog.raw_json.finition, 'BlueHDi 130');
});
