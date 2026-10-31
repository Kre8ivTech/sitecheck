import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { createWebServer, type Job } from '../src/web-server.js';
import { renderReport } from '../src/report.js';
import { publicDestination, createEgressProxy } from '../src/egress.js';
import type { ScanReport } from '../src/types.js';

function report(url: string): ScanReport { return { schemaVersion: 1, version: '0.1.0', url, startedAt: new Date().toISOString(), durationMs: 100, status: 'complete', scope: { maxPages: 3, maxLinks: 20, queuedPagesRemaining: 0, linksNotChecked: 0, robotsSkipped: [], excluded: [] }, pages: [], links: [], journeys: [], findings: [] }; }

async function setup(extra: { ttlMs?: number; rateLimit?: number; delay?: number } = {}) {
  const data = await mkdtemp(join(tmpdir(), 'sitecheck-web-'));
  const settings = { data, origin: 'http://127.0.0.1:0', proxy: 'http://unused', ...extra,
    validate: async (url: string) => { if (url.includes('127.0.0.1') || url.includes('169.254')) throw new Error('Private'); },
    runner: async (job: Job, directory: string, signal: AbortSignal, progress: (text: string) => void) => {
      progress('Scanning 1/3: ' + job.url);
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, extra.delay ?? 100); signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Stopped')); }, { once: true }); });
      if (job.url.includes('fail.example')) throw new Error('Internal secret error: never expose');
      const result = report(job.url);
      await writeFile(join(directory, 'report.json'), JSON.stringify(result));
      await writeFile(join(directory, 'report.html'), renderReport(result));
      return result;
    },
  };
  const app = await createWebServer(settings); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('Listen failed');
  settings.origin = `http://127.0.0.1:${address.port}`;
  const initial = await fetch(settings.origin); const cookie = initial.headers.get('set-cookie')!.split(';')[0]!;
  const post = (body: unknown, origin = settings.origin) => fetch(settings.origin + '/api/scans', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const status = async (id: string) => (await fetch(`${settings.origin}/api/scans/${id}`, { headers: { cookie } })).json();
  const finish = async (id: string) => { for (let n = 0; n < 100; n++) { const job = await status(id); if (!['queued', 'running'].includes(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('Job did not finish'); };
  return { ...app, origin: settings.origin, cookie, post, status, finish, dispose: async () => { await app.close(); await new Promise(resolve => setTimeout(resolve, 30)); await rm(data, { recursive: true, force: true }); } };
}

test('web API enforces origin, permission, public targets, ownership, downloads, and limits', async () => {
  const app = await setup({ rateLimit: 2 });
  try {
    assert.equal((await app.post({ url: 'example.com', permission: true }, 'https://attacker.example')).status, 403);
    assert.equal((await app.post({ url: 'example.com' })).status, 400);
    assert.equal((await app.post({ url: 'http://127.0.0.1', permission: true })).status, 400);
    assert.equal((await app.post({ url: 'http://example.com:22', permission: true })).status, 400);
    assert.equal((await app.post({ url: 'file:///etc/passwd', permission: true })).status, 400);
    const response = await app.post({ url: 'example.com', permission: true }); assert.equal(response.status, 202);
    const { id } = await response.json(); const job = await app.finish(id); assert.equal(job.status, 'complete');
    assert.equal(job.owner, undefined);
    assert.equal((await fetch(`${app.origin}/api/scans/${id}`)).status, 404);
    const html = await fetch(`${app.origin}/api/scans/${id}/report?download=1`, { headers: { cookie: app.cookie } });
    assert.equal(html.status, 200); assert.match(html.headers.get('content-security-policy')!, /^sandbox /);
    assert.match(html.headers.get('content-disposition')!, /attachment/);
    assert.match(await html.text(), /A clearer picture/);
    const failed = await app.post({ url: 'fail.example', permission: true }); const failedId = (await failed.json()).id;
    assert.equal((await app.finish(failedId)).status, 'failed');
    assert.ok(!JSON.stringify(await app.status(failedId)).includes('secret'));
    assert.equal((await app.post({ url: 'third.example', permission: true })).status, 429);
  } finally { await app.dispose(); }
});

test('queue is bounded, cancellation stops work, and expired reports are removed', async () => {
  const app = await setup({ delay: 1000, ttlMs: 150, rateLimit: 10 });
  try {
    const responses = await Promise.all(Array.from({ length: 8 }, (_, n) => app.post({ url: `site${n}.example`, permission: true })));
    assert.equal(responses.filter(response => response.status === 202).length, 4, 'parallel requests must not overbook the queue');
    assert.equal(responses.filter(response => response.status === 503).length, 4);
    const ids: string[] = [];
    for (const response of responses.filter(item => item.status === 202)) ids.push((await response.json()).id);
    assert.equal((await app.post({ url: 'full.example', permission: true })).status, 503);
    for (const id of ids) await fetch(`${app.origin}/api/scans/${id}`, { method: 'DELETE', headers: { cookie: app.cookie, origin: app.origin } });
    assert.equal((await app.status(ids[0]!)).status, 'cancelled');
    await new Promise(resolve => setTimeout(resolve, 180)); await app.cleanup();
    assert.equal((await fetch(`${app.origin}/api/scans/${ids[0]}`, { headers: { cookie: app.cookie } })).status, 404);
  } finally { await app.dispose(); }
});

test('web interface works through submit, progress, report, and new scan at both viewport sizes', { timeout: 60000 }, async () => {
  const app = await setup(); const browser = await chromium.launch();
  try {
    const context = await browser.newContext(); const page = await context.newPage(); await page.goto(app.origin);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze(); assert.deepEqual(axe.violations.map(v => v.id), []);
    }
    await page.getByLabel('Website URL', { exact: true }).fill('example.com');
    await page.getByLabel('I own this website or have permission to scan it.').check();
    await page.getByRole('button', { name: 'Scan my website' }).click();
    await page.getByRole('heading', { name: 'Your website report', exact: true }).waitFor();
    await page.locator('#report').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#metric-findings').innerText(), '0');
    assert.match(await page.locator('#open-report').getAttribute('href') ?? '', /^\/api\/scans\//);
    await page.getByRole('button', { name: 'Scan another website' }).click();
    assert.equal(await page.locator('#result').isVisible(), false);
    assert.equal(await page.getByLabel('Website URL', { exact: true }).isEnabled(), true);
  } finally { await browser.close(); await app.dispose(); }
});

test('egress validates all addresses, restricts ports, and blocks local proxy requests', async () => {
  await assert.rejects(publicDestination('127.0.0.1', 80));
  await assert.rejects(publicDestination('169.254.169.254', 80));
  await assert.rejects(publicDestination('example.com', 22));
  const mixed = (async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]) as unknown as typeof import('node:dns/promises').lookup;
  await assert.rejects(publicDestination('mixed.example', 443, mixed));
  const proxy = createEgressProxy(); proxy.server.listen(0, '127.0.0.1'); await once(proxy.server, 'listening');
  const address = proxy.server.address(); if (!address || typeof address === 'string') throw new Error('Listen failed');
  const http = await import('node:http');
  try {
    const status = await new Promise<number>(resolve => { http.get({ host: '127.0.0.1', port: address.port, path: 'http://127.0.0.1/' }, response => { response.resume(); resolve(response.statusCode!); }); });
    assert.equal(status, 403);
  } finally { await proxy.close(); }
});
