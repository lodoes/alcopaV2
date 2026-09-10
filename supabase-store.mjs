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

function serializeLot(lot, includeDetails) {
  const columns = includeDetails
    ? [...ALCOPA_CATALOG_COLUMNS, ...DETAIL_LOT_COLUMNS]
    : ALCOPA_CATALOG_COLUMNS;
  const row = {};
  for (const column of columns) row[column] = lot[column] ?? null;
  row.raw_json = lot;
  return row;
}

function createSupabaseStore(options = {}) {
  const baseUrl = cleanBaseUrl(options.url || process.env.SUPABASE_URL);
  const key = String(
    options.key
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || process.env.SUPABASE_KEY
      || '',
  ).trim();
  const lotsTable = options.lotsTable || process.env.SUPABASE_LOTS_TABLE || 'alcopa_lots';
  const salesTable = options.salesTable || process.env.SUPABASE_SALES_TABLE || 'alcopa_sales';
  const fetchImpl = options.fetch || fetch;
  const batchSize = Math.max(1, Number(options.batchSize || process.env.SUPABASE_BATCH_SIZE || 100));
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

  async function upsertLots(lots, { includeDetails = false } = {}) {
    if (!lots.length) return 0;
    let saved = 0;
    for (const batch of chunks(lots, batchSize)) {
      await request(lotsTable, {
        method: 'POST',
        query: { on_conflict: 'merge_key' },
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: batch.map((lot) => serializeLot(lot, includeDetails)),
      });
      saved += batch.length;
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

  return {
    selectPendingDetails,
    selectPendingOcr,
    upsertLots,
    upsertSales,
  };
}

export {
  ALCOPA_CATALOG_COLUMNS,
  BASE_LOT_COLUMNS,
  DETAIL_LOT_COLUMNS,
  INTERENCHERES_RESULT_COLUMNS,
  createSupabaseStore,
  serializeLot,
};
