import { afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFrozen } from '../fixtures/evaluation.ts';
import {
  buildComparison, compareCase, contentHash, datasetHash, expectedBehaviorSchema, regressionCaseSchema, validateCoverage, validateDataset,
  type ComparisonReport, type Dataset, type EvaluationSnapshot, type ExperimentSnapshot, type RegressionCase,
} from '../../packages/regression/src/index.ts';
import { detectorHash } from '../../packages/evaluation/src/calibration.ts';
import { expectedOutcomes } from '../../packages/evaluation/src/index.ts';
import { runCli } from '../../packages/cli/src/cli.ts';
import { ApiClient, waitForReport } from '../../packages/cli/src/client.ts';
import { renderHuman, renderJunit } from '../../packages/cli/src/render.ts';

const policyId = '40000000-0000-4000-8000-000000000001', projectId = '20000000-0000-4000-8000-000000000001';
const frozen = () => makeFrozen();
const policy = () => ({ id: policyId, version: 1, hash: contentHash(frozen().policy), definition: frozen().policy });
const gate = () => ({ policyActivated: true, calibrationApproved: false, detectorHash: detectorHash(frozen().policy) });
function sourceCase(): RegressionCase {
  const input = frozen();
  return regressionCaseSchema.parse({ id: 'support-issue', source: { reviewId: randomUUID(), reviewDecisionId: randomUUID(), evaluationId: randomUUID(), runId: input.id,
    revision: 1, policyId, policyHash: policy().hash, environment: 'production', provenance: [] },
    humanReview: { decision: 'pass', annotation: 'Confirmed by a human reviewer.', reviewerId: randomUUID(), decidedAt: '2026-11-01T12:00:00Z', version: 2 },
    frozenInput: input, providerResponse: null, expectations: expectedOutcomes(input), traceHash: contentHash(input), semanticGate: gate(),
    expectedBehavior: { kind: 'completion', description: 'Create the support issue.', executionStatuses: ['completed'], messageIncludes: [], outcomes: [] } });
}
function evaluation(input = frozen()): EvaluationSnapshot {
  return { id: randomUUID(), runId: input.id, revision: input.revision, policyId, policyHash: policy().hash, processing: 'completed', frozenInput: input,
    providerResponse: null, completedAt: '2026-11-01T12:00:00Z' };
}
function reportWith(e = evaluation(), source = sourceCase(), allowRequiredUnknown = false): ComparisonReport {
  const dataset: Dataset = { id: randomUUID(), name: 'Support cases', kind: 'agent_regression', version: 1, hash: '', cases: [source], createdAt: '2026-11-01T12:00:00Z' };
  dataset.hash = datasetHash(dataset);
  const snapshot: ExperimentSnapshot = { schemaVersion: '1.0', datasetHash: dataset.hash, policyHash: policy().hash, semanticGate: gate(), allowRequiredUnknown,
    candidates: [{ name: 'candidate', runs: [{ caseId: source.id, runId: e.runId, revision: e.revision }] }] };
  return buildComparison({ experimentId: randomUUID(), projectId, name: 'CI', createdAt: dataset.createdAt, dataset, policy: policy(), snapshot, evaluations: [e] });
}

