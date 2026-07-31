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
          <h2 id="flect-workplace-title">The interface to your AgentOS company.</h2>
          <p className={styles.introduction}>
            Flect is a public developer preview and a natural future AgentOS dogfooding adopter.
            This is a future direction, not a shipped integration.
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
          <p className={styles.surfaceLabel}>A possible future workflow</p>
          <h3>Personalized context, durable authority.</h3>
          <p>
            A real AgentOS × Flect demonstration would show personalized context and decisions,
            agent-assisted revision, explicit human approval, and bounded handoff to First Mate
            only after that integration is built and dogfooded.
          </p>
        </div>

        <div className={styles.authority}>
          <p className={styles.surfaceLabel}>The boundary stays clear</p>
          <p>
            AgentOS remains the durable authority for accepted work, decisions, evidence, and
            handoffs. Flect can shape the human surface without becoming a second source of truth.
          </p>
        </div>
      </div>

      <div className={styles.storyFooter}>
        <p>
          Flect works beyond AgentOS as a standalone/local interface shell; product and API adapters
          are future work, not shipped.
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
