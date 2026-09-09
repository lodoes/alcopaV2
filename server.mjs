import http from 'node:http';
import { BASE_URL, DEFAULT_URL, describeBlock, fetchHtml, scrape, toCsv } from './scrape-alcopa.mjs';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const APP_VERSION = '2026-09-09-session-warmup-retry-v3';
const DEFAULT_MAX_PAGES = Number(process.env.DEFAULT_MAX_PAGES || 30);
const MAX_ALLOWED_PAGES = Number(process.env.MAX_ALLOWED_PAGES || 40);
const DEFAULT_DELAY_MS = Number(process.env.DEFAULT_DELAY_MS || 350);

function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  const payload = isBuffer || typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    'content-type': isBuffer ? 'application/octet-stream' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(payload);
}

function parsePositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
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

  const startedAt = Date.now();
  const result = await scrape({
    url: targetUrl,
    maxPages,
    delayMs,
    out: '',
    csv: '',
    html: '',
    verbose: false,
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
    url: targetUrl,
    lots: result.lots.length,
    pages: result.pagesSeen,
    expectedPages: result.expectedPages,
    durationMs: Date.now() - startedAt,
    error: result.blocked ? `Alcopa a refuse la requete (HTTP ${result.blockReason?.status ?? '?'}) depuis cet hebergeur` : null,
    blockReason: result.blockReason,
    data: result.lots,
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
    egressIp: ip,
    nodeVersion: process.version,
    homepage: describeBlock(`${BASE_URL}/`, home),
    target: describeBlock(targetUrl, target),
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
        endpoints: {
          scrape: '/scrape?url=https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371&maxPages=30',
          csv: '/scrape?format=csv&url=https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371&maxPages=30',
          debug: '/debug?url=https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371',
        },
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/scrape') {
      await handleScrape(req, res, url);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/debug') {
      await handleDebug(res, url);
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
  server.close(() => process.exit(0));
});
