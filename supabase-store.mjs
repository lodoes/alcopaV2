const BASE_LOT_COLUMNS = [
  'id',
  'merge_key',
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
];

const DETAIL_LOT_COLUMNS = [
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
  'caracteristiques',
  'defauts_esthetiques',
  'url_ct',
  'commentaires_brut',
  'informations_brut',
  'notes_annonce',
  'annonce_fetched_at',
  'detail_last_attempt_at',
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
  'ct_last_attempt_at',
  'ct_source',
  'ct_pages_traitees',
  'ct_error',
];

// These values come from the completed Interencheres sale. Alcopa catalogue
// refreshes must never reset them to null or back to "en_cours".
const INTERENCHERES_RESULT_COLUMNS = new Set([
  'enchere_courante',
  'prix_adjudication_eur',
  'statut',
  'canal',
  'url_interencheres',
  'lot_interencheres_id',
]);

const INTERENCHERES_SELECT_COLUMNS = [
  'id',
  'merge_key',
  'lot_number',
  'sale_id',
  'salle',
  'date_vente',
  'marque',
  'modele',
  'description',
  'enchere_courante',
  'prix_adjudication_eur',
  'statut',
  'canal',
  'url_interencheres',
  'lot_interencheres_id',
];

const ALCOPA_CATALOG_COLUMNS = BASE_LOT_COLUMNS.filter(
  (column) => !INTERENCHERES_RESULT_COLUMNS.has(column),
);

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function cleanBaseUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/rest\/v1\/?$/i, '')
    .replace(/\/+$/, '');
}

function assertTableName(value, label) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`${label} Supabase invalide: ${value}`);
  }
}

function envValue(name) {
  if (process.env[name] != null) return process.env[name];
  const found = Object.entries(process.env).find(([key]) => key.trim() === name);
  return found ? found[1] : '';
}

function serializeLot(lot, includeDetails) {
  const columns = includeDetails
    ? [...ALCOPA_CATALOG_COLUMNS, ...DETAIL_LOT_COLUMNS]
    : ALCOPA_CATALOG_COLUMNS;
  const row = {};
  for (const column of columns) {
    const value = lot[column];
    if (!includeDetails && (value == null || value === '')) continue;
    row[column] = value ?? null;
  }
  row.raw_json = lot;
  return row;
}

function groupRowsByColumns(rows) {
  const groups = new Map();
  for (const row of rows) {
    const columns = Object.keys(row).sort().join(',');
    const group = groups.get(columns) || [];
    group.push(row);
    groups.set(columns, group);
  }
  return groups;
}

