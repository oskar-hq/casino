# syntax=docker/dockerfile:1

# Schlankes Image ohne Build-Step: Das Frontend ist reines HTML/CSS/JS und
# wird direkt ausgeliefert. SQLite steckt in Node (node:sqlite) – es muss
# also nichts nativ kompiliert werden.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=3000
# Die Datenbank liegt im Volume, nicht im Image.
ENV CASINO_DB=/data/casino.db
WORKDIR /app

# Nicht als root laufen (das Image bringt den User "node" bereits mit).
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node core ./core
COPY --chown=node:node games ./games
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=4s --start-period=8s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
