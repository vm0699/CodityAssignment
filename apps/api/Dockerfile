# Built from the repo root: docker build -f apps/api/Dockerfile .
FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/api/package.json apps/api/package.json
RUN npm ci --workspace=@pulse/core --workspace=@pulse/api --include-workspace-root

COPY packages/core packages/core
COPY apps/api apps/api
COPY tsconfig.base.json ./

ENV NODE_ENV=production
EXPOSE 4000
CMD ["npx", "tsx", "apps/api/src/index.ts"]
