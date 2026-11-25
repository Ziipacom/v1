import Link from 'next/link';
import { BrandLogo } from '@/components/brand-logo';
import '@/components/landing/landing.css';
import s from '@/components/network-imports.module.css';

export function PolicyPage({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main className={`ziipa-landing ${s.page}`}>
      <div className={s.content}>
        <nav className={s.nav} aria-label="Ziipa navigation">
          <BrandLogo />
          <Link href="/portal">Open Ziipa</Link>
        </nav>
        <article>
          <h1>{title}</h1>
          {children}
        </article>
        <footer className={s.footer} aria-label="Ziipa policies and support">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms of use</Link>
          <Link href="/community">Community rules</Link>
          <Link href="/account-deletion">Account deletion</Link>
          <a href="mailto:ziipaziipa@gmail.com">Contact support</a>
        </footer>
      </div>
    </main>
  );
}
