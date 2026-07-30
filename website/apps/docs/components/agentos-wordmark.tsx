import Image from 'next/image';
import inkWordmark from '../../../../docs/brand/agentos-wordmark-ink.svg';
import boneWordmark from '../../../../docs/brand/agentos-wordmark-bone.svg';
import { cn } from '@/lib/cn';

export function AgentOSWordmark({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="AgentOS"
      className={cn('inline-flex h-7 w-[120px] shrink-0 items-center', className)}
    >
      <Image
        src={inkWordmark}
        alt=""
        aria-hidden
        width={120}
        height={28}
        className="h-auto w-full dark:hidden"
      />
      <Image
        src={boneWordmark}
        alt=""
        aria-hidden
        width={120}
        height={28}
        className="hidden h-auto w-full dark:block"
      />
    </span>
  );
}
