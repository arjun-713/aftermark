import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import { ZodError } from 'zod';
import { config } from '../../../packages/db/src/config.ts';
import { pool } from '@agent-quality/db';
import { ApiError } from './errors.ts';
import { authRoutes } from './auth.ts';
import { managementRoutes } from './management.ts';
import { ingestionRoutes } from './ingestion.ts';
import { runRoutes } from './runs.ts';
import { evaluationRoutes } from './evaluations.ts';
import { evidenceRoutes } from './evidence.ts';
import { connectionRoutes } from './connections.ts';
import { reviewRoutes } from './reviews.ts';
import { regressionRoutes } from './regression.ts';
import { commerceRoutes } from './commerce.ts';

export async function buildServer() {
  const app=Fastify({bodyLimit:1048576,ajv:{customOptions:{removeAdditional:false,coerceTypes:false}},disableRequestLogging:true,logger:config.NODE_ENV!=='test'?{level:'info',redact:['req.headers.authorization','req.headers.cookie','req.body','res.headers.set-cookie']}:false,trustProxy:false});
  await app.register(cookie);
  await app.register(rateLimit,{max:600,timeWindow:'1 minute'});
  await app.register(swagger,{openapi:{info:{title:'Agent Quality API',version:'1.0.0'},components:{securitySchemes:{apiKey:{type:'http',scheme:'bearer'}}}}});
  app.get('/openapi.json',async()=>app.swagger());
  app.get('/docs',async(_request,reply)=>reply.type('text/html').send('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Agent Quality API</title><style>body{font:16px/1.6 system-ui;max-width:960px;margin:40px auto;padding:20px}pre{white-space:pre-wrap;background:#f6f7f8;padding:20px}a{color:#08717d}</style><h1>Agent Quality API · v1</h1><p>Authenticate with a scoped Bearer API key. A 202 event response means durable acceptance, not completed evaluation.</p><p><a href="/openapi.json">Download OpenAPI contract</a></p><pre id="contract">Loading contract…</pre><script>fetch("/openapi.json").then(r=>r.json()).then(x=>document.getElementById("contract").textContent=JSON.stringify(x,null,2))</script></html>'));
  app.addHook('onRequest',async request=>{
    if(['POST','PUT','PATCH','DELETE'].includes(request.method) && request.headers.origin && request.headers.origin!==config.WEB_ORIGIN) throw new ApiError(403,'origin_rejected','This request origin is not allowed.');
  });
  app.setErrorHandler((error,request,reply)=>{
    if(error instanceof ZodError) return reply.code(400).send({error:{code:'invalid_request',message:'The request does not match the API contract.',issues:error.issues.map(x=>({path:x.path,message:x.message}))},requestId:request.id});
    const status=error instanceof ApiError?error.status:(error as any).statusCode??500;
    if(status>=500) app.log.error({requestId:request.id,code:(error as any).code??'internal'},'Request failed');
    return reply.code(status).send({error:{code:error instanceof ApiError?error.code:status===413?'payload_too_large':'request_failed',message:status>=500?'The service could not complete this request. Please retry.':error instanceof Error?error.message:'Request failed.'},requestId:request.id});
  });
  app.get('/health',async()=>({status:'ok'}));
  app.get('/ready',async(_request,reply)=>{try{await pool.query('select 1'); return {status:'ready'};}catch{return reply.code(503).send({status:'unavailable'});}});
  await authRoutes(app); await managementRoutes(app);await ingestionRoutes(app);await runRoutes(app);await evaluationRoutes(app);
  await connectionRoutes(app);await reviewRoutes(app);await regressionRoutes(app);await commerceRoutes(app);await app.register(evidenceRoutes);
  return app;
}
