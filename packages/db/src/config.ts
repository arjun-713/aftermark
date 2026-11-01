import 'dotenv/config';
import { z } from 'zod';
export const config = z.object({
  NODE_ENV: z.enum(['development','test','production']).default('development'), AUTH_MODE:z.enum(['local','supabase']).default('local'),
  DATABASE_URL: z.string().default('postgresql://aq_app:local_app_password@localhost:55432/agent_quality'),
  PORT:z.coerce.number().default(4100), WEB_ORIGIN:z.url().default('http://localhost:3000'),
  SESSION_SECRET:z.string().min(32).default('local-only-change-this-secret-at-least-32-characters')
}).parse(process.env);
if(config.NODE_ENV === 'production' && (config.AUTH_MODE !== 'supabase' || config.SESSION_SECRET.startsWith('local-only'))) throw new Error('Production requires Supabase authentication and a private session secret');
if(config.AUTH_MODE==='supabase'&&(!process.env.SUPABASE_URL||!process.env.SUPABASE_ANON_KEY))throw new Error('Supabase authentication requires its URL and public anon key');
if(config.NODE_ENV==='production'&&process.env.SUPABASE_URL&&!process.env.SUPABASE_URL.startsWith('https://'))throw new Error('Production authentication requires HTTPS');
