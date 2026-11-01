import type { Outcome,AgentEvent } from '@agent-quality/contracts';
import type { Outcome as PublicOutcome,AgentEvent as PublicEvent } from '../../packages/sdk-typescript/src/types.ts';
type Assert<T extends true>=T;
type OutcomeCompatibility=Assert<PublicOutcome extends Outcome?Outcome extends PublicOutcome?true:false:false>;
type EventCompatibility=Assert<PublicEvent extends AgentEvent?AgentEvent extends PublicEvent?true:false:false>;
