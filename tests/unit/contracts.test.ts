import { describe,it,expect } from 'vitest';
import { eventSchema,eventBatchSchema,receiptSchema } from '@agent-quality/contracts';
const event={schemaVersion:'1.0',eventId:'event_1',runId:'same-run-id',kind:'run.completed',timestamp:'2026-11-01T10:00:00Z',agentVersion:'v1',environment:'test',payload:{text:'I could not complete the update.'}};
describe('public ingestion contract',()=>{
  it('keeps organization identity outside event bodies',()=>{expect(eventSchema.safeParse({...event,organizationId:'forged'}).success).toBe(false);});
  it('requires a real tool result to name its call and success state',()=>{expect(eventSchema.safeParse({...event,kind:'tool.result'}).success).toBe(false);});
  it('rejects empty batches and batches above the atomic event cap',()=>{
    const projectId='20000000-0000-4000-8000-000000000001';
    expect(eventBatchSchema.safeParse({projectId,events:[]}).success).toBe(false);
    expect(eventBatchSchema.safeParse({projectId,events:Array(101).fill(event)}).success).toBe(false);
  });
  it('does not allow the receipt sender to assign provider provenance',()=>{expect(receiptSchema.safeParse({receiptId:'1',projectId:'20000000-0000-4000-8000-000000000001',runId:'same-run-id',outcomeId:'outcome_1',observedAt:'2026-11-01T10:00:00Z',resourceId:'1',properties:{},status:'observed',source:'provider_observation'}).success).toBe(false);});
});
