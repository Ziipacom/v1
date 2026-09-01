'use client';
import { useState, type FormEvent } from 'react';
import { ArrowUpRight, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';

export function WaitlistForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const data = new FormData(event.currentTarget);
    try { await api('/waitlist', { name: data.get('name'), email: data.get('email') }); setDone(true); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return done ? <div className="success-state" role="status"><CheckCircle2 size={34}/><h3>You're on the list.</h3><p>Thanks for being part of what comes next. Your interest has been saved.</p><a href="/portal" className="text-link">Create your member account <ArrowUpRight size={16}/></a></div> : <form onSubmit={submit} className="ziipa-form"><h3>A little curiosity. A first step.</h3><label htmlFor="waitlist-name">Your name</label><Input id="waitlist-name" name="name" autoComplete="name" placeholder="Alex Morgan" required maxLength={100}/><label htmlFor="waitlist-email">Email address</label><Input id="waitlist-email" name="email" autoComplete="email" type="email" placeholder="you@example.com" required maxLength={320}/><Button type="submit" className="form-button" disabled={busy}>{busy ? 'Joining…' : 'Join the waitlist'}<ArrowUpRight size={18}/></Button>{error && <p role="alert" className="form-error">{error}</p>}<p className="form-note">Local development preview. Your details stay in this project's database; no email is sent.</p></form>;
}
