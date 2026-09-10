#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

import { enrichLots as enrichLotRecords } from './vehicle-details.mjs';

const DEFAULT_URL = 'https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371';
const BASE_URL = 'https://www.alcopa-auction.fr';
const CSV_HEADERS = [
  'lot_number',
  'salle',
  'date_vente',
  'marque',
  'modele',
  'description',
  'energie',
  'annee_mec',
  'km',
  'boite',
  'lieu_stockage',
  'mise_a_prix',
  'enchere_courante',
  'estimation_eur',
  'prix_adjudication_eur',
  'statut',
  'canal',
  'garantie',
  'certificat_batterie',
  'url_alcopa',
  'url_interencheres',
  'thumbnail',
  'alcopa_id',
  'lot_interencheres_id',
  'sale_id',
  'source',
  'finition',
  'immatriculation',
  'date_mise_circulation',
  'numero_serie',
  'couleur',
  'tva_recuperable',
  'type_vehicule',
  'carrosserie',
  'co2_g_km',
  'cylindree_cm3',
  'url_ct',
  'commentaires_brut',
  'informations_brut',
  'notes_annonce',
  'defauts_esthetiques',
  'annonce_fetched_at',
  'detail_error',
  'ct_verdict',
  'ct_defauts_maj',
  'ct_defauts_min',
  'ct_critiques',
  'ct_nb_codes',
  'ct_defauts_maj_groupes',
  'ct_defauts_min_groupes',
  'ct_texte_brut',
  'ct_ocr_done_at',
  'ct_source',
  'ct_error',
];

