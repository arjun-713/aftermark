import { rows, sql, type Tx } from '@agent-quality/db';
import { fixtureConnectionBinding } from './evaluation.ts';
import type { ConnectionBinding } from '../../packages/contracts/src/index.ts';
import type { FrozenRun } from '../../packages/evaluation/src/index.ts';
export async function bindProviderFixture(tx:Tx,organizationId:string,projectId:string,input:FrozenRun):Promise<ConnectionBinding> {
  await tx.execute(sql`insert into connections(organization_id,project_id,id,provider,name,credential) values(${organizationId},${projectId},${fixtureConnectionBinding.connectionId},'github','Synthetic verifier fixture','{"fixture":true}'::jsonb) on conflict(organization_id,project_id,provider) do nothing`);
  const [connection]=await rows<any>(tx,sql`select id,verification_version from connections where project_id=${projectId} and provider='github'`);
  const binding={connectionId:connection.id,verificationVersion:connection.verification_version};
  for(const observation of input.evidence)if(observation.source==='provider_observation')observation.connectionBinding=binding;
  for(const expected of Object.values(input.verificationBindings??{}))if(expected)expected.connectionBinding=binding;
  return binding;
}
