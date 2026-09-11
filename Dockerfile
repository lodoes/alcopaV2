FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV SCRAPER_TRANSPORT=browser
ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV BROWSER_TIMEOUT_MS=45000
ENV BROWSER_SETTLE_MS=750

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      fonts-liberation \
      poppler-utils \
      tesseract-ocr \
      tesseract-ocr-fra \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node \
  combined-cron.mjs \
  cron-all-sales.mjs \
  ct-analysis.mjs \
  homepage-sales.mjs \
  interencheres-cron.mjs \
  interencheres.mjs \
  scrape-alcopa.mjs \
  server.mjs \
  supabase-store.mjs \
  vehicle-details.mjs \
  ./

COPY --chown=node:node analytics/lots-unifies-analytics.html ./analytics/lots-unifies-analytics.html

USER node

EXPOSE 3000

CMD ["node", "server.mjs"]
