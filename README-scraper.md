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

Utiliser un deuxieme service Railway connecte au meme depot GitHub:

1. Executer `supabase_alcopa_detail_ct_migration.sql` dans Supabase.
2. Dans Railway, creer un nouveau service GitHub depuis le meme depot et le nommer `alcopa-cron`.
3. Dans ses Settings, definir le chemin du fichier de configuration sur `/railway-cron.json`.
4. Ajouter `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` dans Variables. Ne jamais mettre la cle service-role dans Git.
5. Ne pas generer de domaine public pour ce service. Il s'execute puis s'arrete.

`railway-cron.json` lance `node cron-all-sales.mjs` tous les jours a `02:15 UTC` et conserve la region Amsterdam. Le service API existant continue d'utiliser `railway.json` et `node server.mjs`. Le lancement direct evite que `npm` transforme un arret normal de Railway en faux message `npm error ... SIGTERM`.

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

Le traitement est incremental: le catalogue est mis a jour, puis Supabase fournit seulement les lots dont `annonce_fetched_at` ou `ct_ocr_done_at` est encore vide. Railway utilise les horaires UTC et ignore un nouveau declenchement si le precedent tourne encore.

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
