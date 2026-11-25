'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowUpRight, ArrowLeft, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { BrandLogo } from '@/components/brand-logo';
import { PortalStudio } from '@/components/creator/portal-studio';
import Link from 'next/link';

type Member = {id: number; name: string; email: string; joined: string; membership: string};
export default function Portal() {
  const [member, setMember] = useState<Member | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'login'|'register'>('login');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [needsVerification, setNeedsVerification] = useState(false);
  const [framed, setFramed] = useState<boolean | null>(null);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    setFramed(query.get('layout') === 'frame');
    if (query.get('mode') === 'register') setMode('register');
  }, []);
  useEffect(() => {
    if (!member || framed !== false) return;
    const next = new URLSearchParams(window.location.search).get('next');
    const view = next === 'admin' || next === 'publishing' ? `?view=${next}` : '';
    window.location.replace(`/studio/index.html${view}`);
  }, [member, framed]);
  async function refresh() {
    try { setMember(await api<Member>('/me')); }
    catch (e) { if ((e as {status?:number}).status !== 401) setError((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    const data = Object.fromEntries(new FormData(event.currentTarget));
    setShowPassword(false);
    try {
      const result = await api<{verification_required?: boolean; message?: string}>(`/auth/${mode}`, data);
      if (result.verification_required) {
        if (typeof data.email === 'string') setEmail(data.email);
        setMessage(result.message || 'Check your email to verify your account, then sign in.');
        setNeedsVerification(true);
        setMode('login');
        return;
      }
      await refresh();
    } catch (e) {
      const failure = e as Error & { status?: number };
      setError(failure.message);
      if (failure.status === 403 && /verify your email/i.test(failure.message)) setNeedsVerification(true);
    } finally {
      setBusy(false);
    }
  }
  async function resendVerification(form: HTMLFormElement | null) {
    const field = form?.elements.namedItem('email');
    if (!(field instanceof HTMLInputElement) || !field.reportValidity()) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api<{message?: string}>('/auth/resend-verification', { email: field.value });
      setMessage(result.message || 'If the account needs verification, a new link has been sent.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true); setError('');
    try { await api('/auth/logout', {}, member?.id); setMember(null); }
    catch(e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  if (loading) return <main className="auth-page"><p role="status">Opening Ziipa…</p></main>;
  if (!member) return (
    <main className="auth-page">
      <Link className="back-link" href="/"><ArrowLeft size={16}/> Back to Ziipa</Link>
      <div className="auth-shell">
        <div className="auth-story">
          <BrandLogo/>
          <h1>A space<br/>for <em>you.</em></h1>
          <p>Discover media and share your own creations.</p>
        </div>
        <section className="auth-card">
          <h2>{mode === 'login' ? 'Sign in' : 'Create a Ziipa account'}</h2>
          <form key={mode} className="ziipa-form" onSubmit={submit}>
            {mode === 'register' && <>
              <label htmlFor="name">Your name</label>
              <Input id="name" name="name" autoComplete="name" required maxLength={100}/>
            </>}
            <label htmlFor="email">Email address</label>
            <Input id="email" type="email" name="email" autoComplete="email" value={email}
              onChange={(event) => setEmail(event.currentTarget.value)} required/>
            <label htmlFor="password">Password</label>
            <div className="portal-password-field">
              <Input id="password" name="password" type={showPassword ? 'text' : 'password'}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'} autoCapitalize="none"
                spellCheck={false} minLength={mode === 'register' ? 12 : 1} maxLength={128} required/>
              <button type="button" className="portal-password-toggle" aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-controls="password" onMouseDown={(event) => event.preventDefault()}
                onClick={() => setShowPassword((visible) => !visible)}>
                {showPassword ? <EyeOff size={20} aria-hidden="true"/> : <Eye size={20} aria-hidden="true"/>}
              </button>
            </div>
            {mode === 'register' && <small>Use at least 12 characters and a unique password.</small>}
            <Button className="form-button" type="submit" disabled={busy}>
              {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}<ArrowUpRight size={18}/>
            </Button>
            {mode === 'login' && <Link href="/forgot-password" className="portal-recovery-link">Forgot password?</Link>}
            {mode === 'login' && needsVerification && (
              <Button variant="link" type="button" disabled={busy} onClick={(event) => void resendVerification(event.currentTarget.form)}>
                Resend verification email
              </Button>
            )}
            {message && <p role="status">{message}</p>}
            {error && <p className="form-error" role="alert">{error}</p>}
          </form>
          <div className="auth-switch">
            {mode === 'login' ? 'New to Ziipa?' : 'Already have an account?'}{' '}
            <Button variant="link" disabled={busy} onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setShowPassword(false);
              setError('');
              setMessage('');
            }}>
              {mode === 'login' ? 'Create an account' : 'Sign in'}
            </Button>
          </div>
          <nav className="portal-policy-links" aria-label="Ziipa policies">
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms of use</Link>
            <Link href="/community">Community rules</Link>
          </nav>
        </section>
      </div>
    </main>
  );
  if (framed !== true) return <main className="auth-page"><p role="status">Opening Studio…</p><a href="/studio/index.html">Open Studio</a></main>;
  return <><PortalStudio member={member} onLogout={logout} logoutBusy={busy} onSessionEnded={()=>setMember(null)}/>{error && <p role="alert" className="cw-error">{error}</p>}</>;
}
