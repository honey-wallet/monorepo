# Build from the repository root:
#   docker build -f apps/server/Dockerfile -t honey-server .

FROM rust:1.93-slim-bookworm AS builder
WORKDIR /app

# Cache dependency builds separately from source changes.
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY apps/server/Cargo.toml apps/server/Cargo.toml
RUN mkdir -p apps/server/src \
    && echo "fn main() {}" > apps/server/src/main.rs \
    && touch apps/server/src/lib.rs \
    && cargo build --release --locked -p honey-server \
    && rm -rf apps/server/src

COPY apps/server/src apps/server/src
RUN touch apps/server/src/main.rs apps/server/src/lib.rs \
    && cargo build --release --locked -p honey-server

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=builder /app/target/release/honey-server /usr/local/bin/honey-server
ENV HOST=0.0.0.0 \
    PORT=8080 \
    LOG_FORMAT=json
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/honey-server"]
