import { initializeAlertQueues, runAlertDelivery, markAlertDeadLetter, alertQueueName, alertDeadLetterQueue, type AlertJob } from '../../../packages/alerts/src/index.ts';

export async function startAlertWorkers() {
  const boss = await initializeAlertQueues();
  await boss.work<AlertJob>(alertQueueName,{ batchSize:1,localConcurrency:2,groupConcurrency:1,pollingIntervalSeconds:1 },async jobs=>{
    for (const job of jobs) {
      try { await runAlertDelivery(job); }
      catch { throw new Error('Configured alert delivery failed; durable retry policy applies.'); }
    }
  });
  await boss.work<AlertJob>(alertDeadLetterQueue,{ batchSize:1,localConcurrency:1,pollingIntervalSeconds:1 },async jobs=>{
    for (const job of jobs) {
      try { await markAlertDeadLetter(job.data); }
      catch { throw new Error('Configured alert dead-letter reconciliation failed.'); }
    }
  });
  return async () => { await boss.offWork(alertQueueName,{ wait:true }); await boss.offWork(alertDeadLetterQueue,{ wait:true }); };
}