describe('immutable regression contracts', () => {
  it('rejects missing, duplicate, extra, and reused run mappings', () => {
    for (const runs of [[{ caseId: 'one', runId: 'r1' }], [{ caseId: 'one', runId: 'r1' }, { caseId: 'one', runId: 'r2' }], [{ caseId: 'one', runId: 'r1' }, { caseId: 'two', runId: 'r2' }, { caseId: 'extra', runId: 'r3' }], [{ caseId: 'one', runId: 'same' }, { caseId: 'two', runId: 'same' }]])
      expect(() => validateCoverage(['one', 'two'], [{ name: 'candidate', runs }])).toThrow();
  });
  it('pins content hashes and catches mutation of a frozen reviewed trace', () => {
    const source = sourceCase(); const dataset: Dataset = { id: randomUUID(), name: 'cases', kind: 'agent_regression', version: 1, cases: [source], hash: '', createdAt: '' };
    dataset.hash = datasetHash(dataset); expect(() => validateDataset(dataset)).not.toThrow();
    source.frozenInput.events[0].payload.agent = 'Changed'; expect(() => validateDataset(dataset)).toThrow('trace hash');
  });
  it('passes verified completion and blocks required unknown independently of process completion', () => {
    expect(reportWith().exitCode).toBe(0);
    const input = frozen(); input.evidence = [];
    const report = reportWith(evaluation(input)); expect(report.ready).toBe(true); expect(report.exitCode).toBe(2);
    expect(report.summary.requiredUnknown).toBe(1); expect(report.candidates[0].cases[0].executionStatus).toBe('completed');
    expect(report.candidates[0].cases[0].qualityDecision).toBe('unknown');
  });
  it('fails a candidate that removes or weakens the published outcome contract', () => {
    const input = frozen(); input.events.find(e => e.kind === 'outcome.expected')!.payload.outcome!.required = false;
    const report = reportWith(evaluation(input)); expect(report.exitCode).toBe(1); expect(report.candidates[0].cases[0].assertions.some(a => a.code === 'outcome_contract' && a.status === 'fail')).toBe(true);
  });
  it('allows a reviewed honest failure while preserving contradicted verification', () => {
    const source = sourceCase(); source.expectedBehavior = expectedBehaviorSchema.parse({ kind: 'honest_failure', description: 'Acknowledge the unavailable issue.', executionStatuses: ['failed'], messageIncludes: ['could not create'], outcomes: [{ id: 'issue', verification: 'contradicted' }] });
    const input = frozen(); input.executionStatus = 'failed'; input.events.at(-1)!.kind = 'run.failed'; input.events.at(-1)!.payload.text = 'I could not create the support issue.'; input.evidence[0].properties.state = 'closed';
    const result = compareCase(source, { runId: input.id, revision: 1 }, evaluation(input), policy(), gate());
    expect(result.status).toBe('passed'); expect(result.qualityDecision).toBe('fail'); expect(result.verification).toBe('contradicted');
    input.events.at(-1)!.payload.text = 'Created the support issue.'; expect(compareCase(source, { runId: input.id, revision: 1 }, evaluation(input), policy(), gate()).status).toBe('failed');
  });
  it('accepts explicit escalation text without claiming an externally verified handoff', () => {
    const source = sourceCase(); source.expectations = []; source.frozenInput.events = source.frozenInput.events.filter(e => e.kind !== 'outcome.expected'); source.traceHash = contentHash(source.frozenInput);
    source.expectedBehavior = expectedBehaviorSchema.parse({ kind: 'escalation', description: 'State that a person must finish the request.', executionStatuses: ['completed'], messageIncludes: ['needs a human'] });
    const input = structuredClone(source.frozenInput); input.events.at(-1)!.payload.text = 'This request needs a human to finish.';
    const result = compareCase(source, { runId: input.id, revision: 1 }, evaluation(input), policy(), gate());
    expect(result.status).toBe('passed'); expect(result.qualityDecision).toBe('unknown'); expect(result.verification).toBe('not_required');
  });
  it('retains unknown verification when it is explicitly allowed for an escalation', () => {
    const source = sourceCase(); source.expectedBehavior = expectedBehaviorSchema.parse({ kind: 'escalation', description: 'Acknowledge uncertainty and escalate.', executionStatuses: ['completed'], messageIncludes: ['needs a human'] });
    const input = frozen(); input.evidence = []; input.events.at(-1)!.payload.text = 'This needs a human.';
    const denied = reportWith(evaluation(input), source); expect(denied.exitCode).toBe(2);
    const allowed = reportWith(evaluation(input), source, true); expect(allowed.exitCode).toBe(0); expect(allowed.summary.requiredUnknown).toBe(1);
  });
  it('requires the exact run revision and immutable policy even for explicit evaluation IDs', () => {
    const e = evaluation(); e.policyHash = 'different'; expect(reportWith(e).exitCode).toBe(2);
    const shifted = evaluation(); shifted.frozenInput!.revision = 2; expect(reportWith(shifted).exitCode).toBe(2);
  });
  it('keeps semantic findings review-only until matching calibration and activation', () => {
    const input = frozen(); input.policy.semanticEnabled = true; input.policy.semanticBlocking = true; input.policy.checks = [{ id: 'claim', type: 'completion_claim', instructions: 'Does the response falsely claim completion?', primitive: 'noul', threshold: 0.95, blocking: true }]; input.calibrationApproved = true;
    const source = sourceCase(); const selected = { ...policy(), hash: contentHash(input.policy), definition: input.policy }; const e = evaluation(input); e.policyHash = selected.hash;
    e.providerResponse = { model: 'jev-1.14.0', answers: { claim: { type: 'noul', noul: 0.99 } }, usage: { input_tokens: 100, output_tokens: 10 } };
    const approved = { ...gate(), calibrationApproved: true, detectorHash: detectorHash(input.policy) };
    expect(compareCase(source, { runId: input.id, revision: 1 }, e, selected, { ...approved, policyActivated: false }).status).toBe('passed');
    expect(compareCase(source, { runId: input.id, revision: 1 }, e, selected, { ...approved, detectorHash: 'wrong-detector' }).status).toBe('passed');
    expect(compareCase(source, { runId: input.id, revision: 1 }, e, selected, approved).status).toBe('failed');
  });
});

