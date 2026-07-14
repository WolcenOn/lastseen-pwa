# syntax=docker/dockerfile:1

FROM golang:1.22-alpine AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/lastseen ./cmd/server

FROM alpine:3.20
WORKDIR /app

RUN addgroup -S app && adduser -S app -G app
COPY --from=build /out/lastseen /app/lastseen

USER app
ENV STATIC_DIR=
EXPOSE 8080

CMD ["/app/lastseen"]
