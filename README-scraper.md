# Scraper Alcopa

Scraper Node avec deux transports: `fetch` direct pour le developpement et Chromium headless pour Railway. Le parseur HTML, la pagination `page=N` et les exports JSON/CSV restent communs aux deux modes.

## Test rapide

```powershell
node .\scrape-alcopa.mjs --url "https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371" --out alcopa-lyon-12371.json --csv alcopa-lyon-12371.csv --max-pages 3
```

Test avec le navigateur installe localement:

```powershell
$env:SCRAPER_TRANSPORT="browser"
node .\scrape-alcopa.mjs --url "https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371" --out alcopa-browser.json --max-pages 1
```

## Parse local

```powershell
node .\scrape-alcopa.mjs --html .\alcopa-sample-lyon-12371.html --out sample.json --csv sample.csv
```

## API

| Route | Usage |
| --- | --- |
| `/health` | Version deployee et liste des endpoints |
| `/scrape?url=...&maxPages=30` | Scrape JSON |
| `/scrape?url=...&details=1&detailLimit=3` | Liste + informations des fiches vehicule |
| `/scrape?url=...&details=1&ocr=1&ocrLimit=1` | Liste + fiches + analyse des CT |
| `/vehicle?url=...&ocr=1` | Enrichit et analyse une seule fiche vehicule |
| `/scrape?format=csv&url=...` | Meme scrape en CSV |
| `/probe?url=...` | Teste vraiment Alcopa; renvoie HTTP 502 en cas de blocage |
| `/debug?url=...` | Diagnostic: IP de sortie de l'hebergeur + statut brut renvoye par Alcopa |

## Fiches vehicule et controles techniques

Test rapide sur trois fiches, dont un seul CT analyse:

```text
/scrape?url=https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371&maxPages=1&details=1&detailLimit=3&ocr=1&ocrLimit=1
```

Pour une seule voiture:

```text
/vehicle?url=https://www.alcopa-auction.fr/voiture-occasion/peugeot/308-societe-bluehdi-130ch-s-s-bvm6-active-pack-1109200&ocr=1
```

Le resultat reprend les champs du projet local: `url_ct`, `commentaires_brut`, `informations_brut`, `notes_annonce`, `ct_verdict`, les defauts majeurs/mineurs/critiques groupes par categorie et `ct_texte_brut`. Il ajoute les caracteristiques de la fiche (`finition`, immatriculation, VIN, couleur, TVA, carrosserie, CO2, cylindree) et les defauts esthetiques avec leurs photos.

Le moteur essaie d'abord `pdftotext`. Il lance `pdftoppm` puis Tesseract en francais uniquement pour un PDF scanne. Le `Dockerfile` installe ces trois outils pour Railway.

Pour enrichir toute une vente en ligne de commande:

```powershell
$env:SCRAPER_TRANSPORT="browser"
node .\scrape-alcopa.mjs --url "https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371" --out alcopa-enrichi.json --csv alcopa-enrichi.csv --max-pages 30 --details --ocr --detail-limit 0 --ocr-limit 0 --detail-delay-ms 500
```

Une vente complete avec OCR peut durer longtemps. Depuis une interface web, appeler `/vehicle` sequentiellement est plus robuste qu'une seule grosse requete HTTP. Pour stocker les nouveaux champs dans Supabase, executer une fois `supabase_alcopa_detail_ct_migration.sql` dans l'editeur SQL.

## Cron de toutes les salles

Le cron ne contient aucun ID de vente en dur. A chaque lancement, il ouvre la home Alcopa, recupere tous les liens `Voir la liste`, puis traite chaque `sale_id`. Deux ventes de la meme salle, comme une vente classique et une vente camping-cars a Marseille, restent donc deux ventes distinctes.

Utiliser un deuxieme service Railway connecte au meme depot GitHub. Aucun troisieme service n est necessaire: ce cron execute Alcopa la nuit et Interencheres le soir.

1. Executer `supabase_alcopa_detail_ct_migration.sql` dans Supabase.
2. Dans Railway, creer un nouveau service GitHub depuis le meme depot et le nommer `alcopa-cron`.
3. Dans ses Settings, definir le chemin du fichier de configuration sur `/railway-cron.json`.
4. Ajouter `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` dans Variables. Ne jamais mettre la cle service-role dans Git.
5. Ne pas generer de domaine public pour ce service. Il s'execute puis s'arrete.

`railway-cron.json` lance `node combined-cron.mjs` a `02:15`, `16:15`, `17:15` et `18:15 UTC`, tout en conservant la region Amsterdam. Le passage de `02:15 UTC` lance Alcopa; les trois passages du soir lancent Interencheres. Le service API existant continue d'utiliser `railway.json` et `node server.mjs`. Le lancement direct evite que `npm` transforme un arret normal de Railway en faux message `npm error ... SIGTERM`.

