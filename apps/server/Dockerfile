# Honey Wallet API server image.
#
# Build from the repository root:
#   docker build -f apps/server/Dockerfile -t honey-server .
# Multi-arch (amd64 + arm64), cross-compiled natively rather than emulated:
#   docker buildx build --platform linux/amd64,linux/arm64 -f apps/server/Dockerfile -t honey-server .

# Pin the multi-architecture manifest indexes, not platform-specific manifests,
# so the selected BUILDPLATFORM/TARGETPLATFORM stay consistent across builders.
FROM --platform=$BUILDPLATFORM tonistiigi/xx:1.9.0@sha256:c64defb9ed5a91eacb37f96ccc3d4cd72521c4bd18d5442905b95e2226b0e707 AS xx

FROM --platform=$BUILDPLATFORM rust:1.93-slim-bookworm@sha256:5b9332190bb3b9ece73b810cd1f1e9f06343b294ce184bcb067f0747d7d333ea AS builder
COPY --from=xx / /
ARG DEBIAN_SNAPSHOT=20261019T000000Z
RUN set -eux; \
    rm -f /etc/apt/sources.list.d/debian.sources; \
    printf 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/%s bookworm main\n' "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list; \
    printf 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/%s bookworm-security main\n' "$DEBIAN_SNAPSHOT" >> /etc/apt/sources.list; \
    apt-get -o Acquire::Check-Valid-Until=false update && \
    apt-get install -y --no-install-recommends clang lld && \
    rm -rf /var/lib/apt/lists/*

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
COPY apps/server/migrations apps/server/migrations
RUN touch apps/server/src/main.rs apps/server/src/lib.rs \
    && xx-cargo build --release --locked -p honey-server \
    && xx-verify "target/$(xx-cargo --print-target-triple)/release/honey-server" \
    && cp "target/$(xx-cargo --print-target-triple)/release/honey-server" /honey-server

# Distroless: glibc and CA certificates only; no shell, no package manager.
# Runs as uid 65532 (nonroot) and needs no writable filesystem.
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f

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
