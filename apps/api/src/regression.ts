import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenant, rows, sql, type Tx } from '@agent-quality/db';
import { expectedOutcomes } from '../../../packages/evaluation/src/index.ts';
import { detectorHash } from '../../../packages/evaluation/src/calibration.ts';
import {
  buildComparison, contentHash, datasetHash, experimentSchema, frozenRunSchema, publishDatasetSchema,
  replayFrozen, validateCoverage, validateDataset,
  type Dataset, type DatasetCase, type EvaluationSnapshot, type ExperimentSnapshot, type PinnedCandidate, type SemanticGate,
} from '../../../packages/regression/src/index.ts';
import { authorize } from './auth.ts';
import { audit } from './management.ts';
import { assert } from './errors.ts';

const projectQuery = z.object({ projectId: z.uuid() });
const objectId = z.object({ id: z.uuid() });
const toDataset = (row: any): Dataset => ({ id: row.id, name: row.name, kind: row.kind, version: row.version, hash: row.hash, cases: row.cases, createdAt: new Date(row.created_at).toISOString() });
const toEvaluation = (row: any): EvaluationSnapshot => ({ id: row.id, runId: row.run_id, runInstanceId: row.run_instance_id, revision: row.revision, policyId: row.policy_id, policyHash: row.policy_hash,
  processing: row.processing, frozenInput: row.frozen_input, providerResponse: row.provider_response, completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null });

async function semanticGate(tx: Tx, projectId: string, policy: any): Promise<SemanticGate> {
  const [project] = await rows<any>(tx, sql`select active_policy_id from projects where id=${projectId}`);
  const hash = detectorHash(policy.definition);
  const [report] = policy.definition.calibrationReportId ? await rows<any>(tx, sql`select id,passed,detector_hash from calibration_reports where project_id=${projectId} and id=${policy.definition.calibrationReportId}`) : [];
  return { policyActivated: project?.active_policy_id === policy.id, calibrationApproved: Boolean(report?.passed && report.detector_hash === hash), detectorHash: hash, ...(report ? { reportId: report.id } : {}) };
}
function assertDataset(row: any): Dataset {
  assert(row, 404, 'not_found', 'Dataset not found.');
  const dataset = toDataset(row);
  try { validateDataset(dataset); } catch { assert(false, 409, 'dataset_integrity', 'The dataset content no longer matches its immutable manifest.'); }
  return dataset;
}
async function comparison(tx: Tx, projectId: string, id: string) {
  const [experiment] = await rows<any>(tx, sql`select * from experiments where project_id=${projectId} and id=${id}`);
  assert(experiment, 404, 'not_found', 'Experiment not found.');
  const [datasetRow] = await rows<any>(tx, sql`select * from datasets where project_id=${projectId} and id=${experiment.dataset_id}`);
  const dataset = assertDataset(datasetRow);
  const [policy] = await rows<any>(tx, sql`select * from policies where project_id=${projectId} and id=${experiment.policy_id}`);
  const snapshot = experiment.candidates as ExperimentSnapshot;
  assert(snapshot?.schemaVersion === '1.0' && Array.isArray(snapshot.candidates), 409, 'experiment_integrity', 'The experiment is missing a pinned regression manifest.');
  const identities = snapshot.candidates.flatMap(candidate => candidate.runs).map(run => sql`(run_id=${run.runId} and run_instance_id=${run.runInstanceId ?? null}::uuid and revision=${run.revision})`);
  const evaluations = identities.length ? await rows<any>(tx, sql`select * from evaluations where project_id=${projectId} and policy_id=${experiment.policy_id} and (${sql.join(identities, sql` or `)})`) : [];
  try {
    return buildComparison({ experimentId: id, projectId, name: experiment.name, createdAt: new Date(experiment.created_at).toISOString(), dataset,
      policy: { id: policy.id, version: policy.version, hash: policy.hash, definition: policy.definition }, snapshot, evaluations: evaluations.map(toEvaluation) });
  } catch { assert(false, 409, 'experiment_integrity', 'The experiment does not match its immutable dataset and policy manifest.'); }
}

