'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowUpRight, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { BrandLogo } from '@/components/brand-logo';
import { CreatorWorkspace } from '@/components/creator/workspace';
import Link from 'next/link';

type Member = {name: string; email: string; joined: string; membership: string};
export default function Portal() {
  const [member, setMember] = useState<Member | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'login'|'register'>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function refresh() {
    try { setMember(await api<Member>('/me')); }
    catch (e) { if ((e as {status?:number}).status !== 401) setError((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('');
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try { const result=await api<{verification_required?:boolean;message?:string}>(`/auth/${mode}`, data); if(result.verification_required){setError(result.message||'Check your email to verify the account, then sign in.');setMode('login');return;} await refresh(); }
    catch(e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true); setError('');
    try { await api('/auth/logout', {}); setMember(null); }
    catch(e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  if (loading) return <main className="auth-page"><p role="status">Opening your space…</p></main>;
  if (!member) return <main className="auth-page"><a className="back-link" href="/"><ArrowLeft size={16}/> Back to Ziipa</a><div className="auth-shell"><div className="auth-story"><BrandLogo/><span className="eyebrow">YOUR NEXT CHAPTER STARTS HERE</span><h1>A space<br/>for <em>you.</em></h1><p>Big ideas start with a little curiosity.<br/>Step inside and see what's possible.</p><span className="small-tag">EARLY COMMUNITY / LOCAL PREVIEW</span></div><section className="auth-card"><span className="eyebrow">THE MEMBER PORTAL</span><h2>{mode === 'login' ? 'Welcome back.' : 'Make yourself at home.'}</h2><p>{mode === 'login' ? 'Sign in to your Ziipa account.' : 'Create an account to start your journey.'}</p><form key={mode} className="ziipa-form" onSubmit={submit}>{mode === 'register' && <><label htmlFor="name">Your name</label><Input id="name" name="name" autoComplete="name" required maxLength={100}/></>}<label htmlFor="email">Email address</label><Input id="email" type="email" name="email" autoComplete="email" required/><label htmlFor="password">Password</label><Input id="password" name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'register' ? 12 : 1} maxLength={128} required/>{mode === 'register' && <small>Use at least 12 characters. Please use a test password for this local preview.</small>}<Button className="form-button" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Enter your space' : 'Create account'}<ArrowUpRight size={18}/></Button>{mode === 'login' && <Link href="/forgot-password" style={{fontSize:12,color:'#b9ec80',marginTop:8}}>Forgot password?</Link>}{error && <p className="form-error" role="alert">{error}</p>}</form><div className="auth-switch">{mode === 'login' ? 'New to Ziipa?' : 'Already have an account?'} <Button variant="link" onClick={()=>{setMode(mode === 'login' ? 'register' : 'login');setError('');}}>{mode === 'login' ? 'Create an account' : 'Sign in'}</Button></div></section></div></main>;
  return <><CreatorWorkspace member={member} onLogout={logout} logoutBusy={busy}/>{error && <p role="alert" className="cw-error">{error}</p>}</>;
}