function parseArgs(argv) {
  const args = {
    url: DEFAULT_URL,
    out: 'alcopa-lyon-12371.json',
    csv: '',
    maxPages: 30,
    delayMs: 350,
    html: '',
    verbose: false,
    details: false,
    ocr: false,
    detailLimit: 0,
    ocrLimit: 0,
    detailDelayMs: 500,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url') args.url = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--csv') args.csv = argv[++i];
    else if (arg === '--max-pages') args.maxPages = Number(argv[++i]);
    else if (arg === '--delay-ms') args.delayMs = Number(argv[++i]);
    else if (arg === '--html') args.html = argv[++i];
    else if (arg === '--verbose') args.verbose = true;
    else if (arg === '--details') args.details = true;
    else if (arg === '--ocr') {
      args.details = true;
      args.ocr = true;
    }
    else if (arg === '--detail-limit') args.detailLimit = Number(argv[++i]);
    else if (arg === '--ocr-limit') args.ocrLimit = Number(argv[++i]);
    else if (arg === '--detail-delay-ms') args.detailDelayMs = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      args.url = arg;
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scrape-alcopa.mjs [url] [--out lots.json] [--csv lots.csv]
  node scrape-alcopa.mjs --html alcopa-sample.html --out sample.json --csv sample.csv

Options:
  --url URL          Vente Alcopa a scraper
  --out FILE        Fichier JSON de sortie
  --csv FILE        Fichier CSV de sortie
  --max-pages N     Limite de pagination, defaut 30
  --delay-ms N      Pause entre pages, defaut 350 ms
  --html FILE       Parse un HTML local sans requete reseau
  --details         Visite chaque fiche vehicule et extrait les informations + URL CT
  --ocr             Telecharge et analyse les CT (implique --details)
  --detail-limit N  Limite de fiches a enrichir, 0 = toutes
  --ocr-limit N     Limite de CT a analyser, 0 = tous les CT trouves
  --detail-delay-ms N  Pause entre fiches, defaut 500 ms
  --verbose         Affiche plus de details`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function absolutize(pathOrUrl) {
  if (!pathOrUrl) return '';
  try {
    return new URL(pathOrUrl, BASE_URL).href;
  } catch {
    return pathOrUrl;
  }
}

function pageUrl(sourceUrl, page) {
  const url = new URL(sourceUrl);
  url.searchParams.set('page', String(page));
  return url.href;
}

const USER_AGENT = process.env.SCRAPER_USER_AGENT
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const MAX_ATTEMPTS = Math.max(1, Number(process.env.SCRAPER_MAX_ATTEMPTS || 4));
const SCRAPER_TRANSPORT = (process.env.SCRAPER_TRANSPORT || 'direct').toLowerCase();
const BROWSER_TIMEOUT_MS = Math.max(5_000, Number(process.env.BROWSER_TIMEOUT_MS || 45_000));
const BROWSER_SETTLE_MS = Math.max(0, Number(process.env.BROWSER_SETTLE_MS || 750));
const MAX_BINARY_BYTES = Math.max(1_000_000, Number(process.env.MAX_BINARY_BYTES || 30_000_000));
const RETRY_STATUSES = new Set([403, 405, 408, 425, 429, 500, 502, 503, 504]);

const session = { cookies: new Map(), warm: false };
let browserPromise = null;
let browserContextPromise = null;

function storeCookies(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const cookie of raw) {
    const [pair] = cookie.split(';');
    const index = pair.indexOf('=');
    if (index > 0) session.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

function cookieHeader() {
  return [...session.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function browserHeaders({ referer = '' } = {}) {
  const headers = {
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    'sec-ch-ua': '"Chromium";v="140", "Not(A:Brand";v="24", "Google Chrome";v="140"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': referer ? 'same-origin' : 'none',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    'user-agent': USER_AGENT,
  };
  const cookie = cookieHeader();
  if (cookie) headers.cookie = cookie;
  if (referer) headers.referer = referer;
  return headers;
}

const CHALLENGE_PATTERNS = [
  /awsWafCookieDomainList|gokuProps|token.awswaf.com|human verification/i,
  /cf-chl-|attention required|just a moment/i,
  /datadome|are you a human|px-captcha/i,
];

function isChallenge(html) {
  return CHALLENGE_PATTERNS.some((pattern) => pattern.test(html));
}

async function rawFetch(url, referer) {
  const res = await fetch(url, { headers: browserHeaders({ referer }), redirect: 'follow' });
  const html = await res.text();
  storeCookies(res);
  return {
    status: res.status,
    finalUrl: res.url,
    headers: Object.fromEntries(res.headers.entries()),
    html,
    challenge: isChallenge(html),
  };
}

async function rawFetchBinary(url, referer) {
  const res = await fetch(url, {
    headers: {
      ...browserHeaders({ referer }),
      accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
    },
    redirect: 'follow',
  });
  storeCookies(res);
  const declaredLength = Number(res.headers.get('content-length') || 0);
  if (declaredLength > MAX_BINARY_BYTES) {
    throw new Error(`Document trop volumineux (${declaredLength} octets)`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_BINARY_BYTES) {
    throw new Error(`Document trop volumineux (${buffer.length} octets)`);
  }
  const contentType = res.headers.get('content-type') || '';
  const preview = /html|text/i.test(contentType) ? buffer.subarray(0, 100_000).toString('utf8') : '';
  return {
    status: res.status,
    finalUrl: res.url,
    headers: Object.fromEntries(res.headers.entries()),
    buffer,
    challenge: isChallenge(preview),
  };
}

function apiHeaders({ referer = '', headers = {} } = {}) {
  const values = {
    accept: 'application/json',
    'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    'user-agent': USER_AGENT,
    ...headers,
  };
  if (referer) values.referer = referer;
  return values;
}

async function rawFetchJson(url, referer, headers) {
  const res = await fetch(url, {
    headers: apiHeaders({ referer, headers }),
    redirect: 'follow',
  });
  const text = await res.text();
  return {
    status: res.status,
    finalUrl: res.url,
    headers: Object.fromEntries(res.headers.entries()),
    text,
    challenge: isChallenge(text),
    transport: 'direct',
  };
}

async function launchChromium() {
  const { chromium } = await import('playwright-core');
  const common = {
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  };
  const configuredPath = process.env.CHROMIUM_EXECUTABLE_PATH?.trim();
  const candidates = configuredPath
    ? [{ executablePath: configuredPath }]
    : process.platform === 'win32'
      ? [{ channel: 'chrome' }, { channel: 'msedge' }]
      : [{ executablePath: '/usr/bin/chromium' }, { executablePath: '/usr/bin/chromium-browser' }];

  let lastError = null;
  for (const candidate of candidates) {
    try {
      return await chromium.launch({ ...common, ...candidate });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Chromium introuvable: ${lastError?.message || 'aucun executable compatible'}`);
}

