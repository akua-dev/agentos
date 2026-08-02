import { assert, describe, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import * as KeyValueStore from 'effect/unstable/persistence/KeyValueStore';

import {
  learnProgressStorageKey,
  LearnProgressFromString,
} from './progress';
import { loadLearnProgress, saveLearnProgress } from './progress-storage';

describe('learning progress storage', () => {
  it.effect('normalizes compatible stored progress and persists typed JSON', () =>
    Effect.gen(function*() {
      const store = yield* KeyValueStore.KeyValueStore;
      yield* store.set(
        learnProgressStorageKey,
        '{"version":1,"completedLessonIds":["first",1,"first"]}',
      );

      assert.deepStrictEqual(yield* loadLearnProgress, {
        version: 1,
        completedLessonIds: ['first'],
      });

      yield* saveLearnProgress({
        version: 1,
        completedLessonIds: ['second'],
      });
      const stored = yield* store.get(learnProgressStorageKey);
      assert.deepStrictEqual(
        yield* Schema.decodeUnknownEffect(LearnProgressFromString)(stored),
        { version: 1, completedLessonIds: ['second'] },
      );
    }).pipe(Effect.provide(KeyValueStore.layerMemory)));

  it.effect('falls back to empty progress when the stored payload is invalid', () =>
    Effect.gen(function*() {
      const store = yield* KeyValueStore.KeyValueStore;
      yield* store.set(learnProgressStorageKey, 'invalid');

      assert.deepStrictEqual(yield* loadLearnProgress, {
        version: 1,
        completedLessonIds: [],
      });
    }).pipe(Effect.provide(KeyValueStore.layerMemory)));
});
