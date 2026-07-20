import { describe, expect, test } from "bun:test";
import {
  CodexUsageParseError,
  fetchCodexUsage,
  parseCodexUsage,
} from "../src/usage.ts";

describe("Codex quota observations", () => {
  test("normalizes the short and weekly windows without retaining the raw payload", () => {
    expect(
      parseCodexUsage(
        {
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: 12,
              limit_window_seconds: 18_000,
              reset_at: 2_000_000_000,
            },
            secondary_window: {
              used_percent: 34,
              limit_window_seconds: 604_800,
              reset_at: 2_000_100_000,
            },
          },
          ignored_secret_shape: { token: "must-not-survive" },
        },
        1_000,
        "managed-a",
      ),
    ).toEqual({
      accountId: "managed-a",
      observedAt: 1_000,
      shortWindow: { usedPercent: 12, resetsAt: 2_000_000_000_000 },
      weeklyWindow: { usedPercent: 34, resetsAt: 2_000_100_000_000 },
      stale: false,
      planType: "pro",
    });
  });

  test("rejects an unknown provider payload shape", () => {
    expect(() => parseCodexUsage({ rate_limit: {} }, 1_000, "managed-a")).toThrow(
      CodexUsageParseError,
    );
  });

  test("sends only the selected OAuth identity and reports HTTP status without response body", async () => {
    let observed: Request | undefined;
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      observed = new Request(input instanceof Request ? input.url : input.toString(), init);
      return new Response("provider secret body", { status: 429 });
    };

    await expect(
      fetchCodexUsage({
        accessToken: "access-secret",
        providerAccountId: "provider-account",
        managedAccountId: "managed-a",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ status: 429, message: "Codex usage endpoint returned HTTP 429" });
    expect(observed?.headers.get("authorization")).toBe("Bearer access-secret");
    expect(observed?.headers.get("chatgpt-account-id")).toBe("provider-account");
  });
});