function createSupabaseStore(options = {}) {
  const baseUrl = cleanBaseUrl(options.url || envValue('SUPABASE_URL'));
  const key = String(
    options.key
      || envValue('SUPABASE_SERVICE_ROLE_KEY')
      || envValue('SUPABASE_KEY')
      || '',
  ).trim();
  const lotsTable = options.lotsTable || envValue('SUPABASE_LOTS_TABLE') || 'alcopa_lots';
  const salesTable = options.salesTable || envValue('SUPABASE_SALES_TABLE') || 'alcopa_sales';
  const fetchImpl = options.fetch || fetch;
  const batchSize = Math.max(1, Number(options.batchSize || envValue('SUPABASE_BATCH_SIZE') || 100));
  assertTableName(lotsTable, 'Table lots');
  assertTableName(salesTable, 'Table ventes');

  if (!baseUrl || !key) return null;

  async function request(table, { method = 'GET', query = {}, body, prefer = '' } = {}) {
    const url = new URL(`${baseUrl}/rest/v1/${table}`);
    for (const [name, value] of Object.entries(query)) {
      if (value != null && value !== '') url.searchParams.set(name, String(value));
    }
    const response = await fetchImpl(url, {
      method,
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        ...(body == null ? {} : { 'content-type': 'application/json' }),
        ...(prefer ? { prefer } : {}),
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) {
      const preview = (await response.text()).slice(0, 800);
      throw new Error(`Supabase ${method} ${table}: HTTP ${response.status} ${preview}`);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async function rpc(functionName, { body = {} } = {}) {
    assertTableName(functionName, 'Fonction Supabase');
    const url = new URL(`${baseUrl}/rest/v1/rpc/${functionName}`);
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const preview = (await response.text()).slice(0, 800);
      throw new Error(`Supabase RPC ${functionName}: HTTP ${response.status} ${preview}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async function refreshAnalytics() {
    return rpc('refresh_lots_analytics');
  }

  async function upsertLots(lots, { includeDetails = false } = {}) {
    if (!lots.length) return 0;
    let saved = 0;
    const groups = groupRowsByColumns(
      lots.map((lot) => serializeLot(lot, includeDetails)),
    );
    for (const [columns, rows] of groups) {
      for (const batch of chunks(rows, batchSize)) {
        await request(lotsTable, {
          method: 'POST',
          query: { on_conflict: 'merge_key', columns },
          prefer: 'resolution=merge-duplicates,return=minimal',
          body: batch,
        });
        saved += batch.length;
      }
    }
    return saved;
  }

  async function upsertSales(sales) {
    if (!sales.length) return 0;
    const seenAt = new Date().toISOString();
    const rows = sales.map((sale) => ({
      sale_id: sale.sale_id,
      salle: sale.salle,
      slug: sale.slug,
      url: sale.url,
      date_label: sale.date_label || null,
      title: sale.title || null,
      lots_announced: sale.lots_announced,
      last_seen_at: seenAt,
    }));
    await request(salesTable, {
      method: 'POST',
      query: { on_conflict: 'sale_id' },
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: rows,
    });
    return rows.length;
  }

  async function selectPendingDetails(saleId, limit) {
    return request(lotsTable, {
      query: {
        select: '*',
        sale_id: `eq.${saleId}`,
        annonce_fetched_at: 'is.null',
        order: 'detail_last_attempt_at.asc.nullsfirst,lot_number.asc',
        limit,
      },
    });
  }

  async function selectPendingOcr(saleId, limit) {
    return request(lotsTable, {
      query: {
        select: '*',
        sale_id: `eq.${saleId}`,
        url_ct: 'not.is.null',
        ct_ocr_done_at: 'is.null',
        order: 'ct_last_attempt_at.asc.nullsfirst,lot_number.asc',
        limit,
      },
    });
  }

  async function selectLotsByDate(date) {
    const rows = [];
    const isoMatch = String(date).match(/^(20\d{2})-(\d{2})-(\d{2})$/);
    const dateFilter = isoMatch
      ? `(date_vente.eq.${date},date_vente.eq.${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]})`
      : `(date_vente.eq.${date})`;
    const pageSize = 1_000;
    for (let offset = 0; ; offset += pageSize) {
      const page = await request(lotsTable, {
        query: {
          select: INTERENCHERES_SELECT_COLUMNS.join(','),
          or: dateFilter,
          order: 'id.asc',
          limit: pageSize,
          offset,
        },
      });
      rows.push(...page);
      if (page.length < pageSize) break;
    }
    return rows;
  }

  async function updateInterencheresLots(updates, { concurrency = 8 } = {}) {
    let saved = 0;
    const parallel = Math.max(1, Math.min(20, Number(concurrency) || 8));
    for (const batch of chunks(updates, parallel)) {
      const results = await Promise.all(batch.map(async (update) => {
        const body = {};
        for (const column of INTERENCHERES_RESULT_COLUMNS) {
          if (Object.hasOwn(update, column)) body[column] = update[column];
        }
        if (!update.id || !update.sale_id || !update.date_vente || !Object.keys(body).length) return 0;
        await request(lotsTable, {
          method: 'PATCH',
          query: {
            id: `eq.${update.id}`,
            sale_id: `eq.${update.sale_id}`,
            date_vente: `eq.${update.date_vente}`,
          },
          prefer: 'return=minimal',
          body,
        });
        return 1;
      }));
      saved += results.reduce((sum, value) => sum + value, 0);
    }
    return saved;
  }

  return {
    selectLotsByDate,
    selectPendingDetails,
    selectPendingOcr,
    updateInterencheresLots,
    refreshAnalytics,
    upsertLots,
    upsertSales,
  };
}

export {
  ALCOPA_CATALOG_COLUMNS,
  BASE_LOT_COLUMNS,
  DETAIL_LOT_COLUMNS,
  INTERENCHERES_RESULT_COLUMNS,
  INTERENCHERES_SELECT_COLUMNS,
  createSupabaseStore,
  groupRowsByColumns,
  serializeLot,
};
