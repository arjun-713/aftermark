# One reviewed image, separate roles and credentials. PostgreSQL 17 client matches the deployed DB major.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci
ARG API_ORIGIN=http://localhost:4100
ENV API_ORIGIN=$API_ORIGIN
RUN node scripts/build-services.mjs
RUN mkdir -p apps/web/public && npm run build -w @agent-quality/web
RUN test -f apps/web/.next/standalone/apps/web/server.js

FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package*.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci --omit=dev --ignore-scripts

FROM postgres:17-bookworm AS runtime
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=10000 SERVICE_ROLE=api SEMANTIC_EVALUATIONS_ENABLED=false
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
COPY infra/start.mjs infra/healthcheck.mjs ./infra/
RUN groupadd --gid 10001 aq && useradd --uid 10001 --gid aq --create-home aq && chown -R aq:aq /app
USER 10001:10001
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node","infra/healthcheck.mjs"]
ENTRYPOINT ["node","infra/start.mjs"]
