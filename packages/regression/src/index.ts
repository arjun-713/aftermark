import { createHash } from 'node:crypto';
import { canonical } from '../../contracts/src/redaction.ts';
import { assess, expectedOutcomes, type FrozenRun } from '../../evaluation/src/index.ts';
import { validateJevResponse } from '../../evaluation/src/jev.ts';
import { detectorHash } from '../../evaluation/src/calibration.ts';
import { calibrationCaseSchema, regressionCaseSchema } from './contracts.ts';
import type { Assessment, Policy } from '../../contracts/src/index.ts';
import type {
  AssertionResult, CandidateSpec, CaseReport, ComparisonReport, Dataset, EvaluationSnapshot,
  ExperimentSnapshot, RegressionCase, ReportStatus, SemanticGate, Summary,
} from './contracts.ts';
export * from './contracts.ts';

export function contentHash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function datasetHash(dataset: Pick<Dataset, 'name' | 'kind' | 'version' | 'cases'>): string {
  return contentHash({ name: dataset.name, kind: dataset.kind, version: dataset.version, cases: dataset.cases });
}
export function validateDataset(dataset: Dataset): void {
  const schema = dataset.kind === 'agent_regression' ? regressionCaseSchema : calibrationCaseSchema;
  if (!dataset.cases.length || new Set(dataset.cases.map(c => c.id)).size !== dataset.cases.length) throw new Error('Dataset case IDs must be unique and nonempty.');
  for (const value of dataset.cases) {
    schema.parse(value);
    if (contentHash(value.frozenInput) !== value.traceHash) throw new Error(`Frozen case ${value.id} does not match its trace hash.`);
  }
  if (datasetHash(dataset) !== dataset.hash) throw new Error('Dataset content does not match its immutable hash.');
}
export function validateCoverage(caseIds: string[], candidates: CandidateSpec[]): void {
  if (new Set(candidates.map(c => c.name)).size !== candidates.length) throw new Error('Candidate names must be unique.');
  const expected = new Set(caseIds);
  for (const candidate of candidates) {
    const actual = new Set(candidate.runs.map(run => run.caseId));
    if (actual.size !== candidate.runs.length || actual.size !== expected.size || [...actual].some(id => !expected.has(id)))
      throw new Error(`Candidate ${candidate.name} must map every dataset case exactly once, with no extra case IDs.`);
    if (new Set(candidate.runs.map(run => run.runId)).size !== candidate.runs.length)
      throw new Error(`Candidate ${candidate.name} must use a distinct run for every case.`);
  }
}
export function replayFrozen(input: FrozenRun, providerResponse: unknown, gate?: SemanticGate): Assessment {
  let semantic;
  try { if (providerResponse) semantic = validateJevResponse(providerResponse, input.policy); } catch { /* Invalid stored answers retain uncertainty. */ }
  return assess({ ...input, calibrationApproved: Boolean(input.calibrationApproved && gate?.calibrationApproved && gate.policyActivated && gate.detectorHash === detectorHash(input.policy)) }, semantic);
}

const statusOf = (assertions: AssertionResult[]): ReportStatus => assertions.some(a => a.status === 'fail') ? 'failed' : assertions.some(a => a.status === 'unknown') ? 'indeterminate' : 'passed';
export function summarize(cases: CaseReport[]): Summary {
  return { cases: cases.length, passed: cases.filter(c => c.status === 'passed').length, failed: cases.filter(c => c.status === 'failed').length,
    indeterminate: cases.filter(c => c.status === 'indeterminate').length, requiredUnknown: cases.reduce((sum, c) => sum + c.requiredUnknown, 0), semanticReviewOnly: cases.reduce((sum, c) => sum + c.semanticReviewOnly, 0) };
}
const summaryStatus = (summary: Summary): ReportStatus => summary.failed ? 'failed' : summary.indeterminate ? 'indeterminate' : 'passed';

