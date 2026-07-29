# syntax=docker/dockerfile:1

ARG AGENTOS_IMAGE=agentos:dev
ARG ARTIFACT_FS_VERSION=1.0.0-rc.6
ARG ARTIFACT_FS_MODULE_VERSION=v0.0.0-20260713115237-eb426cd0c09e

FROM golang:1.25.7-bookworm@sha256:564e366a28ad1d70f460a2b97d1d299a562f08707eb0ecb24b659e5bd6c108e1 AS artifact-fs-build

ARG ARTIFACT_FS_MODULE_VERSION
ENV GOBIN=/out

RUN CGO_ENABLED=0 go install \
      "github.com/cloudflare/artifact-fs/cmd/artifact-fs@${ARTIFACT_FS_MODULE_VERSION}" \
  && test -x /out/artifact-fs \
  && artifact_fs_license="$(find "$(go env GOMODCACHE)/github.com/cloudflare" \
       -path '*/artifact-fs@*/LICENSE' -print -quit)" \
  && test -n "$artifact_fs_license" \
  && install -m 0644 "$artifact_fs_license" /out/LICENSE

FROM ${AGENTOS_IMAGE}

ARG ARTIFACT_FS_VERSION
ARG ARTIFACT_FS_MODULE_VERSION

USER 0:0

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
    fuse3=3.17.2-3 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=artifact-fs-build /out/artifact-fs /usr/local/bin/artifact-fs
COPY --from=artifact-fs-build /out/LICENSE /usr/share/licenses/artifact-fs/LICENSE

RUN artifact-fs --help >/dev/null \
  && test -s /usr/share/licenses/artifact-fs/LICENSE

LABEL dev.akua.agentos.profile="artifact-fs-scout" \
      dev.akua.agentos.artifact-fs.version="${ARTIFACT_FS_VERSION}" \
      dev.akua.agentos.artifact-fs.module-version="${ARTIFACT_FS_MODULE_VERSION}" \
      org.opencontainers.image.source="https://github.com/cloudflare/artifact-fs"

USER 1000:1000
