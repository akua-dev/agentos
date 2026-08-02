'use client';

import {
  type ComponentProps,
  Fragment,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Effect } from 'effect';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { cva } from 'class-variance-authority';
import { useTheme } from 'next-themes';
import dynamic from 'next/dynamic';
import {
  delayBrowserEffect,
  loadBrowserModule,
} from '@/lib/effect/browser-effects';
import {
  runBrowserEffect,
  runBrowserPromise,
  runBrowserSync,
} from '@/lib/effect/browser-runtime';

const GrainGradient = dynamic(
  () =>
    runBrowserPromise(
      loadBrowserModule('@paper-design/shaders-react', () =>
        import('@paper-design/shaders-react'),
      ).pipe(Effect.map((module) => module.GrainGradient)),
    ),
  { ssr: false },
);

const Dithering = dynamic(
  () =>
    runBrowserPromise(
      loadBrowserModule('@paper-design/shaders-react', () =>
        import('@paper-design/shaders-react'),
      ).pipe(Effect.map((module) => module.Dithering)),
    ),
  { ssr: false },
);

export function Hero() {
  const { resolvedTheme } = useTheme();
  const ref = useRef<HTMLDivElement | null>(null);
  const visible = useIsVisible(ref);
  const [showShaders, setShowShaders] = useState(false);

  useEffect(() => {
    return runBrowserEffect(
      delayBrowserEffect(
        '250 millis',
        Effect.sync(() => setShowShaders(true)),
      ),
    );
  }, []);

  return (
    <div ref={ref} aria-hidden className="absolute inset-0 overflow-hidden">
      {showShaders && (
        <GrainGradient
          className="absolute inset-0 animate-fd-fade-in duration-800 motion-reduce:animate-none"
          colors={
            resolvedTheme === 'dark'
              ? ['#39BE1C', '#9c2f05', '#7A2A0000']
              : ['#fcfc51', '#ffa057', '#7A2A0020']
          }
          colorBack="#00000000"
          softness={1}
          intensity={0.9}
          noise={0.5}
          speed={visible ? 0.7 : 0}
          shape="corners"
          minPixelRatio={1}
          maxPixelCount={1920 * 1080}
        />
      )}
      {showShaders && (
        <Dithering
          width={720}
          height={720}
          colorBack="#00000000"
          colorFront={resolvedTheme === 'dark' ? '#DF3F00' : '#fa8023'}
          shape="sphere"
          type="4x4"
          scale={0.5}
          size={3}
          speed={0}
          frame={5000 * 120}
          className="absolute right-[-280px] bottom-[-300px] animate-fd-fade-in duration-500 motion-reduce:animate-none md:right-[-120px] lg:top-[2%] lg:right-[-60px]"
          minPixelRatio={1}
        />
      )}
      <div className="absolute inset-x-0 bottom-0 h-1/2 bg-linear-to-t from-fd-background/75 to-transparent" />
    </div>
  );
}

const bootstrapPrompt =
  'Read https://github.com/akua-dev/agentos/blob/main/BOOTSTRAP.md.\nHelp me bring AgentOS online — check my setup first, ask before changing anything.';

export function CreateAppAnimation(props: ComponentProps<'div'>) {
  const tickTime = 18;
  const commandEnd = bootstrapPrompt.length;
  const resultStart = commandEnd + 8;
  const animationEnd = resultStart + 4;
  const [tick, setTick] = useState(animationEnd);

  useEffect(() => {
    if (tick >= animationEnd) return;
    return runBrowserEffect(
      delayBrowserEffect(
        tickTime,
        Effect.sync(() => setTick((value) => value + 1)),
      ),
    );
  }, [animationEnd, tick]);

  const lines: ReactElement[] = [
    <span key="prompt" className="whitespace-pre-wrap">
      {bootstrapPrompt.substring(0, tick)}
      {tick < commandEnd && (
        <span className="inline-block h-3 w-1 animate-pulse bg-fd-foreground motion-reduce:animate-none" />
      )}
    </span>,
  ];

  if (tick > resultStart) {
    lines.push(
      <Fragment key="result">
        <span className="mt-4 text-fd-muted-foreground">◇ Environment inspected</span>
        <span>◆ Changes wait for your approval</span>
        <span>● First Mate ready</span>
      </Fragment>,
    );
  }

  return (
    <div
      {...props}
      onMouseEnter={() => {
        runBrowserSync(
          Effect.sync(() => {
            if (tick >= animationEnd) setTick(0);
          }),
        );
      }}
    >
      {tick >= animationEnd && (
        <LaunchAppWindow className="absolute right-4 bottom-5 z-10 animate-in fade-in slide-in-from-top-6 motion-reduce:animate-none" />
      )}
      <pre className="min-h-[240px] whitespace-pre-wrap font-mono text-xs sm:text-sm">
        <code className="grid">{lines}</code>
      </pre>
    </div>
  );
}

function LaunchAppWindow(props: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={cn('overflow-hidden rounded-md border bg-fd-popover shadow-lg', props.className)}
    >
      <p className="border-b px-4 py-2 text-center text-xs text-fd-muted-foreground">
        your AgentOS Fleet
      </p>
      <p className="px-4 py-2 text-sm">First Mate online</p>
    </div>
  );
}

