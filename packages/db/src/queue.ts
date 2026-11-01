import { PgBoss,fromDrizzle } from 'pg-boss';
import { config } from './config.ts';
import { sql,type Tx } from './index.ts';
let started:Promise<PgBoss>|undefined;
export const queueName='evaluate-run';
export type RunJob={organizationId:string;projectId:string;runId:string;revision:number;policyId?:string;explicit?:boolean;replayEvaluationId?:string};
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
  return (await queue()).send(queueName,job,{db:fromDrizzle(tx,sql),startAfter:delaySeconds,singletonKey:`${job.organizationId}:${job.projectId}:${job.runId}:${job.revision}:${job.policyId??'active'}:${job.explicit?'explicit':'auto'}`,group:{id:job.organizationId}});
}
