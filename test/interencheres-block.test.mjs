import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverSalesForRooms } from '../interencheres-cron.mjs';

const AUCTIONEERS = [
  { room: 'lyon', auctioneer_id: '509', url: 'https://www.interencheres.com/lyon-509/' },
  { room: 'rennes', auctioneer_id: '145', url: 'https://www.interencheres.com/rennes-145/' },
];

const CONFIG = {
  apiEnabled: true,
  discoveryHtmlFallback: false,
  maxCandidatesPerRoom: 12,
};

function blockedResult() {
  return {
    apiUrl: 'https://search.interencheres.com/v1/search/ie4_sales',
    sales: [],
    received: 0,
    blocked: true,
    complete: false,
    error: 'API ventes Interencheres HTTP 403 (challenge anti-bot)',
    response: { status: 403, challenge: true },
  };
}

function emptyResult() {
  return {
    apiUrl: 'https://search.interencheres.com/v1/search/ie4_sales',
    sales: [],
    received: 0,
    blocked: false,
    complete: true,
    error: null,
    response: { status: 200, challenge: false },
  };
}

test('discoverSalesForRooms signale toutes les salles bloquees par l anti-bot', async () => {
  const discovery = await discoverSalesForRooms(['lyon', 'rennes'], '2026-09-10', CONFIG, {
    auctioneers: AUCTIONEERS,
    discoverInterencheresSalesApi: async () => blockedResult(),
  });

  assert.equal(discovery.roomsAttempted, 2);
  assert.deepEqual(discovery.blockedRooms.map((item) => item.room), ['lyon', 'rennes']);
  assert.deepEqual(discovery.failedRooms, []);
  assert.deepEqual(discovery.sales, []);
});

test('une soiree sans resultats publies n est pas comptee comme un blocage', async () => {
  const discovery = await discoverSalesForRooms(['lyon', 'rennes'], '2026-09-10', CONFIG, {
    auctioneers: AUCTIONEERS,
    discoverInterencheresSalesApi: async () => emptyResult(),
  });

  assert.equal(discovery.roomsAttempted, 2);
  assert.deepEqual(discovery.blockedRooms, []);
  assert.deepEqual(discovery.sales, []);
});

test('un blocage partiel ne remonte que la salle concernee', async () => {
  const discovery = await discoverSalesForRooms(['lyon', 'rennes'], '2026-09-10', CONFIG, {
    auctioneers: AUCTIONEERS,
    discoverInterencheresSalesApi: async ({ auctioneer }) => (
      auctioneer.room === 'lyon' ? blockedResult() : emptyResult()
    ),
  });

  assert.equal(discovery.roomsAttempted, 2);
  assert.deepEqual(discovery.blockedRooms.map((item) => item.room), ['lyon']);
});

test('une reponse API invalide est un echec, pas un blocage', async () => {
  const discovery = await discoverSalesForRooms(['lyon'], '2026-09-10', CONFIG, {
    auctioneers: AUCTIONEERS,
    discoverInterencheresSalesApi: async () => ({
      ...blockedResult(),
      blocked: false,
      error: 'Reponse API ventes Interencheres invalide',
      response: { status: 200, challenge: false },
    }),
  });

  assert.deepEqual(discovery.blockedRooms, []);
  assert.deepEqual(discovery.failedRooms.map((item) => item.room), ['lyon']);
});

test('le repli HTML reussi efface le blocage de la salle', async () => {
  const discovery = await discoverSalesForRooms(['lyon'], '2026-09-10', {
    ...CONFIG,
    discoveryHtmlFallback: true,
  }, {
    auctioneers: AUCTIONEERS,
    discoverInterencheresSalesApi: async () => blockedResult(),
    fetchHtml: async () => ({ status: 200, challenge: false, html: '<html></html>', finalUrl: 'https://www.interencheres.com/lyon-509/' }),
  });

  assert.deepEqual(discovery.blockedRooms, []);
});

test('une salle inconnue n est pas comptee dans les tentatives', async () => {
  const discovery = await discoverSalesForRooms(['salle-inexistante'], '2026-09-10', CONFIG, {
    auctioneers: AUCTIONEERS,
    discoverInterencheresSalesApi: async () => blockedResult(),
  });

  assert.equal(discovery.roomsAttempted, 0);
  assert.deepEqual(discovery.blockedRooms, []);
});
