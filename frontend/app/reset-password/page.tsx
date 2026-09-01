'use client';
import {useState, type FormEvent} from 'react';
import Link from 'next/link';
import {BrandLogo} from '@/components/brand-logo';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {api} from '@/lib/api';

export default function ResetPassword(){
 const [busy,setBusy]=useState(false),[done,setDone]=useState(false),[error,setError]=useState('');
 async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();setBusy(true);setError('');try{const token=new URLSearchParams(window.location.search).get('token');if(!token)throw new Error('This reset link is incomplete.');const form=new FormData(e.currentTarget);const password=String(form.get('password')||'');if(password!==form.get('confirm'))throw new Error('Passwords do not match.');await api('/auth/reset-password',{token,password});setDone(true)}catch(err){setError((err as Error).message)}finally{setBusy(false)}}
 return <main className="auth-page"><section className="auth-card" style={{width:'min(520px,100%)'}}><BrandLogo/><h2 style={{marginTop:35}}>Choose a new password.</h2>{done?<><p role="status">Your password has been changed and all existing Ziipa sessions were signed out.</p><Link className="form-button" href="/portal">Sign in</Link></>:<form className="ziipa-form" onSubmit={submit}><label htmlFor="new-password">New password</label><Input id="new-password" name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={busy}/><label htmlFor="confirm-password">Confirm password</label><Input id="confirm-password" name="confirm" type="password" autoComplete="new-password" minLength={12} maxLength={128} required disabled={busy}/><Button className="form-button" type="submit" disabled={busy}>{busy?'Saving…':'Change password'}</Button>{error&&<p className="form-error" role="alert">{error}</p>}</form>}</section></main>;
}
