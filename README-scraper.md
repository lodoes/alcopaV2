# Scraper Alcopa V1

V1 sans dependances: Node `fetch`, parsing HTML serveur, pagination `page=N`, export JSON/CSV compatible avec le dashboard et la table Supabase `alcopa_lots`.

## Test rapide

```powershell
node .\scrape-alcopa.mjs --url "https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371" --out alcopa-lyon-12371.json --csv alcopa-lyon-12371.csv --max-pages 3
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

## Reseau et anti-bot

Alcopa est servi par nginx derriere CloudFront. Chaque requete part maintenant avec:

- une session prealable sur `https://www.alcopa-auction.fr/` pour recuperer les cookies `hl` et `PHPSESSID`;
- des headers de navigateur complets (`user-agent` Chrome, `sec-fetch-*`, `accept-language: fr-FR`) et un `referer` chaine de page en page;
- jusqu'a 4 tentatives avec backoff exponentiel sur `403 405 408 425 429 500 502 503 504`, challenge ou erreur reseau, en renouvelant la session entre deux essais.

Si les tentatives echouent, le scraper ne leve plus d'exception: il renvoie les lots deja collectes avec `blocked: true` et un objet `blockReason` (statut, `allow`, `x-amz-cf-pop`, extrait du corps). Il ne tente pas de contourner une protection anti-bot.

### Variables d'environnement

| Variable | Defaut | Role |
| --- | --- | --- |
| `SCRAPER_USER_AGENT` | UA Chrome 140 Windows | Surcharge du user-agent |
| `SCRAPER_MAX_ATTEMPTS` | `4` | Nombre de tentatives par page |
| `DEFAULT_MAX_PAGES` / `MAX_ALLOWED_PAGES` | `30` / `40` | Pagination par defaut et plafond |
| `DEFAULT_DELAY_MS` | `350` | Pause entre pages |

### HTTP 405 en production

Un `HTTP 405` sur une requete `GET` ne vient pas du code: depuis un poste en France, la meme URL repond `200`. C'est CloudFront/le WAF d'Alcopa qui refuse l'IP de sortie de l'hebergeur. Pour confirmer, appeler `/debug` sur le service deploye et comparer `egressIp`, `homepage.status` et `target.status`. Si les deux statuts sont `405` alors qu'ils sont `200` en local, il faut sortir par une IP residentielle francaise (proxy) plutot que modifier le parsing.
