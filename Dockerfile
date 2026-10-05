FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    NODE_USE_ENV_PROXY=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/venv

ENV PATH="/opt/venv/bin:${PATH}"

WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY templates ./default-templates
COPY scripts/aggregator-entrypoint.sh /usr/local/bin/aggregator-entrypoint

RUN chmod +x /usr/local/bin/aggregator-entrypoint \
    && mkdir -p /data /templates \
    && chown -R node:node /app /data /templates /opt/venv

USER node
EXPOSE 8080
ENTRYPOINT ["aggregator-entrypoint"]
