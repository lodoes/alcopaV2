import http from 'node:http';
import {
  BASE_URL,
  DEFAULT_URL,
  closeBrowser,
  describeBlock,
  enrichVehicles,
  fetchHtml,
  getTransportName,
  scrape,
  toCsv,
} from './scrape-alcopa.mjs';
import {
  matchInterencheresSales,
  normalizeRoom,
  parseFrenchDate,
} from './interencheres.mjs';
import { buildUpdates, groupLocalSales } from './interencheres-cron.mjs';
import { createSupabaseStore } from './supabase-store.mjs';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const APP_VERSION = '2026-09-10-interencheres-sales-api-v2';
const DEFAULT_MAX_PAGES = Number(process.env.DEFAULT_MAX_PAGES || 30);
const MAX_ALLOWED_PAGES = Number(process.env.MAX_ALLOWED_PAGES || 40);
const DEFAULT_DELAY_MS = Number(process.env.DEFAULT_DELAY_MS || 350);
const DEFAULT_DETAIL_LIMIT = Number(process.env.DEFAULT_DETAIL_LIMIT || 10);
const MAX_DETAIL_LIMIT = Number(process.env.MAX_DETAIL_LIMIT || 500);
const DEFAULT_OCR_LIMIT = Number(process.env.DEFAULT_OCR_LIMIT || 3);
const MAX_OCR_LIMIT = Number(process.env.MAX_OCR_LIMIT || 500);
const DEFAULT_DETAIL_DELAY_MS = Number(process.env.DEFAULT_DETAIL_DELAY_MS || 500);
const MAX_IMPORT_BYTES = Math.max(10_000, Number(process.env.MAX_IMPORT_BYTES || 2_000_000));

function supabaseEnvStatus() {
  const url = String(process.env.SUPABASE_URL || '').trim();
  const key = String(
    process.env.SUPABASE_SERVICE_ROLE_KEY
      || process.env.SUPABASE_KEY
      || '',
  ).trim();
  return {
    urlConfigured: Boolean(url),
    serviceRoleKeyConfigured: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    fallbackKeyConfigured: Boolean(process.env.SUPABASE_KEY),
    usable: Boolean(url && key),
  };
}

function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  const payload = isBuffer || typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-import-token',
    'cache-control': 'no-store',
    'content-type': isBuffer ? 'application/octet-stream' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(payload);
}

