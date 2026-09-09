FROM node:22-bookworm-slim AS atproto-dependencies
WORKDIR /bridge
COPY atproto_bridge/package.json atproto_bridge/package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund

FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8000
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY --from=atproto-dependencies /usr/local/bin/node /usr/local/bin/node
COPY requirements.lock.txt requirements.txt ./
RUN pip install --no-cache-dir -r requirements.lock.txt
COPY . .
COPY --from=atproto-dependencies /bridge/node_modules /app/atproto_bridge/node_modules
RUN useradd --create-home --uid 10001 ziipa && chown -R ziipa:ziipa /app
USER ziipa
EXPOSE 8000
CMD ["sh", "-c", "python render_migrate.py && exec uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
