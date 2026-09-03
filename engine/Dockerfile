FROM mcr.microsoft.com/playwright:v1.42.0-jammy

WORKDIR /app

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=UTC \
    NODE_ENV=production \
    PORT=3000 \
    HEADLESS=false \
    DISPLAY=:99

# The scraper drives GoLogin profiles (Orbita anti-detect Chromium) HEADED
# under an Xvfb virtual display. Live viewing is now per-job: the server
# captures a page screenshot on demand (GET /api/scrape/view/:jobId), so the
# old whole-screen noVNC stack (x11vnc + websockify + noVNC) is gone — Xvfb
# alone is enough to run the browsers headed.
#
# The Playwright base image already carries the shared libraries Chromium/Orbita
# need; the GoLogin SDK downloads the Orbita binary into $GOLOGIN_HOME on first
# launch (needs network + ~250 MB of writable space — see k8s volume).
ENV GOLOGIN_HOME=/app/.gologin
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb \
        tini \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p "$GOLOGIN_HOME"

# Install npm deps first (better layer caching).
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# App source
COPY . .

# Entrypoint boots Xvfb + Node and forwards signals cleanly. Tini reaps
# zombies and handles SIGTERM during pod resize / graceful shutdown.
COPY --chmod=0755 k8s/entrypoint.sh /entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