Premier lancement recommande:

```text
CRON_DISCOVERY_ONLY=true
```

Le log `sales_discovered` permet de verifier les salles et ventes trouvees sans scraper les catalogues. Remettre ensuite cette variable a `false`.

Variables principales du cron:

| Variable | Defaut | Role |
| --- | --- | --- |
| `CRON_SALLES` | vide | Filtre optionnel, ex. `lyon,marseille,paris-sud` |
| `CRON_VEHICLES_ONLY` | `true` | Ignore les ventes explicitement motos/scooters/cyclos |
| `CRON_MAX_PAGES_PER_SALE` | `60` | Plafond de pages par vente |
| `CRON_DETAILS` | `true` | Enrichit les fiches encore absentes de Supabase |
| `CRON_DETAIL_LIMIT_PER_SALE` | `25` | Nombre de nouvelles fiches par vente et par passage |
| `CRON_OCR` | `false` | Active l'analyse CT |
| `CRON_OCR_LIMIT_PER_SALE` | `10` | Nombre de CT par vente et par passage |
| `CRON_MAX_RUNTIME_MINUTES` | `240` | Arrete proprement entre deux etapes quand la duree est atteinte |
| `CRON_MAX_SALES` | `0` | Limite de test; `0` traite toutes les ventes trouvees |
| `COMBINED_CRON_JOB` | `auto` | Force `alcopa` ou `interencheres` pour un lancement manuel; remettre ensuite sur `auto` |

Le traitement est incremental: le catalogue est mis a jour, puis Supabase fournit seulement les lots dont `annonce_fetched_at` ou `ct_ocr_done_at` est encore vide. Un champ absent d une page Alcopa ulterieure est omis de l upsert afin de ne pas effacer une valeur deja connue, notamment la mise a prix apres la vente. Railway utilise les horaires UTC et ignore un nouveau declenchement si le precedent tourne encore.

## Resultats d adjudication Interencheres

Alcopa reste la source du catalogue, des caracteristiques, des photos et des controles techniques. Les champs de fin de vente viennent d Interencheres: `prix_adjudication_eur`, `statut`, `canal`, `url_interencheres` et `lot_interencheres_id`.

Le dashboard local `analytics/alcopa-analytics.html` contient un bouton `Importer Interencheres`. Apres execution du bookmarklet Interencheres V2 sur la vente terminee, coller son JSON puis analyser les correspondances. La fusion exige la meme salle, la meme date et le meme numero de lot. Les lignes absentes ou ambigues sont ignorees et aucun lot Interencheres incomplet n est cree.

Le `sale_id` contenu dans le JSON Interencheres n est pas le `sale_id` Alcopa et n est donc jamais copie. Les mises a jour Alcopa omettent volontairement les champs appartenant a Interencheres afin qu un cron ulterieur ne supprime pas les prix et statuts deja importes.

### Cron Interencheres

Le fichier `interencheres-cron.mjs` automatise la recuperation du soir. Il lit les lots Alcopa du jour dans Supabase, decouvre les ventes correspondantes sur les pages officielles des maisons ALCOPA, attend leur etat termine, puis utilise l API de recherche Interencheres avec une pagination `x-range` de 200 lots. Si l API est bloquee ou incomplete, le scraper HTML pagine reprend automatiquement. Deux ventes de la meme salle et du meme jour sont distinguees par le recouvrement de leurs numeros de lots.

La fusion ne cree jamais de ligne: elle utilise un `PATCH` filtre par `id`, `sale_id` et `date_vente` sur des lots deja lus dans Supabase. Seuls `prix_adjudication_eur`, `statut`, `canal`, `url_interencheres`, `lot_interencheres_id` et la remise a zero de `enchere_courante` peuvent etre modifies. Une vente incomplete, ambigue ou bloquee ne produit aucune ecriture.

Le meme service `alcopa-cron` et le meme fichier `/railway-cron.json` lancent aussi ce traitement. Ajouter les variables `IE_*` sur ce service, en plus des variables Supabase deja presentes.

Premier test manuel recommande:

1. Definir `COMBINED_CRON_JOB=interencheres`, `IE_DRY_RUN=true`, `IE_FORCE=true` et eventuellement `IE_ROOMS=lyon`.
2. Lancer manuellement le service et verifier `combined_cron_dispatch`, `ie_sales_discovered`, `ie_sale_api_scraped`, `ie_sale_scraped`, `ie_cron_finished` et `combined_cron_finished`.
3. Remettre `COMBINED_CRON_JOB=auto`. Apres validation, remettre aussi `IE_DRY_RUN=false` et `IE_FORCE=false`.

