import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pool, rows, sql, tenant } from '@agent-quality/db';
import { buildServer } from '../../apps/api/src/server.ts';
import { regressionRoutes } from '../../apps/api/src/regression.ts';
import { evaluateJob } from '../../apps/worker/src/evaluate.ts';
import { makeFrozen } from '../fixtures/evaluation.ts';
import { assess, type FrozenRun } from '../../packages/evaluation/src/index.ts';
import { stopQueue } from '../../packages/db/src/queue.ts';
import type { Dataset } from '../../packages/regression/src/index.ts';
import { runCli } from '../../packages/cli/src/cli.ts';
import { bindProviderFixture } from '../fixtures/provider-connection.ts';

const org = '10000000-0000-4000-8000-000000000001', project = '20000000-0000-4000-8000-000000000001', user = '00000000-0000-4000-8000-000000000001';
const app = await buildServer(); if(!app.hasRoute({method:'GET',url:'/v1/datasets'}))await regressionRoutes(app);
let headers: Record<string, string>, ciHeaders: Record<string, string>, selectedPolicy: any;
let source: { reviewId: string; runId: string; evaluationId: string }, dataset: Dataset, candidate: string;
const expectation = { kind: 'completion', description: 'Create a verified support issue.', executionStatuses: ['completed'], messageIncludes: [], outcomes: [] };
const namespace = randomUUID();
function trace(runId: string, environment: 'test' | 'production' | 'staging' = 'test'): FrozenRun {
  const input = makeFrozen(); input.id = runId; input.policy = structuredClone(selectedPolicy.definition);
  input.events = input.events.map(event => ({ ...event, eventId: `${runId}-${event.eventId}`, runId, environment, payload: { ...event.payload, metadata: { sample: true, provenance: 'synthetic engineering fixture' } } }));
  return input;
}
async function reviewed(environment: 'test' | 'production' = 'test') {
  const runId = `source-${randomUUID()}`, evaluationId = randomUUID(), reviewId = randomUUID(); const input = trace(runId, environment);
  await tenant(org, user, async tx => {
    await bindProviderFixture(tx,org,project,input);
    const [run]=await rows<any>(tx,sql`insert into runs(organization_id,project_id,id,agent_version,environment,execution_status,started_at,completed_at,last_event_at) values(${org},${project},${runId},'v1',${environment},'completed',${input.startedAt},${input.completedAt},now()) returning instance_id`);input.runInstanceId=run.instance_id;
    await tx.execute(sql`insert into evaluations(organization_id,project_id,id,run_id,revision,policy_id,policy_hash,processing,frozen_input,assessment,completed_at) values(${org},${project},${evaluationId},${runId},1,${selectedPolicy.id},${selectedPolicy.hash},'completed',${JSON.stringify(input)}::jsonb,${JSON.stringify(assess(input))}::jsonb,now())`);
    await tx.execute(sql`insert into reviews(organization_id,project_id,id,evaluation_id,run_id,assigned_to,version,status,decision,annotation) values(${org},${project},${reviewId},${evaluationId},${runId},${user},2,'resolved','pass','Human-confirmed expected behavior.')`);
    await tx.execute(sql`insert into review_decisions(organization_id,project_id,review_id,reviewer_id,version,decision,annotation) values(${org},${project},${reviewId},${user},2,'pass','Human-confirmed expected behavior.')`);
  });
  return { reviewId, runId, evaluationId };
}
async function publish(name = `regression-${namespace}`, kind = 'agent_regression', reviewedCase = source) {
  return app.inject({ method: 'POST', url: '/v1/datasets', headers, payload: { projectId: project, name, kind,
    cases: [{ reviewId: reviewedCase.reviewId, reviewVersion: 2, ...(kind === 'agent_regression' ? { expectedBehavior: expectation } : { humanLabel: 'clear', stratum: 'completion' }) }] } });
}
async function candidateRun(evidence = true) {
  const runId = `candidate-${randomUUID()}`, input = trace(runId);
  const accepted = await app.inject({ method: 'POST', url: '/v1/events', headers, payload: { projectId: project, events: input.events } }); expect(accepted.statusCode).toBe(202);
  if (evidence) await tenant(org, user, async tx => {await bindProviderFixture(tx,org,project,input);await tx.execute(sql`insert into evidence(organization_id,project_id,run_id,body) values(${org},${project},${runId},${JSON.stringify(input.evidence[0])}::jsonb)`);});
  const result = await evaluateJob({ organizationId: org, projectId: project, runId, revision: 1, policyId: selectedPolicy.id, explicit: true });
  expect(result.status).toBe('completed'); return runId;
}
async function experiment(overrides: Record<string, unknown> = {}) {
  return app.inject({ method: 'POST', url: '/v1/experiments', headers: ciHeaders, payload: { projectId: project, name: `CI ${namespace}`, datasetId: dataset.id, datasetHash: dataset.hash,
    policyId: selectedPolicy.id, policyHash: selectedPolicy.hash, candidates: [{ name: 'candidate', runs: [{ caseId: dataset.cases[0].id, runId: candidate }] }], evaluateMissing: false, ...overrides } });
}