function readJsonBody(req, maxBytes = MAX_IMPORT_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`Payload trop volumineux (${size} octets)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(new Error(`JSON invalide: ${error.message}`));
      }
    });
  });
}

function cleanText(value = '') {
  return String(value).replace(/\u00a0|\u202f/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeBookmarkletDate(value = '') {
  const parsed = parseFrenchDate(value);
  if (parsed) return parsed;
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

function normalizeImportedLots(items, pageUrl) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    lot_number: Number(item.lot_number),
    salle: cleanText(item.salle || ''),
    date_vente: cleanText(item.date_vente || ''),
    lot_interencheres_id: String(item.lot_interencheres_id || '').trim() || null,
    description: cleanText(item.description || item.marque || ''),
    prix_adjudication_eur: Number.isFinite(Number(item.prix_adjudication_eur))
      ? Number(item.prix_adjudication_eur)
      : null,
    statut: cleanText(item.statut || 'inconnu'),
    canal: cleanText(item.canal || '') || null,
    url_interencheres: cleanText(item.url_interencheres || pageUrl || ''),
  })).filter((lot) => Number.isFinite(lot.lot_number));
}

async function handleInterencheresImport(req, res) {
  const body = await readJsonBody(req);
  const expectedToken = String(process.env.IE_IMPORT_TOKEN || '').trim();
  const providedToken = String(req.headers['x-import-token'] || body.token || '').trim();
  if (expectedToken && providedToken !== expectedToken) {
    send(res, 401, { ok: false, error: 'Token import Interencheres invalide.' });
    return;
  }

  const lots = normalizeImportedLots(body.lots || body.items || body.data, body.pageUrl);
  if (!lots.length) {
    send(res, 400, { ok: false, error: 'Aucun lot Interencheres valide dans le payload.' });
    return;
  }

  const saleDate = normalizeBookmarkletDate(body.date_vente || body.dateVente || lots[0]?.date_vente);
  const room = normalizeRoom(body.salle || body.room || lots[0]?.salle || '');
  if (!room) {
    send(res, 400, { ok: false, error: 'Salle Interencheres introuvable dans le payload.' });
    return;
  }

  const store = createSupabaseStore();
  if (!store) {
    send(res, 500, {
      ok: false,
      error: 'Configure SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY sur le service API Railway, puis redeploy.',
      supabase: supabaseEnvStatus(),
    });
    return;
  }

  const localLots = await store.selectLotsByDate(saleDate);
  const localSales = groupLocalSales(localLots)
    .filter((sale) => normalizeRoom(sale.salle) === room);
  const ieSale = {
    url: cleanText(body.pageUrl || ''),
    metadata: {
      event_id: String(body.saleId || body.sale_id || ''),
      room,
      date: saleDate,
    },
    lots,
  };
  const matches = matchInterencheresSales(localSales, [ieSale]);
  const { updates, stats } = buildUpdates(matches);
  const saved = await store.updateInterencheresLots(updates);

  send(res, 200, {
    ok: matches.length > 0,
    source: body.source || 'bookmarklet',
    room,
    saleDate,
    importedLots: lots.length,
    localSales: localSales.length,
    matchedSales: matches.length,
    updates: updates.length,
    saved,
    ...stats,
  });
}

function interencheresBookmarkletScript() {
  return String.raw`(async () => {
  const currentScript = document.currentScript;
  const apiBase = currentScript ? new URL(currentScript.src).origin : '';
  const apiUrl = apiBase + '/interencheres/import';
  const token = currentScript ? new URL(currentScript.src).searchParams.get('token') || '' : '';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (element) => (element?.textContent || '').replace(/\s+/g, ' ').trim();
  const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const euro = (value) => {
    const match = String(value || '').match(/(\d[\d\s\u202f\u00a0]*)\s*€/);
    return match ? Number(match[1].replace(/[^\d]/g, '')) : null;
  };
  const context = (() => {
    let saleId = '';
    let salle = '';
    const saleMatch = location.href.match(/alcopa-auction-([\w-]+)-(\d+)/i);
    if (saleMatch) {
      salle = saleMatch[1].replace(/-/g, ' ');
      saleId = saleMatch[2];
    }
    if (!saleId) {
      const idMatch = location.href.match(/-(\d{5,})(?:[/?#]|$)/);
      if (idMatch) saleId = idMatch[1];
    }
    const houseLink = document.querySelector('a[href*="commissaire-priseur/alcopa-auction"]');
    if (!salle && houseLink) {
      const roomMatch = houseLink.href.match(/alcopa-auction-([\w-]+)-\d+/i);
      if (roomMatch) salle = roomMatch[1].replace(/-/g, ' ');
    }
    const bodyMatch = document.body.innerText.match(/ALCOPA\s+AUCTION\s+([A-Z\s-]+)/i);
    if (!salle && bodyMatch) salle = bodyMatch[1].trim().toLowerCase();
    return { saleId: saleId || 'unknown', salle };
  })();
  const now = new Date();
  const dateVente = String(now.getDate()).padStart(2, '0') + '/'
    + String(now.getMonth() + 1).padStart(2, '0') + '/'
    + now.getFullYear();
  function parseLot(card) {
    let lotNumber = Number.parseInt(text(card.querySelector('.text-body-2.font-italic span,[class*=font-italic].text-body-2 span')), 10);
    if (!lotNumber) {
      const match = text(card).match(/\bLot\s+(\d+)\b/i);
      if (match) lotNumber = Number.parseInt(match[1], 10);
    }
    if (!lotNumber) return null;
    const title = text(card.querySelector('[class*="min-h-44"] > div'));
    const bidText = text(card.querySelector('.item-card-bid-info'));
    const allText = text(card).toLowerCase();
    let statut = 'inconnu';
    let price = null;
    if (/adjug/.test(allText)) {
      statut = 'adjuge';
      price = euro(bidText || allText);
    } else if (/invendu|non adjug/.test(allText)) {
      statut = 'invendu';
    } else if (/retir/.test(allText)) {
      statut = 'retire';
    } else if (/estimation|ench/.test(allText)) {
      statut = 'en_cours';
    }
    const canal = /en salle/.test(allText)
      ? 'salle'
      : /interencheres|internet|en ligne/.test(allText)
        ? 'internet'
        : '';
    const href = card.href || '';
    const lotId = (href.match(/lot-(\d+)\.html/i) || [])[1] || card.id || '';
    return {
      lot_number: lotNumber,
      lot_interencheres_id: lotId,
      sale_id: context.saleId,
      salle: context.salle,
      date_vente: dateVente,
      description: title,
      prix_adjudication_eur: price,
      statut,
      canal,
      url_interencheres: href.split('?')[0],
      scraped_at: new Date().toISOString(),
    };
  }
  function saleBaseUrl() {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/lot-\d+\.html$/i, '').replace(/\/$/, '');
    return url.href;
  }
  function itemUrl(itemId) {
    return saleBaseUrl() + '/lot-' + itemId + '.html';
  }
  function parseApiItem(item) {
    const itemId = Number(item?.id);
    const lotNumber = Number(item?.meta?.order_number?.primary);
    if (!Number.isFinite(itemId) || !Number.isFinite(lotNumber)) return null;
    const auctioned = item?.pricing?.auctioned || {};
    let statut = 'inconnu';
    let price = null;
    if (item?.states?.suppressed === true) {
      statut = 'retire';
    } else if (auctioned.sold === true) {
      statut = 'adjuge';
      const value = Number(auctioned.price);
      price = Number.isFinite(value) ? value : null;
    } else if (auctioned.sold === false) {
      statut = 'invendu';
    } else if (item?.states?.ended === false || item?.states?.closed === false) {
      statut = 'en_cours';
    }
    const auctionType = normalize((auctioned.type || '') + ' ' + (auctioned.site || ''));
    const canal = /live|online|interencheres/.test(auctionType)
      ? 'internet'
      : /physical|salle/.test(auctionType)
        ? 'salle'
        : '';
    return {
      lot_number: lotNumber,
      lot_interencheres_id: String(itemId),
      sale_id: context.saleId,
      salle: context.salle,
      date_vente: dateVente,
      description: text({ textContent: item?.title_translations?.['fr-FR'] || item?.title_translations?.['en-US'] || item?.description || '' }),
      prix_adjudication_eur: price,
      statut,
      canal,
      url_interencheres: itemUrl(itemId),
      scraped_at: new Date().toISOString(),
    };
  }
  async function fetchApiLots() {
    if (!/^\d+$/.test(context.saleId)) throw new Error('ID vente Interencheres introuvable pour API.');
    const pageSize = 200;
    const maxPages = 20;
    const lots = [];
    for (let page = 0; page < maxPages; page += 1) {
      const start = page * pageSize;
      const end = start + pageSize - 1;
      box.textContent = 'API Interencheres ' + start + '-' + end;
      const url = 'https://search.interencheres.com/v1/search/ie4_items?filters%5Bsale%5D=' + encodeURIComponent(context.saleId);
      const response = await fetch(url, {
        credentials: 'include',
        headers: {
          accept: 'application/json, text/plain, */*',
          'x-range': 'items=' + start + '-' + end,
          'x-requested-with': 'XMLHttpRequest',
        },
      });
      const raw = await response.text();
      if (!response.ok) throw new Error('API Interencheres HTTP ' + response.status + ': ' + raw.slice(0, 160));
      const payload = JSON.parse(raw);
      if (!Array.isArray(payload)) throw new Error('Reponse API Interencheres invalide.');
      lots.push(...payload.map(parseApiItem).filter(Boolean));
      if (payload.length < pageSize) break;
      await sleep(250);
    }
    return lots;
  }
  function scrapePage() {
    return [...document.querySelectorAll('a[href*="/lot-"][id],a[href*="/lot-"]')]
      .map(parseLot)
      .filter(Boolean);
  }
  function totalPages() {
    return Math.max(1, ...[...document.querySelectorAll('.v-pagination__item,button.v-pagination__item')]
      .map((item) => Number.parseInt(text(item), 10))
      .filter(Boolean));
  }
  function nextButton() {
    const explicitNext = [...document.querySelectorAll('button[aria-label*="suiv" i],button[aria-label*="next" i]')]
      .find((button) => !button.disabled && !button.classList.contains('v-pagination__navigation--disabled'));
    if (explicitNext) return explicitNext;
    const navs = [...document.querySelectorAll('.v-pagination__navigation, .v-pagination li button')];
    for (let index = navs.length - 1; index >= 0; index -= 1) {
      const button = navs[index];
      if (!button.disabled && !button.classList.contains('v-pagination__navigation--disabled')) return button;
    }
    return null;
  }
  async function waitForChange(previousKey) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 8000) {
      const first = document.querySelector('a[href*="/lot-"][id],a[href*="/lot-"]');
      const key = first ? first.id || first.href : '';
      if (key && key !== previousKey) return true;
      await sleep(300);
    }
    return false;
  }
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:14px 22px;border-radius:8px;background:#1d4ed8;color:white;font:600 14px sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35)';
  document.body.appendChild(box);
  try {
    let lots = [];
    let source = 'api';
    try {
      lots = await fetchApiLots();
    } catch (apiError) {
      source = 'dom';
      box.textContent = 'API KO, fallback DOM...';
      await sleep(900);
      const pages = totalPages();
      for (let page = 1; page <= pages; page += 1) {
        box.textContent = 'Import IE page ' + page + '/' + pages;
        lots = lots.concat(scrapePage());
        if (page >= pages) break;
        const first = document.querySelector('a[href*="/lot-"][id],a[href*="/lot-"]');
        const previousKey = first ? first.id || first.href : '';
        const button = nextButton();
        if (!button) break;
        button.click();
        await waitForChange(previousKey);
        await sleep(600);
      }
    }
    const unique = Object.values(Object.fromEntries(
      lots.map((lot) => [lot.lot_number + '-' + lot.lot_interencheres_id, lot]),
    ));
    if (!unique.length) throw new Error('Aucun lot trouve sur cette page Interencheres.');
    box.textContent = 'Envoi ' + unique.length + ' lots...';
    const headers = { 'content-type': 'application/json' };
    if (token) headers['x-import-token'] = token;
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source: 'bookmarklet-android-' + source,
        pageUrl: location.href,
        saleId: context.saleId,
        salle: context.salle,
        date_vente: dateVente,
        lots: unique,
      }),
    });
    const resultText = await response.text();
    box.style.background = response.ok ? '#059669' : '#dc2626';
    box.textContent = response.ok ? 'Import OK: ' + unique.length + ' lots' : 'Erreur import ' + response.status;
    alert(resultText.slice(0, 1200));
  } catch (error) {
    box.style.background = '#dc2626';
    box.textContent = 'Erreur: ' + error.message;
    alert(error.message);
  }
  setTimeout(() => box.remove(), 10000);
})();`;
}

function parsePositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|oui|on)$/i.test(String(value));
}

function isAllowedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'www.alcopa-auction.fr';
  } catch {
    return false;
  }
}

function normalizeTargetUrl(value) {
  const cleaned = String(value || '').trim().replace(/\\&/g, '&');
  const alcopaUrl = cleaned.match(/https:\/\/www\.alcopa-auction\.fr\/[^\s\])"'<>]+/i);
  return alcopaUrl ? alcopaUrl[0] : cleaned;
}

async function handleScrape(req, res, url) {
  const targetUrl = normalizeTargetUrl(url.searchParams.get('url') || DEFAULT_URL);
  if (!isAllowedUrl(targetUrl)) {
    send(res, 400, {
      ok: false,
      error: 'URL invalide. Utilise une URL brute https://www.alcopa-auction.fr/... sans crochets Markdown.',
    });
    return;
  }

  const maxPages = Math.min(
    parsePositiveInt(url.searchParams.get('maxPages') || url.searchParams.get('max-pages'), DEFAULT_MAX_PAGES),
    MAX_ALLOWED_PAGES,
  );
  const delayMs = parsePositiveInt(url.searchParams.get('delayMs') || url.searchParams.get('delay-ms'), DEFAULT_DELAY_MS);
  const format = (url.searchParams.get('format') || 'json').toLowerCase();
  const ocr = parseBoolean(url.searchParams.get('ocr'));
  const details = ocr || parseBoolean(url.searchParams.get('details'));
  const detailLimit = Math.min(
    parsePositiveInt(url.searchParams.get('detailLimit') || url.searchParams.get('detail-limit'), DEFAULT_DETAIL_LIMIT),
    MAX_DETAIL_LIMIT,
  );
  const ocrLimit = Math.min(
    parsePositiveInt(url.searchParams.get('ocrLimit') || url.searchParams.get('ocr-limit'), DEFAULT_OCR_LIMIT),
    MAX_OCR_LIMIT,
  );
  const detailDelayMs = parsePositiveInt(
    url.searchParams.get('detailDelayMs') || url.searchParams.get('detail-delay-ms'),
    DEFAULT_DETAIL_DELAY_MS,
  );

  const startedAt = Date.now();
  const result = await scrape({
    url: targetUrl,
    maxPages,
    delayMs,
    out: '',
    csv: '',
    html: '',
    verbose: false,
    details,
    ocr,
    detailLimit,
    ocrLimit,
    detailDelayMs,
  });

  if (format === 'csv') {
    send(res, 200, toCsv(result.lots), {
      'content-disposition': 'attachment; filename="alcopa-lots.csv"',
      'content-type': 'text/csv; charset=utf-8',
    });
    return;
  }

  send(res, result.blocked ? 502 : 200, {
    ok: !result.blocked,
    transport: getTransportName(),
    url: targetUrl,
    lots: result.lots.length,
    pages: result.pagesSeen,
    expectedPages: result.expectedPages,
    durationMs: Date.now() - startedAt,
    error: result.blocked ? `Alcopa a refuse la requete (HTTP ${result.blockReason?.status ?? '?'}) depuis cet hebergeur` : null,
    blockReason: result.blockReason,
    enrichment: result.enrichment,
    data: result.lots,
  });
}

async function handleVehicle(res, url) {
  const targetUrl = normalizeTargetUrl(url.searchParams.get('url') || '');
  if (!isAllowedUrl(targetUrl) || !/\/(?:voiture|utilitaire)-occasion\//i.test(new URL(targetUrl).pathname)) {
    send(res, 400, { ok: false, error: 'URL de fiche vehicule Alcopa invalide.' });
    return;
  }

  const ocr = parseBoolean(url.searchParams.get('ocr'));
  const startedAt = Date.now();
  const result = await enrichVehicles([{ id: 'vehicle', url_alcopa: targetUrl }], {
    detailLimit: 1,
    ocr,
    ocrLimit: 1,
    detailDelayMs: 0,
    referer: `${BASE_URL}/`,
  });
  const vehicle = result.lots[0];
  const ok = !result.stats.blocked && !vehicle.detail_error && !vehicle.ct_error;
  const status = result.stats.blocked ? 502 : ok ? 200 : 500;
  send(res, status, {
    ok,
    transport: getTransportName(),
    durationMs: Date.now() - startedAt,
    enrichment: result.stats,
    data: vehicle,
  });
}

async function egressIp() {
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    return body.ip || null;
  } catch {
    return null;
  }
}

async function handleDebug(res, url) {
  const targetUrl = normalizeTargetUrl(url.searchParams.get('url') || DEFAULT_URL);
  if (!isAllowedUrl(targetUrl)) {
    send(res, 400, { ok: false, error: 'URL invalide.' });
    return;
  }

  const [ip, home, target] = await Promise.all([
    egressIp(),
    fetchHtml(`${BASE_URL}/`).catch((error) => ({ status: 0, networkError: error.message, headers: {}, html: '' })),
    fetchHtml(targetUrl).catch((error) => ({ status: 0, networkError: error.message, headers: {}, html: '' })),
  ]);

  send(res, 200, {
    ok: true,
    version: APP_VERSION,
    transport: getTransportName(),
    egressIp: ip,
    nodeVersion: process.version,
    homepage: describeBlock(`${BASE_URL}/`, home),
    target: describeBlock(targetUrl, target),
  });
}

async function handleProbe(res, url) {
  const targetUrl = normalizeTargetUrl(url.searchParams.get('url') || DEFAULT_URL);
  if (!isAllowedUrl(targetUrl)) {
    send(res, 400, { ok: false, error: 'URL invalide.' });
    return;
  }
  const startedAt = Date.now();
  const response = await fetchHtml(targetUrl).catch((error) => ({
    status: 0,
    finalUrl: targetUrl,
    headers: {},
    html: '',
    networkError: error.message,
  }));
  const ok = !response.challenge && response.status >= 200 && response.status < 300;
  send(res, ok ? 200 : 502, {
    ok,
    transport: getTransportName(),
    durationMs: Date.now() - startedAt,
    probe: describeBlock(targetUrl, response),
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'OPTIONS') {
      send(res, 204, '');
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      send(res, 200, {
        ok: true,
        service: 'alcopa-scraper',
        version: APP_VERSION,
        transport: getTransportName(),
        railwayRegion: process.env.RAILWAY_REPLICA_REGION || null,
        supabase: supabaseEnvStatus(),
        endpoints: {
          scrape: '/scrape?url=https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371&maxPages=30',
          enriched: '/scrape?url=https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371&maxPages=1&details=1&detailLimit=3&ocr=1&ocrLimit=1',
          vehicle: '/vehicle?url=https://www.alcopa-auction.fr/voiture-occasion/...&ocr=1',
          interencheresImport: 'POST /interencheres/import',
          interencheresBookmarklet: '/interencheres/bookmarklet.js',
          csv: '/scrape?format=csv&url=https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371&maxPages=30',
          probe: '/probe?url=https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371',
          debug: '/debug?url=https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371',
        },
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/scrape') {
      await handleScrape(req, res, url);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/vehicle') {
      await handleVehicle(res, url);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/debug') {
      await handleDebug(res, url);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/interencheres/bookmarklet.js') {
      send(res, 200, interencheresBookmarkletScript(), {
        'content-type': 'application/javascript; charset=utf-8',
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/probe') {
      await handleProbe(res, url);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/interencheres/import') {
      await handleInterencheresImport(req, res);
      return;
    }

    send(res, 404, { ok: false, error: 'Route inconnue' });
  } catch (error) {
    send(res, 500, {
      ok: false,
      error: error.message,
      status: error.status || null,
      url: error.url || null,
      finalUrl: error.finalUrl || null,
      upstream: error.headers ? {
        server: error.headers.server || null,
        via: error.headers.via || null,
        cfRay: error.headers['cf-ray'] || null,
        contentType: error.headers['content-type'] || null,
        allow: error.headers.allow || null,
      } : null,
      bodyPreview: error.bodyPreview || null,
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Alcopa scraper API listening on ${HOST}:${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing HTTP server');
  server.close(async () => {
    await closeBrowser();
    process.exit(0);
  });
});
