import http from 'node:http';
import { readFile } from 'node:fs/promises';
import {
  BASE_URL,
  DEFAULT_URL,
  closeBrowser,
  describeBlock,
  enrichVehicles,
  fetchHtml,
  getTransportName,
  scrape,
  toCsv,
} from './scrape-alcopa.mjs';
import {
  matchInterencheresSales,
  normalizeRoom,
  parseFrenchDate,
} from './interencheres.mjs';
import { buildUpdates, groupLocalSales } from './interencheres-cron.mjs';
import { createSupabaseStore } from './supabase-store.mjs';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const APP_VERSION = '2026-09-11-interencheres-autobutton-v1';
const DEFAULT_MAX_PAGES = Number(process.env.DEFAULT_MAX_PAGES || 30);
const MAX_ALLOWED_PAGES = Number(process.env.MAX_ALLOWED_PAGES || 40);
const DEFAULT_DELAY_MS = Number(process.env.DEFAULT_DELAY_MS || 350);
const DEFAULT_DETAIL_LIMIT = Number(process.env.DEFAULT_DETAIL_LIMIT || 10);
const MAX_DETAIL_LIMIT = Number(process.env.MAX_DETAIL_LIMIT || 500);
const DEFAULT_OCR_LIMIT = Number(process.env.DEFAULT_OCR_LIMIT || 3);
const MAX_OCR_LIMIT = Number(process.env.MAX_OCR_LIMIT || 500);
const DEFAULT_DETAIL_DELAY_MS = Number(process.env.DEFAULT_DETAIL_DELAY_MS || 500);
const MAX_IMPORT_BYTES = Math.max(10_000, Number(process.env.MAX_IMPORT_BYTES || 2_000_000));

function supabaseEnvStatus() {
  const envValue = (name) => {
    if (process.env[name] != null) return process.env[name];
    const found = Object.entries(process.env).find(([key]) => key.trim() === name);
    return found ? found[1] : '';
  };
  const seenKeys = Object.keys(process.env)
    .filter((key) => key.toUpperCase().includes('SUPABASE'))
    .sort();
  const url = String(envValue('SUPABASE_URL') || '').trim();
  const key = String(
    envValue('SUPABASE_SERVICE_ROLE_KEY')
      || envValue('SUPABASE_KEY')
      || '',
  ).trim();
  return {
    urlConfigured: Boolean(url),
    serviceRoleKeyConfigured: Boolean(envValue('SUPABASE_SERVICE_ROLE_KEY')),
    fallbackKeyConfigured: Boolean(envValue('SUPABASE_KEY')),
    usable: Boolean(url && key),
    seenKeys,
  };
}

function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  const payload = isBuffer || typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-import-token',
    'cache-control': 'no-store',
    'content-type': isBuffer ? 'application/octet-stream' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(payload);
}

async function sendHtmlFile(res, filePath) {
  const html = await readFile(filePath, 'utf8');
  send(res, 200, html, {
    'content-type': 'text/html; charset=utf-8',
  });
}

