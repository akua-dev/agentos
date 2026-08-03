import * as BrowserKeyValueStore from '@effect/platform-browser/BrowserKeyValueStore';
import { Effect, Layer, Schema } from 'effect';
import * as KeyValueStore from 'effect/unstable/persistence/KeyValueStore';

import {
  learnProgressStorageKey,
  LearnProgressFromString,
  parseProgress,
  type LearnProgress,
} from './progress';

export const loadLearnProgress = Effect.gen(function*() {
  const store = yield* KeyValueStore.KeyValueStore;
  const stored = yield* store.get(learnProgressStorageKey);
  return parseProgress(stored ?? null);
}).pipe(Effect.withSpan('agentos.website.loadLearnProgress'));

export const saveLearnProgress = Effect.fn('agentos.website.saveLearnProgress')(
  function*(progress: LearnProgress) {
    const store = yield* KeyValueStore.KeyValueStore;
    const encoded = yield* Schema.encodeEffect(LearnProgressFromString)(progress);
    yield* store.set(learnProgressStorageKey, encoded);
  },
);

export function learnProgressStorageLayer(
  storage?: Storage,
): Layer.Layer<KeyValueStore.KeyValueStore> {
  return storage === undefined
    ? BrowserKeyValueStore.layerLocalStorage
    : KeyValueStore.layerStorage(() => storage);
}
