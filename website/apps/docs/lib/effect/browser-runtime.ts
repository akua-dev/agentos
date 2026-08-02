import { Effect } from 'effect';

/** One-way React adapter. The returned interruptor is the effect cleanup. */
export function runBrowserEffect<A, E>(
  program: Effect.Effect<A, E>,
): () => void {
  return Effect.runCallback(program);
}

/** One-way adapter for synchronous browser event callback contracts. */
export function runBrowserSync<A>(program: Effect.Effect<A>): A {
  return Effect.runSync(program);
}

/** One-way adapter for browser framework callbacks that require a Promise. */
export function runBrowserPromise<A, E>(
  program: Effect.Effect<A, E>,
): Promise<A> {
  return Effect.runPromise(program);
}
