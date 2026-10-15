# Honey Wallet API server image.
#
# Build from the repository root:
#   docker build -f apps/server/Dockerfile -t honey-server .
# Multi-arch (amd64 + arm64), cross-compiled natively rather than emulated:
#   docker buildx build --platform linux/amd64,linux/arm64 -f apps/server/Dockerfile -t honey-server .

# xx cross-compiles for TARGETPLATFORM on the build machine's own architecture.
FROM --platform=$BUILDPLATFORM tonistiigi/xx:1.9.0 AS xx

FROM --platform=$BUILDPLATFORM rust:1.93-slim-bookworm AS builder
COPY --from=xx / /
RUN apt-get update \
    && apt-get install -y --no-install-recommends clang lld \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# The pinned toolchain must be in place before adding the target, or the
# target lands on the image's default toolchain instead.
COPY rust-toolchain.toml ./

ARG TARGETPLATFORM
RUN xx-apt-get install -y --no-install-recommends gcc libc6-dev \
    && rustup target add "$(xx-cargo --print-target-triple)"

# Cache dependency builds separately from source changes.
COPY Cargo.toml Cargo.lock ./
COPY apps/server/Cargo.toml apps/server/Cargo.toml
RUN mkdir -p apps/server/src \
    && echo "fn main() {}" > apps/server/src/main.rs \
    && touch apps/server/src/lib.rs \
    && xx-cargo build --release --locked -p honey-server \
    && rm -rf apps/server/src

COPY apps/server/src apps/server/src
RUN touch apps/server/src/main.rs apps/server/src/lib.rs \
    && xx-cargo build --release --locked -p honey-server \
    && xx-verify "target/$(xx-cargo --print-target-triple)/release/honey-server" \
    && cp "target/$(xx-cargo --print-target-triple)/release/honey-server" /honey-server

# Distroless: glibc and CA certificates only; no shell, no package manager.
# Runs as uid 65532 (nonroot) and needs no writable filesystem.
FROM gcr.io/distroless/cc-debian12:nonroot

ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="honey-server" \
      org.opencontainers.image.description="HTTP API server for Honey Wallet" \
      org.opencontainers.image.source="https://github.com/honey-wallet/monorepo" \
      org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

COPY --from=builder /honey-server /usr/local/bin/honey-server

ENV HOST=0.0.0.0 \
    PORT=8080 \
    LOG_FORMAT=json
EXPOSE 8080

# Orchestrators with their own probes (Kubernetes, Cloud Run, Fly) should
# point them at GET /health; this covers plain Docker and Compose.
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD ["/usr/local/bin/honey-server", "healthcheck"]

# The server drains in-flight requests on SIGTERM.
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/honey-server"]
