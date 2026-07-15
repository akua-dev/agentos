FROM debian:13-slim@sha256:020c0d20b9880058cbe785a9db107156c3c75c2ac944a6aa7ab59f2add76a7bd

ARG TARGETARCH
ARG MISE_VERSION=2026.4.25
ARG AGENTOS_VERSION=dev

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
COPY . /opt/agentos

RUN chmod 0644 \
    /etc/mise/config.toml \
    /etc/mise/mise.lock \
    /opt/agentos/mise.toml \
    /opt/agentos/mise.lock \
    /opt/agentos/agents/mise.toml \
    /opt/agentos/agents/mise.lock \
    /opt/agentos/agents/firstmate/mise.toml \
  && chmod 0755 \
    /opt/agentos/deploy/kubernetes/firstmate/runtime/prepare-home.ts \
    /opt/agentos/deploy/kubernetes/firstmate/runtime/run-firstmate.ts \
    /opt/agentos/deploy/kubernetes/firstmate/runtime/health.ts

ENV HOME=/home/agent \
    AGENTOS_RELEASE_ROOT=/opt/agentos \
    HERDR_CONFIG_PATH=/home/agent/.config/herdr/config.toml \
    HERDR_SESSION=agentos-firstmate \
    MISE_DATA_DIR=/home/agent/.local/share/mise \
    MISE_LOCKED=1 \
    MISE_GITHUB_GITHUB_ATTESTATIONS=false \
    MISE_GITHUB_SLSA=false \
    MISE_SYSTEM_CONFIG_FILE=/etc/mise/config.toml \
    MISE_TRUSTED_CONFIG_PATHS=/opt/agentos \
    PI_CODING_AGENT_DIR=/home/agent/.pi/agent \
    PATH=/home/agent/.local/share/mise/shims:/home/agent/.local/bin:/usr/local/bin:/usr/bin:/bin

USER 1000:1000
WORKDIR /opt/agentos/agents/firstmate

CMD ["mise", "run", "--skip-tools", "firstmate:run"]
