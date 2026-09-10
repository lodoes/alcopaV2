import assert from 'node:assert/strict';
import test from 'node:test';

import { filterSales, parseHomepageSales } from '../homepage-sales.mjs';

const html = `
  <div class="d-table">
    <span class="font-weight-bold text-prim">Tours</span>
    <span>, 306 lots</span>
    <div class="float-right text-nowrap">ven. 11 sept.</div>
    <div class="text-graynorm mt-1 pt-1 border-top">Vehicules Utilitaires et Tourisme</div>
    <a class="sale-access-href" href="/salle-de-vente-encheres/tours/12105">Voir la liste</a>
  </div>
  <div class="d-table">
    <span class="font-weight-bold text-prim">Marseille</span>
    <span>, 309 lots</span>
    <div class="float-right text-nowrap">ven. 11 sept.</div>
    <div class="text-graynorm mt-1 pt-1 border-top">Vehicules Utilitaires et Tourisme</div>
    <a class="sale-access-href" href="/salle-de-vente-encheres/marseille/12824">Voir la liste</a>
  </div>
  <div class="d-table">
    <span class="font-weight-bold text-prim">Marseille</span>
    <span>, 49 lots</span>
    <div class="float-right text-nowrap">mer. 16 sept.</div>
    <div class="text-graynorm mt-1 pt-1 border-top">Vente exceptionnelle camping cars</div>
    <a class="sale-access-href" href="/salle-de-vente-encheres/marseille/12531">Voir la liste</a>
  </div>`;

test('parseHomepageSales keeps separate sales from the same room', () => {
  const sales = parseHomepageSales(html);
  assert.equal(sales.length, 3);
  assert.deepEqual(sales.map((sale) => sale.sale_id), ['12105', '12824', '12531']);
  assert.equal(sales[0].lots_announced, 306);
  assert.equal(sales[2].title, 'Vente exceptionnelle camping cars');
});

test('filterSales selects every sale for a requested room', () => {
  const sales = filterSales(parseHomepageSales(html), 'marseille');
  assert.equal(sales.length, 2);
  assert.ok(sales.every((sale) => sale.salle === 'Marseille'));
});