function interencheresTodayPage() {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Interencheres du jour</title>
<style>
:root{--bg:#0f0e0d;--surface:#171614;--surface2:#1f1d1a;--line:rgba(255,240,220,.1);--text:#f3eee7;--muted:#8f8379;--accent:#e8a44a;--green:#4ade80;--blue:#60a5fa;--red:#f87171}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:18px 14px 28px}.top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:16px}
h1{margin:0;font-size:24px;line-height:1.1}.date{color:var(--muted);font-size:13px;margin-top:5px}.badge{border:1px solid var(--line);border-radius:999px;background:var(--surface2);color:var(--accent);padding:7px 10px;font-size:12px;font-weight:800;white-space:nowrap}
.section{border:1px solid var(--line);border-radius:14px;background:var(--surface);padding:13px;margin-bottom:13px}.section h2{margin:0 0 10px;font-size:13px;color:var(--muted);letter-spacing:.08em;text-transform:uppercase}
.grid{display:grid;gap:9px}.row{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:stretch}.salle{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:56px;border:1px solid var(--line);border-radius:10px;background:var(--surface2);color:var(--text);padding:10px 12px;text-decoration:none}
.salle.today{border-color:rgba(74,222,128,.38);box-shadow:0 0 0 1px rgba(74,222,128,.12) inset}.name{font-size:17px;font-weight:850}.day{display:block;margin-top:3px;color:var(--muted);font-size:12px}.hint{color:var(--muted);font-size:12px;line-height:1.45;margin-top:10px}
.open{min-width:48px;border:1px solid var(--line);border-radius:10px;background:var(--accent);color:#171614;font-size:18px;font-weight:900;text-decoration:none;display:grid;place-items:center}.open:active,.salle:active{transform:translateY(1px)}
.empty{border:1px dashed var(--line);border-radius:10px;padding:18px;color:var(--muted);text-align:center}.tools{display:grid;grid-template-columns:1fr 1fr;gap:8px}.btn{min-height:42px;border:1px solid var(--line);border-radius:10px;background:var(--surface2);color:var(--text);font-weight:800;text-decoration:none;display:grid;place-items:center;text-align:center}.btn.primary{background:var(--accent);color:#171614;border-color:var(--accent)}
.toast{position:fixed;left:12px;right:12px;bottom:14px;border:1px solid rgba(74,222,128,.3);border-radius:10px;background:#102017;color:var(--green);padding:11px 12px;text-align:center;font-weight:800}
@media(min-width:640px){.grid.all{grid-template-columns:1fr 1fr}.wrap{padding-top:28px}.row.full{grid-column:span 2}}
</style>
</head>
<body>
<main class="wrap">
  <header class="top">
    <div>
      <h1>Interencheres</h1>
      <div class="date" id="date-label">Chargement...</div>
    </div>
    <div class="badge" id="today-badge">Aujourd'hui</div>
  </header>

  <section class="section">
    <h2>Ventes a faire aujourd'hui</h2>
    <div class="grid" id="today-list"></div>
    <div class="hint">Ouvre la salle, attends la liste des lots, puis lance ton bookmarklet Chrome Android.</div>
  </section>

  <section class="section">
    <h2>Outils</h2>
    <div class="tools">
      <a class="btn primary" href="/interencheres/autoscript.user.js">Installer bouton</a>
      <button class="btn" type="button" id="refresh-day">Recalculer</button>
    </div>
    <div class="hint">Avec Kiwi Browser + Tampermonkey : installe une fois, puis un bouton Import IE apparait directement sur Interencheres.</div>
  </section>

  <section class="section">
    <h2>Toutes les salles</h2>
    <div class="grid all" id="all-list"></div>
  </section>
</main>
<script>
const rooms=[
  {name:'Beauvais',day:1,label:'lundi',url:'https://www.interencheres.com/commissaire-priseur/et-alcopa-auction-beauvais-508/'},
  {name:'Paris Sud',day:1,label:'lundi',url:'https://www.interencheres.com/commissaire-priseur/et-alcopa-auction-paris-sud-131/'},
  {name:'Rennes',day:1,label:'lundi',url:'https://www.interencheres.com/commissaire-priseur/et-alcopa-auction-rennes-145/'},
  {name:'Tours',day:5,label:'vendredi',url:'https://www.interencheres.com/commissaire-priseur/et-alcopa-auction-tours-219/'},
  {name:'Nancy',day:3,label:'mercredi',url:'https://www.interencheres.com/commissaire-priseur/et-alcopa-auction-nancy-420/'},
  {name:'Marseille',day:5,label:'vendredi',url:'https://www.interencheres.com/commissaire-priseur/et-alcopa-auction-marseille-443/'},
  {name:'Lyon',day:4,label:'jeudi',url:'https://www.interencheres.com/commissaire-priseur/et-alcopa-auction-lyon-509/'}
];
function frDate(d){return new Intl.DateTimeFormat('fr-FR',{weekday:'long',day:'2-digit',month:'long',year:'numeric'}).format(d)}
function renderRoom(room,today){
  const cls=today?'salle today':'salle';
  const href=room.url+'?alcopaImport=1';
  return '<div class="row'+(room.name==='Lyon'?' full':'')+'"><a class="'+cls+'" href="'+href+'"><span><span class="name">'+room.name+'</span><span class="day">'+room.label+'</span></span><span>'+ (today?'A faire':'Ouvrir') +'</span></a><a class="open" href="'+href+'" aria-label="Ouvrir '+room.name+'">›</a></div>';
}
function render(){
  const now=new Date();
  const day=now.getDay();
  document.getElementById('date-label').textContent=frDate(now);
  const today=rooms.filter(r=>r.day===day);
  document.getElementById('today-badge').textContent=today.length?today.length+' salle'+(today.length>1?'s':''):'Aucune';
  document.getElementById('today-list').innerHTML=today.length?today.map(r=>renderRoom(r,true)).join(''):'<div class="empty">Aucune salle reguliere aujourd\\'hui. Regarde la liste complete si Alcopa a une vente exceptionnelle.</div>';
  document.getElementById('all-list').innerHTML=rooms.map(r=>renderRoom(r,r.day===day)).join('');
}
document.getElementById('refresh-day').addEventListener('click',render);
function toast(msg){const old=document.querySelector('.toast');if(old)old.remove();const el=document.createElement('div');el.className='toast';el.textContent=msg;document.body.appendChild(el);setTimeout(()=>el.remove(),2400)}
render();
</script>
</body>
</html>`;
}

function interencheresAutoButtonUserScript() {
  return `// ==UserScript==
// @name         Alcopa Interencheres Import Button
// @namespace    https://alcopav2-production.up.railway.app/
// @version      2026-09-11
// @description  Ajoute un bouton Import IE sur les pages Interencheres Alcopa.
// @match        https://www.interencheres.com/*
// @match        https://interencheres.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  const SCRIPT_URL = 'https://alcopav2-production.up.railway.app/interencheres/bookmarklet.js';
  const KEY = 'alcopaIeLastRun:' + location.pathname;

  function isAlcopaPage() {
    const path = location.pathname.toLowerCase();
    const body = (document.body && document.body.innerText || '').toLowerCase();
    return path.includes('alcopa') || body.includes('alcopa auction');
  }

  function toast(message, tone) {
    const old = document.getElementById('alcopa-ie-toast');
    if (old) old.remove();
    const box = document.createElement('div');
    box.id = 'alcopa-ie-toast';
    box.textContent = message;
    box.style.cssText = [
      'position:fixed',
      'left:14px',
      'right:14px',
      'bottom:86px',
      'z-index:2147483647',
      'padding:12px 14px',
      'border-radius:12px',
      'font:700 14px system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
      'text-align:center',
      'color:' + (tone === 'error' ? '#fecaca' : '#dcfce7'),
      'background:' + (tone === 'error' ? '#450a0a' : '#052e16'),
      'box-shadow:0 14px 40px rgba(0,0,0,.35)'
    ].join(';');
    document.body.appendChild(box);
    setTimeout(() => box.remove(), 2400);
  }

  function runImport() {
    if (document.querySelector('script[data-alcopa-ie-bookmarklet]')) {
      toast('Import deja lance sur cette page');
      return;
    }
    sessionStorage.setItem(KEY, String(Date.now()));
    const script = document.createElement('script');
    script.src = SCRIPT_URL + '?t=' + Date.now();
    script.dataset.alcopaIeBookmarklet = '1';
    script.onload = () => toast('Import IE lance');
    script.onerror = () => toast('Impossible de charger le script', 'error');
    document.body.appendChild(script);
  }

  function addButton() {
    if (!document.body || document.getElementById('alcopa-ie-import-btn')) return;
    if (!isAlcopaPage()) return;
    const button = document.createElement('button');
    button.id = 'alcopa-ie-import-btn';
    button.type = 'button';
    button.textContent = 'Import IE';
    button.style.cssText = [
      'position:fixed',
      'right:14px',
      'bottom:22px',
      'z-index:2147483647',
      'min-width:118px',
      'height:52px',
      'border:0',
      'border-radius:999px',
      'background:#e8a44a',
      'color:#171614',
      'box-shadow:0 14px 44px rgba(0,0,0,.42)',
      'font:900 15px system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif'
    ].join(';');
    button.addEventListener('click', runImport);
    document.body.appendChild(button);

    const params = new URLSearchParams(location.search);
    if (params.get('alcopaImport') === '1') {
      const last = Number(sessionStorage.getItem(KEY) || 0);
      if (Date.now() - last > 30000) setTimeout(runImport, 1200);
    }
  }

  addButton();
  new MutationObserver(addButton).observe(document.documentElement, { childList: true, subtree: true });
})();`;
}

function readJsonBody(req, maxBytes = MAX_IMPORT_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`Payload trop volumineux (${size} octets)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(new Error(`JSON invalide: ${error.message}`));
      }
    });
  });
}

