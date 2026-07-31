---
name: agentos-secrets
description: Safely create, retry, rotate, take over, roll back, project, and revoke AgentOS-managed Kubernetes Secrets without retaining or printing credential bytes. Use whenever an AgentOS workflow moves credential files into Kubernetes, changes an existing managed Secret, verifies a projected credential, encounters conflicting Secret ownership or legacy annotations, or retires a Kubernetes-delivered credential.
---

# Manage Kubernetes-delivered credentials

Use this lifecycle for every Secret whose credential bytes AgentOS places in
Kubernetes. Use native `kubectl`; do not introduce a wrapper, controller,
credential table, generated manifest file, or `kubectl apply` workflow.

CloudNativePG and other reviewed operators own the Secrets they generate. Do
not take those over with this workflow. Inspect their documented non-secret
shape and consume them through the owning integration instead.

## Preserve the boundary

1. Resolve the exact Kubernetes context, namespace, Secret name, owning Agent
   or service, credential scope, schema version, expected key names, consumers,
   and upstream revocation path. Keep every identifier non-secret and valid as
   a Kubernetes label value.
2. Ask before first distribution, rotation, takeover, rollback, revocation, or
   workload interruption unless exact durable standing authority covers it.
   A rotation does not grant a broader provider scope.
3. Put source files in a mode-`0700` temporary directory outside Git and make
   each credential file mode `0600`. Use `umask 077` before creating them.
   Never put credential values in argv, environment variables, prompts,
   generated manifests, Fleet rows, terminal output, or normal logs.
4. Use these labels on every managed Secret and no annotations:

   - `app.kubernetes.io/managed-by=agentos`
   - `agentos.akua.dev/secret-owner=<stable Agent or service identity>`
   - `agentos.akua.dev/secret-scope=<stable least-privilege scope identity>`
   - `agentos.akua.dev/secret-schema=<versioned key-set identity>`

5. Treat key names as non-secret metadata and credential values as secret.
   Never request a Secret as JSON or YAML, decode `.data`, use
   `--show-managed-fields`, or inspect annotation values. Request one approved
   metadata field or a map's key names at a time.

## Inspect without reading credentials

Confirm the namespace and current object identity before changing anything:

```console
kubectl --context "$AGENTOS_SECRET_CONTEXT" get namespace "$AGENTOS_SECRET_NAMESPACE" --output=name
kubectl --context "$AGENTOS_SECRET_CONTEXT" --namespace "$AGENTOS_SECRET_NAMESPACE" \
  get secret "$AGENTOS_SECRET_NAME" --ignore-not-found \
  --output=jsonpath='{.metadata.uid}'
```

For an existing object, read its UID, resourceVersion, each of the four exact
label values, annotation key names, and data key names with separate bounded
queries. The two key-name queries are safe because their templates never
render map values:

```console
kubectl --context "$AGENTOS_SECRET_CONTEXT" --namespace "$AGENTOS_SECRET_NAMESPACE" \
  get secret "$AGENTOS_SECRET_NAME" --output=jsonpath='{.metadata.resourceVersion}'
kubectl --context "$AGENTOS_SECRET_CONTEXT" --namespace "$AGENTOS_SECRET_NAMESPACE" \
  get secret "$AGENTOS_SECRET_NAME" \
  --output=go-template='{{range $key, $_ := .metadata.annotations}}{{println $key}}{{end}}'
kubectl --context "$AGENTOS_SECRET_CONTEXT" --namespace "$AGENTOS_SECRET_NAMESPACE" \
  get secret "$AGENTOS_SECRET_NAME" \
  --output=go-template='{{range $key, $_ := .data}}{{println $key}}{{end}}'
```

Use JSONPath with an escaped label key to read each approved label, for
example:

```console
kubectl --context "$AGENTOS_SECRET_CONTEXT" --namespace "$AGENTOS_SECRET_NAMESPACE" \
  get secret "$AGENTOS_SECRET_NAME" \
  --output=jsonpath='{.metadata.labels.agentos\.akua\.dev/secret-owner}'
```

Stop the normal lifecycle if any annotation exists, a managed label is missing
or different, the key-name set is unexpected, the Secret type is not `Opaque`,
or the resolved owner or scope differs. Do not repair ambiguous ownership by
force. Route it to the explicit takeover procedure.

## Create only when absent

After the empty UID query proves the name is absent, make one create request.
List one `--from-file=<key>=<private-path>` for every exact schema key. The
paths, never the file contents, appear in argv. This example shows a one-key
schema:

```console
kubectl --context "$AGENTOS_SECRET_CONTEXT" --namespace "$AGENTOS_SECRET_NAMESPACE" \
  create secret generic "$AGENTOS_SECRET_NAME" \
  --from-file=token="$AGENTOS_SECRET_TOKEN_FILE" \
  --dry-run=client --output=json | \
  jq --compact-output \
    --arg owner "$AGENTOS_SECRET_OWNER" \
    --arg scope "$AGENTOS_SECRET_SCOPE" \
    --arg schema "$AGENTOS_SECRET_SCHEMA" '
      .metadata.labels = {
        "app.kubernetes.io/managed-by": "agentos",
        "agentos.akua.dev/secret-owner": $owner,
        "agentos.akua.dev/secret-scope": $scope,
        "agentos.akua.dev/secret-schema": $schema
      }
      | del(.metadata.annotations, .metadata.creationTimestamp)
    ' | \
  kubectl --context "$AGENTOS_SECRET_CONTEXT" --namespace "$AGENTOS_SECRET_NAMESPACE" \
    create --filename=- >/dev/null
```

