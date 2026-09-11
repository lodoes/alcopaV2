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
    send(res, 500, { ok: false, error: 'Configure SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.' });
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
        endpoints: {
          scrape: '/scrape?url=https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371&maxPages=30',
          enriched: '/scrape?url=https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371&maxPages=1&details=1&detailLimit=3&ocr=1&ocrLimit=1',
          vehicle: '/vehicle?url=https://www.alcopa-auction.fr/voiture-occasion/...&ocr=1',
          interencheresImport: 'POST /interencheres/import',
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
