import { readFile, writeFile } from 'node:fs/promises';
import { Command, CommanderError, Option } from 'commander';
import { z } from 'zod';
import { eventBatchSchema } from '../../contracts/src/index.ts';
import { candidateSchema, experimentSchema, publishDatasetSchema, type ComparisonReport } from '../../regression/src/contracts.ts';
import { ApiClient, CliError, waitForReport } from './client.ts';
import { renderHuman, renderInfrastructureJunit, renderJunit } from './render.ts';

type Streams = { stdout: { write(value: string): unknown; isTTY?: boolean; columns?: number }; stderr: { write(value: string): unknown; isTTY?: boolean } };
type Runtime = { env: Readonly<Record<string, string | undefined>>; streams: Streams; fetch: typeof fetch; signal?: AbortSignal };
type CliOptions = { endpoint?: string; project?: string; format: 'human' | 'json' | 'junit'; json?: boolean; plain?: boolean; color?: boolean; output?: string };
async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { throw new CliError(`Cannot read JSON from ${path}. Provide a readable UTF-8 JSON file.`, 'input'); }
}
const positive = (value: string) => { const parsed = Number(value); if (!Number.isFinite(parsed) || parsed <= 0) throw new CliError('Timeout and polling intervals must be positive numbers.', 'input'); return parsed; };

