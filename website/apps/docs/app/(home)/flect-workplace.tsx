import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import styles from './flect-workplace.module.css';

export function FlectWorkplace() {
  return (
    <section className={`col-span-full ${styles.story}`} aria-labelledby="flect-workplace-title">
      <div className={styles.storyHeader}>
        <div>
          <p className={styles.conceptLabel}>AgentOS × Flect concept</p>
          <h2 id="flect-workplace-title">One front door to the work of your company.</h2>
          <p className={styles.introduction}>
            Install Flect and shape an adaptable local workplace today. It is a public developer
            preview and a natural future AgentOS dogfooding adopter; that integration is a future
            direction, not a shipped integration.
          </p>
        </div>
        <p className={styles.previewStatus}>Flect public developer preview</p>
      </div>

      <div className={styles.heroFrame}>
        <Image
          className={styles.heroImage}
          src="/assets/flect-hero.png"
          alt="Flect adapting across product interfaces"
          width={1716}
          height={916}
        />
      </div>

      <div className={styles.storyBody}>
        <div>
          <p className={styles.surfaceLabel}>A future company loop</p>
          <h3>Bring the right work to the right people.</h3>
          <p>
            A future AgentOS adapter could assemble product work, personalized context and
            decisions, then invite people with relevant context, expertise, or authority to review
            it. Flect&apos;s built-in Agent could help inspect or revise the draft before bounded,
            explicitly approved intent returns to First Mate.
          </p>
        </div>

        <div className={styles.authority}>
          <p className={styles.surfaceLabel}>Bridge before deep adapters</p>
          <p>
            An approved embedded browser or iframe could present an existing product inside that
            workplace before a deeper adapter exists. That is a future integration path, not a
            shipped capability. AgentOS remains the durable authority for accepted work, decisions,
            evidence, and handoffs.
          </p>
        </div>
      </div>

      <div className={styles.storyFooter}>
        <p>
          Flect works beyond AgentOS as a standalone/local interface shell; product and API adapters
          are future work, not shipped, and the surface never needs to become a second company
          authority.
        </p>
        <div className={styles.storyLinks}>
          <Link href="/docs/concepts/human-work-surfaces">
            Design a human work surface <ArrowRight aria-hidden />
          </Link>
          <a
            href="https://github.com/akua-dev/flect#what-works-today"
            target="_blank"
            rel="noreferrer noopener"
          >
            See the current Flect preview <ArrowUpRight aria-hidden />
          </a>
          <a
            href="https://github.com/akua-dev/flect"
            target="_blank"
            rel="noreferrer noopener"
          >
            Explore Flect <ArrowUpRight aria-hidden />
          </a>
        </div>
      </div>
    </section>
  );
}