function cleanText(value = '') {
  return String(value).replace(/\u00a0|\u202f/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeBookmarkletDate(value = '') {
  const parsed = parseFrenchDate(value);
  if (parsed) return parsed;
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}

function normalizeImportedLots(items, pageUrl) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    lot_number: Number(item.lot_number),
    salle: cleanText(item.salle || ''),
    date_vente: cleanText(item.date_vente || ''),
    lot_interencheres_id: String(item.lot_interencheres_id || '').trim() || null,
    description: cleanText(item.description || item.marque || ''),
    prix_adjudication_eur: Number.isFinite(Number(item.prix_adjudication_eur))
      ? Number(item.prix_adjudication_eur)
      : null,
    statut: cleanText(item.statut || 'inconnu'),
    canal: cleanText(item.canal || '') || null,
    url_interencheres: cleanText(item.url_interencheres || pageUrl || ''),
  })).filter((lot) => Number.isFinite(lot.lot_number));
}

async function handleInterencheresImport(req, res) {
  const body = await readJsonBody(req);
  const expectedToken = String(process.env.IE_IMPORT_TOKEN || '').trim();
  const providedToken = String(req.headers['x-import-token'] || body.token || '').trim();
  if (expectedToken && providedToken !== expectedToken) {
    send(res, 401, { ok: false, error: 'Token import Interencheres invalide.' });
    return;
  }

  const lots = normalizeImportedLots(body.lots || body.items || body.data, body.pageUrl);
  if (!lots.length) {
    send(res, 400, { ok: false, error: 'Aucun lot Interencheres valide dans le payload.' });
    return;
  }

  const saleDate = normalizeBookmarkletDate(body.date_vente || body.dateVente || lots[0]?.date_vente);
  const room = normalizeRoom(body.salle || body.room || lots[0]?.salle || '');
  if (!room) {
    send(res, 400, { ok: false, error: 'Salle Interencheres introuvable dans le payload.' });
    return;
  }

  const store = createSupabaseStore();
  if (!store) {
    send(res, 500, {
      ok: false,
      error: 'Configure SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY sur le service API Railway, puis redeploy.',
      supabase: supabaseEnvStatus(),
    });
    return;
  }

  const localLots = await store.selectLotsByDate(saleDate);
  const localSales = groupLocalSales(localLots)
    .filter((sale) => normalizeRoom(sale.salle) === room);
  const ieSale = {
    url: cleanText(body.pageUrl || ''),
    metadata: {
      event_id: String(body.saleId || body.sale_id || ''),
      room,
      date: saleDate,
    },
    lots,
  };
  const matches = matchInterencheresSales(localSales, [ieSale]);
  const { updates, stats } = buildUpdates(matches);
  const saved = await store.updateInterencheresLots(updates);
  let analyticsRows = null;
  let analyticsRefreshError = null;
  if (saved > 0) {
    try {
      analyticsRows = await store.refreshAnalytics();
    } catch (error) {
      analyticsRefreshError = error.message;
    }
  }

  send(res, 200, {
    ok: matches.length > 0,
    source: body.source || 'bookmarklet',
    room,
    saleDate,
    importedLots: lots.length,
    localSales: localSales.length,
    matchedSales: matches.length,
    updates: updates.length,
    saved,
    analyticsRows,
    analyticsRefreshError,
    ...stats,
  });
}

