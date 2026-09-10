import assert from 'node:assert/strict';
import test from 'node:test';

import {
  matchInterencheresSales,
  parseAuctioneerLinks,
  parseAuctioneerSales,
  parseFrenchDate,
  parseInterencheresApiItem,
  parseInterencheresPage,
  scrapeInterencheresSale,
  scrapeInterencheresSaleApi,
} from '../interencheres.mjs';
import { buildUpdates } from '../interencheres-cron.mjs';

function salePage({ page = 1, totalPages = 2 } = {}) {
  const firstLot = page === 1 ? 112 : 118;
  const secondLot = page === 1 ? 114 : 120;
  return `
    <html>
      <head><title>Vehicules Utilitaires et Tourisme, vente aux encheres, le 10 septembre 2026</title></head>
      <body>
        <h2>ALCOPA AUCTION LYON</h2>
        <p>La vente est terminee</p>
        <p>4 lots</p>
        <button class="v-pagination__item">1</button>
        <button class="v-pagination__item">${totalPages}</button>
        <a id="ie-${firstLot}" href="/vehicules/vente-687897/lot-900${firstLot}.html?from=list">
          <div class="item-card-bid-info">Adjug&eacute; en salle : ${firstLot === 112 ? '11 000' : '14 800'} &euro;</div>
          <div class="text-body-2 font-italic"><span>${firstLot}</span></div>
          <div class="min-h-44"><div>VOLKSWAGEN - POLO</div></div>
        </a>
        <a id="ie-${secondLot}" href="/vehicules/vente-687897/lot-900${secondLot}.html">
          <div class="item-card-bid-info">Invendu</div>
          <div class="text-body-2 font-italic"><span>${secondLot}</span></div>
          <div class="min-h-44"><div>RENAULT - TRAFIC</div></div>
        </a>
      </body>
    </html>`;
}

test('parseFrenchDate understands the Interencheres French date', () => {
  assert.equal(parseFrenchDate('Jeudi 10 septembre 2026 a 10h00'), '2026-09-10');
});

test('auctioneer discovery keeps Alcopa houses and their vehicle sales', () => {
  const directory = `
    <a href="/commissaire-priseur/alcopa-auction-lyon-509/">ALCOPA AUCTION LYON</a>
    <a href="/commissaire-priseur/other-house-22/">Other</a>`;
  const houses = parseAuctioneerLinks(directory);
  assert.deepEqual(houses.map((house) => house.room), ['lyon']);

  const sales = parseAuctioneerSales(`
    <a href="/vehicules/vehicules-utilitaires-et-tourisme-687897">448 lots Voir les lots</a>
    <a href="/vehicules/vente-687897/lot-123.html">Lot 1</a>`, houses[0].url);
  assert.equal(sales.length, 1);
  assert.equal(sales[0].lots_announced, 448);
});

test('Interencheres page parser extracts terminal results and pagination', () => {
  const parsed = parseInterencheresPage(
    salePage(),
    'https://www.interencheres.com/vehicules/vehicules-utilitaires-et-tourisme-687897',
    'lyon',
  );
  assert.equal(parsed.metadata.date, '2026-09-10');
  assert.equal(parsed.metadata.completed, true);
  assert.equal(parsed.metadata.room_confirmed, true);
  assert.equal(parsed.totalPages, 2);
  assert.equal(parsed.lots.length, 2);
  assert.deepEqual(
    parsed.lots.map((lot) => [lot.lot_number, lot.statut, lot.prix_adjudication_eur]),
    [[112, 'adjuge', 11_000], [114, 'invendu', null]],
  );
  assert.equal(parsed.lots[0].canal, 'salle');
  assert.equal(parsed.lots[0].url_interencheres.endsWith('lot-900112.html'), true);
});

test('sale scraper follows every page', async () => {
  const calls = [];
  const result = await scrapeInterencheresSale({
    url: 'https://www.interencheres.com/vehicules/vehicules-utilitaires-et-tourisme-687897',
    expectedRoom: 'lyon',
    delayMs: 0,
    fetchHtml: async (url) => {
      calls.push(url);
      const page = Number(new URL(url).searchParams.get('page') || 1);
      return { status: 200, challenge: false, finalUrl: url, html: salePage({ page }) };
    },
  });
  assert.equal(result.complete, true);
  assert.equal(result.pagesSeen, 2);
  assert.equal(result.lots.length, 4);
  assert.equal(calls.length, 2);
});

