import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, expect, it } from 'vitest';
import { pool, rows, sql, tenant } from '../../packages/db/src/index.ts';
import { defaultPolicy } from '../../packages/contracts/src/index.ts';

if (!process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).pathname !== '/aq_storage_test' || !process.env.MIGRATION_DATABASE_URL || new URL(process.env.MIGRATION_DATABASE_URL).pathname !== '/aq_storage_test') throw new Error('Usage-retention regression requires the isolated aq_storage_test database.');
const admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
afterAll(async () => { await pool.end(); await admin.end(); });

it('preserves workspace quota after evaluation and project erasure, then cascades on workspace erasure', async () => {
  const org = randomUUID(), project = randomUUID(), policy = randomUUID();
  try {
    await admin.query("insert into organizations(id,name) values($1,'Quota retention fixture')", [org]);
    await admin.query('insert into subscriptions(organization_id) values($1)', [org]);
    await admin.query("insert into projects(organization_id,id,name) values($1,$2,'Disposable project')", [org, project]);
    await admin.query("insert into policies(organization_id,project_id,id,version,definition,hash) values($1,$2,$3,1,$4,'fixture')", [org, project, policy, defaultPolicy]);
    await admin.query("insert into runs(organization_id,project_id,id,agent_version,environment,started_at,last_event_at) values($1,$2,'quota-fixture','1','test',now(),now())", [org, project]);
    for (const [revision, state, units] of [[1, 'consumed', 731], [2, 'reserved', 79], [3, 'ambiguous', 10]] as const) {
      const evaluation = randomUUID();
      await admin.query("insert into evaluations(organization_id,project_id,id,run_id,revision,policy_id,policy_hash) values($1,$2,$3,'quota-fixture',$4,$5,'fixture')", [org, project, evaluation, revision, policy]);
      await admin.query('insert into usage_ledger(organization_id,project_id,evaluation_id,state,units) values($1,$2,$3,$4,$5)', [org, project, evaluation, state, units]);
    }
    const remaining = () => tenant(org, null, async tx => {
      const [subscription] = await rows<{ allowance: number; period_start: Date }>(tx, sql`select allowance,period_start from subscriptions where organization_id=${org}`);
      const [{ used }] = await rows<{ used: number }>(tx, sql`select coalesce(sum(units),0)::int as used from usage_ledger where organization_id=${org} and state in('consumed','reserved','ambiguous') and created_at>=${subscription.period_start}`);
      return { used, remaining: subscription.allowance - used };
    });
    expect(await remaining()).toEqual({ used: 820, remaining: 180 });
    await tenant(org, null, async tx => {
      // Match explicit erasure's detail-first ordering; neither step frees quota.
      await tx.execute(sql`delete from evaluations where organization_id=${org} and project_id=${project}`);
      await tx.execute(sql`delete from projects where organization_id=${org} and id=${project}`);
    });
    expect((await admin.query('select * from projects where organization_id=$1', [org])).rows).toHaveLength(0);
    expect((await admin.query('select * from evaluations where organization_id=$1', [org])).rows).toHaveLength(0);
    expect((await admin.query('select state,units from usage_ledger where organization_id=$1 order by units desc', [org])).rows).toEqual([{ state: 'consumed', units: 731 }, { state: 'reserved', units: 79 }, { state: 'ambiguous', units: 10 }]);
    expect(await remaining()).toEqual({ used: 820, remaining: 180 });
    expect((await pool.query('select * from usage_ledger')).rows).toHaveLength(0);
    await admin.query('delete from organizations where id=$1', [org]);
    expect((await admin.query('select * from usage_ledger where organization_id=$1', [org])).rows).toHaveLength(0);
  } finally {
    await admin.query('delete from evaluations where organization_id=$1', [org]);
    await admin.query('delete from organizations where id=$1', [org]);
  }
});
