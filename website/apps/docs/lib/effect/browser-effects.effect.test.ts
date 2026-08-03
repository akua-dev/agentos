import { assert, describe, it } from '@effect/vitest';
import { Effect, Fiber, Ref } from 'effect';
import { TestClock } from 'effect/testing';

import { delayBrowserEffect, loadBrowserModule } from './browser-effects';

describe('browser Effects', () => {
  it.effect('uses the Effect clock for delayed browser work', () =>
    Effect.gen(function*() {
      const completed = yield* Ref.make(false);
      const fiber = yield* Effect.forkChild(
        delayBrowserEffect('250 millis', Ref.set(completed, true)),
      );

      yield* Effect.yieldNow;
      assert.isFalse(yield* Ref.get(completed));
      yield* TestClock.adjust('250 millis');
      yield* Fiber.join(fiber);
      assert.isTrue(yield* Ref.get(completed));
    }));

  it.effect('reports dynamic module failures in the typed channel', () =>
    Effect.gen(function*() {
      const failure = yield* loadBrowserModule('broken', () =>
        Promise.reject(new Error('missing')),
      ).pipe(Effect.flip);

      assert.strictEqual(failure._tag, 'BrowserModuleError');
      assert.include(failure.message, 'broken');
    }));
});
