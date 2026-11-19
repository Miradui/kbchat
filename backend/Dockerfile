# syntax=docker/dockerfile:1
FROM golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY . .
ARG TARGETOS=linux
ARG TARGETARCH
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    set -eu; for cmd in server migrate doctor bootstrap-admin reembed reindex-keywords; do \
      CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags='-s -w' -o /out/rag-${cmd} ./cmd/${cmd}; \
    done

FROM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f
RUN apk add --no-cache ca-certificates tzdata curl jq poppler-utils tesseract-ocr tesseract-ocr-data-eng tesseract-ocr-data-chi_sim \
    && addgroup -g 10001 app && adduser -D -u 10001 -G app app \
    && mkdir -p /app/uploads && chown app:app /app/uploads
WORKDIR /app
COPY --from=build /out/ ./bin/
COPY migrations/ ./migrations/
USER 10001:10001
ENV SERVER_PORT=8080 UPLOAD_DIR=/app/uploads APP_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=4 \
  CMD curl -fsS http://127.0.0.1:8080/healthz | jq -e '.status == "ok"' >/dev/null || exit 1
CMD ["/app/bin/rag-server"]