test('Interencheres API parser extracts sold, unsold and auction channel', () => {
  const saleUrl = 'https://www.interencheres.com/vehicules/vehicules-utilitaires-et-tourisme-687897';
  const physical = parseInterencheresApiItem({
    id: 88695674,
    meta: { order_number: { primary: 104 } },
    pricing: { auctioned: { sold: true, price: 8300, type: 'physical', site: null } },
    states: { suppressed: false },
    title_translations: { 'fr-FR': 'PEUGEOT - 308 SOCIETE' },
  }, saleUrl);
  const live = parseInterencheresApiItem({
    id: 88695675,
    meta: { order_number: { primary: 105 } },
    pricing: { auctioned: { sold: true, price: 9100, type: 'live_bid', site: 'interencheres' } },
    states: { suppressed: false },
  }, saleUrl);
  const unsold = parseInterencheresApiItem({
    id: 88695676,
    meta: { order_number: { primary: 106 } },
    pricing: { auctioned: { sold: false } },
    states: { suppressed: false },
  }, saleUrl);

  assert.deepEqual(
    [physical, live, unsold].map((lot) => [lot.lot_number, lot.statut, lot.prix_adjudication_eur, lot.canal]),
    [
      [104, 'adjuge', 8300, 'salle'],
      [105, 'adjuge', 9100, 'internet'],
      [106, 'invendu', null, ''],
    ],
  );
  assert.equal(physical.lot_interencheres_id, '88695674');
  assert.equal(physical.url_interencheres.endsWith('/lot-88695674.html'), true);
});

test('Interencheres API scraper paginates with x-range', async () => {
  const calls = [];
  const items = [
    { id: 1, meta: { order_number: { primary: 100 } }, pricing: { auctioned: { sold: true, price: 8000, type: 'physical' } } },
    { id: 2, meta: { order_number: { primary: 101 } }, pricing: { auctioned: { sold: false } } },
    { id: 3, meta: { order_number: { primary: 102 } }, pricing: { auctioned: { sold: true, price: 9000, type: 'live_bid' } } },
  ];
  const result = await scrapeInterencheresSaleApi({
    url: 'https://www.interencheres.com/vehicules/vente-687897',
    saleId: 687897,
    pageSize: 2,
    maxPages: 5,
    delayMs: 0,
    fetchJson: async (url, options) => {
      calls.push({ url, options });
      const range = options.headers['x-range'].match(/items=(\d+)-(\d+)/);
      const start = Number(range[1]);
      const end = Number(range[2]);
      return {
        status: 200,
        challenge: false,
        headers: { 'content-range': `${start}-${Math.min(end, 2)}/3` },
        text: JSON.stringify(items.slice(start, end + 1)),
      };
    },
  });

  assert.equal(result.complete, true);
  assert.equal(result.pagesSeen, 2);
  assert.equal(result.expectedPages, 2);
  assert.equal(result.lots.length, 3);
  assert.equal(calls[0].options.headers['x-range'], 'items=0-1');
  assert.equal(calls[1].options.headers['x-range'], 'items=2-3');
  assert.match(calls[0].url, /filters%5Bsale%5D=687897/);
});

test('same-room sales are assigned by lot-number overlap', () => {
  const localSales = [
    { sale_id: 'main', salle: 'Lyon', date_vente: '2026-09-10', lots: [{ lot_number: 100 }, { lot_number: 101 }, { lot_number: 102 }] },
    { sale_id: 'special', salle: 'Lyon', date_vente: '2026-09-10', lots: [{ lot_number: 1 }, { lot_number: 2 }, { lot_number: 3 }] },
  ];
  const ieSales = [
    { url: 'ie-special', metadata: { event_id: '2', room: 'lyon', date: '2026-09-10' }, lots: [{ lot_number: 1 }, { lot_number: 2 }, { lot_number: 3 }] },
    { url: 'ie-main', metadata: { event_id: '1', room: 'lyon', date: '2026-09-10' }, lots: [{ lot_number: 100 }, { lot_number: 101 }, { lot_number: 102 }] },
  ];
  const matches = matchInterencheresSales(localSales, ieSales);
  assert.deepEqual(
    matches.map((match) => [match.localSale.sale_id, match.ieSale.metadata.event_id]),
    [['main', '1'], ['special', '2']],
  );
});

test('result merge only prepares terminal Interencheres fields', () => {
  const localSale = {
    sale_id: '12371',
    salle: 'Lyon',
    date_vente: '2026-09-10',
    lots: [
      { id: 'lot-112', sale_id: '12371', date_vente: '10/09/2026', lot_number: 112, statut: 'en_cours' },
      { id: 'lot-114', sale_id: '12371', date_vente: '10/09/2026', lot_number: 114, statut: 'en_cours' },
    ],
  };
  const ieSale = {
    lots: [
      { lot_number: 112, statut: 'adjuge', prix_adjudication_eur: 11_000, canal: 'internet', url_interencheres: 'https://www.interencheres.com/lot-112.html', lot_interencheres_id: 'ie-112' },
      { lot_number: 114, statut: 'en_cours', prix_adjudication_eur: null, canal: '', url_interencheres: 'https://www.interencheres.com/lot-114.html', lot_interencheres_id: 'ie-114' },
    ],
  };
  const result = buildUpdates([{ localSale, ieSale }]);
  assert.equal(result.updates.length, 1);
  assert.deepEqual(result.updates[0], {
    id: 'lot-112',
    sale_id: '12371',
    date_vente: '10/09/2026',
    enchere_courante: null,
    prix_adjudication_eur: 11_000,
    statut: 'adjuge',
    canal: 'internet',
    url_interencheres: 'https://www.interencheres.com/lot-112.html',
    lot_interencheres_id: 'ie-112',
  });
});
