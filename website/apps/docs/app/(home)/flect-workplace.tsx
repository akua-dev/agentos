import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import styles from './flect-workplace.module.css';

export function FlectWorkplace() {
  return (
    <section className={`col-span-full ${styles.story}`} aria-labelledby="flect-workplace-title">
      <div className={styles.storyHeader}>
        <div>
          <p className={styles.conceptLabel}>AgentOS × Flect</p>
          <h2 id="flect-workplace-title">One front door to the work of your company.</h2>
          <p className={styles.introduction}>
            Install Flect and enter an adaptable AgentOS workplace today. Flect shapes each view
            around the work and the person while AgentOS keeps ownership, decisions, and delivery
            durable.
          </p>
        </div>
        <p className={styles.previewStatus}>Available today</p>
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
          <p className={styles.surfaceLabel}>The company loop</p>
          <h3>Bring the right work to the right people.</h3>
          <p>
            AgentOS assembles product work, personalized context and decisions, then brings in the
            people with relevant context, expertise, or authority. Flect&apos;s built-in Agent helps
            them inspect or revise the draft before bounded, explicitly approved intent returns to
            First Mate.
          </p>
        </div>

        <div className={styles.authority}>
          <p className={styles.surfaceLabel}>Any product. One workplace.</p>
          <p>
            Flect can surface an existing product through an embedded browser or iframe, or connect
            through a product or API adapter. The view adapts without becoming a second company
            authority; AgentOS keeps accepted work, decisions, evidence, and handoffs durable.
          </p>
        </div>
      </div>

      <div className={styles.storyFooter}>
        <p>
          Flect works anywhere as a standalone interface shell and as the human surface of AgentOS:
          one install opens a flexible workplace for the work of your company.
        </p>
        <div className={styles.storyLinks}>
          <Link href="/docs/concepts/human-work-surfaces">
            See how the workplace works <ArrowRight aria-hidden />
          </Link>
          <a
            href="https://github.com/akua-dev/flect#what-works-today"
            target="_blank"
            rel="noreferrer noopener"
          >
            Install Flect <ArrowUpRight aria-hidden />
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
