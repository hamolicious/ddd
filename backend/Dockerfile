# syntax=docker/dockerfile:1

FROM rust:1-slim-bookworm AS wasm-tools
ARG WASM_BINDGEN_VERSION=0.2.128
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && cargo install wasm-bindgen-cli --version "${WASM_BINDGEN_VERSION}" --locked

FROM rust:1-slim-bookworm AS rust-builder
WORKDIR /build

RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=wasm-tools /usr/local/cargo/bin/wasm-bindgen /usr/local/bin/wasm-bindgen
RUN rustup target add wasm32-unknown-unknown

COPY backend/Cargo.toml backend/Cargo.lock ./
COPY backend/crates/core/Cargo.toml crates/core/Cargo.toml
COPY backend/crates/plugin-abi/Cargo.toml crates/plugin-abi/Cargo.toml
COPY backend/crates/server/Cargo.toml crates/server/Cargo.toml
RUN mkdir -p crates/core/src crates/plugin-abi/src crates/server/src \
    && echo "" > crates/core/src/lib.rs \
    && echo "" > crates/plugin-abi/src/lib.rs \
    && echo "" > crates/server/src/lib.rs \
    && echo "fn main() {}" > crates/server/src/main.rs \
    && cargo build --release --locked \
    && rm -rf crates/core/src crates/plugin-abi/src crates/server/src

COPY backend/crates ./crates
COPY schema /schema
RUN find crates -name '*.rs' -exec touch {} + \
    && cargo build --release --locked --bin ddd \
    && strip target/release/ddd

RUN cargo build -p ddd-core --target wasm32-unknown-unknown --release --locked \
        --no-default-features --features wasm \
    && wasm-bindgen --target web --out-dir /wasm-pkg --out-name ddd_core \
        target/wasm32-unknown-unknown/release/ddd_core.wasm

FROM rust-builder AS plugin-builder
WORKDIR /repo

COPY backend/Cargo.toml backend/Cargo.lock ./backend/
COPY backend/crates ./backend/crates
COPY plugins ./plugins
WORKDIR /repo/plugins
RUN cargo build --workspace --target wasm32-unknown-unknown --release --locked

FROM node:22-bookworm-slim AS web-builder
WORKDIR /repo

COPY web/package.json web/package-lock.json web/
WORKDIR /repo/web
RUN npm ci --no-audit --no-fund

WORKDIR /repo
COPY web ./web
COPY plugins ./plugins
COPY brand ./brand
COPY --from=rust-builder /wasm-pkg ./web/kernel/src/wasm/pkg
COPY --from=plugin-builder /repo/plugins/target/wasm32-unknown-unknown/release \
     ./plugins/target/wasm32-unknown-unknown/release

WORKDIR /repo/web
RUN npm run kernel:dts \
    && npm run build:app \
    && npm run build:plugins \
    && node scripts/build-wasm-plugins.mjs --prebuilt

FROM debian:bookworm-slim AS runtime

LABEL org.opencontainers.image.title="ddd" \
      org.opencontainers.image.description="ddd server: REST API, CRDT document store, auth, attachments, the PWA bundle and the base plugin distribution." \
      org.opencontainers.image.licenses="MIT OR Apache-2.0"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin ddd

COPY --from=rust-builder /build/target/release/ddd /usr/local/bin/ddd

COPY --from=web-builder /repo/web/app/dist /srv/web
COPY --from=web-builder /repo/web/kernel-api/dist/kernel.d.ts /srv/kernel.d.ts

COPY --from=web-builder --chown=10001:10001 /repo/plugins/base/dist /srv/plugins
RUN install -d -o 10001 -g 10001 /srv/plugins.staging

USER 10001:10001
WORKDIR /home/ddd

ENV BIND_ADDR=0.0.0.0:8080 \
    LOG_FORMAT=json \
    RUST_LOG=info \
    WEB_DIST_DIR=/srv/web \
    PLUGINS_DIR=/srv/plugins \
    KERNEL_DTS_PATH=/srv/kernel.d.ts
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=5 \
    CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/${BIND_ADDR##*:} && printf "GET /healthz HTTP/1.0\r\nHost: localhost\r\n\r\n" >&3 && grep -q "200 OK" <&3'

STOPSIGNAL SIGTERM

ENTRYPOINT ["/usr/local/bin/ddd"]
CMD ["serve"]
