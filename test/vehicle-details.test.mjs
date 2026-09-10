import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeCtText, isPdfBuffer } from '../ct-analysis.mjs';
import { enrichLots, parseVehicleDetail } from '../vehicle-details.mjs';

test('parseVehicleDetail extracts characteristics, CT and aesthetic defects', () => {
  const damageSource = JSON.stringify([{
    id: 42,
    vehiculephoto_url: 'https://photos.example/damage.jpg',
    damage: {
      id: 7,
      zone: 'JAVG',
      zone_label: 'Jante avant gauche',
      type: 'P',
      type_label: 'Peinture',
    },
  }]).replace(/"/g, '&quot;');
  const html = `
    <html><body>
      <table><tr><th>Finition</th><td>BlueHDi 130</td></tr>
        <tr><th>Mise en circulation</th><td>03/01/2023</td></tr>
        <tr><th>Kilometrage</th><td>134 404 KM</td></tr>
        <tr><th>TVA Recuperable</th><td>OUI</td></tr>
        <tr><th>CO2</th><td>115 g/km</td></tr></table>
      <a href="/getDocument/ct/abc123">Controle technique</a>
      <div class="order-md-3">Rayure porte droite</div>
      <div class="mb-3 col-12">Double des cles absent</div>
      <div class="js-damage-proges" data-source="${damageSource}"></div>
    </body></html>`;

  const detail = parseVehicleDetail(html, 'https://www.alcopa-auction.fr/voiture-occasion/test-1');
  assert.equal(detail.finition, 'BlueHDi 130');
  assert.equal(detail.kilometrage_detail, 134404);
  assert.equal(detail.tva_recuperable, true);
  assert.equal(detail.co2_g_km, 115);
  assert.equal(detail.url_ct, 'https://www.alcopa-auction.fr/getDocument/ct/abc123');
  assert.match(detail.notes_annonce, /Rayure porte droite/);
  assert.equal(detail.defauts_esthetiques.length, 1);
  assert.equal(detail.defauts_esthetiques[0].zone_label, 'Jante avant gauche');
});

test('analyzeCtText detects verdict and OTC defects', () => {
  const result = analyzeCtText(`
    RESULTAT : DEFAVORABLE POUR DEFAILLANCES MAJEURES
    1.1.14.a Disque de frein use
    3.4.1.b Balai essuie-glace defectueux
  `);

  assert.equal(result.verdict, 'defavorable');
  assert.ok(result.majeures.some((label) => label.includes('1.1.14.a')));
  assert.ok(result.mineures.some((label) => label.includes('3.4.1.b')));
  assert.ok(result.nb_codes_detectes >= 2);
});

test('isPdfBuffer validates the PDF magic bytes', () => {
  assert.equal(isPdfBuffer(Buffer.from('%PDF-1.7\n')), true);
  assert.equal(isPdfBuffer(Buffer.from('<html>')), false);
});

test('enrichLots treats a zero detail limit as all vehicles', async () => {
  const html = '<table><tr><th>Couleur</th><td>Bleu</td></tr></table>';
  const result = await enrichLots([
    { id: 'one', url_alcopa: 'https://www.alcopa-auction.fr/voiture-occasion/one-1' },
    { id: 'two', url_alcopa: 'https://www.alcopa-auction.fr/voiture-occasion/two-2' },
  ], {
    detailLimit: 0,
    delayMs: 0,
    ocr: false,
    fetchHtml: async (url) => ({ status: 200, finalUrl: url, html, challenge: false }),
  });

  assert.equal(result.stats.detailsSucceeded, 2);
  assert.deepEqual(result.lots.map((lot) => lot.couleur), ['Bleu', 'Bleu']);
});
