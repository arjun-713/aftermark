import { styleText } from 'node:util';
import type { ComparisonReport, ReportStatus } from '../../regression/src/contracts.ts';

const clean = (value: unknown) => String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
const xml = (value: unknown) => clean(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const detail = (value: ComparisonReport['candidates'][number]['cases'][number]) => value.assertions.filter(assertion => assertion.status !== 'pass').map(assertion => `${assertion.code}: ${assertion.message}`).join('\n');

export function renderJunit(report: ComparisonReport): string {
  const suites = report.candidates.map(candidate => {
    const cases = candidate.cases.map(value => {
      const result = value.status === 'passed' ? '' : `<${value.status === 'failed' ? 'failure' : 'error'} message="${xml(value.status === 'failed' ? 'Quality assertions failed' : 'Quality is indeterminate')}">${xml(detail(value))}</${value.status === 'failed' ? 'failure' : 'error'}>`;
      return `    <testcase classname="${xml(candidate.name)}" name="${xml(value.caseId)}">${result}<system-out>${xml(`runId=${value.runId}\nrevision=${value.revision}\nexpectedBehavior=${value.expectedBehavior.kind}\nqualityDecision=${value.qualityDecision ?? 'pending'}\nrequiredUnknown=${value.requiredUnknown}`)}</system-out></testcase>`;
    });
    return `  <testsuite name="${xml(candidate.name)}" tests="${candidate.summary.cases}" failures="${candidate.summary.failed}" errors="${candidate.summary.indeterminate}">\n    <properties><property name="datasetId" value="${xml(report.dataset.id)}"/><property name="datasetHash" value="${xml(report.dataset.hash)}"/><property name="policyHash" value="${xml(report.policy.hash)}"/><property name="experimentId" value="${xml(report.experimentId)}"/></properties>\n${cases.join('\n')}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="Agent Quality" tests="${report.summary.cases}" failures="${report.summary.failed}" errors="${report.summary.indeterminate}">\n${suites.join('\n')}\n</testsuites>\n`;
}
export function renderInfrastructureJunit(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="Agent Quality" tests="1" failures="0" errors="1"><testsuite name="infrastructure" tests="1" failures="0" errors="1"><testcase classname="aq" name="comparison"><error message="Infrastructure or input failure">${xml(message)}</error></testcase></testsuite></testsuites>\n`;
}
export function renderHuman(report: ComparisonReport, options: { color?: boolean; width?: number } = {}): string {
  const theme = {
    result: (status: ReportStatus, value: string) => options.color ? styleText(['bold', status === 'passed' ? 'green' : status === 'failed' ? 'red' : 'yellow'], value, { validateStream: false }) : value,
    heading: (value: string) => options.color ? styleText('bold', value, { validateStream: false }) : value,
  };
  const lines = [theme.result(report.status, `Agent Quality  ${report.status.toUpperCase()}`),
    `${report.summary.passed} passed / ${report.summary.failed} failed / ${report.summary.indeterminate} indeterminate · ${report.summary.cases} cases`,
    `Dataset  ${clean(report.dataset.name)} v${report.dataset.version} (${report.dataset.id})`,
    `Policy   ${clean(report.policy.name)} v${report.policy.version} (${report.policy.id})`,
    `Report   ${report.experimentId}`, ''];
  for (const candidate of report.candidates) {
    lines.push(theme.heading(clean(candidate.name)));
    for (const value of candidate.cases) {
      lines.push(`  ${value.status.toUpperCase()}  ${value.caseId} · ${value.expectedBehavior.kind}`,
        `    run ${value.runId} / revision ${value.revision} / quality ${value.qualityDecision ?? 'pending'} / verification ${value.verification}`);
      for (const assertion of value.assertions.filter(item => item.status !== 'pass')) lines.push(`    ${assertion.status === 'allowed' ? 'REVIEW' : assertion.status.toUpperCase()} ${clean(assertion.message)}`);
    }
    lines.push('');
  }
  if (!report.ready) lines.push('Evaluations are pending. Use aq report with --wait and a deadline.');
  if (report.summary.requiredUnknown) lines.push(`Required verification unknown: ${report.summary.requiredUnknown}${report.allowRequiredUnknown ? ' (explicitly allowed)' : ' (blocks CI)'}.`);
  if (report.summary.semanticReviewOnly) lines.push(`Semantic findings for review: ${report.summary.semanticReviewOnly}. Blocking needs the matching calibration and activated policy.`);
  lines.push('Replay used frozen traces and stored answers. Customer code and external requests were not repeated.');
  const width = Math.max(40, options.width ?? 100);
  // Wrap prose without truncating identifiers. Long individual words remain intact and copyable.
  return lines.map(line => {
    if (line.length <= width || line.includes('\u001b[')) return line;
    const indent = line.match(/^\s*/)?.[0] ?? ''; const words = line.trim().split(/\s+/); const wrapped: string[] = []; let current = indent;
    for (const word of words) { if (current.trim() && current.length + word.length + 1 > width) { wrapped.push(current); current = `${indent}${word}`; } else current += `${current.trim() ? ' ' : ''}${word}`; }
    wrapped.push(current); return wrapped.join('\n');
  }).join('\n').trimEnd() + '\n';
}
