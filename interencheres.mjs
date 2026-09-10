import * as cheerio from 'cheerio';

const IE_BASE_URL = 'https://www.interencheres.com';
const IE_SEARCH_URL = 'https://search.interencheres.com/v1/search';
const IE_AUCTIONEER_DIRECTORY_URL = `${IE_BASE_URL}/commissaire-priseur/`;
const KNOWN_ALCOPA_AUCTIONEERS = [
  { room: 'beauvais', auctioneer_id: '508', url: `${IE_BASE_URL}/commissaire-priseur/alcopa-auction-beauvais-508/` },
  { room: 'lyon', auctioneer_id: '509', url: `${IE_BASE_URL}/commissaire-priseur/alcopa-auction-lyon-509/` },
  { room: 'marseille', auctioneer_id: '443', url: `${IE_BASE_URL}/commissaire-priseur/alcopa-auction-marseille-443/` },
  { room: 'nancy', auctioneer_id: '420', url: `${IE_BASE_URL}/commissaire-priseur/et-alcopa-auction-nancy-420/` },
  { room: 'paris sud', auctioneer_id: '131', url: `${IE_BASE_URL}/commissaire-priseur/alcopa-auction-paris-sud-131/` },
  { room: 'rennes', auctioneer_id: '145', url: `${IE_BASE_URL}/commissaire-priseur/alcopa-auction-rennes-145/` },
  { room: 'tours', auctioneer_id: '219', url: `${IE_BASE_URL}/commissaire-priseur/alcopa-auction-tours-219/` },
];

const FRENCH_MONTHS = new Map([
  ['janvier', 1],
  ['fevrier', 2],
  ['mars', 3],
  ['avril', 4],
  ['mai', 5],
  ['juin', 6],
  ['juillet', 7],
  ['aout', 8],
  ['septembre', 9],
  ['octobre', 10],
  ['novembre', 11],
  ['decembre', 12],
]);

