'use client';
import {useState, type FormEvent} from 'react';
import Link from 'next/link';
import {BrandLogo} from '@/components/brand-logo';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {api} from '@/lib/api';

export default function ForgotPassword(){
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();setBusy(true);setError('');try{const form=new FormData(e.currentTarget);const result=await api<{message:string}>('/auth/forgot-password',{email:form.get('email')});setMessage(result.message);}catch(err){setError((err as Error).message)}finally{setBusy(false)}}
 return <main className="auth-page"><Link className="back-link" href="/portal">Back to sign in</Link><section className="auth-card" style={{width:'min(520px,100%)'}}><BrandLogo/><h2 style={{marginTop:35}}>Reset your password.</h2><p>Enter the email on your Ziipa account. The reset link expires after 30 minutes.</p>{message?<p role="status" className="cw-info">{message}</p>:<form className="ziipa-form" onSubmit={submit}><label htmlFor="recovery-email">Email address</label><Input id="recovery-email" name="email" type="email" autoComplete="email" required disabled={busy}/><Button className="form-button" type="submit" disabled={busy}>{busy?'Sending…':'Send reset link'}</Button>{error&&<p className="form-error" role="alert">{error}</p>}</form>}</section></main>;
}
