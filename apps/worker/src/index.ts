import { createServer } from 'node:http';
import { pool,assertApplicationRole } from '@agent-quality/db';
import { queue,queueName,stopQueue,type RunJob } from '../../../packages/db/src/queue.ts';
import { evaluateJob } from './evaluate.ts';
import { collectEvidence } from '../../../packages/integrations/src/providers.ts';
await assertApplicationRole();
const boss=await queue();let active=0,completed=0,failed=0;
await boss.work<RunJob>(queueName,{localConcurrency:2,groupConcurrency:1,batchSize:1,pollingIntervalSeconds:1},async jobs=>{
  for(const job of jobs){active++;try{await evaluateJob(job.data,{collectEvidence});completed++;}catch{failed++;throw new Error('Evaluation interrupted; durable recovery will retry the job.');}finally{active--;}}
});
const health=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'ready',active,completed,failed}));});
health.listen(Number(process.env.WORKER_PORT??4101),'0.0.0.0');
console.log('Evaluation worker ready');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{health.close();await stopQueue();await pool.end();process.exit(0);});