async function getBrowserContext() {
  if (!browserPromise) {
    browserPromise = launchChromium().catch((error) => {
      browserPromise = null;
      throw error;
    });
  }
  if (!browserContextPromise) {
    browserContextPromise = browserPromise.then((browser) => browser.newContext({
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris',
      viewport: { width: 1440, height: 1000 },
    })).catch((error) => {
      browserContextPromise = null;
      throw error;
    });
  }
  return browserContextPromise;
}

async function browserFetch(url, referer) {
  const context = await getBrowserContext();
  const page = await context.newPage();
  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: BROWSER_TIMEOUT_MS,
      referer: referer && referer.startsWith(BASE_URL) ? referer : undefined,
    });
    if (BROWSER_SETTLE_MS) await page.waitForTimeout(BROWSER_SETTLE_MS);
    const html = await page.content();
    return {
      status: response?.status() || 0,
      finalUrl: page.url(),
      headers: response ? await response.allHeaders() : {},
      html,
      challenge: isChallenge(html),
      transport: 'browser',
    };
  } finally {
    await page.close();
  }
}

async function browserFetchBinary(url, referer) {
  const context = await getBrowserContext();
  const response = await context.request.get(url, {
    failOnStatusCode: false,
    headers: {
      accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8',
      ...(referer ? { referer } : {}),
    },
    timeout: BROWSER_TIMEOUT_MS,
  });
  const headers = response.headers();
  const declaredLength = Number(headers['content-length'] || 0);
  if (declaredLength > MAX_BINARY_BYTES) {
    throw new Error(`Document trop volumineux (${declaredLength} octets)`);
  }
  const buffer = await response.body();
  if (buffer.length > MAX_BINARY_BYTES) {
    throw new Error(`Document trop volumineux (${buffer.length} octets)`);
  }
  const preview = /html|text/i.test(headers['content-type'] || '')
    ? buffer.subarray(0, 100_000).toString('utf8')
    : '';
  return {
    status: response.status(),
    finalUrl: response.url(),
    headers,
    buffer,
    challenge: isChallenge(preview),
    transport: 'browser',
  };
}

async function browserFetchJson(url, referer, headers) {
  const context = await getBrowserContext();
  const response = await context.request.get(url, {
    failOnStatusCode: false,
    headers: apiHeaders({ referer, headers }),
    timeout: BROWSER_TIMEOUT_MS,
  });
  const text = await response.text();
  return {
    status: response.status(),
    finalUrl: response.url(),
    headers: response.headers(),
    text,
    challenge: isChallenge(text),
    transport: 'browser',
  };
}

function transportFetch(url, referer) {
  if (SCRAPER_TRANSPORT === 'browser') return browserFetch(url, referer);
  if (SCRAPER_TRANSPORT !== 'direct') {
    throw new Error(`SCRAPER_TRANSPORT invalide: ${SCRAPER_TRANSPORT}`);
  }
  return rawFetch(url, referer);
}

function transportFetchBinary(url, referer) {
  if (SCRAPER_TRANSPORT === 'browser') return browserFetchBinary(url, referer);
  if (SCRAPER_TRANSPORT !== 'direct') {
    throw new Error(`SCRAPER_TRANSPORT invalide: ${SCRAPER_TRANSPORT}`);
  }
  return rawFetchBinary(url, referer);
}

function transportFetchJson(url, referer, headers) {
  if (SCRAPER_TRANSPORT === 'browser') return browserFetchJson(url, referer, headers);
  if (SCRAPER_TRANSPORT !== 'direct') {
    throw new Error(`SCRAPER_TRANSPORT invalide: ${SCRAPER_TRANSPORT}`);
  }
  return rawFetchJson(url, referer, headers);
}

async function clearTransportSession() {
  session.cookies.clear();
  if (browserContextPromise) {
    const context = await browserContextPromise.catch(() => null);
    if (context) await context.clearCookies();
  }
}

async function warmUpSession(force = false) {
  if (session.warm && !force) return true;
  if (force) await clearTransportSession();
  try {
    const res = await transportFetch(`${BASE_URL}/`, '');
    session.warm = res.status >= 200 && res.status < 400;
    return session.warm;
  } catch {
    session.warm = false;
    return false;
  }
}

