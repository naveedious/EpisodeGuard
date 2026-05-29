# syntax=docker/dockerfile:1

# Stage 1: build native deps (better-sqlite3 needs python3/make/g++)
FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# Stage 2: lean runtime image
FROM node:22-alpine
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/

RUN mkdir -p /data

ENV NODE_ENV=production
ENV DATA_DIR=/data

EXPOSE 3000

VOLUME ["/data"]

CMD ["node", "src/index.js"]
