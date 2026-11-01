'use client';
import { useEffect,useState } from 'react';
export default function Workspace(){const[data,setData]=useState<any>();const[error,setError]=useState('');useEffect(()=>{fetch('/api/v1/me').then(async r=>{if(r.status===401){location.href='/login';return;}setData(await r.json());}).catch(()=>setError('Could not load your workspace.'));},[]);return <main className="auth"><h1>Workspace</h1>{error?<p role="alert">{error}</p>:!data?<p>Loading workspaces…</p>:<><p>Signed in as {data.user?.name}</p>{data.workspaces?.map((w:any)=><p key={w.id}>{w.name} · {w.role}</p>)}</>}</main>;}
