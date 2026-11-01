import { describe, expect, it, vi } from 'vitest';
import { assess, expectedOutcomes } from '../../packages/evaluation/src/index.ts';
import { snapshotVerificationBindings } from '../../packages/evaluation/src/identity.ts';
import { semanticRequest, scoreLegend, validateJevResponse } from '../../packages/evaluation/src/jev.ts';
import { frozenRunSchema } from '../../packages/regression/src/contracts.ts';
import { replayFrozen } from '../../packages/regression/src/index.ts';
import { observe } from '../../packages/integrations/src/providers.ts';
import { expected, fixtureConnectionBinding, makeFrozen } from '../fixtures/evaluation.ts';

describe('policy-authoritative outcome contracts', () => {
  it('never accepts trace assertions that weaken the mapped policy', () => {
    const input = makeFrozen(); input.policy.toolMappings = [{ tool: 'github.createIssue', outcome: structuredClone(expected) }];
    input.events.find(event => event.kind === 'outcome.expected')!.payload.outcome!.assertions.state = 'closed'; input.evidence[0].properties.state = 'closed';
    expect(expectedOutcomes(input)[0].assertions.state).toBe('open'); expect(assess(input).decision).toBe('fail');
    input.events=input.events.filter(event=>!['tool.called','tool.result'].includes(event.kind));expect(assess(input).decision).toBe('fail');
  });
  it('retains required policy outcomes when a trace downgrades its required flag', () => {
    const input = makeFrozen(); input.policy.toolMappings = [{ tool: 'github.createIssue', outcome: structuredClone(expected) }];
    input.events.find(event => event.kind === 'outcome.expected')!.payload.outcome!.required = false;
    const result = assess(input); expect(result.outcomes[0].required).toBe(true); expect(result.decision).toBe('unknown'); expect(result.limitations.join(' ')).toContain('immutable policy mapping');
  });
  it('allows only explicitly configured tool-result resource resolution', () => {
    const input = makeFrozen(); const mapped = structuredClone(expected); mapped.resource = { repository: 'example/support', toolResultField: 'number' };
    input.policy.toolMappings = [{ tool: 'github.createIssue', outcome: mapped }];
    expect(expectedOutcomes(input)[0].resource.id).toBe('42'); expect(assess(input).decision).toBe('pass');
    input.events.find(event => event.kind === 'outcome.expected')!.payload.outcome!.resource.id = '999'; expect(assess(input).decision).toBe('unknown');
  });
});

describe('resource and provider account binding', () => {
  it('rejects repository A issue 42 for repository B issue 42 despite a newer unavailable result', () => {
    const input = makeFrozen(); input.events.find(event => event.kind === 'outcome.expected')!.payload.outcome!.resource.repository = 'example/repo-b';
    input.verificationBindings!.issue!.resourceIdentity = { provider: 'github', repository: 'example/repo-b', id: '42' };
    input.evidence.push({ ...input.evidence[0], id: 'unavailable-b', resourceIdentity: { provider: 'github', repository: 'example/repo-b', id: '42' }, status: 'unavailable', observedAt: '2026-11-01T10:00:11Z' });
    expect(assess(input).outcomes[0].verification).toBe('unknown'); expect(assess(input).decision).toBe('unknown');
  });
  it.each(['version', 'connection'] as const)('rejects HubSpot contact observations after an account %s change', changed => {
    const input = makeFrozen(); const outcome = input.events.find(event => event.kind === 'outcome.expected')!.payload.outcome!;
    outcome.source = 'hubspot'; outcome.operation = 'hubspot.contact.update'; outcome.resource = { id: '123' }; outcome.assertions = { stage: 'customer' };
    const prior = structuredClone(fixtureConnectionBinding); const current = { ...prior, ...(changed === 'version' ? { verificationVersion: 2 } : { connectionId: '60000000-0000-4000-8000-000000000002' }) };
    input.verificationBindings = { issue: { resourceIdentity: { provider: 'hubspot', id: '123' }, connectionBinding: current } };
    input.evidence = [{ ...input.evidence[0], provider: 'hubspot', resourceId: '123', resourceIdentity: { provider: 'hubspot', id: '123' }, connectionBinding: prior, properties: { stage: 'customer' } }];
    expect(assess(input).decision).toBe('unknown');
  });
  it.each(['missing snapshot', 'missing evidence identity', 'missing evidence binding'] as const)('keeps legacy %s unknown', mode => {
    const input = makeFrozen(); if (mode === 'missing snapshot') delete input.verificationBindings;
    if (mode === 'missing evidence identity') delete input.evidence[0].resourceIdentity;
    if (mode === 'missing evidence binding') delete input.evidence[0].connectionBinding;
    expect(assess(input).decision).toBe('unknown');
  });
  it('preserves frozen bindings through dataset parsing and ignores later connection changes during replay', () => {
    const input = makeFrozen(); const connection = { id: fixtureConnectionBinding.connectionId, provider: 'github', verification_version: 1 };
    input.verificationBindings = snapshotVerificationBindings(expectedOutcomes(input), [connection]);
    const parsed = frozenRunSchema.parse(input); connection.verification_version = 2;
    expect(parsed).toEqual(input); expect(replayFrozen(parsed, null).decision).toBe('pass');
    const amended = { ...parsed, verificationBindings: snapshotVerificationBindings(expectedOutcomes(parsed), [connection]) }; expect(assess(amended).decision).toBe('unknown');
  });
  it('retains separate signed customer-verifier verification without a provider binding', () => {
    const input = makeFrozen(); input.events.find(event => event.kind === 'outcome.expected')!.payload.outcome!.source = 'customer_verifier';
    input.evidence[0].source = 'customer_verifier'; delete input.verificationBindings; delete input.evidence[0].resourceIdentity; delete input.evidence[0].connectionBinding;
    expect(assess(input).decision).toBe('pass');
  });
  it('refuses to issue even a read-only observation without a frozen connection binding', async () => {
    const transport = vi.fn(); const observation = await observe(expected, 'synthetic-token', transport);
    expect(observation.status).toBe('unavailable'); expect(transport).not.toHaveBeenCalled();
  });
});

describe('shared score legend', () => {
  const input = makeFrozen(); input.policy.semanticEnabled = true;
  input.policy.checks = [{ id: 'requirement', type: 'requirement', instructions: 'Was the user requirement satisfied?', primitive: 'score', threshold: 0.95, blocking: true }];
  const answer = { type: 'score', confidence: 1, probabilities: { '0': 0, '1': 0, '2': 1 }, score: 2, legend: scoreLegend };
  const response = (legend: Record<string,string>) => ({ model: 'jev-1.14.0', answers: { requirement: { ...answer, legend } }, usage: { input_tokens: 100, output_tokens: 10 } });
  it('uses one exact legend for requests and accepted responses', () => {
    const question=semanticRequest(input).questions.requirement;expect('criteria' in question ? question.criteria : undefined).toEqual(Object.values(scoreLegend));
    expect(validateJevResponse(response(scoreLegend), input.policy).probabilities.requirement).toBe(1);
  });
  it.each([
    { ...scoreLegend, '0': scoreLegend['2'], '2': scoreLegend['0'] },
    { '0': scoreLegend['0'], '1': scoreLegend['1'] },
    { ...scoreLegend, '3': 'Other meaning' },
  ])('rejects reversed, missing and extra score meanings', legend => { expect(() => validateJevResponse(response(legend), input.policy)).toThrow('legend'); });
});