function interencheresBookmarkletScript() {
  return String.raw`(async () => {
  const currentScript = document.currentScript;
  const apiBase = currentScript ? new URL(currentScript.src).origin : '';
  const apiUrl = apiBase + '/interencheres/import';
  const token = currentScript ? new URL(currentScript.src).searchParams.get('token') || '' : '';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (element) => (element?.textContent || '').replace(/\s+/g, ' ').trim();
  const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const euro = (value) => {
    const match = String(value || '').match(/(\d[\d\s\u202f\u00a0]*)\s*€/);
    return match ? Number(match[1].replace(/[^\d]/g, '')) : null;
  };
  const context = (() => {
    let saleId = '';
    let salle = '';
    const saleMatch = location.href.match(/alcopa-auction-([\w-]+)-(\d+)/i);
    if (saleMatch) {
      salle = saleMatch[1].replace(/-/g, ' ');
      saleId = saleMatch[2];
    }
    if (!saleId) {
      const idMatch = location.href.match(/-(\d{5,})(?:[/?#]|$)/);
      if (idMatch) saleId = idMatch[1];
    }
    const houseLink = document.querySelector('a[href*="commissaire-priseur/alcopa-auction"]');
    if (!salle && houseLink) {
      const roomMatch = houseLink.href.match(/alcopa-auction-([\w-]+)-\d+/i);
      if (roomMatch) salle = roomMatch[1].replace(/-/g, ' ');
    }
    const bodyMatch = document.body.innerText.match(/ALCOPA\s+AUCTION\s+([A-Z\s-]+)/i);
    if (!salle && bodyMatch) salle = bodyMatch[1].trim().toLowerCase();
    return { saleId: saleId || 'unknown', salle };
  })();
  const now = new Date();
  const dateVente = String(now.getDate()).padStart(2, '0') + '/'
    + String(now.getMonth() + 1).padStart(2, '0') + '/'
    + now.getFullYear();
  function parseLot(card) {
    let lotNumber = Number.parseInt(text(card.querySelector('.text-body-2.font-italic span,[class*=font-italic].text-body-2 span')), 10);
    if (!lotNumber) {
      const match = text(card).match(/\bLot\s+(\d+)\b/i);
      if (match) lotNumber = Number.parseInt(match[1], 10);
    }
    if (!lotNumber) return null;
    const title = text(card.querySelector('[class*="min-h-44"] > div'));
    const bidText = text(card.querySelector('.item-card-bid-info'));
    const allText = text(card).toLowerCase();
    let statut = 'inconnu';
    let price = null;
    if (/adjug/.test(allText)) {
      statut = 'adjuge';
      price = euro(bidText || allText);
    } else if (/invendu|non adjug/.test(allText)) {
      statut = 'invendu';
    } else if (/retir/.test(allText)) {
      statut = 'retire';
    } else if (/estimation|ench/.test(allText)) {
      statut = 'en_cours';
    }
    const canal = /en salle/.test(allText)
      ? 'salle'
      : /interencheres|internet|en ligne/.test(allText)
        ? 'internet'
        : '';
    const href = card.href || '';
    const lotId = (href.match(/lot-(\d+)\.html/i) || [])[1] || card.id || '';
    return {
      lot_number: lotNumber,
      lot_interencheres_id: lotId,
      sale_id: context.saleId,
      salle: context.salle,
      date_vente: dateVente,
      description: title,
      prix_adjudication_eur: price,
      statut,
      canal,
      url_interencheres: href.split('?')[0],
      scraped_at: new Date().toISOString(),
    };
  }
  function saleBaseUrl() {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/lot-\d+\.html$/i, '').replace(/\/$/, '');
    return url.href;
  }
  function itemUrl(itemId) {
    return saleBaseUrl() + '/lot-' + itemId + '.html';
  }
  function parseApiItem(item) {
    const itemId = Number(item?.id);
    const lotNumber = Number(item?.meta?.order_number?.primary);
    if (!Number.isFinite(itemId) || !Number.isFinite(lotNumber)) return null;
    const auctioned = item?.pricing?.auctioned || {};
    let statut = 'inconnu';
    let price = null;
    if (item?.states?.suppressed === true) {
      statut = 'retire';
    } else if (auctioned.sold === true) {
      statut = 'adjuge';
      const value = Number(auctioned.price);
      price = Number.isFinite(value) ? value : null;
    } else if (auctioned.sold === false) {
      statut = 'invendu';
    } else if (item?.states?.ended === false || item?.states?.closed === false) {
      statut = 'en_cours';
    }
    const auctionType = normalize((auctioned.type || '') + ' ' + (auctioned.site || ''));
    const canal = /live|online|interencheres/.test(auctionType)
      ? 'internet'
      : /physical|salle/.test(auctionType)
        ? 'salle'
        : '';
    return {
      lot_number: lotNumber,
      lot_interencheres_id: String(itemId),
      sale_id: context.saleId,
      salle: context.salle,
      date_vente: dateVente,
      description: text({ textContent: item?.title_translations?.['fr-FR'] || item?.title_translations?.['en-US'] || item?.description || '' }),
      prix_adjudication_eur: price,
      statut,
      canal,
      url_interencheres: itemUrl(itemId),
      scraped_at: new Date().toISOString(),
    };
  }
  async function fetchApiLots() {
    if (!/^\d+$/.test(context.saleId)) throw new Error('ID vente Interencheres introuvable pour API.');
    const pageSize = 200;
    const maxPages = 20;
    const lots = [];
    for (let page = 0; page < maxPages; page += 1) {
      const start = page * pageSize;
      const end = start + pageSize - 1;
      box.textContent = 'API Interencheres ' + start + '-' + end;
      const url = 'https://search.interencheres.com/v1/search/ie4_items?filters%5Bsale%5D=' + encodeURIComponent(context.saleId);
      const response = await fetch(url, {
        credentials: 'include',
        headers: {
          accept: 'application/json, text/plain, */*',
          'x-range': 'items=' + start + '-' + end,
          'x-requested-with': 'XMLHttpRequest',
        },
      });
      const raw = await response.text();
      if (!response.ok) throw new Error('API Interencheres HTTP ' + response.status + ': ' + raw.slice(0, 160));
      const payload = JSON.parse(raw);
      if (!Array.isArray(payload)) throw new Error('Reponse API Interencheres invalide.');
      lots.push(...payload.map(parseApiItem).filter(Boolean));
      if (payload.length < pageSize) break;
      await sleep(250);
    }
    return lots;
  }
  function scrapePage() {
    return [...document.querySelectorAll('a[href*="/lot-"][id],a[href*="/lot-"]')]
      .map(parseLot)
      .filter(Boolean);
  }
  function totalPages() {
    return Math.max(1, ...[...document.querySelectorAll('.v-pagination__item,button.v-pagination__item')]
      .map((item) => Number.parseInt(text(item), 10))
      .filter(Boolean));
  }
  function nextButton() {
    const explicitNext = [...document.querySelectorAll('button[aria-label*="suiv" i],button[aria-label*="next" i]')]
      .find((button) => !button.disabled && !button.classList.contains('v-pagination__navigation--disabled'));
    if (explicitNext) return explicitNext;
    const navs = [...document.querySelectorAll('.v-pagination__navigation, .v-pagination li button')];
    for (let index = navs.length - 1; index >= 0; index -= 1) {
      const button = navs[index];
      if (!button.disabled && !button.classList.contains('v-pagination__navigation--disabled')) return button;
    }
    return null;
  }
  async function waitForChange(previousKey) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 8000) {
      const first = document.querySelector('a[href*="/lot-"][id],a[href*="/lot-"]');
      const key = first ? first.id || first.href : '';
      if (key && key !== previousKey) return true;
      await sleep(300);
    }
    return false;
  }
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:14px 22px;border-radius:8px;background:#1d4ed8;color:white;font:600 14px sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35)';
  document.body.appendChild(box);
  try {
    let lots = [];
    let source = 'api';
    try {
      lots = await fetchApiLots();
    } catch (apiError) {
      source = 'dom';
      box.textContent = 'API KO, fallback DOM...';
      await sleep(900);
      const pages = totalPages();
      for (let page = 1; page <= pages; page += 1) {
        box.textContent = 'Import IE page ' + page + '/' + pages;
        lots = lots.concat(scrapePage());
        if (page >= pages) break;
        const first = document.querySelector('a[href*="/lot-"][id],a[href*="/lot-"]');
        const previousKey = first ? first.id || first.href : '';
        const button = nextButton();
        if (!button) break;
        button.click();
        await waitForChange(previousKey);
        await sleep(600);
      }
    }
    const unique = Object.values(Object.fromEntries(
      lots.map((lot) => [lot.lot_number + '-' + lot.lot_interencheres_id, lot]),
    ));
    if (!unique.length) throw new Error('Aucun lot trouve sur cette page Interencheres.');
    box.textContent = 'Envoi ' + unique.length + ' lots...';
    const headers = { 'content-type': 'application/json' };
    if (token) headers['x-import-token'] = token;
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source: 'bookmarklet-android-' + source,
        pageUrl: location.href,
        saleId: context.saleId,
        salle: context.salle,
        date_vente: dateVente,
        lots: unique,
      }),
    });
    const resultText = await response.text();
    box.style.background = response.ok ? '#059669' : '#dc2626';
    box.textContent = response.ok ? 'Import OK: ' + unique.length + ' lots' : 'Erreur import ' + response.status;
    alert(resultText.slice(0, 1200));
  } catch (error) {
    box.style.background = '#dc2626';
    box.textContent = 'Erreur: ' + error.message;
    alert(error.message);
  }
  setTimeout(() => box.remove(), 10000);
})();`;
}

function parsePositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|oui|on)$/i.test(String(value));
}

function isAllowedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'www.alcopa-auction.fr';
  } catch {
    return false;
  }
}

function normalizeTargetUrl(value) {
  const cleaned = String(value || '').trim().replace(/\\&/g, '&');
  const alcopaUrl = cleaned.match(/https:\/\/www\.alcopa-auction\.fr\/[^\s\])"'<>]+/i);
  return alcopaUrl ? alcopaUrl[0] : cleaned;
}

async function handleScrape(req, res, url) {
  const targetUrl = normalizeTargetUrl(url.searchParams.get('url') || DEFAULT_URL);
  if (!isAllowedUrl(targetUrl)) {
    send(res, 400, {
      ok: false,
      error: 'URL invalide. Utilise une URL brute https://www.alcopa-auction.fr/... sans crochets Markdown.',
    });
    return;
  }

  const maxPages = Math.min(
    parsePositiveInt(url.searchParams.get('maxPages') || url.searchParams.get('max-pages'), DEFAULT_MAX_PAGES),
    MAX_ALLOWED_PAGES,
  );
  const delayMs = parsePositiveInt(url.searchParams.get('delayMs') || url.searchParams.get('delay-ms'), DEFAULT_DELAY_MS);
  const format = (url.searchParams.get('format') || 'json').toLowerCase();
  const ocr = parseBoolean(url.searchParams.get('ocr'));
  const details = ocr || parseBoolean(url.searchParams.get('details'));
  const detailLimit = Math.min(
    parsePositiveInt(url.searchParams.get('detailLimit') || url.searchParams.get('detail-limit'), DEFAULT_DETAIL_LIMIT),
    MAX_DETAIL_LIMIT,
  );
  const ocrLimit = Math.min(
    parsePositiveInt(url.searchParams.get('ocrLimit') || url.searchParams.get('ocr-limit'), DEFAULT_OCR_LIMIT),
    MAX_OCR_LIMIT,
  );
  const detailDelayMs = parsePositiveInt(
    url.searchParams.get('detailDelayMs') || url.searchParams.get('detail-delay-ms'),
    DEFAULT_DETAIL_DELAY_MS,
  );

  const startedAt = Date.now();
  const result = await scrape({
    url: targetUrl,
    maxPages,
    delayMs,
    out: '',
    csv: '',
    html: '',
    verbose: false,
    details,
    ocr,
    detailLimit,
    ocrLimit,
    detailDelayMs,
  });

  if (format === 'csv') {
    send(res, 200, toCsv(result.lots), {
      'content-disposition': 'attachment; filename="alcopa-lots.csv"',
      'content-type': 'text/csv; charset=utf-8',
    });
    return;
  }

  send(res, result.blocked ? 502 : 200, {
    ok: !result.blocked,
    transport: getTransportName(),
    url: targetUrl,
    lots: result.lots.length,
    pages: result.pagesSeen,
    expectedPages: result.expectedPages,
    durationMs: Date.now() - startedAt,
    error: result.blocked ? `Alcopa a refuse la requete (HTTP ${result.blockReason?.status ?? '?'}) depuis cet hebergeur` : null,
    blockReason: result.blockReason,
    enrichment: result.enrichment,
    data: result.lots,
  });
}

