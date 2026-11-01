import { spawn } from 'node:child_process';
const role = process.env.SERVICE_ROLE ?? 'api';
const roles = { api: 'dist/api.mjs', worker: 'dist/worker.mjs', web: 'apps/web/server.js', migrate: 'dist/db/migrate.mjs',
  backup: 'dist/backup.mjs', restore: 'dist/restore.mjs', load: 'dist/load.mjs', release: 'dist/release-gates.mjs' };
if (!Object.hasOwn(roles, role)) throw new Error('SERVICE_ROLE must name a supported service.');
const monthly = Number(process.env.MONTHLY_BUDGET_USD ?? 150);
if (!Number.isFinite(monthly) || monthly < 50 || monthly > 150 && process.env.CAPACITY_OVER_150_APPROVED !== 'true') throw new Error('Monthly capacity budget requires explicit configuration/approval.');
if (role !== 'migrate' && process.env.MIGRATION_DATABASE_URL) throw new Error('Migration credentials must not be present in a running service.');
if (!['backup','restore','migrate'].includes(role) && process.env.BACKUP_DATABASE_URL) throw new Error('Backup credentials must not be present in application services.');
const child = spawn(process.execPath, [roles[role], ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, WORKER_PORT: process.env.PORT ?? '10000' } });
for (const signal of ['SIGTERM','SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
child.on('error', () => { process.stderr.write('Service could not start.\n'); process.exitCode = 1; });
