#!/usr/bin/env node
import { runCli } from './cli.ts';
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
try { process.exitCode = await runCli(process.argv.slice(2), { env: process.env, streams: { stdout: process.stdout, stderr: process.stderr }, fetch, signal: controller.signal }); }
finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
