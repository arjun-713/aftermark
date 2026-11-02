# syntax=docker/dockerfile:1
# Both Node stages share one base; the runtime also uses Debian bookworm/glibc.
FROM node:22-bookworm-slim AS node-base
FROM node-base AS build
WORKDIR /app
COPY package*.json tsconfig.json .npmrc ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN --mount=type=secret,id=proxy_ca,required=false --mount=type=cache,id=agent-quality-npm,target=/tmp/pixar-npm-cache,sharing=shared \
    if [ -f /run/secrets/proxy_ca ]; then NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci; else npm ci; fi
ARG API_ORIGIN=http://localhost:4100
ENV API_ORIGIN=$API_ORIGIN
ENV NEXT_TELEMETRY_DISABLED=1
RUN node -e 'const fs=require("node:fs");const u=new URL(process.env.API_ORIGIN);if(!["http:","https:"].includes(u.protocol)||u.username||u.password||u.search||u.hash||u.pathname!=="/")throw Error("API_ORIGIN must be an HTTP(S) origin without credentials, path, query or fragment");fs.writeFileSync(".build-api-origin",u.origin)'
RUN node scripts/build-services.mjs
RUN mkdir -p apps/web/public
RUN node -e 'const fs=require("node:fs");const p=require("node:child_process").spawnSync("npm",["run","build","-w","@agent-quality/web"],{stdio:"inherit",env:{...process.env,API_ORIGIN:fs.readFileSync(".build-api-origin","utf8")}});process.exit(p.status??1)'
RUN test -f apps/web/.next/standalone/apps/web/server.js

FROM node-base AS dependencies
WORKDIR /app
COPY package*.json ./
COPY apps ./apps
COPY packages ./packages
RUN --mount=type=secret,id=proxy_ca,required=false --mount=type=cache,id=agent-quality-npm,target=/tmp/pixar-npm-cache,sharing=shared \
    if [ -f /run/secrets/proxy_ca ]; then NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --omit=dev --ignore-scripts; else npm ci --omit=dev --ignore-scripts; fi

FROM postgres:17-bookworm AS runtime
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 TMPDIR=/tmp PORT=10000 SERVICE_ROLE=api SEMANTIC_EVALUATIONS_ENABLED=false NEXT_TELEMETRY_DISABLED=1 PGSSLROOTCERT=/etc/ssl/certs/ca-certificates.crt
ENV NODE_EXTRA_CA_CERTS=/app/infra/supabase/prod-ca-2021.crt
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
COPY infra/start.mjs infra/healthcheck.mjs ./infra/
COPY infra/supabase/prod-ca-2021.crt ./infra/supabase/prod-ca-2021.crt
COPY --from=build /app/.build-api-origin ./infra/build-api-origin
RUN node -e 'const fs=require("node:fs");fs.mkdirSync("/etc/ssl/certs",{recursive:true});fs.writeFileSync("/etc/ssl/certs/ca-certificates.crt",require("node:tls").rootCertificates.join("\n")+"\n"+fs.readFileSync("infra/supabase/prod-ca-2021.crt","utf8"))'
RUN node --version && pg_dump --version && test -s /etc/ssl/certs/ca-certificates.crt
RUN groupadd --gid 10001 aq && useradd --uid 10001 --gid aq --create-home aq && mkdir -p /app/apps/web/.next/cache && chown -R aq:aq /app/apps/web/.next/cache
USER 10001:10001
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node","infra/healthcheck.mjs"]
ENTRYPOINT ["node","infra/start.mjs"]
CMD []
STOPSIGNAL SIGTERM
