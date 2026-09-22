# STRATUM — persistent shared-world server.
# Long-lived Node process + persistent volume for data/. Static hosts can't run this.
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
# install (not ci): tolerant of lock drift across npm versions — the lock still
# pins every version; this just refuses to fail the whole build over it.
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8090
# Point at the mounted volume in production, e.g. -e STRATUM_DB=/data/world.db
EXPOSE 8090

CMD ["node", "server.js"]
