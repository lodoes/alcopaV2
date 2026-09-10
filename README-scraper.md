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
| `/scrape?format=csv&url=...` | Meme scrape en CSV |
| `/debug?url=...` | Diagnostic: IP de sortie de l'hebergeur + statut brut renvoye par Alcopa |

## Transport navigateur sur Railway

Le `Dockerfile` installe Chromium et configure automatiquement `SCRAPER_TRANSPORT=browser`. Railway utilise ce fichier grace a la section `build` de `railway.json`.

Le navigateur est reutilise pendant le scraping afin de conserver les cookies. En cas de challenge explicite, le scraper s'arrete et renvoie `blocked: true`; il ne tente pas de resoudre automatiquement un CAPTCHA.

Apres le deploiement, `/health` doit afficher:

```json
{
  "version": "2026-09-10-browser-transport-v1",
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

### HTTP 405 en production

Un `HTTP 405` sur une requete `GET` peut provenir du profil de la requete ou de l'environnement cloud. Appeler `/debug` sur le service deploye et comparer `homepage.status`, `target.status` et `transport`. Si Chromium est egalement refuse, les solutions propres sont un acces autorise par Alcopa ou un fournisseur de collecte gere compatible avec leurs conditions d'utilisation.
