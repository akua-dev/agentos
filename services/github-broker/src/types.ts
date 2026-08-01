import { Schema } from "effect";

export const GitHubBrokerErrorCodeSchema = Schema.Literals([
  "credential_unavailable",
  "invalid_configuration",
  "invalid_grant",
  "provider_unavailable",
  "unsupported_route",
]);

export class GitHubBrokerError extends Schema.TaggedErrorClass<GitHubBrokerError>()(
  "GitHubBrokerError",
  { code: GitHubBrokerErrorCodeSchema },
) {}

export function githubBrokerError(code: GitHubBrokerError["code"]) {
  return GitHubBrokerError.make({ code });
}
