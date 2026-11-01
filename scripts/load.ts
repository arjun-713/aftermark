import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { requiredSecret } from '../packages/operations/src/config.ts';
export function percentile(values: number[], p: number) {
  if (!values.length) return null;
  return [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(p * values.length) - 1)];
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
export function representativeRun(projectId: string, id: string) {
  const timestamp = new Date().toISOString(), common = { schemaVersion: '1.0', runId: id, timestamp, environment: 'test', agentVersion: 'load-v1' };
  return [
    { ...common, eventId: `${id}-0`, kind: 'run.started', payload: { agent: 'Operational load probe' } },
    { ...common, eventId: `${id}-1`, kind: 'outcome.expected', payload: { outcome: { id: 'receipt', name: 'Receipt observed', operation: 'custom', source: 'customer_verifier', resource: {}, required: true, assertions: {}, observationWindowSeconds: 300 } } },
    { ...common, eventId: `${id}-2`, kind: 'tool.called', payload: { tool: 'internal.receipt', toolCallId: `${id}-call`, arguments: { customer: 'synthetic-load-customer', items: [1,2,3] } } },
    { ...common, eventId: `${id}-3`, kind: 'tool.result', payload: { tool: 'internal.receipt', toolCallId: `${id}-call`, success: true, result: { receipt: 'reported-only' } } },
    { ...common, eventId: `${id}-4`, kind: 'run.completed', payload: { text: 'Workflow complete; outcome still needs independent verification.' } },
  ];
}
export async function loadTest() {
  const origin = new URL(requiredSecret('LOAD_API_ORIGIN')), projectId = requiredSecret('LOAD_PROJECT_ID');
  if (process.env.LOAD_CONFIRM !== `${origin.origin}/${projectId}`) throw new Error('Set LOAD_CONFIRM to the exact API origin/project ID to authorize generated load.');
  const durationSeconds = Number(process.env.LOAD_DURATION_SECONDS ?? 60), eventsPerSecond = Number(process.env.LOAD_EVENTS_PER_SECOND ?? 100), batchEvents = Number(process.env.LOAD_BATCH_EVENTS ?? 100);
  if (!Number.isInteger(durationSeconds) || durationSeconds < 10 || durationSeconds > 3600 || !Number.isInteger(eventsPerSecond) || eventsPerSecond < 10 || eventsPerSecond > 1000 || eventsPerSecond % 10 || !Number.isInteger(batchEvents) || batchEvents < 10 || batchEvents > 100 || batchEvents % 10 || durationSeconds * eventsPerSecond % batchEvents) throw new Error('Use 10–3600 seconds,10–1000 events/sec and10–100 events/batch in multiples of10 with an integral batch count.');
  const ingestHeaders = { authorization: `Bearer ${requiredSecret('LOAD_INGEST_KEY')}`, 'content-type': 'application/json' };
  const readHeaders = { authorization: `Bearer ${requiredSecret('LOAD_READ_KEY')}` };
  const ingest: number[] = [], queries: number[] = [], evaluations: number[] = [], sampled: { id: string; sentAt: number }[] = [];
  let acceptedEvents = 0, errors = 0, droppedBatches = 0, active = 0, evaluated = 0;
  const requests: Promise<void>[] = [], start = performance.now(), batchCount = durationSeconds * eventsPerSecond / batchEvents;
  for (let i = 0; i < batchCount; i++) {
    const due = start + i * batchEvents * 1000 / eventsPerSecond; await wait(Math.max(0, due - performance.now()));
    if (active >= 100) { droppedBatches++; continue; }
    const first = `load-${randomUUID()}`;
    const events = Array.from({ length: batchEvents / 5 }, (_, j) => representativeRun(projectId, j === 0 ? first : `load-${randomUUID()}`)).flat();
    const sentAt = performance.now(); if (i % Math.max(1, Math.floor(batchCount / 30)) === 0) sampled.push({ id: first, sentAt });
    active++;
    requests.push((async () => {
      try {
        const response = await fetch(new URL('/v1/events', origin), { method: 'POST', headers: ingestHeaders, body: JSON.stringify({ projectId, events }), signal: AbortSignal.timeout(15000) });
        const result = await response.json(); if (response.status !== 202 || result.accepted !== batchEvents || result.durable !== true) errors++; else acceptedEvents += result.accepted;
      } catch { errors++; } finally { ingest.push(performance.now() - sentAt); active--; }
    })());
    if (i % Math.max(1, eventsPerSecond / batchEvents) === 0) {
      const q = performance.now();
      requests.push(fetch(new URL(`/v1/runs?projectId=${projectId}&limit=20`, origin), { headers: readHeaders, signal: AbortSignal.timeout(15000) }).then(async r => { await r.json(); if (!r.ok) errors++; }).catch(() => { errors++; }).finally(() => { queries.push(performance.now() - q); }));
    }
  }
  await Promise.all(requests);
  const ingestDurationSeconds = Math.max(durationSeconds, (performance.now() - start) / 1000);
  const pending = new Map(sampled.map(r => [r.id, r]));
  while (pending.size) {
    for (const [id, run] of pending) {
      try {
        const response = await fetch(new URL(`/v1/runs/${encodeURIComponent(id)}?projectId=${projectId}`, origin), { headers: readHeaders, signal: AbortSignal.timeout(5000) });
        const body = await response.json();
        if (response.ok && body.evaluations?.some((e: any) => e.completed_at && ['completed','partial'].includes(e.processing))) { evaluations.push(performance.now() - run.sentAt); pending.delete(id); evaluated++; }
      } catch { /* Remains pending and fails the deadline. */ }
      if (performance.now() - run.sentAt > 90000) { pending.delete(id); }
    }
    if (pending.size) await wait(1000);
  }
  const report = { version: 1, measuredAt: new Date().toISOString(), commit: process.env.RELEASE_COMMIT ?? '', environment: process.env.LOAD_ENVIRONMENT === 'production-equivalent' ? 'production-equivalent' : 'diagnostic', observer: process.env.LOAD_OBSERVER ?? 'operator-load-harness',
    durationSeconds: ingestDurationSeconds, batchEvents, requestedEventsPerSecond: eventsPerSecond, eventsPerSecond: acceptedEvents / ingestDurationSeconds, acceptedEvents, errors, droppedBatches,
    ingestP95Ms: percentile(ingest, 0.95), queryP95Ms: percentile(queries, 0.95), evaluationP95Ms: percentile(evaluations, 0.95),
    sampleEvaluations: sampled.length, evaluated, pendingEvaluations: sampled.length - evaluated, syntheticWorkload: true };
  const passed = errors === 0 && droppedBatches === 0 && acceptedEvents === batchCount * batchEvents && report.pendingEvaluations === 0 && (report.ingestP95Ms ?? Infinity) <= 500 && (report.queryP95Ms ?? Infinity) <= 1000 && (report.evaluationP95Ms ?? Infinity) <= 90000;
  await writeFile(process.env.LOAD_REPORT_PATH ?? '.local/load-report.json', JSON.stringify({ ...report, passed }, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ ...report, passed }) + '\n'); if (!passed) process.exitCode = 1;
}
if (process.argv[1]?.endsWith('/load.ts') || process.argv[1]?.endsWith('/load.mjs')) loadTest().catch(() => { process.stderr.write('Load verification failed. No release evidence was produced.\n'); process.exitCode = 1; });
