import { assert, describe, it } from "@effect/vitest";
import {
  ProviderBudgetSettlementHttpError,
  ProviderBudgetSettlementReporter,
  providerAuthorizationGrantHeaders,
  type ProviderBudgetSettlementReportV1,
  type ProviderAuthorizationGrantV1,
} from "@akua-dev/agentos";
import { Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";

import {
  handleGitHubBrokerRequest,
  makeGitHubBrokerHandler,
  serveGitHubBrokerRequest,
} from "../src/broker.ts";
import { GitHubProviderHttp } from "../src/http.ts";
import type {
  GitHubInstallationTokenLease,
  GitHubInstallationTokenProvider,
  GitHubInstallationTokenScope,
} from "../src/token.ts";
import { githubBrokerError } from "../src/types.ts";

const now = 1_785_586_000_000;

const successfulSettlements = ProviderBudgetSettlementReporter.of({
  report: (report) => Effect.succeed({
    schemaVersion: 1,
    decisionRef: report.decisionRef,
    outcome: "settled",
  }),
});

function grant(
  capability: ProviderAuthorizationGrantV1["capability"] =
    "github.issue.read",
): ProviderAuthorizationGrantV1 {
  return {
    schemaVersion: 1,
    correlationId: "corr_44444444444444444444444444444444",
    decisionRef: "decision_22222222222222222222222222222222",
    expiresAtMillis: now + 15_000,
    credentialDomain: "github",
    identity: {
      agentId: "10000000-0000-4000-8000-000000000001",
      role: "crewmate",
      fleet: "agentos",
      domain: "engineering",
      assignmentId: "20000000-0000-4000-8000-000000000001",
    },
    capability,
    resource: {
      kind: "github_repository",
      owner: "akua-dev",
      repository: "agentos",
    },
    profile: { profileId: "github-maintainer", profileVersion: 7 },
    ceiling: {
      ceilingId: "ceiling_33333333333333333333333333333333",
      revision: 9,
    },
    rateClass: "standard",
  };
}

function brokerRequest(
  path: string,
  method = "GET",
  authorization = grant(),
  body?: string,
): Request {
  const headers = providerAuthorizationGrantHeaders(authorization);
  headers.set("authorization", "Bearer projected-service-account-jwt");
  headers.set("x-agentos-github-repository", "forged/target");
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(`http://github-broker.test${path}`, {
    method,
    headers,
    body,
  });
}

const makeTokenProvider = Effect.fn("test.githubBroker.makeTokenProvider")(
  function*(tokens: ReadonlyArray<string> = ["ghs_provider_secret"]) {
    const acquired = yield* Ref.make<ReadonlyArray<
      GitHubInstallationTokenScope
    >>([]);
    const invalidated = yield* Ref.make<ReadonlyArray<
      GitHubInstallationTokenScope
    >>([]);
    const index = yield* Ref.make(0);
    const provider: GitHubInstallationTokenProvider = {
      check: Effect.void,
      acquire: (scope) =>
        Effect.gen(function*() {
          yield* Ref.update(acquired, (current) => [...current, scope]);
          const currentIndex = yield* Ref.getAndUpdate(
            index,
            (value) => value + 1,
          );
          const token = tokens[Math.min(currentIndex, tokens.length - 1)] ??
            "ghs_provider_secret";
          const lease: GitHubInstallationTokenLease = {
            token,
            expiresAtMillis: now + 60 * 60_000,
          };
          return lease;
        }),
      invalidate: (scope) =>
        Ref.update(invalidated, (current) => [...current, scope]),
    };
    return { acquired, invalidated, provider };
  },
);

describe("GitHub workload broker", () => {
  it.effect("keeps liveness independent while semantic readiness fails closed", () =>
    Effect.gen(function*() {
      const handler = (_request: Request) =>
        Effect.succeed(Response.json({ unexpected: true }));
      const live = yield* serveGitHubBrokerRequest(
        handler,
        {
          check: Effect.fail(githubBrokerError("credential_unavailable")),
          timeoutMillis: 100,
        },
        new Request("http://github-broker.test/livez"),
      );
      assert.strictEqual(live.status, 200);

      const ready = yield* serveGitHubBrokerRequest(
        handler,
        { check: Effect.void, timeoutMillis: 100 },
        new Request("http://github-broker.test/readyz"),
      );
      assert.strictEqual(ready.status, 200);

      const unavailable = yield* serveGitHubBrokerRequest(
        handler,
        {
          check: Effect.fail(githubBrokerError("credential_unavailable")),
          timeoutMillis: 100,
        },
        new Request("http://github-broker.test/readyz"),
      );
      assert.strictEqual(unavailable.status, 503);
      assert.deepStrictEqual(
        yield* Effect.tryPromise(() => unavailable.json()),
        { status: "not_ready" },
      );

      const timed = yield* Effect.forkChild(
        serveGitHubBrokerRequest(
          handler,
          { check: Effect.never, timeoutMillis: 100 },
          new Request("http://github-broker.test/readyz"),
        ),
        { startImmediately: true },
      );
      yield* TestClock.adjust(100);
      assert.strictEqual((yield* Fiber.join(timed)).status, 503);
    }));

  it.effect("forwards an allowed REST call with only an exact scoped installation token", () =>
    Effect.gen(function*() {
      const tokens = yield* makeTokenProvider();
      const upstream = yield* Ref.make<Request | undefined>(undefined);
      const http = GitHubProviderHttp.of({
        execute: (request) =>
          Ref.set(upstream, request).pipe(
            Effect.as(Response.json({ title: "native result" }, {
              status: 200,
              headers: { "x-github-request-id": "provider-request" },
            })),
          ),
      });
      const handler = yield* makeGitHubBrokerHandler({
        tokens: tokens.provider,
        apiUrl: "https://api.github.test",
        gitUrl: "https://github.test",
        settlements: successfulSettlements,
        now: Effect.succeed(now),
      }).pipe(Effect.provideService(GitHubProviderHttp, http));
      const response = yield* handleGitHubBrokerRequest(
        handler,
        brokerRequest("/api/v3/repos/akua-dev/agentos/issues/94"),
      );
      assert.strictEqual(response.status, 200);
      assert.strictEqual(
        yield* Effect.tryPromise(() => response.text()),
        '{"title":"native result"}',
      );
      assert.strictEqual(
        response.headers.get("x-github-request-id"),
        "provider-request",
      );
      const observed = yield* Ref.get(upstream);
      assert.strictEqual(
        observed?.url,
        "https://api.github.test/repos/akua-dev/agentos/issues/94",
      );
      assert.strictEqual(
        observed?.headers.get("authorization"),
        "Bearer ghs_provider_secret",
      );
      assert.deepStrictEqual(
        observed === undefined
          ? []
          : [...observed.headers.keys()].filter((name) =>
            name.startsWith("x-agentos-")
          ),
        [],
      );
      assert.deepStrictEqual(yield* Ref.get(tokens.acquired), [{
        owner: "akua-dev",
        repository: "agentos",
        permissions: { issues: "read" },
      }]);
    }));

  it.effect("never acquires a credential for a missing or route-mismatched grant", () =>
    Effect.gen(function*() {
      const tokens = yield* makeTokenProvider();
      const upstreamCalls = yield* Ref.make(0);
      const http = GitHubProviderHttp.of({
        execute: () =>
          Ref.update(upstreamCalls, (value) => value + 1).pipe(
            Effect.as(new Response("unexpected")),
          ),
      });
      const handler = yield* makeGitHubBrokerHandler({
        tokens: tokens.provider,
        apiUrl: "https://api.github.test",
        gitUrl: "https://github.test",
        settlements: successfulSettlements,
        now: Effect.succeed(now),
      }).pipe(Effect.provideService(GitHubProviderHttp, http));
      const missing = brokerRequest(
        "/api/v3/repos/akua-dev/agentos/issues/94",
      );
      missing.headers.delete("x-agentos-authz-decision-ref");
      assert.strictEqual(
        (yield* handleGitHubBrokerRequest(handler, missing)).status,
        401,
      );
      assert.strictEqual(
        (yield* handleGitHubBrokerRequest(
          handler,
          brokerRequest(
            "/api/v3/repos/akua-dev/agentos/pulls/149",
            "GET",
            grant("github.issue.read"),
          ),
        )).status,
        403,
      );
      assert.deepStrictEqual(yield* Ref.get(tokens.acquired), []);
      assert.strictEqual(yield* Ref.get(upstreamCalls), 0);
    }));

  it.effect("uses Basic installation auth for smart HTTP and preserves native failures", () =>
    Effect.gen(function*() {
      const tokens = yield* makeTokenProvider();
      const upstream = yield* Ref.make<Request | undefined>(undefined);
      const http = GitHubProviderHttp.of({
        execute: (request) =>
          Ref.set(upstream, request).pipe(
            Effect.as(new Response("remote: protected branch\n", {
              status: 422,
              statusText: "Unprocessable Content",
              headers: { "content-type": "text/plain" },
            })),
          ),
      });
      const handler = yield* makeGitHubBrokerHandler({
        tokens: tokens.provider,
        apiUrl: "https://api.github.test",
        gitUrl: "https://github.test",
        settlements: successfulSettlements,
        now: Effect.succeed(now),
      }).pipe(Effect.provideService(GitHubProviderHttp, http));
      const response = yield* handleGitHubBrokerRequest(
        handler,
        brokerRequest(
          "/akua-dev/agentos.git/git-receive-pack",
          "POST",
          grant("github.contents.write"),
          "0000",
        ),
      );
      assert.strictEqual(response.status, 422);
      assert.strictEqual(response.statusText, "Unprocessable Content");
      assert.strictEqual(
        yield* Effect.tryPromise(() => response.text()),
        "remote: protected branch\n",
      );
      const observed = yield* Ref.get(upstream);
      assert.strictEqual(
        observed?.url,
        "https://github.test/akua-dev/agentos.git/git-receive-pack",
      );
      assert.strictEqual(
        observed?.headers.get("authorization"),
        `Basic ${Buffer.from("x-access-token:ghs_provider_secret").toString("base64")}`,
      );
      assert.deepStrictEqual(
        (yield* Ref.get(tokens.acquired))[0]?.permissions,
        { contents: "write" },
      );
    }));

  it.effect("permits repository-bound GraphQL reads and rejects opaque mutations", () =>
    Effect.gen(function*() {
      const tokens = yield* makeTokenProvider();
      const upstreamBodies = yield* Ref.make<ReadonlyArray<string>>([]);
      const http = GitHubProviderHttp.of({
        execute: Effect.fn("test.githubBroker.graphqlHttp")(function*(
          request: Request,
        ) {
          const body = yield* Effect.tryPromise({
            try: () => request.text(),
            catch: () => githubBrokerError("provider_unavailable"),
          });
          yield* Ref.update(upstreamBodies, (current) => [...current, body]);
          return Response.json({ data: { repository: { pullRequest: {} } } });
        }),
      });
      const handler = yield* makeGitHubBrokerHandler({
        tokens: tokens.provider,
        apiUrl: "https://api.github.test",
        gitUrl: "https://github.test",
        settlements: successfulSettlements,
        now: Effect.succeed(now),
      }).pipe(Effect.provideService(GitHubProviderHttp, http));
      const readBody = JSON.stringify({
        query: "query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){pullRequest(number:149){id}}}",
        variables: { owner: "akua-dev", repo: "agentos" },
      });
      assert.strictEqual(
        (yield* handleGitHubBrokerRequest(
          handler,
          brokerRequest(
            "/api/graphql",
            "POST",
            grant("github.pull_request.read"),
            readBody,
          ),
        )).status,
        200,
      );
      const mutationBody = JSON.stringify({
        query: "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}",
        variables: { id: "PR_kwDOExample" },
      });
      assert.strictEqual(
        (yield* handleGitHubBrokerRequest(
          handler,
          brokerRequest(
            "/api/graphql",
            "POST",
            grant("github.pull_request.write"),
            mutationBody,
          ),
        )).status,
        403,
      );
      assert.deepStrictEqual(yield* Ref.get(upstreamBodies), [readBody]);
      assert.strictEqual((yield* Ref.get(tokens.acquired)).length, 1);
    }));

  it.effect("invalidates a rejected installation token for the next native call", () =>
    Effect.gen(function*() {
      const tokens = yield* makeTokenProvider(["ghs_stale", "ghs_fresh"]);
      const authorizations = yield* Ref.make<ReadonlyArray<string>>([]);
      const http = GitHubProviderHttp.of({
        execute: Effect.fn("test.githubBroker.retryHttp")(function*(request) {
          const authorization = request.headers.get("authorization") ?? "";
          yield* Ref.update(authorizations, (current) => [
            ...current,
            authorization,
          ]);
          return authorization.includes("ghs_stale")
            ? Response.json({ message: "Bad credentials" }, { status: 401 })
            : Response.json({ ok: true });
        }),
      });
      const handler = yield* makeGitHubBrokerHandler({
        tokens: tokens.provider,
        apiUrl: "https://api.github.test",
        gitUrl: "https://github.test",
        settlements: successfulSettlements,
        now: Effect.succeed(now),
      }).pipe(Effect.provideService(GitHubProviderHttp, http));
      const first = yield* handleGitHubBrokerRequest(
        handler,
        brokerRequest("/api/v3/repos/akua-dev/agentos/issues/94"),
      );
      assert.strictEqual(first.status, 401);
      assert.strictEqual((yield* Ref.get(tokens.invalidated)).length, 1);
      const second = yield* handleGitHubBrokerRequest(
        handler,
        brokerRequest("/api/v3/repos/akua-dev/agentos/issues/94"),
      );
      assert.strictEqual(second.status, 200);
      assert.deepStrictEqual(yield* Ref.get(authorizations), [
        "Bearer ghs_stale",
        "Bearer ghs_fresh",
      ]);
    }));

  it.effect("settles completed and provider-rejected forwards after their bodies terminate", () =>
    Effect.gen(function*() {
      const tokens = yield* makeTokenProvider();
      const reports = yield* Ref.make<ReadonlyArray<
        ProviderBudgetSettlementReportV1
      >>([]);
      const statuses = yield* Ref.make<ReadonlyArray<number>>([200, 422]);
      const http = GitHubProviderHttp.of({
        execute: () =>
          Ref.modify(statuses, (remaining) => [
            new Response("provider body", { status: remaining[0] ?? 500 }),
            remaining.slice(1),
          ]),
      });
      const settlements = ProviderBudgetSettlementReporter.of({
        report: (report) =>
          Ref.update(reports, (current) => [...current, report]).pipe(
            Effect.as({
              schemaVersion: 1,
              decisionRef: report.decisionRef,
              outcome: "settled",
            }),
          ),
      });
      const handler = yield* makeGitHubBrokerHandler({
        tokens: tokens.provider,
        apiUrl: "https://api.github.test",
        gitUrl: "https://github.test",
        settlements,
        now: Effect.succeed(now),
      }).pipe(Effect.provideService(GitHubProviderHttp, http));

      const completed = yield* handleGitHubBrokerRequest(
        handler,
        brokerRequest("/api/v3/repos/akua-dev/agentos/issues/94"),
      );
      assert.deepStrictEqual(yield* Ref.get(reports), []);
      yield* Effect.tryPromise(() => completed.text());

      const rejected = yield* handleGitHubBrokerRequest(
        handler,
        brokerRequest("/api/v3/repos/akua-dev/agentos/issues/94"),
      );
      yield* Effect.tryPromise(() => rejected.text());
      assert.deepStrictEqual(yield* Ref.get(reports), [
        {
          schemaVersion: 1,
          decisionRef: grant().decisionRef,
          forwardOutcome: "completed",
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          spendMicros: 0,
        },
        {
          schemaVersion: 1,
          decisionRef: grant().decisionRef,
          forwardOutcome: "provider_rejected",
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          spendMicros: 0,
        },
      ]);
    }));

  it.effect("settles transport failures while a settlement outage never replaces provider semantics", () =>
    Effect.gen(function*() {
      const tokens = yield* makeTokenProvider();
      const reports = yield* Ref.make<ReadonlyArray<
        ProviderBudgetSettlementReportV1
      >>([]);
      const transportFailure = GitHubProviderHttp.of({
        execute: () => Effect.fail(githubBrokerError("provider_unavailable")),
      });
      const recordingSettlements = ProviderBudgetSettlementReporter.of({
        report: (report) =>
          Ref.update(reports, (current) => [...current, report]).pipe(
            Effect.as({
              schemaVersion: 1,
              decisionRef: report.decisionRef,
              outcome: "settled",
            }),
          ),
      });
      const failedHandler = yield* makeGitHubBrokerHandler({
        tokens: tokens.provider,
        apiUrl: "https://api.github.test",
        gitUrl: "https://github.test",
        settlements: recordingSettlements,
        now: Effect.succeed(now),
      }).pipe(Effect.provideService(GitHubProviderHttp, transportFailure));
      assert.strictEqual((yield* handleGitHubBrokerRequest(
        failedHandler,
        brokerRequest("/api/v3/repos/akua-dev/agentos/issues/94"),
      )).status, 502);
      assert.deepStrictEqual(
        (yield* Ref.get(reports)).map(({ forwardOutcome }) => forwardOutcome),
        ["transport_failed"],
      );

      const upstream = GitHubProviderHttp.of({
        execute: () => Effect.succeed(new Response("native response")),
      });
      const unavailableSettlements = ProviderBudgetSettlementReporter.of({
        report: () =>
          Effect.fail(ProviderBudgetSettlementHttpError.make({
            code: "dependency_unavailable",
            status: 503,
          })),
      });
      const preservedHandler = yield* makeGitHubBrokerHandler({
        tokens: tokens.provider,
        apiUrl: "https://api.github.test",
        gitUrl: "https://github.test",
        settlements: unavailableSettlements,
        now: Effect.succeed(now),
      }).pipe(Effect.provideService(GitHubProviderHttp, upstream));
      const preserved = yield* handleGitHubBrokerRequest(
        preservedHandler,
        brokerRequest("/api/v3/repos/akua-dev/agentos/issues/94"),
      );
      assert.strictEqual(preserved.status, 200);
      assert.strictEqual(
        yield* Effect.tryPromise(() => preserved.text()),
        "native response",
      );
    }));

  it.effect("settles a downstream-cancelled response as cancelled exactly once", () =>
    Effect.gen(function*() {
      const tokens = yield* makeTokenProvider();
      const reports = yield* Ref.make<ReadonlyArray<
        ProviderBudgetSettlementReportV1
      >>([]);
      const http = GitHubProviderHttp.of({
        execute: () => Effect.succeed(new Response(new ReadableStream({
          pull: (controller) => controller.enqueue(new Uint8Array([1])),
        }))),
      });
      const settlements = ProviderBudgetSettlementReporter.of({
        report: (report) =>
          Ref.update(reports, (current) => [...current, report]).pipe(
            Effect.as({
              schemaVersion: 1,
              decisionRef: report.decisionRef,
              outcome: "settled",
            }),
          ),
      });
      const handler = yield* makeGitHubBrokerHandler({
        tokens: tokens.provider,
        apiUrl: "https://api.github.test",
        gitUrl: "https://github.test",
        settlements,
        now: Effect.succeed(now),
      }).pipe(Effect.provideService(GitHubProviderHttp, http));
      const response = yield* handleGitHubBrokerRequest(
        handler,
        brokerRequest("/api/v3/repos/akua-dev/agentos/issues/94"),
      );
      const body = response.body;
      assert.isNotNull(body);
      if (body !== null) {
        yield* Effect.tryPromise(() => body.cancel());
      }
      assert.deepStrictEqual(
        (yield* Ref.get(reports)).map(({ forwardOutcome }) => forwardOutcome),
        ["cancelled"],
      );
    }));
});
