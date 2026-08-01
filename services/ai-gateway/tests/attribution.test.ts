import { describe, expect, test } from "bun:test";
import type { ProviderAuthorizationGrantV1 } from "@akua-dev/agentos";

import {
  attributedSessionKey,
  gatewayRequestAttribution,
} from "../src/attribution.ts";

const AgentId = "10000000-0000-4000-8000-000000000001";
const AssignmentId = "20000000-0000-4000-8000-000000000001";

function grant(
  assignmentId: string | null = AssignmentId,
): ProviderAuthorizationGrantV1 {
  return {
    schemaVersion: 1,
    correlationId: "corr_44444444444444444444444444444444",
    decisionRef: "decision_22222222222222222222222222222222",
    expiresAtMillis: 1_785_586_015_000,
    credentialDomain: "openai-responses",
    identity: {
      agentId: AgentId,
      role: assignmentId === null ? "second_mate" : "crewmate",
      fleet: "agentos",
      domain: "engineering",
      assignmentId,
    },
    capability: "openai.responses.create",
    resource: {
      kind: "provider_service",
      provider: "openai",
      service: "responses",
    },
    profile: { profileId: "openai-responses", profileVersion: 7 },
    ceiling: {
      ceilingId: "ceiling_33333333333333333333333333333333",
      revision: 9,
    },
    rateClass: "standard",
  };
}

describe("AI Gateway canonical request attribution", () => {
  test("uses Assignment custody when present and otherwise the Mate identity", () => {
    expect(gatewayRequestAttribution(grant())).toEqual({
      kind: "assignment",
      id: AssignmentId,
      key: `assignment:${AssignmentId}`,
      agentId: AgentId,
      profileId: "openai-responses",
      profileVersion: 7,
      rateClass: "standard",
      decisionRef: "decision_22222222222222222222222222222222",
    });
    expect(gatewayRequestAttribution(grant(null))).toEqual({
      kind: "mate",
      id: AgentId,
      key: `mate:${AgentId}`,
      agentId: AgentId,
      profileId: "openai-responses",
      profileVersion: 7,
      rateClass: "standard",
      decisionRef: "decision_22222222222222222222222222222222",
    });
  });

  test("namespaces sticky sessions by canonical custody without exceeding router bounds", () => {
    const one = attributedSessionKey("conversation-a", grant());
    const same = attributedSessionKey("conversation-a", grant());
    const otherAssignment = attributedSessionKey("conversation-a", {
      ...grant(),
      identity: {
        ...grant().identity,
        assignmentId: "20000000-0000-4000-8000-000000000002",
      },
    });
    const mate = attributedSessionKey("conversation-a", grant(null));
    expect(one).toBe(same);
    expect(one).not.toBe(otherAssignment);
    expect(one).not.toBe(mate);
    expect(one).toMatch(/^agentos-v1:assignment:[0-9a-f]{64}$/);
    expect(attributedSessionKey("s".repeat(256), grant())!.length).toBeLessThan(
      128,
    );
    expect(attributedSessionKey(undefined, grant())).toBeUndefined();
    expect(attributedSessionKey("legacy", undefined)).toBe("legacy");
  });
});
