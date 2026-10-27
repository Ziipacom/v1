import type { Metadata } from 'next';
import Link from 'next/link';
import { BrandLogo } from '@/components/brand-logo';
import notice from '@/content/beta-privacy.json';
import '@/components/landing/landing.css';
import s from '@/components/network-imports.module.css';

export const metadata: Metadata = {
  title: 'Ziipa beta privacy notice',
  description: 'Privacy information for the current adult Ziipa iPhone beta, including account content, permissions, optional AI, TestFlight and deletion controls.',
  robots: { index: false, follow: false },
};

export default function BetaPrivacyNotice() {
  return (
    <main className={`ziipa-landing ${s.page}`}>
      <div className={s.content}>
        <nav className={s.nav} aria-label="Ziipa navigation">
          <BrandLogo />
          <Link href="/portal">Open Ziipa</Link>
        </nav>
        <article>
          <p className={s.eyebrow}>TESTFLIGHT BETA · NOTICE VERSION OCTOBER 27, 2026</p>
          <h1>{notice.title}</h1>
          <p className={s.intro}>{notice.subtitle}</p>
          {process.env.NODE_ENV !== 'production' && (
            <p role="status">Review copy. Publication is awaiting owner approval.</p>
          )}
          <nav aria-label="Privacy notice sections">
            <ul>
              {notice.sections.map((section) => (
                <li key={section.id}><a href={`#${section.id}`}>{section.title}</a></li>
              ))}
            </ul>
          </nav>
          {notice.sections.map((section) => (
            <section id={section.id} key={section.id}>
              <h2>{section.title}</h2>
              {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
              {'links' in section && section.links && (
                <ul>
                  {section.links.map((link) => (
                    <li key={link.url}><a href={link.url}>{link.label}</a></li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </article>
        <footer className={s.footer}>
          <Link href="/">Back to Ziipa</Link>
          <Link href="/account-deletion">Account deletion</Link>
          <a href={`mailto:${notice.support_and_privacy_email}`}>Contact support</a>
        </footer>
      </div>
    </main>
  );
}
