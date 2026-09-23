# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Builder: compile the workspace release binary.
# Dependencies are built in their own layer so source edits don't refetch crates.
# ---------------------------------------------------------------------------
FROM rust:1-slim-bookworm AS builder
WORKDIR /build

RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 1. Dependency layer: manifests only, with dummy sources.
COPY Cargo.toml Cargo.lock ./
COPY crates/core/Cargo.toml crates/core/Cargo.toml
COPY crates/server/Cargo.toml crates/server/Cargo.toml
RUN mkdir -p crates/core/src crates/server/src \
    && echo "" > crates/core/src/lib.rs \
    && echo "" > crates/server/src/lib.rs \
    && echo "fn main() {}" > crates/server/src/main.rs \
    && cargo build --release --locked \
    && rm -rf crates/core/src crates/server/src

# 2. Real sources.
COPY crates ./crates
# Touch so cargo notices the real sources are newer than the dummy build.
RUN find crates -name '*.rs' -exec touch {} + \
    && cargo build --release --locked --bin life-manager \
    && strip target/release/life-manager

# ---------------------------------------------------------------------------
# Runtime: no toolchain, non-root, TLS terminated upstream (SPEC §8).
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

LABEL org.opencontainers.image.title="life-manager" \
      org.opencontainers.image.description="Life Manager server: REST API, CRDT document store, auth, attachments." \
      org.opencontainers.image.licenses="MIT OR Apache-2.0"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin lifemanager

COPY --from=builder /build/target/release/life-manager /usr/local/bin/life-manager

USER 10001:10001
WORKDIR /home/lifemanager

# Defaults only. MONGO_URI and SESSION_SECRET have no defaults and must be
# supplied (SPEC §5.2) — the server refuses to start without them.
ENV BIND_ADDR=0.0.0.0:8080 \
    LOG_FORMAT=json \
    RUST_LOG=info
EXPOSE 8080

# Liveness only: /healthz never touches Mongo, so a database blip cannot get the
# container killed (readiness is /readyz, which the orchestrator polls instead).
# No curl in the image on purpose; bash is part of debian's essential set and
# /dev/tcp costs nothing.
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=5 \
    CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/${BIND_ADDR##*:} && printf "GET /healthz HTTP/1.0\r\nHost: localhost\r\n\r\n" >&3 && grep -q "200 OK" <&3'

# SIGTERM → graceful shutdown inside 30 s (SPEC §8); no init shim needed because
# the binary is PID 1 and handles the signal itself.
STOPSIGNAL SIGTERM

ENTRYPOINT ["/usr/local/bin/life-manager"]
CMD ["serve"]
