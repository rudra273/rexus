
.PHONY: build web go test dev dev-db dev-api dev-web dev-logs dev-down dev-reset up down logs clean

## build: build UI + single binary into ./bin/rexus
build: web go

web:
	cd web && npm ci && npm run build

go:
	CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o bin/rexus ./cmd/rexus

test:
	go vet ./... && go test ./...

## Local development — all in Docker (docker-compose.dev.yml), nothing installed on the host.
## make dev: DB + API (:8080) + UI (:5173)   make dev-down: stop (keeps data)   make dev-reset: wipe dev data
DEV = docker compose -f docker-compose.dev.yml

dev:
	$(DEV) up -d

dev-db:
	$(DEV) up -d postgres

dev-api:
	$(DEV) up -d api

dev-web:
	$(DEV) up -d web

dev-logs:
	$(DEV) logs -f

dev-down:
	$(DEV) down

dev-reset:
	$(DEV) down -v

## Docker: Rexus + Postgres
up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f rexus

clean:
	rm -rf bin web/dist/assets web/dist/index.html web/dist/favicon.svg