async function fetchHtml(url, { referer = '' } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await warmUpSession(attempt > 1);
    try {
      last = await transportFetch(url, referer || `${BASE_URL}/`);
    } catch (error) {
      last = { status: 0, finalUrl: url, headers: {}, html: '', challenge: false, networkError: error.message };
    }
    if (last.challenge) {
      console.error(`[stop] ${url}: challenge anti-bot detecte, aucune nouvelle tentative`);
      return { ...last, attempts: attempt };
    }
    const retryable = last.status === 0 || RETRY_STATUSES.has(last.status);
    if (!retryable) return { ...last, attempts: attempt };
    if (attempt < MAX_ATTEMPTS) {
      console.error(`[retry ${attempt}/${MAX_ATTEMPTS}] ${url} -> statut ${last.status}${last.challenge ? ' (challenge)' : ''}`);
      await sleep(500 * (2 ** (attempt - 1)));
    }
  }
  return { ...last, attempts: MAX_ATTEMPTS };
}

async function fetchBinary(url, { referer = '' } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await warmUpSession(attempt > 1);
    try {
      last = await transportFetchBinary(url, referer || `${BASE_URL}/`);
    } catch (error) {
      last = {
        status: 0,
        finalUrl: url,
        headers: {},
        buffer: Buffer.alloc(0),
        challenge: false,
        networkError: error.message,
      };
    }
    if (last.challenge) return { ...last, attempts: attempt };
    const retryable = last.status === 0 || RETRY_STATUSES.has(last.status);
    if (!retryable) return { ...last, attempts: attempt };
    if (attempt < MAX_ATTEMPTS) await sleep(500 * (2 ** (attempt - 1)));
  }
  return { ...last, attempts: MAX_ATTEMPTS };
}

async function fetchJson(url, { referer = '', headers = {} } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      last = await transportFetchJson(url, referer, headers);
    } catch (error) {
      last = {
        status: 0,
        finalUrl: url,
        headers: {},
        text: '',
        challenge: false,
        networkError: error.message,
      };
    }
    if (last.challenge) return { ...last, attempts: attempt };
    const retryable = last.status === 0 || RETRY_STATUSES.has(last.status);
    if (!retryable) return { ...last, attempts: attempt };
    if (attempt < MAX_ATTEMPTS) await sleep(500 * (2 ** (attempt - 1)));
  }
  return { ...last, attempts: MAX_ATTEMPTS };
}

function describeBlock(url, response) {
  return {
    url,
    finalUrl: response.finalUrl || url,
    status: response.status,
    challenge: Boolean(response.challenge),
    networkError: response.networkError || null,
    attempts: response.attempts || 1,
    transport: response.transport || SCRAPER_TRANSPORT,
    upstream: {
      server: response.headers?.server || null,
      via: response.headers?.via || null,
      allow: response.headers?.allow || null,
      contentType: response.headers?.['content-type'] || null,
      amzCfPop: response.headers?.['x-amz-cf-pop'] || null,
      amzCfId: response.headers?.['x-amz-cf-id'] || null,
    },
    bodyPreview: stripTags(response.html || '').slice(0, 500),
  };
}

function getTransportName() {
  return SCRAPER_TRANSPORT;
}

async function closeBrowser() {
  const context = browserContextPromise ? await browserContextPromise.catch(() => null) : null;
  browserContextPromise = null;
  if (context) await context.close().catch(() => {});
  const browser = browserPromise ? await browserPromise.catch(() => null) : null;
  browserPromise = null;
  if (browser) await browser.close().catch(() => {});
  session.warm = false;
}

function decodeHtml(value = '') {
  const named = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    euro: 'EUR',
    eacute: 'e',
    Eacute: 'E',
    egrave: 'e',
    Egrave: 'E',
    ecirc: 'e',
    Ecirc: 'E',
    agrave: 'a',
    ccedil: 'c',
    ugrave: 'u',
    deg: 'deg',
  };

  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-zA-Z]+);/g, (match, name) => named[name] ?? match)
    .replace(/\u00a0/g, ' ');
}

function stripTags(html = '') {
  return decodeHtml(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' '))
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\s+\n/g, '\n')
    .trim();
}

function numberFromText(text = '') {
  const match = decodeHtml(text).match(/(\d[\d\s.,]*)/);
  if (!match) return null;
  const normalized = match[1].replace(/[^\d]/g, '');
  return normalized ? Number(normalized) : null;
}

