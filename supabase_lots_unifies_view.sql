create or replace view public.lots_unifies
with (security_invoker = true)
as
with source_rows as (
  select
    2 as source_priority,
    'alcopa_lots'::text as source_table,
    to_jsonb(a) as data
  from public.alcopa_lots a

  union all

  select
    1 as source_priority,
    'lots'::text as source_table,
    to_jsonb(l) as data
  from public.lots l
),
normalized as (
  select
    source_priority,
    source_table,
    coalesce(
      nullif(data->>'merge_key', ''),
      nullif(data->>'id', ''),
      nullif(data->>'url_alcopa', ''),
      nullif(data->>'url_interencheres', ''),
      concat_ws('|',
        nullif(data->>'sale_id', ''),
        nullif(lower(data->>'salle'), ''),
        nullif(data->>'date_vente', ''),
        nullif(data->>'lot_number', '')
      )
    ) as unified_key,
    nullif(data->>'id', '') as id,
    nullif(data->>'merge_key', '') as merge_key,
    nullif(data->>'sale_id', '') as sale_id,
    case
      when data->>'lot_number' ~ '^\d+$' then (data->>'lot_number')::integer
      else null
    end as lot_number,
    nullif(data->>'salle', '') as salle,
    nullif(data->>'date_vente', '') as date_vente,
    nullif(data->>'marque', '') as marque,
    nullif(data->>'modele', '') as modele,
    nullif(data->>'description', '') as description,
    nullif(data->>'energie', '') as energie,
    nullif(data->>'annee_mec', '') as annee_mec,
    case
      when data->>'km' ~ '^\d+$' then (data->>'km')::integer
      else null
    end as km,
    nullif(data->>'boite', '') as boite,
    nullif(data->>'lieu_stockage', '') as lieu_stockage,
    case
      when data->>'mise_a_prix' ~ '^\d+(\.\d+)?$' then (data->>'mise_a_prix')::numeric
      else null
    end as mise_a_prix,
    case
      when data->>'enchere_courante' ~ '^\d+(\.\d+)?$' then (data->>'enchere_courante')::numeric
      else null
    end as enchere_courante,
    case
      when data->>'estimation_eur' ~ '^\d+(\.\d+)?$' then (data->>'estimation_eur')::numeric
      else null
    end as estimation_eur,
    case
      when data->>'prix_adjudication_eur' ~ '^\d+(\.\d+)?$' then (data->>'prix_adjudication_eur')::numeric
      else null
    end as prix_adjudication_eur,
    nullif(data->>'statut', '') as statut,
    nullif(data->>'canal', '') as canal,
    nullif(data->>'url_alcopa', '') as url_alcopa,
    nullif(data->>'url_interencheres', '') as url_interencheres,
    nullif(data->>'thumbnail', '') as thumbnail,
    nullif(data->>'alcopa_id', '') as alcopa_id,
    nullif(data->>'lot_interencheres_id', '') as lot_interencheres_id,
    nullif(data->>'url_ct', '') as url_ct,
    nullif(data->>'ct_verdict', '') as ct_verdict,
    data->'ct_defauts_maj' as ct_defauts_maj,
    data->'ct_defauts_min' as ct_defauts_min,
    data->'raw_json' as raw_json,
    data as source_json,
    case
      when data->>'updated_at' ~ '^\d{4}-\d{2}-\d{2}' then (data->>'updated_at')::timestamptz
      when data->>'scraped_at' ~ '^\d{4}-\d{2}-\d{2}' then (data->>'scraped_at')::timestamptz
      else null
    end as source_updated_at
  from source_rows
),
ranked as (
  select
    *,
    row_number() over (
      partition by unified_key
      order by source_priority desc, source_updated_at desc nulls last, id desc nulls last
    ) as rn
  from normalized
  where unified_key is not null and unified_key <> ''
)
select
  unified_key,
  source_table,
  id,
  merge_key,
  sale_id,
  lot_number,
  salle,
  date_vente,
  marque,
  modele,
  description,
  energie,
  annee_mec,
  km,
  boite,
  lieu_stockage,
  mise_a_prix,
  enchere_courante,
  estimation_eur,
  prix_adjudication_eur,
  statut,
  canal,
  url_alcopa,
  url_interencheres,
  thumbnail,
  alcopa_id,
  lot_interencheres_id,
  url_ct,
  ct_verdict,
  ct_defauts_maj,
  ct_defauts_min,
  raw_json,
  source_json,
  source_updated_at
from ranked
where rn = 1;
