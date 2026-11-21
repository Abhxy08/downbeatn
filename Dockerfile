# DownBeat backend (Cloud Run). Built from the monorepo root because npm workspaces
# share one package-lock.json:   gcloud run deploy downbeat-server --source .
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci --workspace server --include-workspace-root=false --ignore-scripts
COPY server/tsconfig.json server/
COPY server/src server/src
RUN npm run build --workspace server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json server/
RUN npm ci --workspace server --include-workspace-root=false --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder /app/server/dist server/dist
USER node
# Cloud Run sets PORT (8080)
CMD ["node", "server/dist/index.js"]
