import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixture.js';

const exec = promisify(execFile);

test('CLI exit codes distinguish a clean scan, threshold findings, and incomplete coverage', { timeout: 90000 }, async () => {
  const site = await fixture();
  const output = await mkdtemp(join(tmpdir(), 'sitecheck-cli-'));
  const run = async (path: string, extra: string[] = []) => {
    try {
      const result = await exec(process.execPath, ['--import', 'tsx', 'src/cli.ts', `${site.url}${path}`, '--allow-private', '--max-pages', '1', '--max-links', '1', '--output', output, ...extra], { timeout: 30000 });
      return { code: 0, stdout: result.stdout };
    } catch (error) {
      const result = error as { code: number; stdout: string };
      return { code: result.code, stdout: result.stdout };
    }
  };
  try {
    assert.equal((await run('contact')).code, 0);
    assert.equal((await run('')).code, 1);
    assert.equal((await run('', ['--fail-on', 'none'])).code, 0);
    assert.equal((await run('missing', ['--fail-on', 'none'])).code, 2);
  } finally { await site.close(); await rm(output, { recursive: true, force: true }); }
});