type WritingTabValue = 'chatbot' | 'agent' | 'company';

const writingTabs: ReadonlyArray<{
  readonly name: string;
  readonly value: WritingTabValue;
}> = [
  { name: 'Chatbot', value: 'chatbot' },
  { name: 'Agent', value: 'agent' },
  { name: 'Company', value: 'company' },
];

export function Writing({
  tabs: tabContents,
}: {
  tabs: Record<WritingTabValue, ReactNode>;
}) {
  const [tab, setTab] = useState<WritingTabValue>('chatbot');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectTab = Effect.fn('agentos.website.selectWritingTab')(
    (index: number) =>
      Effect.sync(() => {
        const selected = writingTabs[index];
        if (selected === undefined) return;
        setTab(selected.value);
        tabRefs.current[index]?.focus();
      }),
  );

  const handleTabKeyDown = Effect.fn('agentos.website.handleWritingTabKey')(
    function*(index: number, event: KeyboardEvent<HTMLButtonElement>) {
      let nextIndex: number | undefined;

      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          nextIndex = (index + 1) % writingTabs.length;
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          nextIndex = (index - 1 + writingTabs.length) % writingTabs.length;
          break;
        case 'Home':
          nextIndex = 0;
          break;
        case 'End':
          nextIndex = writingTabs.length - 1;
          break;
      }

      if (nextIndex === undefined) return;
      yield* Effect.sync(() => event.preventDefault());
      yield* selectTab(nextIndex);
    },
  );

  return (
    <div className="col-span-full my-16">
      <h2 className="mb-5 text-center text-3xl font-medium tracking-tight text-brand md:text-4xl">
        From one answer to a company.
      </h2>
      <p className="mx-auto mb-8 max-w-[760px] text-center">
        Models generate. Agents own bounded outcomes. AgentOS gives many Agents the durable
        organization required to work as a company.
      </p>
      <div
        role="tablist"
        aria-label="Progression from chatbot to company"
        className="mb-6 flex items-center justify-center gap-3 text-fd-muted-foreground sm:gap-5"
      >
        {writingTabs.map((item, index) => (
          <Fragment key={item.value}>
            {index > 0 && <ArrowRight aria-hidden className="size-4" />}
            <button
              type="button"
              role="tab"
              aria-selected={item.value === tab}
              tabIndex={item.value === tab ? 0 : -1}
              aria-controls={`progression-${item.value}`}
              id={`progression-tab-${item.value}`}
              ref={(element) => {
                runBrowserSync(
                  Effect.sync(() => {
                    tabRefs.current[index] = element;
                  }),
                );
              }}
              className={cn(
                'rounded-md px-2 py-1 text-base font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand sm:text-lg',
                item.value === tab && 'text-brand',
              )}
              onClick={() => runBrowserSync(selectTab(index))}
              onKeyDown={(event) =>
                runBrowserSync(handleTabKeyDown(index, event))
              }
            >
              {item.name}
            </button>
          </Fragment>
        ))}
      </div>
      {Object.entries(tabContents).map(([key, value]) => (
        <div
          key={key}
          id={`progression-${key}`}
          role="tabpanel"
          aria-labelledby={`progression-tab-${key}`}
          hidden={key !== tab}
          className="animate-fd-fade-in motion-reduce:animate-none"
        >
          {value}
        </div>
      ))}
    </div>
  );
}

export function AgnosticBackground() {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useIsVisible(ref);

  return (
    <div
      ref={ref}
      aria-hidden
      className="absolute inset-0 -z-1 mask-[linear-gradient(to_top,white_30%,transparent_calc(100%-120px))]"
    >
      <Dithering
        colorBack="#00000000"
        colorFront="#c6bb58"
        shape="warp"
        type="4x4"
        speed={visible ? 0.35 : 0}
        className="size-full motion-reduce:hidden"
        minPixelRatio={1}
      />
    </div>
  );
}

const observeVisibility = Effect.fn('agentos.website.observeVisibility')(
  (element: HTMLElement, setVisible: (visible: boolean) => void) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const observer = new IntersectionObserver((entries) => {
          runBrowserSync(
            Effect.sync(() => {
              for (const entry of entries) {
                if (entry.target === element) setVisible(entry.isIntersecting);
              }
            }),
          );
        });
        observer.observe(element);
        return observer;
      }),
      (observer) => Effect.sync(() => observer.disconnect()),
    ).pipe(Effect.andThen(Effect.never), Effect.scoped),
);

function useIsVisible(ref: RefObject<HTMLElement | null>) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    return runBrowserEffect(
      Effect.suspend(() => {
        const element = ref.current;
        return element === null
          ? Effect.void
          : observeVisibility(element, setVisible);
      }),
    );
  }, [ref]);

  return visible;
}

export const compactButtonVariants = cva(
  'inline-flex items-center justify-center rounded-full px-4 py-2 text-sm font-medium transition-colors',
);
