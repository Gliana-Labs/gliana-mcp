# Dockerfile for Glama's MCP introspection checks (glama.ai/mcp/servers).
#
# Glama builds this, starts the server and calls tools/list. That handshake needs
# NO credentials: discovery tools read the public catalog, and only a paid call
# needs a wallet key — which stays on the user's machine and is never baked in
# here. So the image runs with no secrets and no network writes.
#
# Multi-stage so the published image carries dist/ and production deps only,
# not the TypeScript toolchain.
FROM node:22-alpine AS build
WORKDIR /app

# Copy manifests first so `npm ci` is cached until dependencies actually change.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Non-root: the server only reads a public HTTP catalog and speaks stdio, so it
# needs no privileges at all.
USER node

# stdio transport — Glama talks to the process over stdin/stdout, so there is no
# port to expose and no HTTP server to wait on.
ENTRYPOINT ["node", "dist/index.js"]