function textMatch(html, regex) {
  const match = html.match(regex);
  return match ? stripTags(match[1]) : '';
}

function attrMatch(html, regex) {
  const match = html.match(regex);
  return match ? decodeHtml(match[1]).trim() : '';
}

function extractThumbnail(card) {
  const imageTags = card.match(/<img\b[^>]*>/gi) || [];
  for (const imageTag of imageTags) {
    for (const attribute of ['data-src', 'data-original', 'data-lazy-src', 'src']) {
      const value = attrMatch(imageTag, new RegExp(`\\b${attribute}=["']([^"']+)["']`, 'i'));
      if (value && !/^data:/i.test(value)) return absolutize(value);
    }

    const srcset = attrMatch(imageTag, /\b(?:data-srcset|srcset)=["']([^"']+)["']/i);
    const firstSource = srcset.split(',')[0]?.trim().split(/\s+/)[0] || '';
    if (firstSource && !/^data:/i.test(firstSource)) return absolutize(firstSource);
  }
  return '';
}

function detectSalle(url, html) {
  const fromUrl = url.match(/salle-de-vente-encheres\/([^/?#]+)\/(\d+)/i);
  if (fromUrl) return fromUrl[1].replace(/-/g, ' ').toLowerCase();
  const location = textMatch(html, /title="Lieu de stockage"[\s\S]*?<strong[^>]*>([\s\S]*?)<\/strong>/i);
  return location.replace(/^.*?\s/, '').toLowerCase();
}

function detectSaleId(url) {
  const match = url.match(/\/(\d+)(?:[/?#]|$)/);
  return match ? match[1] : '';
}

function extractResultFrame(html) {
  const match = html.match(/<turbo-frame[^>]+id="search-results"[^>]*>([\s\S]*?)<\/turbo-frame>/i);
  return match ? match[1] : html;
}

function extractCards(html) {
  const frame = extractResultFrame(html);
  return frame
    .split(/(?=<div class="col-12 col-lg-6 align-items-stretch mb-3 fs-14">)/g)
    .filter((part) => /Lot n/i.test(part) && /card-title/i.test(part));
}

function parseSpec(specHtml) {
  const lines = stripTags(specHtml).split('\n').map((line) => line.trim()).filter(Boolean);
  const rawEnergy = lines[0] || '';
  const energyMap = {
    GO: 'Diesel',
    ES: 'Essence',
    EL: 'Electrique',
    HY: 'Hybride',
    EH: 'Hybride',
    EE: 'Hybride',
    GP: 'GPL',
    GN: 'GNV',
    OT: 'Autres',
  };
  const energyCode = (rawEnergy.match(/\b[A-Z]{2}\b/) || [rawEnergy])[0].toUpperCase();
  const annee = (lines.join(' ').match(/(?:1ere|1ère|mise)\s*:\s*(\d{4})/i) || [])[1] || '';
  const km = numberFromText(lines.find((line) => /\bkm\b/i.test(line)) || '');
  const boiteLine = lines.find((line) => /bo[iî]te|bva|bvm|auto|manuelle/i.test(line)) || '';
  let boite = '';
  if (/automatique|auto|bva|dsg|eat|edc/i.test(boiteLine)) boite = 'Automatique';
  else if (/manuelle|bvm/i.test(boiteLine)) boite = 'Manuelle';
  else if (/sequentielle|séquentielle/i.test(boiteLine)) boite = 'Sequentielle';

  return {
    energie: energyMap[energyCode] || rawEnergy,
    annee_mec: annee,
    km,
    boite,
  };
}

function parseCard(card, context) {
  const titleHtml = textMatch(card, /<div class="card-title"[\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/i);
  const title = titleHtml.replace(/\s+/g, ' ').trim();
  const [marque = '', modelFamily = ''] = title.split('|').map((part) => part.trim());
  const fichePath = attrMatch(card, /<div class="card-title"[\s\S]*?<a\s+href="([^"]+)"/i);
  const urlAlcopa = absolutize(fichePath);
  const alcopaId = (urlAlcopa.match(/-(\d+)(?:[/?#]|$)/) || [])[1] || '';
  const thumbnail = extractThumbnail(card);
  const modele = textMatch(card, /<p class="mb-2">\s*([\s\S]*?)<\/p>/i);
  const specHtml = (card.match(/<p class="mb-1">([\s\S]*?)<\/p>/i) || [])[1] || '';
  const spec = parseSpec(specHtml);
  const lotNumber = numberFromText(textMatch(card, /Lot n[^<]*<strong>([\s\S]*?)<\/strong>/i));
  const dateVente = textMatch(card, /title="Date vente"[\s\S]*?<strong[^>]*>([\s\S]*?)<\/strong>/i).replace(/^.*?\s/, '').trim();
  const lieu = textMatch(card, /title="Lieu de stockage"[\s\S]*?<strong[^>]*>([\s\S]*?)<\/strong>/i).replace(/^.*?\s/, '').trim();
  const priceBlock = (card.match(/Mise\s*(?:à|a)\s*prix\s*:[\s\S]*?<strong[^>]*>([\s\S]*?)<\/strong>/i) || [])[1] || '';
  const miseAPrix = numberFromText(priceBlock);
  const garantie = /Garantie/i.test(stripTags(card));
  const certificatBatterie = /certificat batterie|batterie/i.test(stripTags(card));
  const description = [marque, modelFamily || modele].filter(Boolean).join(' | ');
  const idBase = `${context.salle || 'x'}-${context.saleId || 'sale'}-lot-${lotNumber || alcopaId || 'x'}`;

  return {
    id: idBase.replace(/\s+/g, '-').toLowerCase(),
    merge_key: idBase.replace(/\s+/g, '-').toLowerCase(),
    lot_number: lotNumber,
    salle: context.salle,
    date_vente: dateVente,
    marque,
    modele: modele || modelFamily,
    description,
    energie: spec.energie,
    annee_mec: spec.annee_mec,
    km: spec.km,
    boite: spec.boite,
    lieu_stockage: lieu,
    mise_a_prix: miseAPrix,
    enchere_courante: null,
    estimation_eur: miseAPrix,
    prix_adjudication_eur: null,
    statut: 'en_cours',
    canal: 'alcopa',
    garantie,
    certificat_batterie: certificatBatterie,
    url_alcopa: urlAlcopa,
    url_interencheres: '',
    thumbnail,
    alcopa_id: alcopaId,
    lot_interencheres_id: '',
    sale_id: context.saleId,
    source: 'alcopa',
  };
}

function detectMaxPage(html) {
  const pages = [...html.matchAll(/name="page"[\s\S]{0,80}?value="(\d+)"/gi)].map((match) => Number(match[1]));
  return pages.length ? Math.max(...pages) : 1;
}

function detectTotalLots(html) {
  return numberFromText(textMatch(html, /Nombre de lots\s*:\s*<b[^>]*>([\s\S]*?)<\/b>/i));
}

function parseHtml(html, sourceUrl) {
  const context = {
    saleId: detectSaleId(sourceUrl),
    salle: detectSalle(sourceUrl, html),
  };
  const cards = extractCards(html);
  const lots = cards.map((card) => parseCard(card, context)).filter((lot) => lot.lot_number);
  const totalLots = detectTotalLots(html);
  const estimatedPages = totalLots && lots.length ? Math.ceil(totalLots / lots.length) : 1;
  return {
    context,
    visibleMaxPage: detectMaxPage(html),
    estimatedPages,
    maxPage: Math.max(detectMaxPage(html), estimatedPages),
    totalLots,
    lots,
  };
}

function dedupeLots(lots) {
  const byKey = new Map();
  for (const lot of lots) {
    const key = lot.merge_key || lot.id;
    byKey.set(key, { ...(byKey.get(key) || {}), ...lot });
  }
  return [...byKey.values()].sort((a, b) => (a.lot_number || 0) - (b.lot_number || 0));
}

function toCsv(lots) {
  const escape = (value) => {
    const stringValue = value == null
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
    const escaped = stringValue.replace(/"/g, '""');
    return /[",\n\r]/.test(escaped) ? `"${escaped}"` : escaped;
  };
  const rows = lots.map((lot) => CSV_HEADERS.map((header) => escape(lot[header])).join(','));
  return `\uFEFF${CSV_HEADERS.join(',')}\n${rows.join('\n')}\n`;
}

async function enrichVehicles(lots, options = {}) {
  return enrichLotRecords(lots, {
    fetchHtml,
    fetchBinary,
    delayMs: options.detailDelayMs ?? options.delayMs ?? 500,
    ...options,
  });
}

async function scrape(args) {
  if (args.html) {
    const fs = await import('node:fs/promises');
    const html = await fs.readFile(args.html, 'utf8');
    const parsed = parseHtml(html, args.url);
    return { lots: parsed.lots, pagesSeen: 1, expectedPages: parsed.maxPage, blocked: false, blockReason: null };
  }

  const allLots = [];
  const seenKeys = new Set();
  let expectedPages = 1;
  let expectedLots = null;
  let pagesFetched = 0;
  let blocked = false;
  let blockReason = null;
  let previousUrl = '';

  for (let page = 1; page <= Math.min(expectedPages, args.maxPages); page += 1) {
    const url = page === 1 ? args.url : pageUrl(args.url, page);
    const response = await fetchHtml(url, { referer: previousUrl });
    previousUrl = response.finalUrl || url;
    if (response.challenge || response.status < 200 || response.status >= 300) {
      blocked = true;
      blockReason = describeBlock(url, response);
      console.error(`[stop] page ${page}: statut ${response.status}${response.challenge ? ' (challenge)' : ''} apres ${response.attempts} tentative(s)`);
      break;
    }
    pagesFetched = page;

    const parsed = parseHtml(response.html, response.finalUrl || url);
    if (page === 1) {
      expectedLots = parsed.totalLots;
      expectedPages = Math.min(Math.max(parsed.visibleMaxPage, parsed.estimatedPages), args.maxPages);
    } else {
      expectedPages = Math.min(Math.max(expectedPages, parsed.visibleMaxPage), args.maxPages);
    }
    let newLots = 0;
    for (const lot of parsed.lots) {
      const key = lot.merge_key || lot.id;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        allLots.push(lot);
        newLots += 1;
      }
    }

    console.error(`[ok] page ${page}/${expectedPages}: ${parsed.lots.length} lots (${newLots} nouveaux)`);
    if (!parsed.lots.length) break;
    if (expectedLots && allLots.length >= expectedLots) break;
    if (newLots === 0 && page > 1) break;
    if (page < expectedPages) await sleep(args.delayMs);
  }

  let lots = dedupeLots(allLots);
  let enrichment = null;
  if (!blocked && args.details) {
    const enriched = await enrichVehicles(lots, {
      detailLimit: args.detailLimit,
      ocr: args.ocr,
      ocrLimit: args.ocrLimit,
      detailDelayMs: args.detailDelayMs,
      referer: args.url,
      onProgress: ({ current, total, lot, ctAnalyzed }) => {
        console.error(`[detail ${current}/${total}] lot ${lot.lot_number || lot.alcopa_id || '?'}${lot.url_ct ? ' CT' : ''}${ctAnalyzed ? ' analyse' : ''}`);
      },
    });
    lots = enriched.lots;
    enrichment = enriched.stats;
    if (enrichment.blocked) {
      blocked = true;
      blockReason = enrichment.blockReason;
    }
  }

  return {
    lots,
    pagesSeen: pagesFetched,
    expectedPages,
    blocked,
    blockReason,
    enrichment,
  };
}

export {
  DEFAULT_URL,
  BASE_URL,
  CSV_HEADERS,
  parseHtml,
  scrape,
  toCsv,
  fetchHtml,
  fetchBinary,
  fetchJson,
  enrichVehicles,
  describeBlock,
  getTransportName,
  closeBrowser,
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fs = await import('node:fs/promises');
  const result = await scrape(args);

  await fs.writeFile(args.out, `${JSON.stringify(result.lots, null, 2)}\n`, 'utf8');
  if (args.csv) await fs.writeFile(args.csv, toCsv(result.lots), 'utf8');

  const sold = result.lots.filter((lot) => lot.statut === 'adjuge').length;
  console.log(JSON.stringify({
    ok: !result.blocked,
    lots: result.lots.length,
    sold,
    out: args.out,
    csv: args.csv || null,
    pages: result.pagesSeen,
    expectedPages: result.expectedPages,
    enrichment: result.enrichment || null,
    blockReason: result.blockReason,
  }, null, 2));

  if (result.blocked) {
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }).finally(closeBrowser);
}
