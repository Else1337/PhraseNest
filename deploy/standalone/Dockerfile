FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 ZHIBI_NODE_DEPLOY=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY public ./public
COPY next.config.ts tsconfig.json next-env.d.ts ./
RUN node node_modules/next/dist/bin/next build --webpack

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=9000 ZHIBI_PERSISTENCE_MODE=standalone STANDALONE_ORIGINALS_DIR=/var/lib/phrasenest/originals STUDENT_PROJECT_DATA_DIR=/tmp/phrasenest-cache
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --chown=node:node deploy/standalone/*.mjs ./standalone/
COPY --chown=node:node cloudbase/migrations ./cloudbase/migrations/
USER node
EXPOSE 9000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/login',{redirect:'manual'}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
CMD ["node","standalone/start.mjs"]
