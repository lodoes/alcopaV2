import * as cheerio from 'cheerio';

const ALCOPA_HOME_URL = 'https://www.alcopa-auction.fr/';

function cleanText(value = '') {
  return String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function titleFromSlug(slug = '') {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parseHomepageSales(html, baseUrl = ALCOPA_HOME_URL) {
  const $ = cheerio.load(html);
  let links = $('a.sale-access-href[href*="/salle-de-vente-encheres/"]');
  if (!links.length) links = $('a[href*="/salle-de-vente-encheres/"]');

  const bySaleId = new Map();
  links.each((_, element) => {
    const href = $(element).attr('href') || '';
    let url;
    try {
      url = new URL(href, baseUrl);
    } catch {
      return;
    }
    const match = url.pathname.match(/^\/salle-de-vente-encheres\/([^/]+)\/(\d+)\/?$/i);
    if (!match) return;

    const [, slug, saleId] = match;
    const card = $(element).closest('.d-table');
    const cardText = cleanText(card.text());
    const salle = cleanText(card.find('.font-weight-bold.text-prim').first().text()) || titleFromSlug(slug);
    const dateLabel = cleanText(card.find('.float-right.text-nowrap').first().text());
    const title = cleanText(card.find('.text-graynorm.mt-1.pt-1.border-top').first().text());
    const lotsMatch = cardText.match(/([\d\s]+)\s+lots?\b/i);

    bySaleId.set(saleId, {
      sale_id: saleId,
      salle,
      slug: slug.toLowerCase(),
      url: url.href,
      date_label: dateLabel,
      title,
      lots_announced: lotsMatch ? Number(lotsMatch[1].replace(/\D/g, '')) : null,
    });
  });

  return [...bySaleId.values()];
}

function filterSales(sales, roomFilter = '') {
  const wanted = String(roomFilter)
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!wanted.length) return sales;
  return sales.filter((sale) => wanted.includes(sale.slug) || wanted.includes(sale.salle.toLowerCase()));
}

async function discoverHomepageSales(fetchHtml) {
  const response = await fetchHtml(ALCOPA_HOME_URL);
  const ok = !response.challenge && response.status >= 200 && response.status < 300;
  if (!ok) {
    const error = new Error(`La page d'accueil Alcopa a repondu HTTP ${response.status || 0}`);
    error.response = response;
    throw error;
  }
  return {
    sales: parseHomepageSales(response.html, response.finalUrl || ALCOPA_HOME_URL),
    response,
  };
}

export { ALCOPA_HOME_URL, discoverHomepageSales, filterSales, parseHomepageSales };