function cleanText(value = '') {
  return String(value).replace(/\u00a0|\u202f/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeText(value = '') {
  return cleanText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function normalizeRoom(value = '') {
  return normalizeText(value)
    .replace(/\balcopa\s+auction\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isoDate(year, month, day) {
  if (!year || !month || !day) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseFrenchDate(value, fallbackYear = new Date().getUTCFullYear()) {
  const text = normalizeText(value);
  const isoMatch = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (isoMatch) return isoDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));

  const numericMatch = text.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (numericMatch) {
    return isoDate(Number(numericMatch[3]), Number(numericMatch[2]), Number(numericMatch[1]));
  }

  const monthNames = [...FRENCH_MONTHS.keys()].join('|');
  const namedMatch = text.match(new RegExp(`\\b(\\d{1,2})(?:er)?\\s+(${monthNames})(?:\\s+(20\\d{2}))?\\b`));
  if (!namedMatch) return null;
  return isoDate(
    Number(namedMatch[3] || fallbackYear),
    FRENCH_MONTHS.get(namedMatch[2]),
    Number(namedMatch[1]),
  );
}

function absoluteInterencheresUrl(value, baseUrl = IE_BASE_URL) {
  try {
    const url = new URL(value, baseUrl);
    if (!/(^|\.)interencheres\.com$/i.test(url.hostname)) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function interencheresApiItemsUrl(saleId) {
  const url = new URL(`${IE_SEARCH_URL}/ie4_items`);
  url.searchParams.set('filters[sale]', String(saleId));
  return url.href;
}

function interencheresItemUrl(saleUrl, itemId) {
  const url = absoluteInterencheresUrl(saleUrl);
  if (!url || !itemId) return url || '';
  const parsed = new URL(url);
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/lot-${itemId}.html`;
  return parsed.href;
}

function contentRangeTotal(headers = {}) {
  const value = headers['content-range'] || headers['Content-Range'] || '';
  const match = String(value).match(/\/(\d+)\s*$/);
  return match ? Number(match[1]) : null;
}

function parseInterencheresApiItem(item, saleUrl) {
  const itemId = Number(item?.id);
  const lotNumber = Number(item?.meta?.order_number?.primary);
  if (!Number.isFinite(itemId) || !Number.isFinite(lotNumber)) return null;

  const auctioned = item?.pricing?.auctioned;
  let statut = 'inconnu';
  let price = null;
  if (item?.states?.suppressed === true) {
    statut = 'retire';
  } else if (auctioned?.sold === true) {
    statut = 'adjuge';
    const value = Number(auctioned.price);
    price = Number.isFinite(value) ? value : null;
  } else if (auctioned?.sold === false) {
    statut = 'invendu';
  }

  const auctionType = normalizeText(`${auctioned?.type || ''} ${auctioned?.site || ''}`);
  let canal = '';
  if (/live|online|interencheres/.test(auctionType)) canal = 'internet';
  else if (/physical|salle/.test(auctionType)) canal = 'salle';

  return {
    lot_number: lotNumber,
    lot_interencheres_id: String(itemId),
    description: cleanText(
      item?.title_translations?.['fr-FR']
      || item?.title_translations?.['en-US']
      || item?.description
      || '',
    ),
    prix_adjudication_eur: price,
    statut,
    canal,
    url_interencheres: interencheresItemUrl(saleUrl, itemId),
  };
}

function parseInterencheresApiPage(text, saleUrl) {
  const payload = typeof text === 'string' ? JSON.parse(text) : text;
  if (!Array.isArray(payload)) throw new Error('Reponse API Interencheres invalide');
  return payload.map((item) => parseInterencheresApiItem(item, saleUrl)).filter(Boolean);
}

function parseAuctioneerLinks(html, baseUrl = IE_AUCTIONEER_DIRECTORY_URL) {
  const $ = cheerio.load(html);
  const byRoom = new Map();
  $('a[href*="/commissaire-priseur/"]').each((_, element) => {
    const href = $(element).attr('href') || '';
    const url = absoluteInterencheresUrl(href, baseUrl);
    if (!url) return;
    const match = new URL(url).pathname.match(/\/commissaire-priseur\/alcopa-auction-([a-z0-9-]+)-(\d+)\/?$/i);
    if (!match) return;
    const room = normalizeRoom(match[1].replace(/-/g, ' '));
    if (!room) return;
    byRoom.set(room, {
      room,
      auctioneer_id: match[2],
      name: cleanText($(element).text()) || `ALCOPA AUCTION ${match[1].replace(/-/g, ' ')}`,
      url,
    });
  });
  return [...byRoom.values()];
}

function parseAuctioneerSales(html, baseUrl) {
  const $ = cheerio.load(html);
  const byUrl = new Map();
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href') || '';
    const url = absoluteInterencheresUrl(href, baseUrl);
    if (!url) return;
    const pathname = new URL(url).pathname;
    if (pathname.includes('/lot-')) return;
    if (!/^\/(?:[a-z]{2}-[A-Z]{2}\/)?(?:vehicules|biens-equipement)\/[^/]+-\d+\/?$/i.test(pathname)) return;
    const text = cleanText($(element).text());
    const lotsMatch = text.match(/([\d\s\u202f\u00a0]+)\s+lots?\b/i);
    byUrl.set(url, {
      url,
      label: text,
      lots_announced: lotsMatch ? Number(lotsMatch[1].replace(/\D/g, '')) : null,
    });
  });
  return [...byUrl.values()];
}

function pageTitle($) {
  return cleanText(
    $('h1').first().text()
      || $('meta[property="og:title"]').attr('content')
      || $('title').text(),
  );
}

function parseSaleMetadata(html, sourceUrl, expectedRoom = '') {
  const $ = cheerio.load(html);
  const title = pageTitle($);
  const body = cleanText($('body').text());
  const headText = cleanText(`${title} ${$('meta[property="og:description"]').attr('content') || ''}`);
  const datetime = $('time[datetime]').map((_, element) => $(element).attr('datetime')).get()
    .find((value) => /20\d{2}-\d{2}-\d{2}/.test(value || ''));
  const targetYear = Number(String(sourceUrl).match(/20\d{2}/)?.[0]) || new Date().getUTCFullYear();
  const date = parseFrenchDate(datetime || headText || body.slice(0, 5_000), targetYear)
    || parseFrenchDate(body.slice(0, 8_000), targetYear);
  const bodyNormalized = normalizeText(body);
  const expectedLotsMatch = body.match(/([\d\s\u202f\u00a0]+)\s+lots?\b/i);
  const url = absoluteInterencheresUrl(sourceUrl) || sourceUrl;
  const eventId = new URL(url).pathname.match(/-(\d+)\/?$/)?.[1] || null;
  const room = normalizeRoom(expectedRoom);

  return {
    event_id: eventId,
    url,
    title,
    date,
    room,
    room_confirmed: room ? bodyNormalized.includes(`alcopa auction ${room}`) : false,
    completed: /vente (?:est )?terminee|live termine|\btermine\b/.test(bodyNormalized),
    lots_announced: expectedLotsMatch ? Number(expectedLotsMatch[1].replace(/\D/g, '')) : null,
  };
}

function parseEuro(value) {
  const digits = String(value || '').replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}

function lotNumberFromCard($, card) {
  const preferred = $(card).find('.text-body-2.font-italic span, [class*="font-italic"].text-body-2 span')
    .first().text();
  const preferredNumber = Number.parseInt(preferred, 10);
  if (Number.isFinite(preferredNumber)) return preferredNumber;
  const text = cleanText($(card).text());
  const match = text.match(/\bLot(?:\s+n(?:o|°|º|\.)?)?\s*(\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function titleFromCard($, card, text) {
  const preferred = cleanText($(card).find('[class*="min-h-44"] > div').first().text());
  if (preferred) return preferred;
  return cleanText(text
    .replace(/Adjug[eé][^:]{0,40}:\s*[\d\s\u202f\u00a0]+\s*€/i, '')
    .replace(/\b(?:Invendu|Retir[eé])\b/i, '')
    .replace(/\bLot(?:\s+n(?:o|°|º|\.)?)?\s*\d+\b/i, '')
    .replace(/\bLive\b|\bTermin[eé]\b|\bD[eé]j[aà] vu\b/gi, ''));
}

function extractLot($, card, baseUrl) {
  const rawHref = $(card).attr('href') || '';
  const url = absoluteInterencheresUrl(rawHref, baseUrl);
  if (!url) return null;
  const lotNumber = lotNumberFromCard($, card);
  if (!Number.isFinite(lotNumber)) return null;

  const text = cleanText($(card).text());
  const normalized = normalizeText(text);
  const soldMatch = text.match(/Adjug[eé](?:\s+(?:en salle|sur Interencheres))?\s*:\s*([\d\s\u202f\u00a0.,]+)\s*€/i);
  let statut = 'inconnu';
  let price = null;
  if (soldMatch) {
    statut = 'adjuge';
    price = parseEuro(soldMatch[1]);
  } else if (/\bnon adjuge\b|\binvendu\b/.test(normalized)) {
    statut = 'invendu';
  } else if (/\bretire\b/.test(normalized)) {
    statut = 'retire';
  } else if (/\bestimation\b|\benchere\b/.test(normalized)) {
    statut = 'en_cours';
  }

  let canal = '';
  if (/adjug[eé]\s+sur interencheres/i.test(text)) canal = 'internet';
  else if (/adjug[eé]\s+en salle/i.test(text)) canal = 'salle';

  const idMatch = new URL(url).pathname.match(/\/lot-(\d+)\.html$/i);
  return {
    lot_number: lotNumber,
    lot_interencheres_id: $(card).attr('id') || idMatch?.[1] || '',
    description: titleFromCard($, card, text),
    prix_adjudication_eur: price,
    statut,
    canal,
    url_interencheres: url.split('?')[0],
  };
}

function parsePagination($) {
  let max = 1;
  $('.v-pagination__item, button.v-pagination__item, [aria-label*="page" i]').each((_, element) => {
    const values = [$(element).text(), $(element).attr('aria-label')];
    for (const value of values) {
      const numbers = String(value || '').match(/\d+/g) || [];
      for (const number of numbers) max = Math.max(max, Number(number));
    }
  });
  return max;
}

function parseInterencheresPage(html, sourceUrl, expectedRoom = '') {
  const $ = cheerio.load(html);
  const byUrl = new Map();
  $('a[href*="/lot-"]').each((_, card) => {
    const lot = extractLot($, card, sourceUrl);
    if (lot) byUrl.set(lot.url_interencheres, lot);
  });
  return {
    metadata: parseSaleMetadata(html, sourceUrl, expectedRoom),
    lots: [...byUrl.values()],
    totalPages: parsePagination($),
  };
}

function pageUrl(sourceUrl, page) {
  const url = new URL(sourceUrl);
  url.searchParams.set('page', String(page));
  return url.href;
}

async function scrapeInterencheresSale(options) {
  const {
    url,
    expectedRoom = '',
    fetchHtml,
    maxPages = 30,
    delayMs = 500,
    firstResponse = null,
  } = options;
  const byLotId = new Map();
  let expectedPages = 1;
  let pagesSeen = 0;
  let metadata = null;
  let previousFirstId = '';

  for (let page = 1; page <= Math.min(maxPages, expectedPages); page += 1) {
    const response = page === 1 && firstResponse
      ? firstResponse
      : await fetchHtml(page === 1 ? url : pageUrl(url, page), { referer: url });
    if (response.challenge || response.status < 200 || response.status >= 400) {
      return {
        url,
        lots: [...byLotId.values()],
        pagesSeen,
        expectedPages,
        metadata,
        blocked: Boolean(response.challenge),
        complete: false,
        error: `Interencheres HTTP ${response.status || 0}${response.challenge ? ' (challenge anti-bot)' : ''}`,
      };
    }

    const parsed = parseInterencheresPage(
      response.html,
      response.finalUrl || pageUrl(url, page),
      expectedRoom,
    );
    if (page === 1) {
      metadata = parsed.metadata;
      expectedPages = Math.max(1, parsed.totalPages);
      if (expectedPages === 1 && metadata.lots_announced > parsed.lots.length && parsed.lots.length) {
        expectedPages = Math.ceil(metadata.lots_announced / parsed.lots.length);
      }
    }
    const firstId = parsed.lots[0]?.lot_interencheres_id || parsed.lots[0]?.url_interencheres || '';
    if (!parsed.lots.length || (page > 1 && firstId === previousFirstId)) {
      return {
        url,
        lots: [...byLotId.values()],
        pagesSeen,
        expectedPages,
        metadata,
        blocked: false,
        complete: false,
        error: `Pagination Interencheres interrompue a la page ${page}`,
      };
    }
    previousFirstId = firstId;
    for (const lot of parsed.lots) {
      byLotId.set(lot.lot_interencheres_id || lot.url_interencheres, lot);
    }
    pagesSeen = page;
    if (page < expectedPages && delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return {
    url,
    lots: [...byLotId.values()],
    pagesSeen,
    expectedPages,
    metadata,
    blocked: false,
    complete: pagesSeen === expectedPages && expectedPages <= maxPages,
    error: expectedPages > maxPages ? `Limite de ${maxPages} pages atteinte` : null,
  };
}

async function scrapeInterencheresSaleApi(options) {
  const {
    url,
    saleId,
    metadata = null,
    fetchJson,
    maxPages = 10,
    pageSize = 200,
    delayMs = 250,
  } = options;
  const apiUrl = interencheresApiItemsUrl(saleId);
  const byLotId = new Map();
  let pagesSeen = 0;
  let expectedPages = 1;
  let total = null;
  let complete = false;
  let error = null;

  for (let page = 0; page < maxPages; page += 1) {
    const start = page * pageSize;
    const end = start + pageSize - 1;
    const response = await fetchJson(apiUrl, {
      referer: url,
      headers: {
        'x-range': `items=${start}-${end}`,
        'x-requested-with': 'XMLHttpRequest',
      },
    });
    if (response.challenge || response.status < 200 || response.status >= 400) {
      return {
        url,
        apiUrl,
        lots: [...byLotId.values()],
        pagesSeen,
        expectedPages,
        metadata,
        blocked: Boolean(response.challenge),
        complete: false,
        transport: 'api',
        error: `API Interencheres HTTP ${response.status || 0}${response.challenge ? ' (challenge anti-bot)' : ''}`,
      };
    }

    let lots;
    try {
      lots = parseInterencheresApiPage(response.text, url);
    } catch (parseError) {
      return {
        url,
        apiUrl,
        lots: [...byLotId.values()],
        pagesSeen,
        expectedPages,
        metadata,
        blocked: false,
        complete: false,
        transport: 'api',
        error: parseError.message,
      };
    }

    total = contentRangeTotal(response.headers) ?? total;
    expectedPages = total == null
      ? Math.max(expectedPages, page + (lots.length >= pageSize ? 2 : 1))
      : Math.max(1, Math.ceil(total / pageSize));
    let newLots = 0;
    for (const lot of lots) {
      const key = lot.lot_interencheres_id || `${lot.lot_number}`;
      if (!byLotId.has(key)) newLots += 1;
      byLotId.set(key, lot);
    }
    pagesSeen = page + 1;

    if (total != null && byLotId.size >= total) {
      complete = true;
      break;
    }
    if (lots.length < pageSize) {
      complete = lots.length > 0 || page > 0;
      break;
    }
    if (!newLots) {
      error = `Pagination API Interencheres interrompue a la page ${page + 1}`;
      break;
    }
    if (page + 1 < maxPages && delayMs) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (!complete && !error) error = `Limite de ${maxPages} pages API atteinte`;
  return {
    url,
    apiUrl,
    lots: [...byLotId.values()],
    pagesSeen,
    expectedPages,
    total,
    metadata,
    blocked: false,
    complete,
    transport: 'api',
    error,
  };
}

function scoreSalePair(localSale, ieSale) {
  const localNumbers = new Set(localSale.lots.map((lot) => Number(lot.lot_number)).filter(Number.isFinite));
  const ieNumbers = new Set(ieSale.lots.map((lot) => Number(lot.lot_number)).filter(Number.isFinite));
  let intersection = 0;
  for (const number of ieNumbers) if (localNumbers.has(number)) intersection += 1;
  return {
    localSale,
    ieSale,
    intersection,
    localCoverage: localNumbers.size ? intersection / localNumbers.size : 0,
    ieCoverage: ieNumbers.size ? intersection / ieNumbers.size : 0,
  };
}

function matchInterencheresSales(localSales, ieSales) {
  const pairs = [];
  for (const localSale of localSales) {
    for (const ieSale of ieSales) {
      if (normalizeRoom(localSale.salle) !== normalizeRoom(ieSale.metadata?.room)) continue;
      if (localSale.date_vente !== ieSale.metadata?.date) continue;
      pairs.push(scoreSalePair(localSale, ieSale));
    }
  }
  pairs.sort((a, b) => b.intersection - a.intersection
    || b.localCoverage - a.localCoverage
    || b.ieCoverage - a.ieCoverage);

  const usedLocal = new Set();
  const usedIe = new Set();
  const matches = [];
  for (const pair of pairs) {
    const localKey = pair.localSale.sale_id;
    const ieKey = pair.ieSale.metadata?.event_id || pair.ieSale.url;
    const minimum = Math.min(3, pair.localSale.lots.length, pair.ieSale.lots.length);
    if (!minimum || pair.intersection < minimum) continue;
    if (usedLocal.has(localKey) || usedIe.has(ieKey)) continue;

    const competing = pairs.find((candidate) => (
      candidate !== pair
      && candidate.intersection === pair.intersection
      && (candidate.localSale.sale_id === localKey
        || (candidate.ieSale.metadata?.event_id || candidate.ieSale.url) === ieKey)
    ));
    if (competing) continue;
    usedLocal.add(localKey);
    usedIe.add(ieKey);
    matches.push(pair);
  }
  return matches;
}

export {
  IE_AUCTIONEER_DIRECTORY_URL,
  IE_BASE_URL,
  IE_SEARCH_URL,
  KNOWN_ALCOPA_AUCTIONEERS,
  cleanText,
  contentRangeTotal,
  interencheresApiItemsUrl,
  matchInterencheresSales,
  normalizeRoom,
  parseAuctioneerLinks,
  parseAuctioneerSales,
  parseFrenchDate,
  parseInterencheresApiItem,
  parseInterencheresApiPage,
  parseInterencheresPage,
  parseSaleMetadata,
  scrapeInterencheresSale,
  scrapeInterencheresSaleApi,
};
