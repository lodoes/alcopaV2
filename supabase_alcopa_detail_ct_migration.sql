alter table public.alcopa_lots
  add column if not exists finition text,
  add column if not exists immatriculation text,
  add column if not exists date_mise_circulation text,
  add column if not exists numero_serie text,
  add column if not exists couleur text,
  add column if not exists tva_recuperable boolean,
  add column if not exists type_vehicule text,
  add column if not exists carrosserie text,
  add column if not exists co2_g_km integer,
  add column if not exists cylindree_cm3 integer,
  add column if not exists caracteristiques jsonb,
  add column if not exists defauts_esthetiques jsonb,
  add column if not exists url_ct text,
  add column if not exists commentaires_brut text,
  add column if not exists informations_brut text,
  add column if not exists notes_annonce text,
  add column if not exists annonce_fetched_at timestamptz,
  add column if not exists detail_error text,
  add column if not exists ct_verdict text,
  add column if not exists ct_defauts_maj jsonb,
  add column if not exists ct_defauts_min jsonb,
  add column if not exists ct_critiques jsonb,
  add column if not exists ct_nb_codes integer,
  add column if not exists ct_defauts_maj_groupes jsonb,
  add column if not exists ct_defauts_min_groupes jsonb,
  add column if not exists ct_texte_brut text,
  add column if not exists ct_ocr_done_at timestamptz,
  add column if not exists ct_source text,
  add column if not exists ct_pages_traitees integer,
  add column if not exists ct_error text;

create index if not exists alcopa_lots_ct_verdict_idx
  on public.alcopa_lots (ct_verdict);

create index if not exists alcopa_lots_annonce_fetched_at_idx
  on public.alcopa_lots (annonce_fetched_at);