Le planning `15 2,16,17,18 * * *` couvre le changement d heure Europe/Paris. En ete, le passage de `16:15 UTC` correspond a `18:15` a Paris. En hiver, ce premier passage est ignore par la barriere horaire et celui de `17:15 UTC` prend le relais. Les passages suivants sont idempotents et servent de nouvelles tentatives. Railway ignore un declenchement si l execution precedente tourne encore. Le script ne resout pas les CAPTCHA et s arrete explicitement si Cloudflare presente un challenge.

Le fichier `/railway-interencheres-cron.json` reste disponible uniquement si le plan Railway permet plus tard de separer Interencheres dans un troisieme service.

Variables principales:

| Variable | Defaut | Role |
| --- | --- | --- |
| `IE_NOT_BEFORE_HOUR` | `18` | Heure locale Paris avant laquelle le cron quitte sans travailler |
| `IE_ROOMS` | vide | Filtre optionnel, ex. `lyon,marseille` |
| `IE_DRY_RUN` | `false` | Calcule les fusions sans ecrire dans Supabase |
| `IE_FORCE` | `false` | Recontrole aussi les ventes deja terminales |
| `IE_API_ENABLED` | `true` | Utilise l API de lots avant le repli HTML |
| `IE_API_PAGE_SIZE` | `200` | Nombre de lots demandes par appel API |
| `IE_API_MAX_PAGES_PER_SALE` | `10` | Plafond de pages API par vente |
| `IE_MAX_PAGES_PER_SALE` | `60` | Plafond de pages par vente IE |
| `IE_PAGE_DELAY_MS` | `450` | Pause entre pages |
| `IE_MAX_CANDIDATES_PER_ROOM` | `12` | Plafond de ventes inspectees sur une page de maison |
| `IE_WRITE_CONCURRENCY` | `8` | Nombre maximal de PATCH Supabase simultanes |
| `IE_TARGET_DATE` | aujourd hui | Date ISO de reprise manuelle; contourne uniquement la barriere horaire |
| `IE_RUN_ANYTIME` | `false` | Autorise un lancement manuel avant 18 h |

## Transport navigateur sur Railway

Le `Dockerfile` installe Chromium et configure automatiquement `SCRAPER_TRANSPORT=browser`. Railway utilise ce fichier grace a la section `build` de `railway.json`. Une seule replique est placee en EU West (Amsterdam) afin d'heberger le service au plus pres du site francais.

Le navigateur est reutilise pendant le scraping afin de conserver les cookies. En cas de challenge explicite, le scraper s'arrete et renvoie `blocked: true`; il ne tente pas de resoudre automatiquement un CAPTCHA.

Apres le deploiement, `/health` doit afficher:

```json
{
  "version": "2026-09-10-details-ct-ocr-v1",
  "transport": "browser"
}
```

### Variables d'environnement

| Variable | Defaut | Role |
| --- | --- | --- |
| `SCRAPER_TRANSPORT` | `direct` hors Docker, `browser` dans Docker | Selectionne `fetch` ou Chromium |
| `CHROMIUM_EXECUTABLE_PATH` | `/usr/bin/chromium` dans Docker | Chemin du navigateur |
| `BROWSER_TIMEOUT_MS` | `45000` | Delai maximal de navigation |
| `BROWSER_SETTLE_MS` | `750` | Courte attente apres le chargement DOM |
| `SCRAPER_USER_AGENT` | UA Chrome 140 Windows | Surcharge du user-agent |
| `SCRAPER_MAX_ATTEMPTS` | `4` | Nombre de tentatives par page |
| `DEFAULT_MAX_PAGES` / `MAX_ALLOWED_PAGES` | `30` / `40` | Pagination par defaut et plafond |
| `DEFAULT_DELAY_MS` | `350` | Pause entre pages |
| `DEFAULT_DETAIL_LIMIT` / `MAX_DETAIL_LIMIT` | `10` / `500` | Nombre de fiches traitees par appel API |
| `DEFAULT_OCR_LIMIT` / `MAX_OCR_LIMIT` | `3` / `500` | Nombre de CT analyses par appel API |
| `DEFAULT_DETAIL_DELAY_MS` | `500` | Pause entre les fiches |
| `MAX_BINARY_BYTES` | `30000000` | Taille maximale acceptee pour un CT |
| `PDFTOTEXT_BIN`, `PDFTOPPM_BIN`, `TESSERACT_BIN` | commandes du PATH | Executables PDF/OCR |
| `CT_MAX_PAGES` / `CT_OCR_DPI` | `4` / `200` | Limites de lecture du CT |

### HTTP 405 en production

Un `HTTP 405` sur une requete `GET` peut provenir du profil de la requete ou de l'environnement cloud. Appeler `/debug` sur le service deploye et comparer `homepage.status`, `target.status` et `transport`. Si Chromium est egalement refuse, les solutions propres sont un acces autorise par Alcopa ou un fournisseur de collecte gere compatible avec leurs conditions d'utilisation.
