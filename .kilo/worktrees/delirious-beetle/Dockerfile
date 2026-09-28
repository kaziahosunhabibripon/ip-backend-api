FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
# Never run as root. The app writes nothing to disk; its settings come from .env.prod or the environment.
USER node
EXPOSE 4000
# Readiness, not liveness: an instance that can't reach Postgres is marked unhealthy and taken out of rotation.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-4000}/api/v1/health/ready" > /dev/null || exit 1
CMD ["node", "dist/main"]
