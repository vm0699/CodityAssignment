# Built from the repo root: docker build -f apps/worker/Dockerfile .
FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN npm ci --workspace=@pulse/core --workspace=@pulse/worker --include-workspace-root

COPY packages/core packages/core
COPY apps/worker apps/worker
COPY tsconfig.base.json ./

ENV NODE_ENV=production
CMD ["npx", "tsx", "apps/worker/src/index.ts"]
