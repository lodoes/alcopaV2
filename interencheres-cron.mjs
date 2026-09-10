#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  closeBrowser,
  describeBlock,
  fetchHtml,
  fetchJson,
  getTransportName,
} from './scrape-alcopa.mjs';
import {
  IE_AUCTIONEER_DIRECTORY_URL,
  KNOWN_ALCOPA_AUCTIONEERS,
  matchInterencheresSales,
  normalizeRoom,
  parseAuctioneerLinks,
  parseAuctioneerSales,
  parseFrenchDate,
  parseSaleMetadata,
  scrapeInterencheresSale,
  scrapeInterencheresSaleApi,
} from './interencheres.mjs';
import { createSupabaseStore } from './supabase-store.mjs';

const TERMINAL_STATUSES = new Set(['adjuge', 'invendu', 'retire']);

function envBoolean(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|oui|on)$/i.test(value);
}

function envInteger(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function log(event, data = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...data }));
}

function parisClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
  };
}

function groupLocalSales(lots) {
  const groups = new Map();
  for (const lot of lots) {
    if (!lot.sale_id || !lot.salle || !lot.date_vente) continue;
    const key = String(lot.sale_id);
    const group = groups.get(key) || {
      sale_id: key,
      salle: lot.salle,
      date_vente: parseFrenchDate(lot.date_vente) || lot.date_vente,
      lots: [],
    };
    group.lots.push(lot);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function filterRooms(sales, value) {
  const wanted = new Set(String(value || '').split(',').map(normalizeRoom).filter(Boolean));
  return wanted.size ? sales.filter((sale) => wanted.has(normalizeRoom(sale.salle))) : sales;
}

function assertFetchResponse(response, url, label) {
  if (!response.challenge && response.status >= 200 && response.status < 400) return;
  const error = new Error(`${label}: HTTP ${response.status || 0}${response.challenge ? ' (challenge anti-bot)' : ''}`);
  error.response = response;
  error.url = response.finalUrl || url;
  throw error;
}

async function discoverSalesForRooms(rooms, targetDate, config) {
  const byRoom = new Map(
    KNOWN_ALCOPA_AUCTIONEERS.map((item) => [normalizeRoom(item.room), item]),
  );
  const missingRooms = rooms.filter((room) => !byRoom.has(normalizeRoom(room)));
  if (missingRooms.length) {
    const directory = await fetchHtml(IE_AUCTIONEER_DIRECTORY_URL);
    assertFetchResponse(directory, IE_AUCTIONEER_DIRECTORY_URL, 'Annuaire Interencheres');
    const auctioneers = parseAuctioneerLinks(
      directory.html,
      directory.finalUrl || IE_AUCTIONEER_DIRECTORY_URL,
    );
    for (const item of auctioneers) byRoom.set(normalizeRoom(item.room), item);
  }
  const discovered = [];

  for (const room of rooms) {
    const auctioneer = byRoom.get(normalizeRoom(room));
    if (!auctioneer) {
      log('ie_auctioneer_missing', { room });
      continue;
    }
    const house = await fetchHtml(auctioneer.url);
    assertFetchResponse(house, auctioneer.url, `Maison de ventes ${room}`);
    const candidates = parseAuctioneerSales(house.html, house.finalUrl || auctioneer.url)
      .slice(0, config.maxCandidatesPerRoom);
    log('ie_sale_candidates', { room, count: candidates.length });

    for (const candidate of candidates) {
      const response = await fetchHtml(candidate.url, { referer: auctioneer.url });
      assertFetchResponse(response, candidate.url, `Vente Interencheres ${candidate.url}`);
      const metadata = parseSaleMetadata(response.html, response.finalUrl || candidate.url, room);
      if (metadata.date !== targetDate || !metadata.room_confirmed) continue;
      discovered.push({
        url: metadata.url,
        metadata,
        firstResponse: response,
      });
    }
  }

  const unique = new Map(discovered.map((sale) => [sale.metadata.event_id || sale.url, sale]));
  return [...unique.values()];
}

function valuesEqual(left, right) {
  return (left ?? null) === (right ?? null);
}

function buildUpdates(matches) {
  const updates = [];
  const stats = { matchedLots: 0, terminalLots: 0, ambiguousLots: 0, unchangedLots: 0 };
  for (const match of matches) {
    const localByNumber = new Map();
    for (const lot of match.localSale.lots) {
      const key = Number(lot.lot_number);
      const current = localByNumber.get(key);
      localByNumber.set(key, current ? null : lot);
    }
    for (const ieLot of match.ieSale.lots) {
      const local = localByNumber.get(Number(ieLot.lot_number));
      if (local === null) {
        stats.ambiguousLots += 1;
        continue;
      }
      if (!local) continue;
      stats.matchedLots += 1;
      if (!TERMINAL_STATUSES.has(ieLot.statut)) continue;
      stats.terminalLots += 1;
      const result = {
        id: local.id,
        sale_id: local.sale_id,
        date_vente: local.date_vente,
        enchere_courante: null,
        prix_adjudication_eur: ieLot.prix_adjudication_eur,
        statut: ieLot.statut,
        canal: ieLot.canal || null,
        url_interencheres: ieLot.url_interencheres,
        lot_interencheres_id: ieLot.lot_interencheres_id || null,
      };
      const unchanged = [...TERMINAL_STATUSES].includes(local.statut)
        && valuesEqual(local.enchere_courante, result.enchere_courante)
        && valuesEqual(local.prix_adjudication_eur, result.prix_adjudication_eur)
        && valuesEqual(local.statut, result.statut)
        && valuesEqual(local.canal, result.canal)
        && valuesEqual(local.url_interencheres, result.url_interencheres)
        && valuesEqual(local.lot_interencheres_id, result.lot_interencheres_id);
      if (unchanged) {
        stats.unchangedLots += 1;
        continue;
      }
      updates.push(result);
    }
  }
  return { updates, stats };
}

async function runCron() {
  const runId = randomUUID();
  const startedAt = Date.now();
  const clock = parisClock();
  const config = {
    targetDate: String(process.env.IE_TARGET_DATE || clock.date).trim(),
    notBeforeHour: envInteger('IE_NOT_BEFORE_HOUR', 18, { min: 0, max: 23 }),
    runAnytime: envBoolean('IE_RUN_ANYTIME', false),
    force: envBoolean('IE_FORCE', false),
    dryRun: envBoolean('IE_DRY_RUN', false),
    rooms: process.env.IE_ROOMS || '',
    maxPages: envInteger('IE_MAX_PAGES_PER_SALE', 60, { min: 1, max: 100 }),
    apiEnabled: envBoolean('IE_API_ENABLED', true),
    apiPageSize: envInteger('IE_API_PAGE_SIZE', 200, { min: 20, max: 200 }),
    apiMaxPages: envInteger('IE_API_MAX_PAGES_PER_SALE', 10, { min: 1, max: 100 }),
    pageDelayMs: envInteger('IE_PAGE_DELAY_MS', 450, { min: 0, max: 10_000 }),
    maxCandidatesPerRoom: envInteger('IE_MAX_CANDIDATES_PER_ROOM', 12, { min: 1, max: 30 }),
    writeConcurrency: envInteger('IE_WRITE_CONCURRENCY', 8, { min: 1, max: 20 }),
  };
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(config.targetDate)) {
    throw new Error(`IE_TARGET_DATE invalide: ${config.targetDate}`);
  }

  log('ie_cron_started', {
    runId,
    targetDate: config.targetDate,
    parisHour: clock.hour,
    transport: getTransportName(),
    region: process.env.RAILWAY_REPLICA_REGION || null,
    dryRun: config.dryRun,
  });
  if (!config.runAnytime && !process.env.IE_TARGET_DATE && clock.hour < config.notBeforeHour) {
    return { runId, ok: true, skipped: 'before_time_gate', targetDate: config.targetDate };
  }

  const store = createSupabaseStore();
  if (!store) throw new Error('Configure SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.');
  const lots = await store.selectLotsByDate(config.targetDate);
  let localSales = filterRooms(groupLocalSales(lots), config.rooms);
  if (!config.force) {
    localSales = localSales.filter((sale) => sale.lots.some((lot) => !TERMINAL_STATUSES.has(lot.statut)));
  }
  if (!localSales.length) {
    return {
      runId,
      ok: true,
      targetDate: config.targetDate,
      localLots: lots.length,
      skipped: 'all_sales_already_terminal_or_no_lots',
    };
  }

  const rooms = [...new Set(localSales.map((sale) => normalizeRoom(sale.salle)))];
  log('ie_local_sales', {
    runId,
    sales: localSales.map((sale) => ({
      sale_id: sale.sale_id,
      salle: sale.salle,
      lots: sale.lots.length,
    })),
  });
  const discovered = await discoverSalesForRooms(rooms, config.targetDate, config);
  log('ie_sales_discovered', {
    runId,
    count: discovered.length,
    sales: discovered.map((sale) => sale.metadata),
  });

  const scraped = [];
  for (const sale of discovered) {
    if (!sale.metadata.completed) {
      log('ie_sale_not_finished', { runId, sale: sale.metadata });
      continue;
    }
    let result = null;
    if (config.apiEnabled) {
      result = await scrapeInterencheresSaleApi({
        url: sale.url,
        saleId: sale.metadata.event_id,
        metadata: sale.metadata,
        fetchJson,
        maxPages: config.apiMaxPages,
        pageSize: config.apiPageSize,
        delayMs: config.pageDelayMs,
      });
      log('ie_sale_api_scraped', {
        runId,
        eventId: result.metadata?.event_id,
        room: result.metadata?.room,
        lots: result.lots.length,
        pages: result.pagesSeen,
        expectedPages: result.expectedPages,
        total: result.total,
        complete: result.complete,
        blocked: result.blocked,
        error: result.error,
      });
    }
    if (!result?.complete || result.blocked) {
      if (result) {
        log('ie_sale_api_fallback', {
          runId,
          eventId: sale.metadata.event_id,
          blocked: result.blocked,
          error: result.error,
        });
      }
      result = {
        ...await scrapeInterencheresSale({
          url: sale.url,
          expectedRoom: sale.metadata.room,
          fetchHtml,
          maxPages: config.maxPages,
          delayMs: config.pageDelayMs,
          firstResponse: sale.firstResponse,
        }),
        transport: 'html',
      };
    }
    log('ie_sale_scraped', {
      runId,
      eventId: result.metadata?.event_id,
      room: result.metadata?.room,
      lots: result.lots.length,
      pages: result.pagesSeen,
      expectedPages: result.expectedPages,
      complete: result.complete,
      transport: result.transport,
      error: result.error,
    });
    if (result.complete && !result.blocked) scraped.push(result);
  }

  const matches = matchInterencheresSales(localSales, scraped);
  const { updates, stats } = buildUpdates(matches);
  const saved = config.dryRun
    ? 0
    : await store.updateInterencheresLots(updates, { concurrency: config.writeConcurrency });
  const unmatchedSales = localSales.length - matches.length;
  return {
    runId,
    ok: unmatchedSales === 0 && scraped.every((sale) => sale.complete),
    targetDate: config.targetDate,
    localLots: lots.length,
    localSales: localSales.length,
    discoveredSales: discovered.length,
    scrapedSales: scraped.length,
    matchedSales: matches.length,
    unmatchedSales,
    updates: updates.length,
    saved,
    dryRun: config.dryRun,
    ...stats,
    durationMs: Date.now() - startedAt,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.once('SIGTERM', () => {
    log('ie_cron_sigterm', { message: 'Railway a demande un arret propre du cron IE.' });
    closeBrowser().finally(() => process.exit(0));
  });

  runCron()
    .then((summary) => {
      log('ie_cron_finished', summary);
      if (summary.ok === false) process.exitCode = 2;
    })
    .catch((error) => {
      log('ie_cron_failed', {
        error: error.message,
        blockReason: error.response
          ? describeBlock(error.url || IE_AUCTIONEER_DIRECTORY_URL, error.response)
          : null,
      });
      process.exitCode = 1;
    })
    .finally(closeBrowser);
}

export {
  buildUpdates,
  groupLocalSales,
  parisClock,
  runCron,
};
