# Built from the repo root: docker build -f apps/scheduler/Dockerfile .
FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/scheduler/package.json apps/scheduler/package.json
RUN npm ci --workspace=@pulse/core --workspace=@pulse/scheduler --include-workspace-root

COPY packages/core packages/core
COPY apps/scheduler apps/scheduler
COPY tsconfig.base.json ./

ENV NODE_ENV=production
CMD ["npx", "tsx", "apps/scheduler/src/index.ts"]
