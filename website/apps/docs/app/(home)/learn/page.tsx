import type { Metadata } from 'next';
import Link from 'next/link';
import { CourseMap } from '@/components/learn/course-map';
import { getCurriculum } from '@/lib/learn/curriculum.server';

export const metadata: Metadata = {
  title: 'Learn to build an autonomous company',
  description:
    'Four guided AgentOS courses from models and Agents to operating a sovereign autonomous company.',
};

export default function Page() {
  const curriculum = getCurriculum();

  return (
    <main className="mx-auto w-full max-w-[1200px] px-5 py-14 sm:px-8 md:py-20">
      <p className="mb-4 text-xs font-medium tracking-wide text-brand uppercase">AgentOS Learn</p>
      <h1 className="max-w-[900px] text-4xl font-semibold tracking-[-0.04em] text-balance md:text-6xl">
        Learn to build an autonomous company.
      </h1>
      <p className="mt-6 mb-10 max-w-[720px] text-lg text-pretty text-fd-muted-foreground">
        Follow the progression from models and chatbots to durable Agents, accountable
        organizations and sovereign company infrastructure. Learn teaches the model in sequence;
        <Link href="/docs" className="mx-1 text-brand hover:underline">
          Docs
        </Link>
        gives exact technical and operating reference.
      </p>
      <CourseMap curriculum={curriculum} />
    </main>
  );
}
