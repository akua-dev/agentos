import type { ValidateResult } from 'next-validate-link';
import { Effect, Runtime, Schema } from 'effect';

export class InvalidDocsLinksError extends
  Schema.TaggedErrorClass<InvalidDocsLinksError>()('InvalidDocsLinksError', {
    code: Schema.Literal('invalid_links'),
    message: Schema.String,
    count: Schema.Number,
  }) {
  override readonly [Runtime.errorExitCode] = 1;
}

export function formatLinkValidationResults(
  results: ReadonlyArray<ValidateResult>,
): string {
  const lines: Array<string> = [];
  let totalErrors = 0;
  for (const result of results) {
    if (result.errors.length === 0) continue;
    lines.push(`Invalid URLs in ${result.file}:`);
    for (const error of result.errors) {
      const reason =
        error.reason instanceof Error ? error.reason.message : error.reason;
      lines.push(
        `${error.url}: ${reason} at ${result.file}:${error.line}:${error.column}`,
      );
    }
    totalErrors += result.errors.length;
  }
  lines.push(
    `${results.filter((result) => result.errors.length > 0).length} errored files, ${totalErrors} errors`,
  );
  return `${lines.join('\n')}\n`;
}

export const assertValidLinkResults = Effect.fn(
  'agentos.website.assertValidLinkResults',
)(function*(results: ReadonlyArray<ValidateResult>) {
  const count = results.reduce(
    (total, result) => total + result.errors.length,
    0,
  );
  if (count > 0) {
    return yield* new InvalidDocsLinksError({
      code: 'invalid_links',
      message: `${count} invalid link${count === 1 ? '' : 's'} found in AgentOS documentation.`,
      count,
    });
  }
});
