FROM debian:13-slim@sha256:020c0d20b9880058cbe785a9db107156c3c75c2ac944a6aa7ab59f2add76a7bd AS agentos-base

ARG TARGETARCH
ARG MISE_VERSION=2026.4.25
ARG AGENTOS_VERSION=dev
ARG POSTGRESQL_CLIENT_VERSION=18.4-1.pgdg13+1
ARG PGDG_SIGNING_CHECKSUM=0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76

LABEL org.opencontainers.image.source="https://github.com/akua-dev/agentos" \
      org.opencontainers.image.description="Persistent engineering agents for Kubernetes" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${AGENTOS_VERSION}"

SHELL ["/bin/sh", "-euxc"]

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
    ca-certificates \
    curl \
    git \
    openssh-client \
    procps \
    unzip \
    xz-utils \
    zstd \
  && install -d -m 0755 /usr/share/postgresql-common/pgdg \
  && curl --fail --location --retry 3 \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    --output /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  && echo "${PGDG_SIGNING_CHECKSUM}  /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc" \
    | sha256sum --check --strict \
  && printf '%s\n' \
    'Types: deb' \
    'URIs: https://apt.postgresql.org/pub/repos/apt' \
    'Suites: trixie-pgdg' \
    'Components: main' \
    'Signed-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc' \
    > /etc/apt/sources.list.d/pgdg.sources \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
    "postgresql-client-18=${POSTGRESQL_CLIENT_VERSION}" \
  && test "$(psql --version)" = \
    "psql (PostgreSQL) 18.4 (Debian ${POSTGRESQL_CLIENT_VERSION})" \
  && ! command -v postgres \
  && rm -f \
    /etc/apt/sources.list.d/pgdg.sources \
    /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  && rm -rf /var/lib/apt/lists/*

RUN case "$TARGETARCH" in \
      amd64) \
        mise_arch=x64; \
        mise_sha=9fa2419738eb0476338a09e815b43506e66aebdb8148c5b2d690996641636ef7 \
        ;; \
      arm64) \
        mise_arch=arm64; \
        mise_sha=9988716d9d23a3e2fa82eea1c59d0a0f9f9cf4970a6f6f853275babc4ced357d \
        ;; \
      *) \
        echo "Unsupported target architecture: $TARGETARCH" >&2; \
        exit 1 \
        ;; \
    esac; \
    curl --fail --location --retry 3 \
      "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${mise_arch}" \
      --output /usr/local/bin/mise; \
    echo "$mise_sha  /usr/local/bin/mise" | sha256sum --check --strict; \
    chmod 0755 /usr/local/bin/mise

RUN groupadd --gid 1000 agent \
  && useradd --uid 1000 --gid 1000 --home-dir /home/agent --create-home --shell /bin/sh agent \
  && install -d -o agent -g agent -m 0700 /home/agent \
  && install -d -o root -g root -m 0755 /etc/mise /opt/agentos

COPY mise.toml /etc/mise/config.toml
COPY mise.lock /etc/mise/mise.lock

RUN MISE_DATA_DIR=/opt/mise \
    MISE_GITHUB_GITHUB_ATTESTATIONS=false \
    MISE_GITHUB_SLSA=false \
    MISE_LOCKED=1 \
    MISE_SYSTEM_CONFIG_FILE=/etc/mise/config.toml \
    mise install github:oven-sh/bun \
  && ln -s \
    "$(MISE_DATA_DIR=/opt/mise MISE_SYSTEM_CONFIG_FILE=/etc/mise/config.toml mise where github:oven-sh/bun)/bun" \
    /usr/local/bin/bun \
  && test "$(bun --version)" = "1.4.0"

FROM agentos-base AS agentos-seed

ARG AGENTOS_GIT_REMOTE=https://github.com/akua-dev/agentos.git
ARG AGENTOS_GIT_UPSTREAM=https://github.com/akua-dev/agentos.git

COPY . /tmp/agentos-source

RUN bun /tmp/agentos-source/runtime/create-image-seed.ts \
      --source /tmp/agentos-source \
      --output /opt/agentos-seed \
      --origin "$AGENTOS_GIT_REMOTE" \
      --upstream "$AGENTOS_GIT_UPSTREAM"

FROM agentos-base AS agentos-runtime-dependencies

WORKDIR /tmp/agentos-dependencies

COPY package.json bun.lock ./
COPY clis/pg-listen/package.json clis/pg-listen/package.json
COPY database/package.json database/package.json
COPY clis/pg-listen/pg-listen.ts clis/pg-listen/pg-listen.ts

RUN bun install \
      --frozen-lockfile \
      --ignore-scripts \
      --no-progress \
      --production \
      --filter @agentos/pg-listen \
  && bun clis/pg-listen/pg-listen.ts --help >/dev/null

FROM agentos-base

COPY --from=agentos-seed /opt/agentos-seed/ /opt/agentos/
COPY --from=agentos-runtime-dependencies \
  /tmp/agentos-dependencies/node_modules/ \
  /opt/agentos/node_modules/
COPY --from=agentos-runtime-dependencies \
  /tmp/agentos-dependencies/clis/pg-listen/node_modules/ \
  /opt/agentos/clis/pg-listen/node_modules/

RUN chmod 0644 \
    /etc/mise/config.toml \
    /etc/mise/mise.lock \
    /opt/agentos/mise.toml \
    /opt/agentos/mise.lock \
    /opt/agentos/agents/firstmate/mise.toml \
    /opt/agentos/agents/crewmate/BRIEF.md \
    /opt/agentos/agents/secondmate/mise.toml \
  && chmod 0755 \
    /opt/agentos/runtime/prepare-home.ts \
    /opt/agentos/runtime/create-image-seed.ts \
    /opt/agentos/runtime/run-mate.ts \
    /opt/agentos/runtime/health.ts \
  && chmod 0755 \
    /opt/agentos/clis/pg-listen/pg-listen.ts \
  && ln -s \
    /opt/agentos/clis/pg-listen/pg-listen.ts \
    /usr/local/bin/pg-listen \
  && git config --system --add safe.directory /opt/agentos \
  && git config --system --add safe.directory /opt/agentos/.git

ENV HOME=/home/agent \
    AGENTOS_RELEASE_ROOT=/opt/agentos \
    HERDR_CONFIG_PATH=/home/agent/.config/herdr/config.toml \
    MISE_DATA_DIR=/home/agent/.local/share/mise \
    MISE_LOCKED=1 \
    MISE_GITHUB_GITHUB_ATTESTATIONS=false \
    MISE_GITHUB_SLSA=false \
    MISE_SYSTEM_CONFIG_FILE=/etc/mise/config.toml \
    MISE_TRUSTED_CONFIG_PATHS=/opt/agentos \
    PI_CODING_AGENT_DIR=/home/agent/.pi/agent \
    PATH=/home/agent/.local/share/mise/shims:/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin

USER 1000:1000
WORKDIR /opt/agentos