async function handleVehicle(res, url) {
  const targetUrl = normalizeTargetUrl(url.searchParams.get('url') || '');
  if (!isAllowedUrl(targetUrl) || !/\/(?:voiture|utilitaire)-occasion\//i.test(new URL(targetUrl).pathname)) {
    send(res, 400, { ok: false, error: 'URL de fiche vehicule Alcopa invalide.' });
    return;
  }

  const ocr = parseBoolean(url.searchParams.get('ocr'));
  const startedAt = Date.now();
  const result = await enrichVehicles([{ id: 'vehicle', url_alcopa: targetUrl }], {
    detailLimit: 1,
    ocr,
    ocrLimit: 1,
    detailDelayMs: 0,
    referer: `${BASE_URL}/`,
  });
  const vehicle = result.lots[0];
  const ok = !result.stats.blocked && !vehicle.detail_error && !vehicle.ct_error;
  const status = result.stats.blocked ? 502 : ok ? 200 : 500;
  send(res, status, {
    ok,
    transport: getTransportName(),
    durationMs: Date.now() - startedAt,
    enrichment: result.stats,
    data: vehicle,
  });
}

async function egressIp() {
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    return body.ip || null;
  } catch {
    return null;
  }
}

async function handleDebug(res, url) {
  const targetUrl = normalizeTargetUrl(url.searchParams.get('url') || DEFAULT_URL);
  if (!isAllowedUrl(targetUrl)) {
    send(res, 400, { ok: false, error: 'URL invalide.' });
    return;
  }

  const [ip, home, target] = await Promise.all([
    egressIp(),
    fetchHtml(`${BASE_URL}/`).catch((error) => ({ status: 0, networkError: error.message, headers: {}, html: '' })),
    fetchHtml(targetUrl).catch((error) => ({ status: 0, networkError: error.message, headers: {}, html: '' })),
  ]);

  send(res, 200, {
    ok: true,
    version: APP_VERSION,
    transport: getTransportName(),
    egressIp: ip,
    nodeVersion: process.version,
    homepage: describeBlock(`${BASE_URL}/`, home),
    target: describeBlock(targetUrl, target),
  });
}

