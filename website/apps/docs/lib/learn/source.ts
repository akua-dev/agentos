import { Effect, Schema } from 'effect';
import type { LearnPageRecord } from './curriculum';

const LearnVideoSchema = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  transcript: Schema.optional(Schema.String),
});
export type LearnVideo = typeof LearnVideoSchema.Type;

export class LearnSourceError extends Schema.TaggedErrorClass<LearnSourceError>()(
  'LearnSourceError',
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export const validateLearnVideo = Effect.fn(
  'agentos.website.validateLearnVideo',
)(function*(value: unknown) {
  const video = yield* Schema.decodeUnknownEffect(LearnVideoSchema)(value).pipe(
    Effect.mapError((cause) =>
      new LearnSourceError({
        message: 'Learn video metadata is incomplete',
        cause,
      })
    ),
  );
  if (
    !video.url.startsWith('https://') ||
    video.title.trim().length === 0 ||
    (video.transcript !== undefined && video.transcript.trim().length === 0)
  ) {
    return yield* new LearnSourceError({
      message: 'Learn video metadata must use HTTPS and non-empty text',
    });
  }
  return video;
});

export const normalizeLearnPage = Effect.fn(
  'agentos.website.normalizeLearnPage',
)(function*(page: {
  readonly url: string;
  readonly data: Omit<LearnPageRecord, 'url'>;
}) {
  if (!isLearnUrl(page.url)) {
    return yield* new LearnSourceError({
      message: `Invalid Learn page URL: ${page.url}`,
    });
  }
  return { ...page.data, url: page.url };
});

function isLearnUrl(value: string): value is `/learn/${string}` {
  return value.startsWith('/learn/') && value !== '/learn/';
}