export function compareCase(source: RegressionCase, mapping: { runId: string; revision: number }, evaluation: EvaluationSnapshot | undefined,
  policy: { id: string; hash: string; definition: Policy }, gate: SemanticGate, allowRequiredUnknown = false): CaseReport {
  const assertions: AssertionResult[] = [];
  const add = (code: string, status: AssertionResult['status'], message: string) => assertions.push({ code, status, message });
  const base: CaseReport = { caseId: source.id, runId: mapping.runId, revision: mapping.revision, evaluationId: evaluation?.id ?? null,
    expectedBehavior: source.expectedBehavior, executionStatus: null, qualityDecision: null, verification: 'unknown', status: 'indeterminate',
    requiredUnknown: source.expectations.filter(outcome => outcome.required).length, semanticReviewOnly: 0, assertions, findings: [], limitations: [] };
  if (!evaluation || !evaluation.completedAt || !evaluation.frozenInput) {
    add('evaluation_pending', 'unknown', 'The pinned run revision has no completed frozen evaluation under the selected policy.'); return base;
  }
  if (evaluation.runId !== mapping.runId || evaluation.revision !== mapping.revision || evaluation.policyId !== policy.id || evaluation.policyHash !== policy.hash ||
      contentHash(evaluation.frozenInput.policy) !== contentHash(policy.definition) || evaluation.frozenInput.id !== mapping.runId || evaluation.frozenInput.revision !== mapping.revision) {
    add('evaluation_identity', 'unknown', 'The evaluation does not match the pinned run revision and immutable policy.'); return base;
  }
  if (evaluation.processing === 'error') { add('evaluation_error', 'unknown', 'Evaluation processing failed. Inspect the run and retry evaluation.'); return base; }
  if (!['completed', 'partial'].includes(evaluation.processing)) { add('evaluation_pending', 'unknown', 'Evaluation processing has not reached a terminal state.'); return base; }
  const assessment = replayFrozen(evaluation.frozenInput, evaluation.providerResponse, gate);
  const expected = source.expectedBehavior;
  const input = evaluation.frozenInput;
  base.executionStatus = input.executionStatus; base.qualityDecision = assessment.decision; base.findings = assessment.findings; base.limitations = assessment.limitations;
  add('execution_status', expected.executionStatuses.includes(input.executionStatus as any) ? 'pass' : 'fail', `Expected execution ${expected.executionStatuses.join(' or ')}; recorded ${input.executionStatus}.`);
  const finalText = input.events.filter(e => e.kind === 'message' || ['run.completed', 'run.failed', 'run.cancelled'].includes(e.kind)).map(e => e.payload.text ?? '').join('\n');
  for (const phrase of expected.messageIncludes) add('acknowledgement', finalText.toLocaleLowerCase('en-US').includes(phrase.toLocaleLowerCase('en-US')) ? 'pass' : 'fail', `The recorded response must include ${JSON.stringify(phrase)}.`);
  const candidateExpectations = new Map(expectedOutcomes(input).map(outcome => [outcome.id, outcome]));
  const required = source.expectations.filter(outcome => outcome.required);
  for (const outcome of source.expectations) {
    const candidate = candidateExpectations.get(outcome.id);
    const mustMatch = outcome.required || expected.outcomes.some(item => item.id === outcome.id);
    if (!mustMatch) continue;
    const contractMatches = candidate && candidate.required === outcome.required && candidate.operation === outcome.operation && candidate.source === outcome.source && canonical(candidate.assertions) === canonical(outcome.assertions)
      && candidate.observationWindowSeconds === outcome.observationWindowSeconds && candidate.resource.repository === outcome.resource.repository && candidate.resource.toolResultField === outcome.resource.toolResultField;
    add('outcome_contract', contractMatches ? 'pass' : 'fail', `Outcome ${outcome.id} must preserve the published operation, source, assertions, observation window, repository, and required flag. Resource IDs may differ between runs.`);
  }
  const outcomeResults = new Map(assessment.outcomes.map(outcome => [outcome.id, outcome]));
  const outcomeAssertions = new Map(expected.outcomes.map(outcome => [outcome.id, outcome.verification]));
  if (expected.kind === 'completion') for (const outcome of required) if (!outcomeAssertions.has(outcome.id)) outcomeAssertions.set(outcome.id, 'verified');
  if (expected.kind === 'completion' && !required.length && !outcomeAssertions.size) add('completion_contract', 'unknown', 'Completion needs at least one explicit outcome assertion.');
  for (const [id, wanted] of outcomeAssertions) {
    const actual = outcomeResults.get(id)?.verification ?? 'unknown';
    add('outcome_assertion', actual === 'unknown' ? 'unknown' : actual === wanted ? 'pass' : 'fail', `Outcome ${id}: expected ${wanted}; recorded ${actual}.`);
  }
  const requiredResults = [...new Set([...required.map(o => o.id), ...assessment.outcomes.filter(o => o.required).map(o => o.id)])].map(id => outcomeResults.get(id));
  base.requiredUnknown = requiredResults.filter(outcome => !outcome || outcome.verification === 'unknown').length;
  if (base.requiredUnknown) add('required_unknown', allowRequiredUnknown ? 'allowed' : 'unknown', `${base.requiredUnknown} required outcome(s) remain unknown.${allowRequiredUnknown ? ' The experiment explicitly allows this uncertainty.' : ' CI blocks this uncertainty by default.'}`);
  base.verification = !requiredResults.length ? 'not_required' : base.requiredUnknown ? 'unknown' : requiredResults.some(outcome => outcome?.verification === 'contradicted') ? 'contradicted' : 'verified';
  for (const finding of assessment.findings.filter(finding => finding.blocking)) {
    const expectedContradiction = expected.kind !== 'completion' && finding.code === 'outcome_contradicted' && finding.outcomeId && outcomeAssertions.get(finding.outcomeId) === 'contradicted';
    add(finding.code, expectedContradiction ? 'pass' : 'fail', expectedContradiction ? `The contradiction of ${finding.outcomeId} is explicitly expected for ${expected.kind}.` : finding.summary);
  }
  base.semanticReviewOnly = assessment.findings.filter(finding => finding.code.startsWith('semantic_') && !finding.blocking).length;
  if (base.semanticReviewOnly) add('semantic_review_only', 'allowed', `${base.semanticReviewOnly} semantic finding(s) remain for review; they do not block without the exact calibrated and activated policy.`);
  for (const limitation of assessment.limitations) {
    const semanticOnly = input.policy.semanticEnabled && (!gate.calibrationApproved || !gate.policyActivated) && /Semantic checks|Semantic answer/.test(limitation);
    const noOutcomeFailure = expected.kind !== 'completion' && limitation.startsWith('No explicit expected outcomes');
    if (!semanticOnly && !noOutcomeFailure) add('trace_limitation', 'unknown', limitation);
  }
  base.status = statusOf(assertions); return base;
}

