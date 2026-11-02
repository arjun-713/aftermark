import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const roles = { api: 'dist/api.mjs', worker: 'dist/worker.mjs', web: 'apps/web/server.js', migrate: 'dist/db/migrate.mjs',
  backup: 'dist/backup.mjs', restore: 'dist/restore.mjs', load: 'dist/load.mjs', release: 'dist/release-gates.mjs' };
const credentialRoles = {
  DATABASE_URL:['api','worker','migrate','restore'], MIGRATION_DATABASE_URL:['migrate'], BACKUP_DATABASE_URL:['backup'], RESTORE_DATABASE_URL:['restore'], SOURCE_DATABASE_URL:['restore'],
  TYPESAFE_API_KEY:['worker'], BACKUP_ENCRYPTION_KEY:['backup','restore'], SESSION_SECRET:['api','worker','migrate','restore'],
  SUPABASE_SERVICE_ROLE_KEY:['api','worker','backup','restore'], KMS_KEY_ID:['api','worker','restore'],
  AWS_ACCESS_KEY_ID:['api','worker','backup','restore'], AWS_SECRET_ACCESS_KEY:['api','worker','backup','restore'], AWS_SESSION_TOKEN:['api','worker','backup','restore'],
  DELETION_JOURNAL_HMAC_KEY:['api','worker','restore'], GITHUB_APP_PRIVATE_KEY:['api','worker'], GITHUB_CLIENT_SECRET:['api','worker'], HUBSPOT_CLIENT_SECRET:['api','worker'],
  DODO_PAYMENTS_API_KEY:['api','worker'], DODO_PAYMENTS_WEBHOOK_KEY:['api','worker'], RESEND_API_KEY:['api'],
};
function origin(value) {
  let url; try { url = new URL(value); } catch { throw new Error('API_ORIGIN must be an HTTP(S) origin.'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('API_ORIGIN must be an HTTP(S) origin.');
  return url.origin;
}
export function validateRoleEnvironment(env, compiledOrigin) {
  const role = env.SERVICE_ROLE ?? 'api';
  if (!Object.hasOwn(roles,role)) throw new Error('SERVICE_ROLE must name a supported service.');
  const monthly = Number(env.MONTHLY_BUDGET_USD ?? 150);
  if (!Number.isFinite(monthly) || monthly < 50 || monthly > 150 && env.CAPACITY_OVER_150_APPROVED !== 'true') throw new Error('Monthly capacity budget requires explicit configuration/approval.');
  for (const [name,allowed] of Object.entries(credentialRoles)) if (env[name] && !allowed.includes(role)) throw new Error(`${name} is not permitted for SERVICE_ROLE=${role}.`);
  if (role !== 'worker' && env.SEMANTIC_EVALUATIONS_ENABLED === 'true') throw new Error('Semantic provider requests can be enabled only on the worker.');
  if (env.NODE_ENV === 'production' && ['api','worker','migrate','restore'].includes(role)) {
    for (const name of ['DATABASE_URL']) if (!env[name]) throw new Error(`Configure ${name} for this server role.`);
    if(role==='api'){for(const name of ['SESSION_SECRET','SUPABASE_URL','SUPABASE_ANON_KEY','WEB_ORIGIN'])if(!env[name])throw new Error(`Configure ${name} for the API role.`);if(env.AUTH_MODE!=='supabase')throw new Error('Production API requires Supabase authentication.');}
  }
  if (role === 'backup') for (const name of ['BACKUP_DATABASE_URL','BACKUP_BUCKET','BACKUP_KMS_KEY_ID','BACKUP_ENCRYPTION_KEY','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','ARCHIVE_BUCKET']) if (!env[name]) throw new Error(`Configure ${name} for the complete database/archive backup.`);
  if (role === 'migrate' && !env.MIGRATION_DATABASE_URL) throw new Error('Configure the migration-only database credential.');
  if (role === 'web') {
    if (!env.API_ORIGIN || !compiledOrigin) throw new Error('Web startup requires API_ORIGIN and the image build-origin record.');
    if (origin(env.API_ORIGIN) !== origin(compiledOrigin)) throw new Error('API_ORIGIN differs from the compiled Next rewrite. Rebuild the web image.');
  }
  return { role,apiOrigin:role === 'web' ? origin(env.API_ORIGIN) : env.API_ORIGIN };
}
export function serviceExitCode(role, code, signal, requestedSignal) {
  const requestedCode = requestedSignal === 'SIGTERM' ? 143 : 130;
  if (['api','worker','web'].includes(role) && requestedSignal && (code === 0 || code === requestedCode || signal === requestedSignal)) return 0;
  return code ?? (signal ? 1 : 0);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const compiledOrigin = process.env.SERVICE_ROLE === 'web' ? readFileSync(new URL('./build-api-origin',import.meta.url),'utf8') : undefined;
  const { role,apiOrigin } = validateRoleEnvironment(process.env,compiledOrigin);
  const child = spawn(process.execPath,[roles[role],...process.argv.slice(2)],{ stdio:'inherit',env:{ ...process.env,...(apiOrigin?{API_ORIGIN:apiOrigin}:{}),WORKER_PORT:process.env.PORT ?? '10000' } });
  let requestedSignal;
  for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{requestedSignal=signal;child.kill(signal);});
  child.on('exit',(code,signal)=>{process.exitCode=serviceExitCode(role,code,signal,requestedSignal);});
  child.on('error',()=>{process.stderr.write('Service could not start.\n');process.exitCode=1;});
}
