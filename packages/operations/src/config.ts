import { z } from 'zod';

export const retention = Object.freeze({ detailDays: 30, aggregateDays: 90, auditDays: 365, backupDays: 7, backupHours: 6 });
export const operationsConfigSchema = z.object({
  ARCHIVE_BUCKET: z.string().min(1).default('agent-quality-private'),
  ARCHIVE_AFTER_DAYS: z.coerce.number().int().min(1).max(29).default(7),
  OPERATIONS_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  OPERATIONS_INTERVAL_MS: z.coerce.number().int().min(1000).default(60000),
  BACKUP_REGION: z.literal('ap-southeast-1').default('ap-southeast-1'),
  MONTHLY_BUDGET_USD: z.coerce.number().min(50).default(150),
  BUDGET_ALERT_USD: z.coerce.number().positive().max(120).default(120),
  CAPACITY_OVER_150_APPROVED: z.enum(['true', 'false']).default('false'),
}).superRefine((v, ctx) => {
  if (v.MONTHLY_BUDGET_USD > 150 && v.CAPACITY_OVER_150_APPROVED !== 'true')
    ctx.addIssue({ code: 'custom', path: ['MONTHLY_BUDGET_USD'], message: 'Capacity above $150 requires explicit budget approval.' });
  if (v.BUDGET_ALERT_USD > v.MONTHLY_BUDGET_USD)
    ctx.addIssue({ code: 'custom', path: ['BUDGET_ALERT_USD'], message: 'Budget alert must not exceed the budget.' });
});
export function operationsConfig(env: Record<string, string | undefined> = process.env) { return operationsConfigSchema.parse(env); }
export function requiredSecret(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name]; if (!value) throw new Error(`Configure ${name} in the server secret store.`); return value;
}
