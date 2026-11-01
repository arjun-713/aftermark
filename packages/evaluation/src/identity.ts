import { connectionBindingSchema, type ConnectionBinding, type Evidence, type Outcome, type ProviderResourceIdentity, type VerificationBinding } from '../../contracts/src/index.ts';
import { canonical } from '../../contracts/src/redaction.ts';

export function resourceIdentity(outcome: Outcome): ProviderResourceIdentity | undefined {
  if (!outcome.resource.id) return undefined;
  if (outcome.source === 'github' && outcome.resource.repository) return { provider: 'github', repository: outcome.resource.repository.toLowerCase(), id: outcome.resource.id };
  if (outcome.source === 'hubspot') return { provider: 'hubspot', id: outcome.resource.id };
  return undefined;
}
export function connectionBinding(connection: { id: string; verification_version: number }): ConnectionBinding | undefined {
  const parsed = connectionBindingSchema.safeParse({ connectionId: connection.id, verificationVersion: connection.verification_version });
  return parsed.success ? parsed.data : undefined;
}
export function snapshotVerificationBindings(outcomes: Outcome[], connections: { id: string; provider: string; verification_version: number }[]): Record<string, VerificationBinding | null> {
  return Object.fromEntries(outcomes.filter(outcome => outcome.source !== 'customer_verifier').map(outcome => {
    const resource = resourceIdentity(outcome); const connection = connections.find(value => value.provider === outcome.source); const binding = connection && connectionBinding(connection);
    return [outcome.id, resource && binding ? { resourceIdentity: resource, connectionBinding: binding } : null];
  }));
}
export function matchesProviderEvidence(outcome: Outcome, evidence: Evidence, expected: VerificationBinding | null | undefined): boolean {
  const resource = resourceIdentity(outcome);
  return Boolean(resource && expected && evidence.resourceIdentity && evidence.connectionBinding &&
    canonical(resource) === canonical(expected.resourceIdentity) && canonical(evidence.resourceIdentity) === canonical(expected.resourceIdentity) &&
    canonical(evidence.connectionBinding) === canonical(expected.connectionBinding));
}
