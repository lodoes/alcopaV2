import assert from 'node:assert/strict';
import test from 'node:test';

import { createSupabaseStore, serializeLot } from '../supabase-store.mjs';

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

test('catalog serialization omits missing values without dropping known prices', () => {
  const missing = serializeLot({
    id: 'lyon-112',
    merge_key: 'lyon-112',
    mise_a_prix: null,
    estimation_eur: undefined,
    thumbnail: '',
  }, false);
  const known = serializeLot({
    id: 'lyon-114',
    merge_key: 'lyon-114',
    mise_a_prix: 16_100,
    estimation_eur: 16_100,
  }, false);

  for (const column of ['mise_a_prix', 'estimation_eur', 'thumbnail']) {
    assert.equal(Object.hasOwn(missing, column), false);
  }
  assert.equal(known.mise_a_prix, 16_100);
  assert.equal(known.estimation_eur, 16_100);
});

test('catalog upserts group sparse rows and never send a missing price as null', async () => {
  const calls = [];
  const store = createSupabaseStore({
    url: 'https://example.supabase.co',
    key: 'test-key',
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(null, { status: 204 });
    },
  });

  const saved = await store.upsertLots([
    {
      id: 'lyon-112',
      merge_key: 'lyon-112',
      sale_id: '12371',
      mise_a_prix: null,
      estimation_eur: null,
    },
    {
      id: 'lyon-114',
      merge_key: 'lyon-114',
      sale_id: '12371',
      mise_a_prix: 16_100,
      estimation_eur: 16_100,
    },
  ]);

  assert.equal(saved, 2);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const rows = JSON.parse(call.options.body);
    const columns = new URL(call.url).searchParams.get('columns').split(',');
    assert.deepEqual(Object.keys(rows[0]).sort(), columns.sort());
    assert.equal(
      rows.some((row) => row.mise_a_prix === null || row.estimation_eur === null),
      false,
    );
  }
});

test('Interencheres storage reads both date formats and patches existing rows only', async () => {
  const calls = [];
  const store = createSupabaseStore({
    url: 'https://example.supabase.co',
    key: 'test-key',
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      if (options.method === 'PATCH') return new Response(null, { status: 204 });
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  await store.selectLotsByDate('2026-09-10');
  const selectUrl = new URL(calls[0].url);
  assert.equal(
    selectUrl.searchParams.get('or'),
    '(date_vente.eq.2026-09-10,date_vente.eq.10/09/2026)',
  );

  await store.updateInterencheresLots([{
    id: 'lyon-12371-lot-112',
    sale_id: '12371',
    date_vente: '10/09/2026',
    statut: 'adjuge',
    prix_adjudication_eur: 11_000,
    description: 'must not be updated',
  }]);
  const patchCall = calls[1];
  const patchUrl = new URL(patchCall.url);
  assert.equal(patchCall.options.method, 'PATCH');
  assert.equal(patchUrl.searchParams.get('id'), 'eq.lyon-12371-lot-112');
  assert.equal(patchUrl.searchParams.get('sale_id'), 'eq.12371');
  assert.equal(patchUrl.searchParams.get('date_vente'), 'eq.10/09/2026');
  assert.deepEqual(JSON.parse(patchCall.options.body), {
    prix_adjudication_eur: 11_000,
    statut: 'adjuge',
  });
});