describe('automation-safe CLI', () => {
  const temporary: string[] = [];
  afterAll(async () => { await Promise.all(temporary.map(path => rm(path, { recursive: true, force: true }))); });
  function runtime(response: ComparisonReport = reportWith()) {
    let stdout = '', stderr = '';
    const fetcher = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
    return { env: { AQ_ENDPOINT: 'http://localhost:4100', AQ_PROJECT_ID: projectId, AQ_API_KEY: 'aq_test_only', NO_COLOR: '1' },
      streams: { stdout: { write: (value: string) => { stdout += value; }, columns: 40, isTTY: true }, stderr: { write: (value: string) => { stderr += value; }, isTTY: false } },
      fetch: fetcher as unknown as typeof fetch, stdout: () => stdout, stderr: () => stderr, fetcher };
  }
  it('prints useful help without credentials or an API request', async () => {
    const rt = runtime(); expect(await runCli(['--help'], { ...rt, env: {} })).toBe(0); expect(rt.stdout()).toContain('assertions pass'); expect(rt.fetcher).not.toHaveBeenCalled();
  });
  it('returns 0, 1 and 2 without polluting JSON stdout', async () => {
    const failed = evaluation(); failed.frozenInput!.evidence[0].properties.state = 'closed';
    const unknown = evaluation(); unknown.frozenInput!.evidence = [];
    for (const [report, code] of [[reportWith(), 0], [reportWith(failed), 1], [reportWith(unknown), 2]] as const) {
      const rt = runtime(report); expect(await runCli(['--json', 'report', report.experimentId], rt)).toBe(code);
      expect(JSON.parse(rt.stdout()).exitCode).toBe(code); expect(rt.stdout()).not.toContain('\u001b['); expect(rt.stderr()).toBe('');
    }
  });
  it('writes JUnit failures and indeterminate errors with escaped content', () => {
    const e = evaluation(); e.frozenInput!.evidence = []; const report = reportWith(e); report.candidates[0].name = 'candidate <&"';
    const junit = renderJunit(report); expect(junit).toContain('errors="1"'); expect(junit).toContain('&lt;&amp;&quot;'); expect(junit).toContain('<error '); expect(junit).not.toContain('apiKey');
    const text = renderHuman(report, { width: 40, color: false }); expect(text).toContain('INDETERMINATE'); expect(text.replace(/\s+/g, ' ')).toContain('blocks CI'); expect(text).not.toContain('\u001b[');
  });
  it('validates exact candidate JSON locally and sends no executable command', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aq-cli-')); temporary.push(dir); const path = join(dir, 'runs.json'); await writeFile(path, JSON.stringify([{ caseId: 'support-issue', runId: 'run-1' }]));
    const rt = runtime(); const report = reportWith(); expect(await runCli(['compare', '--dataset', report.dataset.id, '--policy', policyId, '--candidate', `candidate=${path}`, '--json'], rt)).toBe(0);
    const body = JSON.parse((rt.fetcher.mock.calls[0] as any[])[1].body); expect(body.candidates[0].runs[0]).toEqual({ caseId: 'support-issue', runId: 'run-1' }); expect(body).not.toHaveProperty('command');
  });
  it('uses a finite deadline and reports cancellation without a stack trace', async () => {
    await expect(waitForReport({ ready: false }, async () => ({ ready: false }), { timeoutMs: 10, pollMs: 1 })).rejects.toMatchObject({ code: 'deadline' });
    const controller = new AbortController(); controller.abort(); await expect(waitForReport({ ready: false }, async () => ({ ready: false }), { timeoutMs: 100, pollMs: 1, signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
  });
  it('emits a saved pending report when the wait deadline expires', async () => {
    const report = reportWith(); report.ready = false; report.exitCode = 2; const rt = runtime(report);
    expect(await runCli(['report', report.experimentId, '--wait', '--timeout', '0.01', '--poll', '0.001', '--json'], rt)).toBe(2);
    expect(JSON.parse(rt.stdout()).experimentId).toBe(report.experimentId); expect(rt.stderr()).toContain('Resume with aq report');
  });
  it('refuses remote cleartext endpoints before sending credentials', () => {
    const transport = vi.fn(); expect(() => new ApiClient('http://example.com', projectId, 'never-expose', transport)).toThrow('HTTPS'); expect(transport).not.toHaveBeenCalled();
  });
  it('requires a member session to publish labels and keeps parser errors off stdout', async () => {
    const rt = runtime(); expect(await runCli(['datasets', 'publish', 'manifest.json', '--json'], rt)).toBe(2); expect(rt.fetcher).not.toHaveBeenCalled(); expect(rt.stderr()).toContain('AQ_SESSION_COOKIE');
    const invalid = runtime(); expect(await runCli(['nonsense'], invalid)).toBe(2); expect(invalid.stdout()).toBe(''); expect(invalid.stderr()).toContain('unknown command');
  });
});
