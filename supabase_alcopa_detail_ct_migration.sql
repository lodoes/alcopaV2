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
  add column if not exists detail_last_attempt_at timestamptz,
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
  add column if not exists ct_last_attempt_at timestamptz,
  add column if not exists ct_source text,
  add column if not exists ct_pages_traitees integer,
  add column if not exists ct_error text;

-- Une salle peut avoir plusieurs ventes simultanees avec les memes numeros de lot.
-- L'identifiant contient deja le sale_id et devient donc la cle de fusion fiable.
update public.alcopa_lots
set merge_key = id
where merge_key is distinct from id;

create index if not exists alcopa_lots_ct_verdict_idx
  on public.alcopa_lots (ct_verdict);

create index if not exists alcopa_lots_annonce_fetched_at_idx
  on public.alcopa_lots (annonce_fetched_at);

create table if not exists public.alcopa_sales (
  sale_id text primary key,
  salle text not null,
  slug text not null,
  url text not null,
  date_label text,
  title text,
  lots_announced integer,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists alcopa_sales_last_seen_at_idx
  on public.alcopa_sales (last_seen_at desc);

alter table public.alcopa_sales enable row level security;
