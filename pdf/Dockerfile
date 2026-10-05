FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    NODE_USE_ENV_PROXY=1 \
    PUPPETEER_SKIP_DOWNLOAD=true \
    CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-core fonts-noto-color-emoji ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
RUN mkdir -p /exports && chown -R node:node /app /exports

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
