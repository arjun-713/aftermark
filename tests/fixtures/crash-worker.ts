import { evaluateJob } from '../../apps/worker/src/evaluate.ts';
await evaluateJob(JSON.parse(process.env.AQ_TEST_JOB!),{semanticTransport:async()=>{process.stdout.write('provider-call-started\n');await new Promise(resolve=>setTimeout(resolve,60000));throw new Error('Unexpected continuation');}});
