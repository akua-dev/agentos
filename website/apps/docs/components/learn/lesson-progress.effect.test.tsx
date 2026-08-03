// @vitest-environment jsdom

import { assert, describe, it } from '@effect/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Effect, Schema } from 'effect';
import type { ReactNode } from 'react';

import { LessonProgress, LearnProgressSummary } from './lesson-progress';
import {
  LearnProgressFromString,
  learnProgressStorageKey,
} from '@/lib/learn/progress';

class LessonProgressTestError extends Schema.TaggedErrorClass<LessonProgressTestError>()(
  'LessonProgressTestError',
  { detail: Schema.String },
) {}

class MemoryStorageAdapter implements Storage {
  readonly #values: Map<string, string>;

  constructor(initial: Readonly<Record<string, string>> = {}) {
    this.#values = new Map(Object.entries(initial));
  }

  get length() {
    return this.#values.size;
  }

  clear() {
    this.#values.clear();
  }

  getItem(key: string) {
    return this.#values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.#values.delete(key);
  }

  setItem(key: string, value: string) {
    this.#values.set(key, value);
  }
}

class DeniedStorageAdapter extends MemoryStorageAdapter {
  override getItem(): string | null {
    return decodeURIComponent('%');
  }

  override setItem(): void {
    decodeURIComponent('%');
  }
}

const renderScoped = (children: ReactNode) =>
  Effect.acquireRelease(
    Effect.sync(() => render(children)),
    () => Effect.sync(cleanup),
  );

const findByRole = Effect.fn('test.lessonProgress.findByRole')(
  (role: 'button', name: string) =>
    Effect.tryPromise({
      try: () => screen.findByRole(role, { name }),
      catch: () => LessonProgressTestError.make({ detail: `Missing ${name}` }),
    }),
);

const findByText = Effect.fn('test.lessonProgress.findByText')((text: string) =>
  Effect.tryPromise({
    try: () => screen.findByText(text),
    catch: () => LessonProgressTestError.make({ detail: `Missing ${text}` }),
  }));

const readStoredProgress = Effect.fn('test.lessonProgress.readStored')(
  function*(storage: Storage) {
    const stored = yield* Effect.try({
      try: () => storage.getItem(learnProgressStorageKey),
      catch: () => LessonProgressTestError.make({ detail: 'Storage read failed' }),
    });
    if (stored === null) {
      return yield* LessonProgressTestError.make({ detail: 'Progress was not stored' });
    }
    return yield* Schema.decodeUnknownEffect(LearnProgressFromString)(stored);
  },
);

describe('LessonProgress', () => {
  it.effect('hydrates completion and persists a toggle', () =>
    Effect.gen(function* () {
      const initial = yield* Schema.encodeEffect(LearnProgressFromString)({
        version: 1,
        completedLessonIds: ['first'],
      });
      const storage = new MemoryStorageAdapter({
        [learnProgressStorageKey]: initial,
      });
      yield* renderScoped(
        <LessonProgress lessonId="first" validLessonIds={['first', 'second']} storage={storage} />,
      );
      const button = yield* findByRole('button', 'Mark incomplete');
      assert.strictEqual(button.getAttribute('aria-pressed'), 'true');
      yield* Effect.sync(() => fireEvent.click(button));
      assert.strictEqual(button.getAttribute('aria-pressed'), 'false');
      assert.deepStrictEqual(yield* readStoredProgress(storage), {
        version: 1,
        completedLessonIds: [],
      });
    }));

  it.effect('ignores unknown IDs in the visible count and resets known progress', () =>
    Effect.gen(function* () {
      const initial = yield* Schema.encodeEffect(LearnProgressFromString)({
        version: 1,
        completedLessonIds: ['first', 'removed'],
      });
      const storage = new MemoryStorageAdapter({
        [learnProgressStorageKey]: initial,
      });
      yield* renderScoped(
        <LearnProgressSummary validLessonIds={['first', 'second']} storage={storage} />,
      );
      assert.ok(yield* findByText('1 of 2 complete'));
      const reset = screen.getByRole('button', { name: 'Reset progress' });
      yield* Effect.sync(() => fireEvent.click(reset));
      assert.ok(yield* findByText('0 of 2 complete'));
    }));

  it.effect('keeps the control usable when storage throws', () =>
    Effect.gen(function* () {
      const storage = new DeniedStorageAdapter();
      yield* renderScoped(
        <LessonProgress lessonId="first" validLessonIds={['first']} storage={storage} />,
      );
      const button = yield* findByRole('button', 'Mark complete');
      yield* Effect.sync(() => fireEvent.click(button));
      assert.strictEqual(button.getAttribute('aria-pressed'), 'true');
    }));
});