beforeAll(async () => {
  // The isolated local runner sets this guard; CI may use its own disposable database.
  if (process.env.AQ_REGRESSION_TEST_DATABASE) expect(new URL(process.env.DATABASE_URL!).pathname).toBe(`/${process.env.AQ_REGRESSION_TEST_DATABASE}`);
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'alex@example.test', password: 'local-password-123' } }); expect(login.statusCode).toBe(200);
  headers = { cookie: login.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), 'x-workspace-id': org };
  [selectedPolicy] = await tenant(org, user, tx => rows<any>(tx, sql`select p.* from policies p join projects pr on pr.organization_id=p.organization_id and pr.id=p.project_id and pr.active_policy_id=p.id where p.project_id=${project}`));
  const key = await app.inject({ method: 'POST', url: '/v1/keys', headers, payload: { projectId: project, name: 'Regression integration CI', scopes: ['ci', 'read'] } }); expect(key.statusCode).toBe(200);
  ciHeaders = { authorization: `Bearer ${key.json().secret}` };
  source = await reviewed(); const publication = await publish(); expect(publication.statusCode).toBe(201); dataset = publication.json(); candidate = await candidateRun();
});
afterAll(async () => { await app.close(); await stopQueue(); await pool.end(); });

describe('review to regression workflow', () => {
  it('publishes versioned frozen cases with human provenance and an honest environment', async () => {
    expect(dataset.kind).toBe('agent_regression'); expect(dataset.version).toBe(1); expect(dataset.cases[0].source.environment).toBe('test');
    expect(dataset.cases[0].source.provenance).toContain('synthetic engineering fixture'); expect(dataset.cases[0].source.reviewDecisionId).toBeTruthy();
    const next = await publish(); expect(next.statusCode).toBe(201); expect(next.json().version).toBe(2); expect(next.json().hash).not.toBe(dataset.hash);
    const production = await reviewed('production'); const prod = await publish(`production-${namespace}`, 'agent_regression', production); expect(prod.statusCode).toBe(201); expect(prod.json().cases[0].source.environment).toBe('production');
    await expect(tenant(org, user, tx => tx.execute(sql`update datasets set name='changed' where id=${dataset.id}`))).rejects.toMatchObject({ cause: { code: '42501' } });
  });
  it('rejects stale/unresolved reviews and CI attempts to publish labels', async () => {
    const request = { projectId: project, name: 'Stale', kind: 'agent_regression', cases: [{ reviewId: source.reviewId, reviewVersion: 1, expectedBehavior: expectation }] };
    expect((await app.inject({ method: 'POST', url: '/v1/datasets', headers, payload: request })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/v1/datasets', headers: ciHeaders, payload: request })).statusCode).toBe(403);
    const unresolved = await reviewed(); await tenant(org, user, tx => tx.execute(sql`update reviews set status='open' where id=${unresolved.reviewId}`));
    expect((await publish(`unresolved-${namespace}`, 'agent_regression', unresolved)).statusCode).toBe(409);
  });
  it('replays archived traces without new provider calls, ledger entries or run mutations', async () => {
    const counts = () => tenant(org, user, tx => rows<any>(tx, sql`select (select count(*) from usage_ledger) as usage,(select count(*) from evaluations) as evaluations,(select count(*) from evidence) as evidence,(select sum(revision) from runs) as revisions`));
    const before = await counts(); const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No external call is permitted'));
    try {
      const replay = await app.inject({ method: 'POST', url: `/v1/datasets/${dataset.id}/replay`, headers, payload: { projectId: project } });
      expect(replay.statusCode).toBe(200); expect(replay.json().externalRequestsRepeated).toBe(false); expect(replay.json().customerCodeExecuted).toBe(false);
      expect(replay.json().cases[0].assessment.decision).toBe('pass'); expect(fetchSpy).not.toHaveBeenCalled(); expect(await counts()).toEqual(before);
    } finally { fetchSpy.mockRestore(); }
  });
  it('separates evaluator calibration datasets from agent regression experiments', async () => {
    const response = await publish(`calibration-${namespace}`, 'evaluator_calibration'); expect(response.statusCode).toBe(201);
    expect(response.json().cases[0].humanLabel).toBe('clear'); expect(response.json().cases[0]).not.toHaveProperty('expectedBehavior');
    expect((await experiment({ datasetId: response.json().id, datasetHash: response.json().hash })).json().error.code).toBe('wrong_dataset_kind');
  });
  it('rejects incomplete/extra case coverage, wrong hashes, and wrong-policy evaluation IDs', async () => {
    const coverage = await experiment({ candidates: [{ name: 'candidate', runs: [{ caseId: 'extra-case', runId: candidate }] }] }); expect(coverage.statusCode).toBe(400); expect(coverage.json().error.code).toBe('case_coverage');
    expect((await experiment({ datasetHash: '0'.repeat(64) })).json().error.code).toBe('dataset_mismatch');
    expect((await experiment({ policyHash: 'different' })).json().error.code).toBe('policy_mismatch');
    const wrong = await experiment({ candidates: [{ name: 'candidate', runs: [{ caseId: dataset.cases[0].id, runId: candidate, evaluationId: source.evaluationId }] }] }); expect(wrong.statusCode).toBe(409); expect(wrong.json().error.code).toBe('evaluation_mismatch');
  });
  it('compares an ingested candidate and keeps the selected revision after late data', async () => {
    const response = await experiment(); expect(response.statusCode).toBe(201); expect(response.json().exitCode).toBe(0); expect(response.json().ready).toBe(true);
    const saved = response.json(); expect(saved.candidates[0].cases[0].revision).toBe(1); expect(saved.dataset.hash).toBe(dataset.hash);
    await tenant(org, user, tx => tx.execute(sql`update runs set revision=2 where id=${candidate}`));
    const fetched = await app.inject({ url: `/v1/experiments/${saved.experimentId}?projectId=${project}`, headers: ciHeaders });
    expect(fetched.statusCode).toBe(200); expect(fetched.json().candidates[0].cases[0].revision).toBe(1); expect(fetched.json().exitCode).toBe(0);
    await expect(tenant(org, user, tx => tx.execute(sql`update experiments set name='changed' where id=${saved.experimentId}`))).rejects.toMatchObject({ cause: { code: '42501' } });
  });
  it('returns indeterminate and blocks CI when an evaluated candidate lacks required evidence', async () => {
    const unknown = await candidateRun(false); const response = await experiment({ candidates: [{ name: 'unknown', runs: [{ caseId: dataset.cases[0].id, runId: unknown }] }] });
    expect(response.statusCode).toBe(201); expect(response.json().ready).toBe(true); expect(response.json().exitCode).toBe(2); expect(response.json().summary.requiredUnknown).toBe(1); expect(response.json().status).toBe('indeterminate');
  });
  it('keeps pending evaluations visible and schedules only selected-policy candidate processing', async () => {
    const pending = `pending-${randomUUID()}`; const input = trace(pending); const result = await app.inject({ method: 'POST', url: '/v1/events', headers, payload: { projectId: project, events: input.events } }); expect(result.statusCode).toBe(202);
    const response = await experiment({ evaluateMissing: true, candidates: [{ name: 'pending', runs: [{ caseId: dataset.cases[0].id, runId: pending }] }] });
    expect(response.statusCode).toBe(201); expect(response.json().ready).toBe(false); expect(response.json().exitCode).toBe(2); expect(response.json().candidates[0].cases[0].assertions[0].code).toBe('evaluation_pending');
  });
  it('drives the actual HTTP API through the CLI without mixing diagnostics into JSON', async () => {
    const runId = await candidateRun(); const directory = await mkdtemp(join(tmpdir(), 'aq-regression-http-'));
    try {
      const path = join(directory, 'candidate.json'); await writeFile(path, JSON.stringify([{ caseId: dataset.cases[0].id, runId }]));
      const endpoint = await app.listen({ host: '127.0.0.1', port: 0 }); let stdout = '', stderr = '';
      const code = await runCli(['compare', '--dataset', dataset.id, '--policy', selectedPolicy.id, '--candidate', `candidate=${path}`, '--no-evaluate', '--json'], {
        env: { AQ_ENDPOINT: endpoint, AQ_PROJECT_ID: project, AQ_API_KEY: ciHeaders.authorization.slice('Bearer '.length), NO_COLOR: '1' },
        streams: { stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } }, fetch });
      expect(code).toBe(0); expect(JSON.parse(stdout).candidates[0].cases[0].runId).toBe(runId); expect(stderr).toBe('');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('enforces project/tenant and CI scope boundaries', async () => {
    expect((await app.inject({ url: `/v1/datasets/${dataset.id}?projectId=${project}` })).statusCode).toBe(401);
    expect((await app.inject({ url: `/v1/datasets/${dataset.id}?projectId=20000000-0000-4000-8000-000000000002`, headers: ciHeaders })).statusCode).toBe(404);
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'sam@example.test', password: 'local-password-123' } });
    const foreign = { cookie: login.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-workspace-id': '10000000-0000-4000-8000-000000000002' };
    expect((await app.inject({ url: `/v1/datasets/${dataset.id}?projectId=20000000-0000-4000-8000-000000000002`, headers: foreign })).statusCode).toBe(404);
    const readKey = await app.inject({ method: 'POST', url: '/v1/keys', headers, payload: { projectId: project, name: 'read only', scopes: ['read'] } });
    expect((await app.inject({ url: `/v1/experiments?projectId=${project}`, headers: { authorization: `Bearer ${readKey.json().secret}` } })).statusCode).toBe(403);
  });
  it('cascades derived experiments when a curated dataset is explicitly deleted', async () => {
    const local = await publish(`deletion-${namespace}`); const published = local.json();
    // Use the already frozen candidate evaluation after its source run advanced.
    const [evaluation] = await tenant(org, user, tx => rows<any>(tx, sql`select id from evaluations where project_id=${project} and run_id=${candidate} and revision=1 and policy_id=${selectedPolicy.id}`));
    const created = await experiment({ datasetId: published.id, datasetHash: published.hash, candidates: [{ name: 'candidate', runs: [{ caseId: published.cases[0].id, runId: candidate, evaluationId: evaluation.id }] }] }); expect(created.statusCode).toBe(201);
    await tenant(org, user, tx => tx.execute(sql`delete from datasets where id=${published.id}`));
    expect((await app.inject({ url: `/v1/experiments/${created.json().experimentId}?projectId=${project}`, headers: ciHeaders })).statusCode).toBe(404);
  });
});
