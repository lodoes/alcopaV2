FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV SCRAPER_TRANSPORT=browser
ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV BROWSER_TIMEOUT_MS=45000
ENV BROWSER_SETTLE_MS=750

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node scrape-alcopa.mjs server.mjs ./

USER node

EXPOSE 3000

CMD ["npm", "start"]
