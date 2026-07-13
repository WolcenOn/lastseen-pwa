.PHONY: run test tidy fmt

run:
	cd backend && STATIC_DIR=../web go run ./cmd/server

test:
	cd backend && go test ./...

tidy:
	cd backend && go mod tidy

fmt:
	cd backend && gofmt -w ./cmd ./internal