async function handleProbe(res, url) {
  const targetUrl = normalizeTargetUrl(url.searchParams.get('url') || DEFAULT_URL);
  if (!isAllowedUrl(targetUrl)) {
    send(res, 400, { ok: false, error: 'URL invalide.' });
    return;
  }
  const startedAt = Date.now();
  const response = await fetchHtml(targetUrl).catch((error) => ({
    status: 0,
    finalUrl: targetUrl,
    headers: {},
    html: '',
    networkError: error.message,
  }));
  const ok = !response.challenge && response.status >= 200 && response.status < 300;
  send(res, ok ? 200 : 502, {
    ok,
    transport: getTransportName(),
    durationMs: Date.now() - startedAt,
    probe: describeBlock(targetUrl, response),
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'OPTIONS') {
      send(res, 204, '');
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      send(res, 200, {
        ok: true,
        service: 'alcopa-scraper',
        version: APP_VERSION,
        transport: getTransportName(),
        railwayRegion: process.env.RAILWAY_REPLICA_REGION || null,
        supabase: supabaseEnvStatus(),
        endpoints: {
          analytics: '/analytics/lots-unifies',
          interencheresToday: '/interencheres/today',
          interencheresAutoButton: '/interencheres/autoscript.user.js',
          scrape: '/scrape?url=https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371&maxPages=30',
          enriched: '/scrape?url=https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371&maxPages=1&details=1&detailLimit=3&ocr=1&ocrLimit=1',
          vehicle: '/vehicle?url=https://www.alcopa-auction.fr/voiture-occasion/...&ocr=1',
          interencheresImport: 'POST /interencheres/import',
          interencheresBookmarklet: '/interencheres/bookmarklet.js',
          csv: '/scrape?format=csv&url=https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371&maxPages=30',
          probe: '/probe?url=https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371',
          debug: '/debug?url=https://www.alcopa-auction.fr/salle-de-vente-encheres/lyon/12371',
        },
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/interencheres/today') {
      send(res, 200, interencheresTodayPage(), {
        'content-type': 'text/html; charset=utf-8',
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/interencheres/autoscript.user.js') {
      send(res, 200, interencheresAutoButtonUserScript(), {
        'content-type': 'application/javascript; charset=utf-8',
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/analytics/lots-unifies') {
      await sendHtmlFile(res, new URL('./analytics/lots-unifies-analytics.html', import.meta.url));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/scrape') {
      await handleScrape(req, res, url);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/vehicle') {
      await handleVehicle(res, url);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/debug') {
      await handleDebug(res, url);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/interencheres/bookmarklet.js') {
      send(res, 200, interencheresBookmarkletScript(), {
        'content-type': 'application/javascript; charset=utf-8',
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/probe') {
      await handleProbe(res, url);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/interencheres/import') {
      await handleInterencheresImport(req, res);
      return;
    }

    send(res, 404, { ok: false, error: 'Route inconnue' });
  } catch (error) {
    send(res, 500, {
      ok: false,
      error: error.message,
      status: error.status || null,
      url: error.url || null,
      finalUrl: error.finalUrl || null,
      upstream: error.headers ? {
        server: error.headers.server || null,
        via: error.headers.via || null,
        cfRay: error.headers['cf-ray'] || null,
        contentType: error.headers['content-type'] || null,
        allow: error.headers.allow || null,
      } : null,
      bodyPreview: error.bodyPreview || null,
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Alcopa scraper API listening on ${HOST}:${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing HTTP server');
  server.close(async () => {
    await closeBrowser();
    process.exit(0);
  });
});