Do not replace `create` with `apply`. A racing creator must produce
`AlreadyExists`; inspect the winner before deciding whether this is an exact
retry or an ownership conflict. Do not use `--save-config`.

## Retry or rotate with an optimistic lock

An exact retry uses the same approved scope, schema, key names, and staged
files. A rotation uses fresh approved files but cannot change scope or schema.
For either operation:

1. Inspect the existing non-secret contract and save its UID and
   resourceVersion in memory.
2. Generate a complete desired Secret from the staged files, set the inspected
   resourceVersion, set the four exact labels, and delete annotations in the
   pipeline.
3. Send it with `kubectl replace --filename=-`. A stale resourceVersion must
   fail with `Conflict`; re-inspect instead of retrying blindly.

```console
kubectl --context "$AGENTOS_SECRET_CONTEXT" --namespace "$AGENTOS_SECRET_NAMESPACE" \
  create secret generic "$AGENTOS_SECRET_NAME" \
  --from-file=token="$AGENTOS_SECRET_TOKEN_FILE" \
  --dry-run=client --output=json | \
  jq --compact-output \
    --arg resourceVersion "$AGENTOS_SECRET_RESOURCE_VERSION" \
    --arg owner "$AGENTOS_SECRET_OWNER" \
    --arg scope "$AGENTOS_SECRET_SCOPE" \
    --arg schema "$AGENTOS_SECRET_SCHEMA" '
      .metadata.resourceVersion = $resourceVersion
      | .metadata.labels = {
          "app.kubernetes.io/managed-by": "agentos",
          "agentos.akua.dev/secret-owner": $owner,
          "agentos.akua.dev/secret-scope": $scope,
          "agentos.akua.dev/secret-schema": $schema
        }
      | del(.metadata.annotations, .metadata.creationTimestamp)
    ' | \
  kubectl --context "$AGENTOS_SECRET_CONTEXT" --namespace "$AGENTOS_SECRET_NAMESPACE" \
    replace --filename=- >/dev/null
```

After replacement, verify that the UID is unchanged, the exact labels and
key-name set remain, and the annotation key-name query is empty. Kubernetes may
keep the resourceVersion unchanged for a byte-identical exact retry. A rotation
or rollback whose non-secret projection marker changed must advance it. A
changed UID means deletion and recreation occurred; stop because a different
object now owns the name.

## Project and prove takeover

Mount Secret volumes read-only without `subPath`. Set `defaultMode: 0440` and
an explicit Pod `fsGroup` that only the intended workload uses. A workload that
cannot use an `fsGroup` must receive the credential through an atomic
mode-`0600` file owned by its runtime UID; do not fall back to `0644`.

Kubelet updates a normal projected Secret volume eventually. Prove rollover
with a non-secret version or expiry file from the schema, not by printing or
hashing credential bytes. Verify the file mode and group from inside the
intended container, then perform the provider's harmless authenticated probe.
Only after the new projection and provider takeover both succeed may the old
upstream key or token be revoked. Delete staging after takeover is verified.

## Take over a conflicting or historical object

Takeover is exceptional and needs approval naming the live UID, old owner,
new owner, intended scope, expected key names, annotations to remove, consumer
cutover, rollback credential, and upstream revocation order. Never copy values
from the live Secret.

Generate the desired object from independently supplied approved files and use
the guarded replacement procedure with the current resourceVersion. This
removes all annotations, including historical
`kubectl.kubernetes.io/last-applied-configuration`, while preserving the UID.
Verify metadata, projection, and a harmless provider request before revoking
the superseded upstream credential. If any inspected fact changed between
approval and replacement, stop and re-authorize.

## Roll back or revoke

Rollback is possible only while a separately staged previous upstream
credential remains valid. Re-run the guarded replacement with that file and
the current resourceVersion, then verify unchanged UID, projection rollover,
and provider health. Never retain rollback bytes in Git, a generated artifact,
or Agent home merely to make rollback possible.

For revocation, stop or remove every consumer first so no process retains the
credential. Revoke the upstream credential, remove the volume or environment
reference through the reviewed workload workflow, and verify replacement Pods
do not receive it. Re-read the Secret UID immediately before deleting the exact
name and stop if it differs from the approved UID:

```console
kubectl --context "$AGENTOS_SECRET_CONTEXT" --namespace "$AGENTOS_SECRET_NAMESPACE" \
  delete secret "$AGENTOS_SECRET_NAME" --wait=true >/dev/null
kubectl --context "$AGENTOS_SECRET_CONTEXT" --namespace "$AGENTOS_SECRET_NAMESPACE" \
  get secret "$AGENTOS_SECRET_NAME" --ignore-not-found --output=name
```

The final query must be empty. Secret deletion alone does not revoke an
upstream credential and does not prove that a running process forgot it.

## Completion evidence

Retain only the Secret name, UID, non-secret labels, key names, provider scope,
provider expiry, workload revision, verification result, and upstream
revocation result. Search captured command output, annotations, logs, and
retained artifacts for neither raw nor base64 credential bytes; do that proof
with synthetic bytes in disposable tests, never by echoing a real credential.
