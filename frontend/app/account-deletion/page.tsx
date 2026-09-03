'use client';
import { useState, type SubmitEvent } from 'react';
import Link from 'next/link';
import { BrandLogo } from '@/components/brand-logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import '@/components/landing/landing.css';

export default function AccountDeletion() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (
      !window.confirm(
        'Permanently delete this Ziipa account, its posts, uploads, comments, feeds, and preferences? This cannot be undone.',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      await api('/auth/login', {
        email: form.get('email'),
        password: form.get('password'),
      });
      const result = await api<{ pending_media_cleanup: boolean }>(
        '/account/delete',
        {
          password: form.get('password'),
          confirmation: form.get('confirmation'),
        },
      );
      setPending(result.pending_media_cleanup);
      setDone(true);
      await api('/auth/logout', {}).catch(() => {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main
      className="ziipa-landing"
      style={{ minHeight: '100vh', padding: '40px 20px' }}
    >
      <div style={{ maxWidth: 600, margin: '0 auto' }}>
        <BrandLogo />
        <div className="zl-waitlist-form" style={{ marginTop: 40 }}>
          {done ? (
            <div aria-live="polite">
              <h1 style={{ fontSize: 34, marginBottom: 20 }}>
                Account deleted.
              </h1>
              <p>
                {pending
                  ? 'Your account has been removed. Some media files remain queued for cleanup.'
                  : 'Your account and uploaded files have been removed from this Ziipa server.'}
              </p>
              <Link href="/" className="zl-button" style={{ marginTop: 25 }}>
                Return to Ziipa
              </Link>
            </div>
          ) : (
            <>
              <h1 style={{ fontSize: 36, marginBottom: 20 }}>
                Delete your Ziipa account
              </h1>
              <p style={{ lineHeight: 1.8 }}>
                This permanently deletes your account, uploaded media, posts,
                comments, custom feeds, bookmarks, likes, safety preferences,
                and matching waitlist record on this server. Other devices will
                be signed out. File cleanup failures are queued for retry.
              </p>
              <p style={{ marginTop: 20 }}>
                You can also delete your account in the mobile app under
                Settings. For help, contact{' '}
                <a href="mailto:hello@ziipa.com">hello@ziipa.com</a>.
              </p>
              <form
                className="ziipa-form"
                onSubmit={submit}
                style={{ marginTop: 25 }}
              >
                <label htmlFor="delete-email">Account email</label>
                <Input
                  id="delete-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  disabled={busy}
                />
                <label htmlFor="delete-password">Current password</label>
                <Input
                  id="delete-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={128}
                  disabled={busy}
                />
                <label htmlFor="delete-confirmation">
                  Type DELETE to confirm
                </label>
                <Input
                  id="delete-confirmation"
                  name="confirmation"
                  pattern="DELETE"
                  required
                  disabled={busy}
                />
                <Button className="form-button" type="submit" disabled={busy}>
                  {busy ? 'Deleting…' : 'Permanently delete my account'}
                </Button>
                {error && (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                )}
                <p className="form-note">
                  This form calls Ziipa&apos;s live account-deletion API. Public
                  blockchain transactions and content already published to IPFS
                  cannot be erased from those networks.
                </p>
              </form>
            </>
          )}
        </div>
        <Link href="/" style={{ display: 'inline-block', marginTop: 25 }}>
          ← Back to Ziipa
        </Link>
      </div>
    </main>
  );
}
