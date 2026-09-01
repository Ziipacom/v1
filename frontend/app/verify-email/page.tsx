'use client';
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {BrandLogo} from '@/components/brand-logo';
import {api} from '@/lib/api';

export default function VerifyEmail(){
 const [status,setStatus]=useState('Verifying your email…'),[ok,setOk]=useState(false);
 useEffect(()=>{const token=new URLSearchParams(window.location.search).get('token');if(!token){setStatus('This verification link is incomplete.');return;}void api('/auth/verify-email',{token}).then(()=>{setOk(true);setStatus('Your email is verified. You can sign in to Ziipa.')}).catch(e=>setStatus((e as Error).message));},[]);
 return <main className="auth-page"><section className="auth-card" style={{width:'min(520px,100%)'}}><BrandLogo/><h2 style={{marginTop:35}}>{ok?'You’re verified.':'Email verification'}</h2><p role="status">{status}</p><Link className="form-button" href="/portal">Continue to sign in</Link></section></main>;
}
