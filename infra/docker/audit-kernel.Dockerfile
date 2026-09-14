# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/audit-kernel/package.json packages/audit-kernel/
COPY packages/contracts/package.json packages/contracts/
COPY packages/sdk-ts/package.json packages/sdk-ts/
COPY apps/core-api/package.json apps/core-api/
COPY apps/shell/package.json apps/shell/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @verityos/audit-kernel build
ENTRYPOINT ["node", "packages/audit-kernel/dist/cli.js"]
CMD ["--help"]
