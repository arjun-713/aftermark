export class CliError extends Error { constructor(message: string, public code = 'infrastructure') { super(message); } }
export class ApiClient {
  readonly endpoint: URL;
  constructor(endpoint: string, readonly projectId: string, readonly apiKey: string, readonly transport: typeof fetch = fetch, readonly signal?: AbortSignal,
    readonly session?: { cookie: string; workspaceId: string }) {
    try { this.endpoint = new URL(endpoint); } catch { throw new CliError('AQ_ENDPOINT must be an absolute HTTP or HTTPS URL.', 'configuration'); }
    if (!['http:', 'https:'].includes(this.endpoint.protocol) || this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash)
      throw new CliError('AQ_ENDPOINT must be HTTP or HTTPS without credentials, query parameters, or fragments.', 'configuration');
    if (this.endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(this.endpoint.hostname))
      throw new CliError('Use HTTPS for remote API endpoints. HTTP is supported only for local development.', 'configuration');
    this.endpoint.pathname = this.endpoint.pathname.replace(/\/$/, '') + '/';
  }
  async request<T>(path: string, body?: unknown, deadline?: number): Promise<T> {
    const url = new URL(path.replace(/^\//, ''), this.endpoint);
    if (body === undefined) url.searchParams.set('projectId', this.projectId);
    const timeout = Math.min(15000, Math.max(1, deadline === undefined ? 15000 : deadline - Date.now()));
    const signal = this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    let response: Response;
    try { response = await this.transport(url, { method: body === undefined ? 'GET' : 'POST', headers: { ...(this.session ? { Cookie: this.session.cookie, 'x-workspace-id': this.session.workspaceId } : { Authorization: `Bearer ${this.apiKey}` }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal, redirect: 'error' }); }
    catch { throw new CliError(this.signal?.aborted ? 'Comparison cancelled.' : 'The API request failed or timed out. Check AQ_ENDPOINT and retry.'); }
    let value: any;
    try { value = await response.json(); } catch { throw new CliError('The API returned an invalid JSON response.'); }
    if (!response.ok) throw new CliError(`API HTTP ${response.status}: ${typeof value?.error?.message === 'string' ? value.error.message : 'The request was rejected.'}`, typeof value?.error?.code === 'string' ? value.error.code : 'api_error');
    return value as T;
  }
}
export async function waitForReport<T extends { ready: boolean }>(initial: T, get: (deadline: number) => Promise<T>, options: { timeoutMs: number; pollMs: number; signal?: AbortSignal; onWait?: () => void }): Promise<T> {
  const deadline = Date.now() + options.timeoutMs; let report = initial;
  if (report.ready) return report;
  options.onWait?.();
  while (!report.ready) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CliError('The evaluation deadline expired. The experiment is saved; run aq report <id> to resume.', 'deadline');
    await new Promise<void>((resolve, reject) => {
      if (options.signal?.aborted) { reject(new CliError('Comparison cancelled.', 'cancelled')); return; }
      const onAbort = () => { clearTimeout(timer); reject(new CliError('Comparison cancelled.', 'cancelled')); };
      const timer = setTimeout(() => { options.signal?.removeEventListener('abort', onAbort); resolve(); }, Math.min(options.pollMs, remaining));
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });
    if (Date.now() >= deadline) throw new CliError('The evaluation deadline expired. The experiment is saved; run aq report <id> to resume.', 'deadline');
    report = await get(deadline);
  }
  return report;
}
