# Build the Vite frontend and TypeScript API on the same Node image family.
FROM node:26.11-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 may need to compile its native addon on newer Node releases.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:26.11-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    DATABASE_PATH=/app/data/app.sqlite \
    UPLOAD_DIR=/app/uploads

RUN mkdir -p /app/data /app/uploads \
  && chown -R node:node /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server

USER node
EXPOSE 8787
CMD ["node", "dist-server/server/index.js"]
