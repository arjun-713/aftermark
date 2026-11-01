import 'dotenv/config';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { passwordHash,digest } from '../apps/api/src/auth.ts';
import { defaultPolicy } from '@agent-quality/contracts';
if(process.env.NODE_ENV==='production') throw new Error('Development seed is disabled in production');
if(!process.env.MIGRATION_DATABASE_URL) throw new Error('Set MIGRATION_DATABASE_URL first');
const admin=new Pool({connectionString:process.env.MIGRATION_DATABASE_URL});
const client=await admin.connect();
try {
  await client.query('begin');
  for (const [index,email,name,workspace] of [[1,'alex@example.test','Alex Morgan','Northstar'],[2,'sam@example.test','Sam Rivera','Orbit']] as const) {
    const uid=`00000000-0000-4000-8000-00000000000${index}`;
    const org=`10000000-0000-4000-8000-00000000000${index}`;
    const project=`20000000-0000-4000-8000-00000000000${index}`;
    await client.query('insert into users(id,email,name,password_hash) values($1,$2,$3,$4) on conflict(id) do update set password_hash=excluded.password_hash',[uid,email,name,passwordHash('local-password-123')]);
    await client.query('insert into organizations(id,name) values($1,$2) on conflict do nothing',[org,workspace]);
    await client.query("insert into memberships values($1,$2,'owner') on conflict do nothing",[org,uid]);
    await client.query("insert into subscriptions(organization_id) values($1) on conflict do nothing",[org]);
    await client.query('insert into projects(organization_id,id,name) values($1,$2,$3) on conflict do nothing',[org,project,index===1?'Support workflows':'CRM assistant']);
    const policy=randomUUID();
    const result=await client.query('insert into policies(organization_id,project_id,id,version,definition,hash) values($1,$2,$3,1,$4,$5) on conflict(organization_id,project_id,version) do nothing returning id',[org,project,policy,defaultPolicy,digest(JSON.stringify(defaultPolicy))]);
    if(result.rowCount) await client.query('update projects set active_policy_id=$1 where organization_id=$2 and id=$3',[policy,org,project]);
  }
  await client.query('commit'); console.log('Seeded two isolated development workspaces. Login: alex@example.test or sam@example.test / local-password-123');
} catch(error){await client.query('rollback');throw error;} finally {client.release();await admin.end();}
