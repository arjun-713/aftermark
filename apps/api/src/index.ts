import { buildServer } from './server.ts';
import { config } from '../../../packages/db/src/config.ts';
import { pool,assertApplicationRole } from '@agent-quality/db';
await assertApplicationRole();
const app=await buildServer();
await app.listen({port:config.PORT,host:'0.0.0.0'});
for(const signal of ['SIGTERM','SIGINT']) process.once(signal,async()=>{await app.close();await pool.end();process.exit(0);});
