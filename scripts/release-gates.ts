import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { checksum } from '../packages/operations/src/storage.ts';
import { releaseGates, releaseManifestSchema, validateGate } from '../packages/operations/src/release.ts';

const manifestPath = resolve(process.argv[2] ?? 'infra/release-evidence.json');
try {
  const manifest = releaseManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8'))), root = await realpath(dirname(manifestPath));
  const results = [];
  for (const gate of releaseGates) {
    const artifacts = manifest.artifacts.filter(a => a.gate === gate);
    if (artifacts.length !== 1) { results.push({ gate, passed: false, reason: artifacts.length ? 'Exactly one evidence artifact is required.' : 'Pending measured evidence.' }); continue; }
    try {
      const artifact = artifacts[0], path = await realpath(resolve(root, artifact.path)), rel = relative(root, path);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Evidence must remain within the manifest directory.');
      const bytes = await readFile(path); if (checksum(bytes) !== artifact.sha256) throw new Error('Evidence checksum mismatch.');
      results.push({ gate, ...validateGate(gate, JSON.parse(bytes.toString('utf8')), manifest.commit) });
    } catch (error) { results.push({ gate, passed: false, reason: error instanceof Error ? error.message : 'Evidence could not be verified.' }); }
  }
  const passed = results.every(r => r.passed);
  process.stdout.write(JSON.stringify({ releaseId: manifest.releaseId, commit: manifest.commit, passed, results }, null, 2) + '\n');
  if (!passed) process.exitCode = 1;
} catch { process.stderr.write('Release blocked: a valid persisted evidence manifest is required. See docs/RELEASE.md.\n'); process.exitCode = 1; }
