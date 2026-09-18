#!/usr/bin/env node

import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import {
  closeBrowser,
  describeBlock,
  enrichVehicles,
  fetchHtml,
  getTransportName,
  scrape,
} from './scrape-alcopa.mjs';
import { discoverHomepageSales, filterSales } from './homepage-sales.mjs';
import { createSupabaseStore } from './supabase-store.mjs';

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

process.once('SIGTERM', () => {
  log('cron_sigterm', { message: 'Railway a demande un arret propre du cron.' });
  closeBrowser().finally(() => process.exit(0));
});

function replaceLots(target, replacements) {
  const byKey = new Map(target.map((lot) => [lot.merge_key || lot.id, lot]));
  for (const lot of replacements) byKey.set(lot.merge_key || lot.id, lot);
  return [...byKey.values()];
}

async function runCron() {
  const runId = randomUUID();
  const startedAt = Date.now();
  const config = {
    maxPages: envInteger('CRON_MAX_PAGES_PER_SALE', 60, { min: 1, max: 100 }),
    pageDelayMs: envInteger('CRON_PAGE_DELAY_MS', 450, { min: 0, max: 10_000 }),
    saleDelayMs: envInteger('CRON_SALE_DELAY_MS', 2_000, { min: 0, max: 60_000 }),
    details: envBoolean('CRON_DETAILS', true),
    detailLimit: envInteger('CRON_DETAIL_LIMIT_PER_SALE', 25, { min: 0, max: 2_000 }),
    detailDelayMs: envInteger('CRON_DETAIL_DELAY_MS', 650, { min: 0, max: 30_000 }),
    ocr: envBoolean('CRON_OCR', false),
    ocrLimit: envInteger('CRON_OCR_LIMIT_PER_SALE', 10, { min: 0, max: 2_000 }),
    maxSales: envInteger('CRON_MAX_SALES', 0, { min: 0, max: 100 }),
    maxRuntimeMinutes: envInteger('CRON_MAX_RUNTIME_MINUTES', 240, { min: 5, max: 1_440 }),
    rooms: process.env.CRON_SALLES || '',
    vehiclesOnly: envBoolean('CRON_VEHICLES_ONLY', true),
    discoveryOnly: envBoolean('CRON_DISCOVERY_ONLY', false),
    output: String(process.env.CRON_OUTPUT || '').trim(),
  };
  if (config.ocr) config.details = true;

  const store = createSupabaseStore();
  if (!store && !config.output && !config.discoveryOnly) {
    throw new Error('Configure SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, ou CRON_OUTPUT pour un export fichier.');
  }

  log('cron_started', {
    runId,
    transport: getTransportName(),
    region: process.env.RAILWAY_REPLICA_REGION || null,
    details: config.details,
    ocr: config.ocr,
  });

  const discovery = await discoverHomepageSales(fetchHtml);
  let sales = filterSales(discovery.sales, config.rooms);
  if (config.vehiclesOnly) {
    sales = sales.filter((sale) => !/motos?|scooters?|cyclos?/i.test(sale.title || ''));
  }
  if (config.maxSales) sales = sales.slice(0, config.maxSales);
  if (!sales.length) throw new Error('Aucune vente Alcopa trouvee sur la page d accueil avec les filtres demandes.');
  log('sales_discovered', { runId, count: sales.length, sales });

  if (config.discoveryOnly) {
    return { runId, sales, results: [], lots: [], durationMs: Date.now() - startedAt };
  }
  if (store) await store.upsertSales(sales);

  const deadline = startedAt + config.maxRuntimeMinutes * 60_000;
  const results = [];
  let exportedLots = [];
  let stoppedReason = null;

  for (let saleIndex = 0; saleIndex < sales.length; saleIndex += 1) {
    if (Date.now() >= deadline) {
      stoppedReason = `Duree maximale de ${config.maxRuntimeMinutes} minutes atteinte`;
      break;
    }

    const sale = sales[saleIndex];
    log('sale_started', { runId, index: saleIndex + 1, total: sales.length, sale });
    const saleResult = {
      sale_id: sale.sale_id,
      salle: sale.salle,
      url: sale.url,
      catalogLots: 0,
      details: null,
      ocr: null,
      blocked: false,
      error: null,
    };

    try {
      const catalog = await scrape({
        url: sale.url,
        maxPages: config.maxPages,
        delayMs: config.pageDelayMs,
        details: false,
        ocr: false,
      });
      saleResult.catalogLots = catalog.lots.length;
      saleResult.pages = catalog.pagesSeen;
      saleResult.expectedPages = catalog.expectedPages;
      saleResult.blocked = catalog.blocked;
      if (catalog.blocked) {
        saleResult.blockReason = catalog.blockReason;
        results.push(saleResult);
        stoppedReason = `Blocage Alcopa pendant la vente ${sale.sale_id}`;
        log('sale_blocked', { runId, saleId: sale.sale_id, blockReason: catalog.blockReason });
        break;
      }

      if (store) await store.upsertLots(catalog.lots);
      exportedLots = replaceLots(exportedLots, catalog.lots);
      log('catalog_saved', {
        runId,
        saleId: sale.sale_id,
        lots: catalog.lots.length,
        pages: catalog.pagesSeen,
      });

      if (config.details && Date.now() < deadline) {
        const pending = store
          ? await store.selectPendingDetails(sale.sale_id, config.detailLimit || 2_000)
          : config.detailLimit
            ? catalog.lots.slice(0, config.detailLimit)
            : catalog.lots;
        const detailBatch = config.detailLimit ? pending.slice(0, config.detailLimit) : pending;
        if (detailBatch.length) {
          const detailed = await enrichVehicles(detailBatch, {
            detailLimit: 0,
            ocr: false,
            detailDelayMs: config.detailDelayMs,
            referer: sale.url,
          });
          saleResult.details = detailed.stats;
          if (store) await store.upsertLots(detailed.lots, { includeDetails: true });
          exportedLots = replaceLots(exportedLots, detailed.lots);
          if (detailed.stats.blocked) {
            saleResult.blocked = true;
            saleResult.blockReason = detailed.stats.blockReason;
            results.push(saleResult);
            stoppedReason = `Blocage Alcopa pendant les fiches de la vente ${sale.sale_id}`;
            break;
          }
        } else {
          saleResult.details = { requested: 0, detailsSucceeded: 0 };
        }
      }

      if (config.ocr && Date.now() < deadline) {
        const candidates = store
          ? await store.selectPendingOcr(sale.sale_id, config.ocrLimit || 2_000)
          : exportedLots.filter((lot) => lot.sale_id === sale.sale_id && lot.url_ct && !lot.ct_ocr_done_at);
        const ocrBatch = config.ocrLimit ? candidates.slice(0, config.ocrLimit) : candidates;
        if (ocrBatch.length) {
          const analyzed = await enrichVehicles(ocrBatch, {
            detailLimit: 0,
            ocr: true,
            ocrLimit: 0,
            detailDelayMs: config.detailDelayMs,
            referer: sale.url,
          });
          saleResult.ocr = analyzed.stats;
          if (store) await store.upsertLots(analyzed.lots, { includeDetails: true });
          exportedLots = replaceLots(exportedLots, analyzed.lots);
          if (analyzed.stats.blocked) {
            saleResult.blocked = true;
            saleResult.blockReason = analyzed.stats.blockReason;
            results.push(saleResult);
            stoppedReason = `Blocage Alcopa pendant les CT de la vente ${sale.sale_id}`;
            break;
          }
        } else {
          saleResult.ocr = { requested: 0, ctAnalyzed: 0 };
        }
      }
    } catch (error) {
      saleResult.error = error.message;
      log('sale_error', { runId, saleId: sale.sale_id, error: error.message });
    }

    results.push(saleResult);
    log('sale_finished', { runId, result: saleResult });
    if (saleIndex + 1 < sales.length && config.saleDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, config.saleDelayMs));
    }
  }

  const summary = {
    runId,
    ok: !stoppedReason && results.every((result) => !result.error && !result.blocked),
    salesDiscovered: sales.length,
    salesProcessed: results.length,
    catalogLots: results.reduce((sum, result) => sum + result.catalogLots, 0),
    stoppedReason,
    durationMs: Date.now() - startedAt,
    results,
  };
  if (store && summary.catalogLots > 0) {
    try {
      summary.analyticsRows = await store.refreshAnalytics();
      log('analytics_refreshed', { runId, rows: summary.analyticsRows });
    } catch (error) {
      summary.analyticsRefreshError = error.message;
      log('analytics_refresh_failed', { runId, error: error.message });
    }
  }
  if (config.output) {
    await fs.writeFile(config.output, `${JSON.stringify({ ...summary, sales, lots: exportedLots }, null, 2)}\n`, 'utf8');
    summary.output = config.output;
  }
  return summary;
}

runCron()
  .then((summary) => {
    log('cron_finished', summary);
    if (summary.ok === false) process.exitCode = 2;
  })
  .catch((error) => {
    const response = error.response;
    log('cron_failed', {
      error: error.message,
      blockReason: response ? describeBlock(response.finalUrl || 'https://www.alcopa-auction.fr/', response) : null,
    });
    process.exitCode = 1;
  })
  .finally(closeBrowser);
