FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.9.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
ENV NODE_ENV=production GOALLOOP_CONTAINER=1 GOALLOOP_DATA_DIR=/data GOALLOOP_PORT=12400
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 12400
CMD ["node","dist/cli.js","serve","--worker"]
