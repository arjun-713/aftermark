import { PgBoss,fromDrizzle } from 'pg-boss';
import { config } from './config.ts';
import { sql,rows,type Tx } from './index.ts';
let started:Promise<PgBoss>|undefined;
export const queueName='evaluate-run';
export type RunJob={organizationId:string;projectId:string;runId:string;instanceId?:string;revision:number;policyId?:string;explicit?:boolean;replayEvaluationId?:string};
export async function queue():Promise<PgBoss> {
  if(!started) started=(async()=>{
    const boss=new PgBoss({connectionString:config.DATABASE_URL,schema:'pgboss',max:4,createSchema:false,migrate:config.NODE_ENV!=='production'});
    boss.on('error',()=>process.stderr.write('Durable queue error\n'));
    await boss.start(); await boss.createQueue('evaluation-dead-letter');
    await boss.createQueue(queueName,{retryLimit:4,retryDelay:5,retryBackoff:true,retryDelayMax:60,expireInSeconds:180,deadLetter:'evaluation-dead-letter'});
    return boss;
  })().catch(error=>{started=undefined;throw error;});
  return started;
}
export async function stopQueue(){if(started){const boss=await started;started=undefined;await boss.stop({graceful:true,timeout:10000});}}
export async function enqueue(tx:Tx,job:RunJob,delaySeconds=30) {
  const [run]=await rows<{instance_id:string}>(tx,sql`select instance_id from runs where project_id=${job.projectId} and id=${job.runId}`);
  if(!run || job.instanceId && job.instanceId!==run.instance_id)throw new Error('The run instance changed before its evaluation could be queued');
  const pinned={...job,instanceId:run.instance_id};
  return (await queue()).send(queueName,pinned,{db:fromDrizzle(tx,sql),startAfter:delaySeconds,singletonKey:`${job.organizationId}:${job.projectId}:${job.runId}:${run.instance_id}:${job.revision}:${job.policyId??'active'}:${job.explicit?'explicit':'auto'}`,group:{id:job.organizationId}});
}