export async function regressionRoutes(app: FastifyInstance) {
  app.get('/v1/datasets', async request => {
    const { projectId, kind } = projectQuery.extend({ kind: z.enum(['agent_regression', 'evaluator_calibration']).optional() }).parse(request.query);
    const a = await authorize(request, { scope: 'read', projectId });
    return tenant(a.organizationId, a.userId, tx => rows(tx, sql`select id,name,kind,version,hash,jsonb_array_length(cases) as case_count,created_at from datasets where project_id=${projectId} and (${kind ?? null}::text is null or kind=${kind ?? null}) order by created_at desc,id limit 100`));
  });
  app.get('/v1/datasets/:id', async request => {
    const { id } = objectId.parse(request.params); const { projectId } = projectQuery.parse(request.query);
    const a = await authorize(request, { scope: 'read', projectId });
    return tenant(a.organizationId, a.userId, async tx => assertDataset((await rows(tx, sql`select * from datasets where project_id=${projectId} and id=${id}`))[0]));
  });
  app.post('/v1/datasets', async (request, reply) => {
    const body = publishDatasetSchema.parse(request.body);
    const a = await authorize(request, { sessionOnly: true, roles: ['owner', 'admin', 'member'], projectId: body.projectId });
    assert(new Set(body.cases.map(c => c.caseId ?? c.reviewId)).size === body.cases.length && new Set(body.cases.map(c => c.reviewId)).size === body.cases.length,
      400, 'duplicate_case', 'Each review and case ID may occur only once in a dataset version.');
    const published = await tenant(a.organizationId, a.userId, async tx => {
      await tx.execute(sql`select id from projects where id=${body.projectId} for update`);
      const cases: DatasetCase[] = [];
      for (const requested of body.cases) {
        const [source] = await rows<any>(tx, sql`select r.*,e.frozen_input,e.provider_response,e.policy_id,e.policy_hash,e.revision as evaluated_revision,e.completed_at as evaluated_at,run.environment,run.expired_at,
          d.id as decision_id,d.reviewer_id,d.created_at as decided_at,d.annotation as decision_annotation,d.decision as human_decision,p.definition as policy_definition
          from reviews r join evaluations e on e.organization_id=r.organization_id and e.project_id=r.project_id and e.id=r.evaluation_id
          join runs run on run.organization_id=r.organization_id and run.project_id=r.project_id and run.id=r.run_id
          join policies p on p.organization_id=e.organization_id and p.project_id=e.project_id and p.id=e.policy_id
          join review_decisions d on d.organization_id=r.organization_id and d.project_id=r.project_id and d.review_id=r.id and d.version=r.version
          where r.project_id=${body.projectId} and r.id=${requested.reviewId} for share of r,run`);
        assert(source, 404, 'review_not_found', 'A reviewed case with an immutable human decision is required.');
        assert(!source.expired_at, 410, 'data_expired', 'Expired run content cannot be published.');
        assert(source.version === requested.reviewVersion, 409, 'review_conflict', 'The review version changed. Refresh before publishing.');
        assert(source.status === 'resolved' && ['pass', 'fail'].includes(source.human_decision) && source.evaluated_at && source.frozen_input, 409, 'review_unresolved', 'Resolve the human review of a frozen completed evaluation before publishing.');
        const frozenInput = frozenRunSchema.parse(source.frozen_input);
        const expectations = expectedOutcomes(frozenInput);
        if ('expectedBehavior' in requested) {
          assert(requested.expectedBehavior.outcomes.every(outcome => expectations.some(expected => expected.id === outcome.id)), 400, 'unknown_outcome', 'Expected outcome assertions must name an outcome in the frozen reviewed trace.');
          if (requested.expectedBehavior.kind === 'completion') assert(expectations.some(outcome => outcome.required), 400, 'completion_contract', 'A completion case needs a required expected outcome in its frozen trace.');
        }
        const common = { id: requested.caseId ?? requested.reviewId,
          source: { reviewId: source.id, reviewDecisionId: source.decision_id, evaluationId: source.evaluation_id, runId: source.run_id, revision: source.evaluated_revision, policyId: source.policy_id, policyHash: source.policy_hash, environment: source.environment,
            provenance: [...new Set(frozenInput.events.flatMap(event => {
              const metadata = event.payload.metadata;
              return ['sample', 'fixture', 'provenance'].flatMap(key => metadata?.[key] === true ? [key] : typeof metadata?.[key] === 'string' ? [String(metadata[key]).slice(0, 500)] : []);
            }))].slice(0, 20) },
          humanReview: { decision: source.human_decision, annotation: source.decision_annotation, reviewerId: source.reviewer_id, decidedAt: new Date(source.decided_at).toISOString(), version: source.version },
          frozenInput, providerResponse: source.provider_response ?? null, expectations, traceHash: contentHash(frozenInput),
          semanticGate: await semanticGate(tx, body.projectId, { id: source.policy_id, definition: source.policy_definition }) };
        cases.push('expectedBehavior' in requested ? { ...common, expectedBehavior: requested.expectedBehavior } : { ...common, humanLabel: requested.humanLabel, stratum: requested.stratum });
      }
      const [{ version }] = await rows<any>(tx, sql`select coalesce(max(version),0)+1 as version from datasets where project_id=${body.projectId} and name=${body.name} and kind=${body.kind}`);
      const hash = datasetHash({ name: body.name, kind: body.kind, version, cases });
      const [row] = await rows<any>(tx, sql`insert into datasets(organization_id,project_id,name,kind,version,cases,hash) values(${a.organizationId},${body.projectId},${body.name},${body.kind},${version},${JSON.stringify(cases)}::jsonb,${hash}) returning *`);
      await audit(tx, a.organizationId, a.userId, 'dataset.published', row.id);
      return toDataset(row);
    });
    return reply.code(201).send(published);
  });
  app.post('/v1/datasets/:id/replay', async request => {
    const { id } = objectId.parse(request.params); const { projectId } = projectQuery.parse(request.body);
    const a = await authorize(request, { scope: 'evaluate', roles: ['owner', 'admin', 'member'], projectId });
    return tenant(a.organizationId, a.userId, async tx => {
      const dataset = assertDataset((await rows(tx, sql`select * from datasets where project_id=${projectId} and id=${id}`))[0]);
      return { datasetId: dataset.id, datasetHash: dataset.hash, kind: dataset.kind, version: dataset.version, historicalReplay: true,
        customerCodeExecuted: false, externalRequestsRepeated: false, cases: dataset.cases.map(value => ({ caseId: value.id, source: value.source,
          assessment: replayFrozen(value.frozenInput, value.providerResponse, value.semanticGate) })) };
    });
  });
  app.post('/v1/experiments', async (request, reply) => {
    const body = experimentSchema.parse(request.body);
    const a = await authorize(request, { scope: 'ci', roles: ['owner', 'admin', 'member'], projectId: body.projectId });
    const report = await tenant(a.organizationId, a.userId, async tx => {
      const dataset = assertDataset((await rows(tx, sql`select * from datasets where project_id=${body.projectId} and id=${body.datasetId}`))[0]);
      assert(dataset.kind === 'agent_regression', 409, 'wrong_dataset_kind', 'Evaluator calibration datasets cannot be used for agent regression experiments.');
      assert(!body.datasetHash || body.datasetHash === dataset.hash, 409, 'dataset_mismatch', 'The supplied dataset hash does not match this immutable version.');
      try { validateCoverage(dataset.cases.map(c => c.id), body.candidates); } catch (error) { assert(false, 400, 'case_coverage', (error as Error).message); }
      const [policy] = await rows<any>(tx, sql`select * from policies where project_id=${body.projectId} and id=${body.policyId}`);
      assert(policy, 404, 'policy_not_found', 'Policy not found.');
      assert(!body.policyHash || body.policyHash === policy.hash, 409, 'policy_mismatch', 'The supplied policy hash does not match this immutable version.');
      const candidates: PinnedCandidate[] = [];
      const requestedEvaluations = new Map<string, { runId: string; revision: number }>();
      for (const candidate of body.candidates) {
        const runs: PinnedCandidate['runs'] = [];
        for (const mapping of candidate.runs) {
          const [run] = await rows<any>(tx, sql`select id,instance_id,revision,execution_status,expired_at,environment from runs where project_id=${body.projectId} and id=${mapping.runId} for share`);
          assert(run, 404, 'run_not_found', 'A candidate run was not found in this project. Submit its trace first.');
          assert(!run.expired_at, 410, 'data_expired', 'Candidate run content has expired.');
          assert(run.execution_status !== 'running', 409, 'run_incomplete', 'Candidate runs need a terminal execution event before comparison.');
          assert(run.environment !== 'production', 409, 'candidate_environment', 'Submit regression candidate runs with environment test or staging.');
          const [evaluation] = mapping.evaluationId
            ? await rows<any>(tx, sql`select * from evaluations where project_id=${body.projectId} and id=${mapping.evaluationId}`)
            : await rows<any>(tx, sql`select * from evaluations where project_id=${body.projectId} and run_id=${mapping.runId} and revision=${run.revision} and policy_id=${body.policyId}`);
          if (mapping.evaluationId) assert(evaluation && evaluation.run_id === run.id && evaluation.run_instance_id === run.instance_id && evaluation.policy_id === policy.id && evaluation.policy_hash === policy.hash,
            409, 'evaluation_mismatch', 'The candidate evaluation must belong to this run and the selected immutable policy.');
          assert(!evaluation || evaluation.revision === run.revision || evaluation.completed_at, 409, 'evaluation_superseded', 'A pending older evaluation cannot process a newer run revision. Select a completed evaluation or the current run revision.');
          const revision = evaluation?.revision ?? run.revision;
          runs.push({ caseId: mapping.caseId, runId: mapping.runId, runInstanceId: run.instance_id, revision, ...(evaluation ? { evaluationId: evaluation.id } : {}) });
          if (!evaluation?.completed_at && body.evaluateMissing) requestedEvaluations.set(`${mapping.runId}:${revision}`, { runId: mapping.runId, revision });
        }
        candidates.push({ name: candidate.name, runs });
      }
      const snapshot: ExperimentSnapshot = { schemaVersion: '1.0', datasetHash: dataset.hash, policyHash: policy.hash, semanticGate: await semanticGate(tx, body.projectId, policy), allowRequiredUnknown: body.allowRequiredUnknown, candidates };
      const [experiment] = await rows<any>(tx, sql`insert into experiments(organization_id,project_id,name,dataset_id,policy_id,candidates) values(${a.organizationId},${body.projectId},${body.name},${dataset.id},${policy.id},${JSON.stringify(snapshot)}::jsonb) returning id`);
      if (requestedEvaluations.size) {
        const { enqueue } = await import('../../../packages/db/src/queue.ts');
        for (const run of requestedEvaluations.values()) await enqueue(tx, { organizationId: a.organizationId, projectId: body.projectId, runId: run.runId, revision: run.revision, policyId: policy.id, explicit: true }, 0);
      }
      await audit(tx, a.organizationId, a.userId, 'experiment.created', experiment.id);
      return comparison(tx, body.projectId, experiment.id);
    });
    return reply.code(201).send(report);
  });
  app.get('/v1/experiments', async request => {
    const { projectId } = projectQuery.parse(request.query); const a = await authorize(request, { scope: 'ci', projectId });
    return tenant(a.organizationId, a.userId, tx => rows(tx, sql`select e.id,e.name,e.dataset_id,e.policy_id,e.created_at,d.name as dataset_name,d.version as dataset_version,d.hash as dataset_hash from experiments e join datasets d on d.organization_id=e.organization_id and d.project_id=e.project_id and d.id=e.dataset_id where e.project_id=${projectId} order by e.created_at desc,e.id limit 100`));
  });
  app.get('/v1/experiments/:id', async request => {
    const { id } = objectId.parse(request.params); const { projectId } = projectQuery.parse(request.query);
    const a = await authorize(request, { scope: 'ci', projectId });
    return tenant(a.organizationId, a.userId, tx => comparison(tx, projectId, id));
  });
}
