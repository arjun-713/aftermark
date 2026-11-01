import { createHash } from 'node:crypto';
import { canonical } from '../../contracts/src/redaction.ts';
import type { Policy } from '@agent-quality/contracts';
import { jevModel } from './jev.ts';
export function detectorHash(policy:Policy){return createHash('sha256').update(canonical({model:jevModel,checks:policy.checks.map(({blocking,...check})=>check)})).digest('hex');}
