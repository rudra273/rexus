# ---- 1. Build the web UI ----
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- 2. Build the Go binary (UI embedded) ----
FROM golang:1.26-alpine AS go
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /web/dist ./web/dist
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/rexus ./cmd/rexus

# ---- 3. Small runtime image ----
FROM alpine:3.22
# postgresql-client provides pg_dump/pg_restore for backups (Phase 6).
RUN apk add --no-cache ca-certificates tzdata postgresql17-client \
    && addgroup -S rexus && adduser -S -G rexus -h /app rexus \
    && mkdir /backups && chown rexus:rexus /backups
COPY --from=go /out/rexus /usr/local/bin/rexus
USER rexus
WORKDIR /app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
    CMD wget -qO- http://127.0.0.1:${REXUS_PORT:-8080}/api/health >/dev/null || exit 1
ENTRYPOINT ["rexus"]
CMD ["serve"]
