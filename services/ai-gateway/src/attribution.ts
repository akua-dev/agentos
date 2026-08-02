import type { ProviderAuthorizationGrantV1 } from "@akua-dev/agentos";
import { Crypto, Effect, Encoding, Schema } from "effect";

const GatewayRequestAttributionErrorCode = Schema.Literals([
  "disabled_grant",
  "crypto_unavailable",
]);

export class GatewayRequestAttributionError extends Schema.TaggedErrorClass<GatewayRequestAttributionError>()(
  "GatewayRequestAttributionError",
  { code: GatewayRequestAttributionErrorCode },
) {}

export interface GatewayRequestAttribution {
  readonly kind: "mate" | "assignment";
  readonly id: string;
  readonly key: string;
  readonly agentId: string;
  readonly profileId: string;
  readonly profileVersion: number;
  readonly rateClass: "low" | "standard" | "high";
  readonly decisionRef: string;
}

export const gatewayRequestAttribution = Effect.fn(
  "agentos.aiGateway.gatewayRequestAttribution",
)(function*(grant: ProviderAuthorizationGrantV1) {
  const assignmentId = grant.identity.assignmentId;
  const kind = assignmentId === null ? "mate" : "assignment";
  const id = assignmentId ?? grant.identity.agentId;
  if (grant.rateClass === "disabled") {
    return yield* GatewayRequestAttributionError.make({
      code: "disabled_grant",
    });
  }
  return {
    kind,
    id,
    key: `${kind}:${id}`,
    agentId: grant.identity.agentId,
    profileId: grant.profile.profileId,
    profileVersion: grant.profile.profileVersion,
    rateClass: grant.rateClass,
    decisionRef: grant.decisionRef,
  } satisfies GatewayRequestAttribution;
});

export const attributedSessionKey = Effect.fn(
  "agentos.aiGateway.attributedSessionKey",
)(function*(
  sessionKey: string | undefined,
  grant: ProviderAuthorizationGrantV1 | undefined,
): Effect.fn.Return<
  string | undefined,
  GatewayRequestAttributionError,
  Crypto.Crypto
> {
  if (sessionKey === undefined || grant === undefined) return sessionKey;
  const attribution = yield* gatewayRequestAttribution(grant);
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest(
    "SHA-256",
    new TextEncoder().encode(`${attribution.key}\0${sessionKey}`),
  ).pipe(
    Effect.mapError(() =>
      GatewayRequestAttributionError.make({ code: "crypto_unavailable" })
    ),
  );
  return `agentos-v1:${attribution.kind}:${Encoding.encodeHex(digest)}`;
});
