import { Effect } from 'effect';

/** One-way Next.js adapter. Domain and route logic stays in Effect programs. */
export function runServerEffect<A, E>(program: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(program);
}

/** One-way adapter for framework configuration that must be evaluated synchronously. */
export function runServerSync<A>(program: Effect.Effect<A>): A {
  return Effect.runSync(program);
}
