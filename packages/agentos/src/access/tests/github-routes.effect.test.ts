import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  resolveProviderAuthorizationRoute,
} from "../http-authorizer.ts";

const repository = {
  kind: "github_repository",
  owner: "akua-dev",
  repository: "agentos",
} as const;

describe("GitHub provider authorization routes", () => {
  it.effect("classifies repository-scoped REST reads and writes", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(
        yield* resolveProviderAuthorizationRoute(
          "GET",
          "/api/v3/repos/akua-dev/agentos/issues/94/comments?per_page=100",
        ),
        {
          credentialDomain: "github",
          provider: "github",
          capability: "github.issue.read",
          resource: repository,
        },
      );
      assert.deepStrictEqual(
        yield* resolveProviderAuthorizationRoute(
          "POST",
          "/api/v3/repos/akua-dev/agentos/issues/94/comments",
        ),
        {
          credentialDomain: "github",
          provider: "github",
          capability: "github.issue.write",
          resource: repository,
        },
      );
      assert.deepStrictEqual(
        yield* resolveProviderAuthorizationRoute(
          "POST",
          "/api/v3/repos/akua-dev/agentos/actions/workflows/ci.yml/dispatches",
        ),
        {
          credentialDomain: "github",
          provider: "github",
          capability: "github.actions.dispatch",
          resource: repository,
        },
      );
    }));

  it.effect("classifies Git smart HTTP without broadening receive-pack", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(
        yield* resolveProviderAuthorizationRoute(
          "GET",
          "/akua-dev/agentos.git/info/refs?service=git-upload-pack",
        ),
        {
          credentialDomain: "github",
          provider: "github",
          capability: "github.repository.read",
          resource: repository,
        },
      );
      assert.deepStrictEqual(
        yield* resolveProviderAuthorizationRoute(
          "POST",
          "/akua-dev/agentos.git/git-receive-pack",
        ),
        {
          credentialDomain: "github",
          provider: "github",
          capability: "github.contents.write",
          resource: repository,
        },
      );
    }));

  it.effect("classifies a bounded GraphQL query from its exact repository", () =>
    Effect.gen(function*() {
      const body = JSON.stringify({
        operationName: "PullRequestView",
        query: `query PullRequestView($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) { number title state }
          }
        }`,
        variables: { owner: "akua-dev", name: "agentos", number: 149 },
      });
      assert.deepStrictEqual(
        yield* resolveProviderAuthorizationRoute(
          "POST",
          "/api/graphql",
          { body },
        ),
        {
          credentialDomain: "github",
          provider: "github",
          capability: "github.pull_request.read",
          resource: repository,
        },
      );
    }));

  it.effect("rejects opaque GraphQL node mutations even with a repository hint", () =>
    Effect.gen(function*() {
      const body = JSON.stringify({
        operationName: "MarkPullRequestReadyForReview",
        query: `mutation MarkPullRequestReadyForReview($pullRequestId: ID!) {
          markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
            pullRequest { id }
          }
        }`,
        variables: { pullRequestId: "PR_kwDOExample" },
      });
      const failure = yield* resolveProviderAuthorizationRoute(
          "POST",
          "/api/graphql",
          { body, githubRepository: "akua-dev/agentos" },
        ).pipe(Effect.flip);
      assert.strictEqual(failure.code, "unsupported_route");
    }));

  it.effect("denies ambiguous, mismatched, and unsupported GitHub operations", () =>
    Effect.gen(function*() {
      const mutation = JSON.stringify({
        query: "mutation { deleteRepository(input: { repositoryId: \"R_1\" }) { clientMutationId } }",
      });
      const mismatch = JSON.stringify({
        query: `query($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) { issues(first: 1) { totalCount } }
        }`,
        variables: { owner: "other", name: "repository" },
      });

      const unsupported = yield* resolveProviderAuthorizationRoute(
        "POST",
        "/api/graphql",
        { body: mutation, githubRepository: "akua-dev/agentos" },
      ).pipe(Effect.flip);
      assert.strictEqual(unsupported.code, "unsupported_route");

      const mismatched = yield* resolveProviderAuthorizationRoute(
        "POST",
        "/api/graphql",
        { body: mismatch, githubRepository: "akua-dev/agentos" },
      ).pipe(Effect.flip);
      assert.strictEqual(mismatched.code, "resource_mismatch");

      const broad = yield* resolveProviderAuthorizationRoute(
        "DELETE",
        "/api/v3/repos/akua-dev/agentos",
      ).pipe(Effect.flip);
      assert.strictEqual(broad.code, "unsupported_route");
    }));
});
