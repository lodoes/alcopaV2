import assert from 'node:assert/strict';
import test from 'node:test';

import { parseHtml } from '../scrape-alcopa.mjs';

function catalogHtml(imageAttributes) {
  return `
    <turbo-frame id="search-results">
      <div class="col-12 col-lg-6 align-items-stretch mb-3 fs-14">
        <div class="card-title"><a href="/voiture-occasion/peugeot/308-123456">PEUGEOT | 308</a></div>
        <img class="vehicle-photo" ${imageAttributes} alt="PEUGEOT 308">
        <p class="mb-2">308 BlueHDi 130</p>
        <p class="mb-1">GO<br>1ere : 2023<br>45 200 km<br>Boîte manuelle</p>
        Lot n° <strong>7</strong>
      </div>
    </turbo-frame>`;
}

test('parseHtml extracts and absolutizes a lazy-loaded thumbnail', () => {
  const parsed = parseHtml(
    catalogHtml('data-src="/uploads/vehicles/308.jpg"'),
    'https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371',
  );

  assert.equal(parsed.lots.length, 1);
  assert.equal(parsed.lots[0].thumbnail, 'https://www.alcopa-auction.fr/uploads/vehicles/308.jpg');
});

test('parseHtml accepts src when it is not the first image attribute', () => {
  const parsed = parseHtml(
    catalogHtml('loading="lazy" src="https://cdn.example/308.webp"'),
    'https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371',
  );

  assert.equal(parsed.lots[0].thumbnail, 'https://cdn.example/308.webp');
});
