# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install --no-audit --no-fund
COPY apps ./apps
COPY db ./db
RUN npm run build && npm prune --omit=dev --workspaces --include-workspace-root

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Runtime only runs `node apps/server/dist/main.js`; drop npm/npx/corepack and
# their bundled deps (pacote, sigstore, ip-address, picomatch, brace-expansion,
# ...) so the shipped image doesn't carry CVEs from tooling it never executes.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/db ./db
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "apps/server/dist/main.js"]
