import * as cheerio from 'cheerio';

import { analyzeCtText, extractCtText, isPdfBuffer } from './ct-analysis.mjs';

const DETAIL_FIELD_MAP = new Map([
  ['marque', 'marque'],
  ['modele', 'modele'],
  ['finition', 'finition'],
  ['immatriculation', 'immatriculation'],
  ['energie', 'energie_detail'],
  ['mise en circulation', 'date_mise_circulation'],
  ['kilometrage', 'kilometrage_detail'],
  ['numero de serie', 'numero_serie'],
  ['couleur', 'couleur'],
  ['tva recuperable', 'tva_recuperable'],
  ['type', 'type_vehicule'],
  ['carrosserie', 'carrosserie'],
  ['lieu de stockage', 'lieu_stockage_detail'],
  ['co2', 'co2_g_km'],
  ['cylindree moteur', 'cylindree_cm3'],
  ['boite de vitesse', 'boite_detail'],
]);

function normalizeText(value = '') {
  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeLabel(value = '') {
  return normalizeText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function numericValue(value = '') {
  const digits = String(value).replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
}

function absoluteUrl(value, baseUrl) {
  if (!value) return '';
  try {
    return new URL(String(value).replace(/\\/g, ''), baseUrl).href;
  } catch {
    return '';
  }
}

function extractCtUrl($, html, detailUrl) {
  const selectors = [
    'a[href*="getDocument/ct"]',
    '[data-href*="getDocument/ct"]',
    '[data-url*="getDocument/ct"]',
    '[onclick*="getDocument/ct"]',
  ];
  for (const selector of selectors) {
    const element = $(selector).first();
    if (!element.length) continue;
    for (const attribute of ['href', 'data-href', 'data-url', 'onclick']) {
      const candidate = element.attr(attribute) || '';
      const match = candidate.match(/(https?:\/\/[^\s"'()]+getDocument\/ct\/[^\s"'()]+|\/getDocument\/ct\/[^\s"'()]+)/i);
      if (match) return absoluteUrl(match[1], detailUrl);
    }
  }

  const regexes = [
    /(?:href|data-href|data-url)=["']([^"']*getDocument[\\/]ct[\\/][^"']+)["']/i,
    /onclick=["'][^"']*(\/getDocument\/ct\/[^"']+)["']/i,
    /"(?:url_ct|ct_url|documentCT|ctUrl)"\s*:\s*"([^"]+getDocument[^"]+)"/i,
  ];
  for (const regex of regexes) {
    const match = html.match(regex);
    if (match) return absoluteUrl(match[1], detailUrl);
  }
  return '';
}

function firstText($, selectors) {
  for (const selector of selectors) {
    const value = normalizeText($(selector).first().text());
    if (value) return value;
  }
  return '';
}

function parseCharacteristics($) {
  const characteristics = {};
  $('table tr').each((_, row) => {
    const label = normalizeText($(row).find('th').first().text());
    const value = normalizeText($(row).find('td').first().text());
    if (label && value && characteristics[label] == null) characteristics[label] = value;
  });
  return characteristics;
}

function parseAestheticDefects($) {
  const defects = [];
  const seen = new Set();
  $('.js-damage-proges[data-source], [data-source*="damage"]').each((_, element) => {
    const raw = $(element).attr('data-source');
    if (!raw) return;
    let rows;
    try {
      rows = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      const damage = row?.damage || {};
      const parsed = {
        id: damage.id || row?.id || null,
        zone: damage.zone || '',
        zone_label: damage.zone_label || '',
        type: damage.type || '',
        type_label: damage.type_label || '',
        photo_url: row?.vehiculephoto_url || '',
      };
      const key = String(parsed.id || `${parsed.zone}|${parsed.type}|${parsed.photo_url}`);
      if (!seen.has(key)) {
        seen.add(key);
        defects.push(parsed);
      }
    }
  });
  return defects;
}

function parseVehicleDetail(html, detailUrl) {
  const $ = cheerio.load(html);
  const characteristics = parseCharacteristics($);
  const mapped = {};
  for (const [label, value] of Object.entries(characteristics)) {
    const field = DETAIL_FIELD_MAP.get(normalizeLabel(label));
    if (field && mapped[field] == null) mapped[field] = value;
  }

  if (mapped.tva_recuperable != null) {
    mapped.tva_recuperable = /^(oui|yes|1|true)$/i.test(mapped.tva_recuperable);
  }
  if (mapped.co2_g_km != null) mapped.co2_g_km = numericValue(mapped.co2_g_km);
  if (mapped.cylindree_cm3 != null) mapped.cylindree_cm3 = numericValue(mapped.cylindree_cm3);
  if (mapped.kilometrage_detail != null) mapped.kilometrage_detail = numericValue(mapped.kilometrage_detail);

  const commentaires = firstText($, [
    'div.order-md-3',
    '.order-md-3',
    '[class*="order-md-3"]',
  ]);
  const informations = firstText($, [
    'div.mb-3.col-12',
    '.mb-3.col-12',
    '[class*="mb-3"][class*="col-12"]',
  ]);

  return {
    ...mapped,
    url_ct: extractCtUrl($, html, detailUrl),
    caracteristiques: characteristics,
    defauts_esthetiques: parseAestheticDefects($),
    commentaires_brut: commentaires,
    informations_brut: informations,
    notes_annonce: normalizeText([commentaires, informations].filter(Boolean).join('\n\n')),
    annonce_fetched_at: new Date().toISOString(),
  };
}

function blockReason(url, response) {
  return {
    url,
    finalUrl: response.finalUrl || url,
    status: response.status || 0,
    challenge: Boolean(response.challenge),
    attempts: response.attempts || 1,
    networkError: response.networkError || null,
  };
}

async function enrichLot(lot, options) {
  const detailUrl = lot.url_alcopa;
  const detailAttemptedAt = new Date().toISOString();
  const output = { ...lot, detail_last_attempt_at: detailAttemptedAt };
  let detailResponse;
  try {
    detailResponse = await options.fetchHtml(detailUrl, { referer: options.referer || '' });
    if (detailResponse.challenge || detailResponse.status < 200 || detailResponse.status >= 300) {
      return {
        lot: {
          ...output,
          detail_error: `HTTP ${detailResponse.status || 0} sur la fiche Alcopa`,
        },
        blocked: Boolean(detailResponse.challenge || [403, 405, 429].includes(detailResponse.status)),
        blockReason: blockReason(detailUrl, detailResponse),
        ctAttempted: false,
        ctAnalyzed: false,
      };
    }
    Object.assign(output, parseVehicleDetail(detailResponse.html, detailResponse.finalUrl || detailUrl));
    output.detail_error = null;
  } catch (error) {
    return {
      lot: {
        ...output,
        detail_error: error.message,
      },
      blocked: false,
      blockReason: null,
      ctAttempted: false,
      ctAnalyzed: false,
    };
  }

  if (!options.ocr || !output.url_ct) {
    return { lot: output, blocked: false, blockReason: null, ctAttempted: false, ctAnalyzed: false };
  }

  const ctAttemptedAt = new Date().toISOString();
  output.ct_last_attempt_at = ctAttemptedAt;
  try {
    if (new URL(output.url_ct).hostname !== 'www.alcopa-auction.fr') {
      throw new Error('Le lien CT ne pointe pas vers le domaine Alcopa autorise.');
    }
    const response = await options.fetchBinary(output.url_ct, { referer: detailResponse.finalUrl || detailUrl });
    if (response.challenge || response.status < 200 || response.status >= 300) {
      output.ct_error = `HTTP ${response.status || 0} pendant le telechargement du CT`;
      return {
        lot: output,
        blocked: Boolean(response.challenge || [403, 405, 429].includes(response.status)),
        blockReason: blockReason(output.url_ct, response),
        ctAttempted: true,
        ctAnalyzed: false,
      };
    }
    if (!isPdfBuffer(response.buffer)) throw new Error('Le lien CT ne renvoie pas un PDF valide.');

    const extracted = await extractCtText(response.buffer, options.ctOptions);
    const analysis = analyzeCtText(extracted.text);
    Object.assign(output, {
      ct_verdict: analysis.verdict,
      ct_defauts_maj: analysis.majeures,
      ct_defauts_min: analysis.mineures,
      ct_critiques: analysis.critiques,
      ct_nb_codes: analysis.nb_codes_detectes,
      ct_defauts_maj_groupes: analysis.majeures_groupes,
      ct_defauts_min_groupes: analysis.mineures_groupes,
      ct_texte_brut: analysis.texte_brut,
      ct_ocr_done_at: new Date().toISOString(),
      ct_source: extracted.source,
      ct_pages_traitees: extracted.pagesProcessed,
      ct_error: null,
    });
    return { lot: output, blocked: false, blockReason: null, ctAttempted: true, ctAnalyzed: true };
  } catch (error) {
    output.ct_error = error.message;
    return { lot: output, blocked: false, blockReason: null, ctAttempted: true, ctAnalyzed: false };
  }
}

async function enrichLots(lots, options) {
  const output = lots.map((lot) => ({ ...lot }));
  const detailLimit = Math.max(0, Number(options.detailLimit || 0));
  const ocrLimit = Math.max(0, Number(options.ocrLimit || 0));
  const delayMs = Math.max(0, Number(options.delayMs || 0));
  const availableIndexes = output
    .map((lot, index) => ({ lot, index }))
    .filter(({ lot }) => lot.url_alcopa);
  const indexes = detailLimit ? availableIndexes.slice(0, detailLimit) : availableIndexes;
  const stats = {
    requested: indexes.length,
    detailsAttempted: 0,
    detailsSucceeded: 0,
    ctFound: 0,
    ctAttempted: 0,
    ctAnalyzed: 0,
    errors: 0,
    errorSamples: [],
    blocked: false,
    blockReason: null,
  };
  let ocrSelected = 0;
  let previousUrl = options.referer || '';

  for (let position = 0; position < indexes.length; position += 1) {
    const { lot, index } = indexes[position];
    const allowOcr = Boolean(options.ocr) && (!ocrLimit || ocrSelected < ocrLimit);
    const result = await enrichLot(lot, {
      ...options,
      ocr: allowOcr,
      referer: previousUrl,
    });
    output[index] = result.lot;
    previousUrl = lot.url_alcopa;
    stats.detailsAttempted += 1;
    if (!result.lot.detail_error) stats.detailsSucceeded += 1;
    else {
      stats.errors += 1;
      if (stats.errorSamples.length < 5) {
        stats.errorSamples.push({
          lot: result.lot.lot_number || result.lot.alcopa_id || null,
          url: result.lot.url_alcopa || null,
          phase: 'detail',
          error: result.lot.detail_error,
        });
      }
    }
    if (result.lot.url_ct) stats.ctFound += 1;
    if (result.ctAttempted) {
      stats.ctAttempted += 1;
      ocrSelected += 1;
    }
    if (result.ctAnalyzed) stats.ctAnalyzed += 1;
    if (result.lot.ct_error) {
      stats.errors += 1;
      if (stats.errorSamples.length < 5) {
        stats.errorSamples.push({
          lot: result.lot.lot_number || result.lot.alcopa_id || null,
          url: result.lot.url_ct || result.lot.url_alcopa || null,
          phase: 'ct',
          error: result.lot.ct_error,
        });
      }
    }

    options.onProgress?.({ ...stats, current: position + 1, total: indexes.length, lot: result.lot });
    if (result.blocked) {
      stats.blocked = true;
      stats.blockReason = result.blockReason;
      break;
    }
    if (position + 1 < indexes.length && delayMs) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return { lots: output, stats };
}

export { enrichLot, enrichLots, extractCtUrl, normalizeText, parseVehicleDetail };
