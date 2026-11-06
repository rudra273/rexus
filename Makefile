
.PHONY: build web go test dev-db dev-api dev-web up down logs clean

## build: build UI + single binary into ./bin/rexus
build: web go

web:
	cd web && npm ci && npm run build

go:
	CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o bin/rexus ./cmd/rexus

test:
	go vet ./... && go test ./...

## Local development (3 terminals): make dev-db, make dev-api, make dev-web
dev-db:
	docker compose up postgres

dev-api:
	REXUS_ENV=development go run ./cmd/rexus serve

dev-web:
	cd web && npm run dev

## Docker: Rexus + Postgres
up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f rexus

clean:
	rm -rf bin web/dist/assets web/dist/index.html web/dist/favicon.svg
