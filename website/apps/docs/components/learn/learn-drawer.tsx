'use client';

import { Menu, X } from 'lucide-react';
import { useRef } from 'react';
import type { Curriculum } from '@/lib/learn/curriculum';
import { CurriculumNavigation, type LearnSelection } from './learn-sidebar';

export function LearnDrawer({
  curriculum,
  selection,
}: {
  curriculum: Curriculum;
  selection: LearnSelection;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const selectedTitle =
    selection.kind === 'introduction'
      ? 'Introduction'
      : (curriculum.lessons.find((lesson) => lesson.lessonId === selection.lessonId)?.title ??
        'AgentOS Learn');

  function close() {
    dialogRef.current?.close();
  }

  return (
    <div className="sticky top-14 z-20 flex items-center justify-between border-y bg-fd-background/95 px-4 py-2 backdrop-blur lg:hidden">
      <p className="truncate text-sm font-medium">{selectedTitle}</p>
      <button
        ref={openerRef}
        type="button"
        aria-label="Open curriculum"
        onClick={() => dialogRef.current?.showModal()}
        className="rounded-md border p-2 hover:bg-fd-accent"
      >
        <Menu className="size-4" aria-hidden />
      </button>
      <dialog
        ref={dialogRef}
        aria-label="Learn curriculum"
        onClose={() => openerRef.current?.focus()}
        className="m-0 h-dvh max-h-none w-[min(88vw,360px)] max-w-none border-r bg-fd-background p-0 text-fd-foreground shadow-2xl backdrop:bg-black/50"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-fd-background px-4 py-3">
          <p className="font-medium">AgentOS Learn</p>
          <button
            type="button"
            aria-label="Close curriculum"
            onClick={close}
            className="rounded-md border p-2 hover:bg-fd-accent"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="h-[calc(100dvh-57px)] overflow-y-auto px-3 py-6">
          <CurriculumNavigation
            curriculum={curriculum}
            selection={selection}
            onNavigate={close}
          />
        </div>
      </dialog>
    </div>
  );
}
