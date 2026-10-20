'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { BrandLogo } from '@/components/brand-logo';

export default function AdministrationEntry() {
  const [message, setMessage] = useState('Checking your administration access…');
  const [signIn, setSignIn] = useState(false);
  useEffect(() => {
    let live = true;
    void api<{role?: string}>('/me').then((user) => {
      if (!live) return;
      if (['owner', 'admin', 'moderator'].includes(user.role || '')) {
        window.location.replace('/studio/index.html?view=admin');
      } else setMessage('Administration is available only to authorized Ziipa staff.');
    }).catch((error: unknown) => {
      if (!live) return;
      setSignIn((error as {status?: number}).status === 401);
      setMessage((error as {status?: number}).status === 401
        ? 'Sign into your Ziipa staff account to open Administration.'
        : 'Administration could not be opened. Please try again.');
    });
    return () => { live = false; };
  }, []);
  return <main className="auth-page"><section className="auth-card"><BrandLogo /><h1>Ziipa Administration</h1><p role="status">{message}</p>{signIn && <Link href="/portal?next=admin">Sign in to Ziipa</Link>}<p><Link href="/portal">Return to your Studio</Link></p></section></main>;
}
