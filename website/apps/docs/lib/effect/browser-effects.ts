import { Duration, Effect, Schema } from 'effect';

export class BrowserModuleError extends
  Schema.TaggedErrorClass<BrowserModuleError>()('BrowserModuleError', {
    moduleName: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {}

export function delayBrowserEffect<A, E, R>(
  duration: Duration.Input,
  program: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.sleep(duration).pipe(Effect.andThen(program));
}

export const loadBrowserModule = Effect.fn('agentos.website.loadBrowserModule')(
  <Module>(moduleName: string, load: () => Promise<Module>) =>
    Effect.tryPromise({
      try: load,
      catch: (cause) =>
        new BrowserModuleError({
          moduleName,
          message: `Could not load browser module: ${moduleName}`,
          cause,
        }),
    }),
);
