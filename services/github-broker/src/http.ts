import { Context, Effect, Layer, Stream } from "effect";
import {
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";

import { type GitHubBrokerError, githubBrokerError } from "./types.ts";

export class GitHubProviderHttp extends Context.Service<
  GitHubProviderHttp,
  {
    readonly execute: (
      request: Request,
    ) => Effect.Effect<Response, GitHubBrokerError>;
  }
>()("agentos/github-broker/GitHubProviderHttp") {}

export const GitHubProviderHttpLive = Layer.effect(
  GitHubProviderHttp,
  Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient;
    return GitHubProviderHttp.of({
      execute: Effect.fn("agentos.githubBroker.http.execute")(function*(
        request,
      ) {
        const clientRequest = yield* Effect.try({
          try: () => HttpClientRequest.fromWeb(request),
          catch: () => githubBrokerError("provider_unavailable"),
        });
        const response = yield* client.execute(clientRequest).pipe(
          Effect.mapError(() => githubBrokerError("provider_unavailable")),
        );
        const hasNoBody = request.method === "HEAD" || response.status === 204 ||
          response.status === 304;
        const body = hasNoBody
          ? null
          : yield* Stream.toReadableStreamEffect(
            response.stream.pipe(
              Stream.mapError(() =>
                githubBrokerError("provider_unavailable")
              ),
            ),
          );
        return yield* Effect.try({
          try: () =>
            new Response(body, {
              status: response.status,
              headers: Object.entries(response.headers),
            }),
          catch: () => githubBrokerError("provider_unavailable"),
        });
      }),
    });
  }),
);