export async function runCli(argv: string[], runtime: Runtime): Promise<number> {
  let exitCode = 0;
  const program = new Command().name('aq').description('Assert agent regression quality against immutable reviewed cases.').version('0.1.0');
  program.exitOverride().configureOutput({ writeOut: value => runtime.streams.stdout.write(value), writeErr: value => runtime.streams.stderr.write(value) });
  program.option('--endpoint <url>', 'API endpoint (or AQ_ENDPOINT)', runtime.env.AQ_ENDPOINT)
    .option('--project <id>', 'Project UUID (or AQ_PROJECT_ID)', runtime.env.AQ_PROJECT_ID)
    .addOption(new Option('--format <format>', 'Report format').choices(['human', 'json', 'junit']).default('human'))
    .option('--json', 'Write JSON only to stdout').option('--plain', 'Use unstyled readable output').option('--no-color', 'Disable terminal color')
    .option('--output <path>', 'Write the result to a file instead of stdout')
    .addHelpText('after', '\nExamples:\n  aq compare --dataset <id> --policy <id> --candidate candidate=runs.json --wait --timeout 120\n  aq report <experiment-id> --json\n  aq submit events.json\n\nCredentials: AQ_API_KEY (server-side secret). CI exit codes: 0 assertions pass, 1 quality failure, 2 infrastructure or indeterminate.\n');
  const options = (): CliOptions => { const value = program.opts<CliOptions>(); return { ...value, format: value.json ? 'json' : value.format }; };
  const client = (memberSession = false) => {
    const opts = options();
    if (!opts.endpoint || !opts.project) throw new CliError('Set AQ_ENDPOINT and AQ_PROJECT_ID, or pass --endpoint and --project.', 'configuration');
    if (!z.uuid().safeParse(opts.project).success) throw new CliError('AQ_PROJECT_ID or --project must be a UUID.', 'configuration');
    if (memberSession) {
      if (!runtime.env.AQ_SESSION_COOKIE || !z.uuid().safeParse(runtime.env.AQ_WORKSPACE_ID).success) throw new CliError('Publishing human-reviewed datasets requires AQ_SESSION_COOKIE and AQ_WORKSPACE_ID from your workspace member session. CI API keys cannot publish human labels.', 'session_required');
      return new ApiClient(opts.endpoint, opts.project, '', runtime.fetch, runtime.signal, { cookie: runtime.env.AQ_SESSION_COOKIE, workspaceId: runtime.env.AQ_WORKSPACE_ID! });
    }
    if (!runtime.env.AQ_API_KEY) throw new CliError('Set AQ_API_KEY in the environment. Keep CI credentials server-side.', 'configuration');
    return new ApiClient(opts.endpoint, opts.project, runtime.env.AQ_API_KEY, runtime.fetch, runtime.signal);
  };
  const emit = async (value: unknown, kind: 'report' | 'json' = 'json') => {
    const opts = options();
    if (opts.format === 'junit' && kind !== 'report') throw new CliError('JUnit output is available for compare and report. Use --json for dataset and ingestion commands.', 'input');
    const output = kind === 'report' ? opts.format === 'json' ? JSON.stringify(value, null, 2) + '\n' : opts.format === 'junit' ? renderJunit(value as ComparisonReport) : renderHuman(value as ComparisonReport,
      { color: Boolean(opts.color && !opts.plain && runtime.streams.stdout.isTTY && !runtime.env.NO_COLOR && runtime.env.TERM !== 'dumb'), width: runtime.streams.stdout.columns }) : JSON.stringify(value, null, 2) + '\n';
    if (opts.output) await writeFile(opts.output, output, 'utf8'); else runtime.streams.stdout.write(output);
  };
  const printReport = async (initial: ComparisonReport, cmd: { wait?: boolean; timeout: number; poll: number }, api: ApiClient) => {
    let report = initial;
    if (cmd.wait && !report.ready) {
      if (runtime.streams.stderr.isTTY) runtime.streams.stderr.write(`Waiting for evaluations in experiment ${report.experimentId} (deadline ${cmd.timeout}s).\n`);
      try { report = await waitForReport(report, async deadline => {
        report = await api.request(`/v1/experiments/${encodeURIComponent(report.experimentId)}`, undefined, deadline); return report;
      }, { timeoutMs: cmd.timeout * 1000, pollMs: cmd.poll * 1000, signal: runtime.signal }); }
      catch (error) {
        if (!(error instanceof CliError) || error.code !== 'deadline') throw error;
        runtime.streams.stderr.write(`Evaluation deadline expired. Resume with aq report ${report.experimentId} --wait.\n`);
        // Keep the complete pending report useful to JSON and JUnit consumers.
        exitCode = 2; await emit(report, 'report'); return;
      }
    }
    exitCode = report.ready ? report.exitCode : 2; await emit(report, 'report');
  };
  const polling = (command: Command) => command.option('--wait', 'Wait for pinned candidate evaluations until the deadline').option('--timeout <seconds>', 'Maximum evaluation wait', positive, 120).option('--poll <seconds>', 'Polling interval', positive, 2);
  const datasets = program.command('datasets').description('Read or publish immutable reviewed datasets');
  datasets.command('list').description('List published dataset versions').action(async () => emit(await client().request('/v1/datasets')));
  datasets.command('get <dataset-id>').description('Export a frozen dataset version').action(async id => emit(await client().request(`/v1/datasets/${encodeURIComponent(id)}`)));
  datasets.command('publish <manifest>').description('Publish reviewed cases using an explicit workspace member session')
    .action(async path => { const api = client(true); const body = publishDatasetSchema.parse({ ...(await readJson(path) as object), projectId: api.projectId }); await emit(await api.request('/v1/datasets', body)); });
  datasets.command('replay <dataset-id>').description('Assess frozen cases without repeating external requests').action(async id => {
    const api = client(); await emit(await api.request(`/v1/datasets/${encodeURIComponent(id)}/replay`, { projectId: api.projectId }));
  });
  datasets.command('validate <manifest>').description('Validate a dataset publication manifest locally').action(async path => emit(publishDatasetSchema.parse(await readJson(path))));
  program.command('submit <events-file>').description('Submit a customer-generated event batch; executes no customer code').action(async path => {
    const api = client(); const input = await readJson(path); const body = eventBatchSchema.parse({ ...(input as object), projectId: api.projectId });
    await emit(await api.request('/v1/events', body));
  });
  polling(program.command('compare').description('Pin candidate runs and compare against one dataset and policy version')
    .requiredOption('--dataset <id>', 'Immutable regression dataset UUID').requiredOption('--policy <id>', 'Immutable policy UUID')
    .option('--name <name>', 'Experiment name', 'CI regression')
    .requiredOption('--candidate <name=file...>', 'Candidate name and JSON run mapping; repeat for comparisons', (value, previous: string[]) => [...previous, value], [] as string[])
    .option('--allow-required-unknown', 'Explicitly allow required unknown verification; recorded in the report')
    .option('--no-evaluate', 'Use only existing evaluations without scheduling missing revisions'))
    .action(async cmd => {
      const api = client(); const candidates = [];
      for (const item of cmd.candidate as string[]) {
        const split = item.indexOf('='); if (split <= 0 || split === item.length - 1) throw new CliError('Use --candidate name=runs.json. The file must contain [{"caseId":"case","runId":"run"}].', 'input');
        candidates.push(candidateSchema.parse({ name: item.slice(0, split), runs: await readJson(item.slice(split + 1)) }));
      }
      const body = experimentSchema.parse({ projectId: api.projectId, name: cmd.name, datasetId: cmd.dataset, policyId: cmd.policy, candidates, allowRequiredUnknown: Boolean(cmd.allowRequiredUnknown), evaluateMissing: cmd.evaluate });
      await printReport(await api.request('/v1/experiments', body), cmd, api);
    });
  polling(program.command('report <experiment-id>').description('Read or wait for a saved comparison report')).action(async (id, cmd) => {
    const api = client(); await printReport(await api.request(`/v1/experiments/${encodeURIComponent(id)}`), cmd, api);
  });
  try {
    await program.parseAsync(argv, { from: 'user' });
    if (!argv.length) { program.outputHelp(); return 0; }
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) return error.code === 'commander.helpDisplayed' || error.code === 'commander.version' ? 0 : 2;
    const message = error instanceof z.ZodError ? `Input does not match the contract: ${error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}` : error instanceof CliError ? error.message : 'The command could not complete. Check the input files and API availability.';
    runtime.streams.stderr.write(`Error: ${message}\n`);
    const opts = options();
    const payload = opts.format === 'junit' ? renderInfrastructureJunit(message) : opts.format === 'json' ? JSON.stringify({ error: { code: error instanceof CliError ? error.code : 'invalid_input', message }, exitCode: 2 }) + '\n' : '';
    if (payload) { if (opts.output) { try { await writeFile(opts.output, payload, 'utf8'); } catch { runtime.streams.stderr.write('Error: Cannot write the report output file.\n'); } } else runtime.streams.stdout.write(payload); }
    return 2;
  }
}