export function buildComparison(input: {
  experimentId: string; projectId: string; name: string; createdAt: string; dataset: Dataset;
  policy: { id: string; version: number; hash: string; definition: Policy }; snapshot: ExperimentSnapshot; evaluations: EvaluationSnapshot[];
}, now = new Date()): ComparisonReport {
  validateDataset(input.dataset);
  if (input.dataset.kind !== 'agent_regression') throw new Error('Evaluator calibration datasets cannot be used for agent regression experiments.');
  if (input.dataset.hash !== input.snapshot.datasetHash || input.policy.hash !== input.snapshot.policyHash) throw new Error('The experiment does not match its immutable dataset and policy hashes.');
  validateCoverage(input.dataset.cases.map(c => c.id), input.snapshot.candidates);
  const byIdentity = new Map(input.evaluations.map(evaluation => [`${evaluation.runId}:${evaluation.revision}`, evaluation]));
  const byId = new Map(input.evaluations.map(evaluation => [evaluation.id, evaluation]));
  const caseById = new Map((input.dataset.cases as RegressionCase[]).map(value => [value.id, value]));
  let ready = true;
  const candidates = input.snapshot.candidates.map(candidate => {
    const cases = candidate.runs.map(mapping => {
      const evaluation = mapping.evaluationId ? byId.get(mapping.evaluationId) : byIdentity.get(`${mapping.runId}:${mapping.revision}`);
      if (!evaluation?.completedAt) ready = false;
      return compareCase(caseById.get(mapping.caseId)!, mapping, evaluation, input.policy, input.snapshot.semanticGate, input.snapshot.allowRequiredUnknown);
    });
    const summary = summarize(cases); return { name: candidate.name, status: summaryStatus(summary), summary, cases };
  });
  const summary = summarize(candidates.flatMap(candidate => candidate.cases)); const status = summaryStatus(summary);
  return { schemaVersion: '1.0', experimentId: input.experimentId, projectId: input.projectId, name: input.name, createdAt: input.createdAt, generatedAt: now.toISOString(),
    dataset: { id: input.dataset.id, name: input.dataset.name, kind: 'agent_regression', version: input.dataset.version, hash: input.dataset.hash },
    policy: { id: input.policy.id, version: input.policy.version, name: input.policy.definition.name, hash: input.policy.hash, semanticGate: input.snapshot.semanticGate },
    allowRequiredUnknown: input.snapshot.allowRequiredUnknown, ready, status, exitCode: !ready ? 2 : status === 'passed' ? 0 : status === 'failed' ? 1 : 2, summary, candidates,
    historicalReplay: true, customerCodeExecuted: false, externalRequestsRepeated: false };
}
