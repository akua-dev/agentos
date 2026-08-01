import { createHash } from "node:crypto";
import type { ProviderAuthorizationGrantV1 } from "@akua-dev/agentos";

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

export function gatewayRequestAttribution(
  grant: ProviderAuthorizationGrantV1,
): GatewayRequestAttribution {
  const assignmentId = grant.identity.assignmentId;
  const kind = assignmentId === null ? "mate" : "assignment";
  const id = assignmentId ?? grant.identity.agentId;
  if (grant.rateClass === "disabled") {
    throw new Error("disabled authorization grant cannot be attributed");
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
  };
}

export function attributedSessionKey(
  sessionKey: string | undefined,
  grant: ProviderAuthorizationGrantV1 | undefined,
): string | undefined {
  if (sessionKey === undefined || grant === undefined) return sessionKey;
  const attribution = gatewayRequestAttribution(grant);
  const digest = createHash("sha256")
    .update(attribution.key, "utf8")
    .update("\0", "utf8")
    .update(sessionKey, "utf8")
    .digest("hex");
  return `agentos-v1:${attribution.kind}:${digest}`;
}
