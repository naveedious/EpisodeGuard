# syntax=docker/dockerfile:1

# Stage 1: build native deps (better-sqlite3 needs python3/make/g++)
FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Stage 2: lean runtime image
FROM node:22-alpine
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/

RUN mkdir -p /data && chown -R node:node /app /data

ARG BUILD_DATE
ARG VERSION
ARG REVISION

ENV APP_VERSION=$VERSION

LABEL org.opencontainers.image.title="Episode Guard" \
      org.opencontainers.image.description="Watches Tautulli and keeps Sonarr ahead of what you're watching" \
      org.opencontainers.image.url="https://github.com/naveedious/episodeguard" \
      org.opencontainers.image.source="https://github.com/naveedious/episodeguard" \
      org.opencontainers.image.created=$BUILD_DATE \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$REVISION

ENV NODE_ENV=production
ENV DATA_DIR=/data

EXPOSE 8988

VOLUME ["/data"]

USER node

CMD ["node", "src/index.js"]
