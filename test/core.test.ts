import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { optionsFrom, httpUrl } from '../src/config.js';
import { isPublicAddress, networkGuard } from '../src/network.js';
import { compareReports, finding } from '../src/findings.js';
import { renderReport } from '../src/report.js';
import { scan } from '../src/scanner.js';
import { fixture } from './fixture.js';
import type { ScanReport } from '../src/types.js';

test('configuration rejects unsafe URLs, unbounded inputs, and cross-origin journeys', async () => {
  assert.throws(() => httpUrl('file:///etc/passwd'));
  assert.throws(() => httpUrl('https://user:password@example.com'));
  for (const maxPages of [0, -1, 26, NaN, 1.5, 'many']) await assert.rejects(optionsFrom({ url: 'https://example.com', maxPages }));
  await assert.rejects(optionsFrom({ url: 'https://example.com', paths: ['https://other.example/'] }));
  await assert.rejects(optionsFrom({ url: 'https://example.com', journeys: [{ name: 'Offsite', steps: [{ path: '//other.example/', expect: 'h1' }] }] }));
  assert.equal((await optionsFrom({ url: 'https://example.com/#top' })).url, 'https://example.com/');
});

test('network guard rejects local, reserved, and IPv4-mapped private addresses', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0', '100.64.0.1']) assert.equal(isPublicAddress(ip), false, ip);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  await assert.rejects(networkGuard(false)('http://127.0.0.1/'));
  await networkGuard(true)('http://127.0.0.1/');
});

test('report escapes hostile page content and embedded JSON', () => {
  const f = finding({ url: 'https://example.com/', category: 'metadata', severity: 'high', rule: 'test', title: '<img src=x onerror=alert(1)>', detail: '</script><script>alert(1)</script>', recommendation: 'Use a title', evidence: ['<script>evil()</script>'], helpUrl: 'javascript:alert(1)' });
  const report: ScanReport = { schemaVersion: 1, version: '0.1.0', url: 'https://example.com/', startedAt: new Date().toISOString(), durationMs: 1, status: 'complete', scope: { maxPages: 1, maxLinks: 1, queuedPagesRemaining: 0, linksNotChecked: 0, robotsSkipped: [], excluded: [] }, pages: [], links: [], journeys: [], findings: [f] };
  const html = renderReport(report);
  assert.ok(html.includes('&lt;img src=x'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('\\u003c/script>'));
  const previous = structuredClone(report);
  report.findings = [];
  const compared = compareReports(report, previous);
  assert.equal(compared.resolved.length, 0);
  assert.equal(compared.unverified.length, 1, 'absence from a smaller scan must not imply resolution');
  const a11y = finding({ ...f, category: 'accessibility', rule: 'color-contrast' });
  const incomplete = { ...report, pages: [{ url: f.url, durationMs: 1, accessibility: 'passed' as const, accessibilityIncomplete: ['color-contrast'] }] };
  const uncertain = compareReports(incomplete, { ...previous, findings: [a11y] });
  assert.equal(uncertain.resolved.length, 0, 'an inconclusive rule must not imply a repair');
  assert.equal(uncertain.unverified.length, 1);
});

test('scanner finds real problems, respects exclusions, checks journeys, and compares a repair', { timeout: 120000 }, async () => {
  const site = await fixture();
  const output = await mkdtemp(join(tmpdir(), 'sitecheck-test-'));
  try {
    const options = await optionsFrom({ url: site.url, output, maxPages: 2, maxLinks: 5, allowPrivate: true, timeout: 1500,
      journeys: [{ name: 'Contact is usable', steps: [{ path: '/contact', expect: 'form input[type=email]' }] }, { name: 'Missing confirmation', steps: [{ path: '/contact', expect: '[data-confirmed]' }] }],
    });
    const report = await scan(options);
    assert.equal(report.pages.length, 2);
    assert.ok(report.findings.some(f => f.rule === 'missing-title'));
    assert.ok(report.findings.some(f => f.rule === 'missing-description'));
    assert.ok(report.findings.some(f => f.rule === 'image-alt'));
    assert.ok(report.findings.some(f => f.rule === 'button-name'));
    assert.ok(report.links.some(l => l.url.endsWith('/missing') && l.outcome === 'broken' && l.status === 404));
    assert.deepEqual(report.journeys.map(j => j.status), ['passed', 'failed']);
    assert.ok(report.scope.robotsSkipped.some(url => url.endsWith('/private')));
    assert.ok(report.scope.excluded.some(url => url.endsWith('/logout')));
    assert.ok(!site.requests.some(request => /\/private|\/logout|\?source/.test(request)));
    assert.ok((await readFile(join(output, 'report.html'), 'utf8')).includes('data:image/jpeg;base64,'));
    site.fix();
    const next = await scan({ ...options, output: join(output, 'after'), baseline: join(output, 'report.json'), journeys: options.journeys.slice(0, 1) });
    assert.ok(next.comparison?.resolved.some(f => f.rule === 'missing-title'));
    assert.ok(next.comparison?.resolved.some(f => f.rule === 'broken-link'));
    assert.ok(next.comparison?.unverified.some(f => f.rule === 'journey:Missing confirmation'));
    assert.ok(!next.findings.some(f => f.rule === 'image-alt'));
  } finally { await site.close(); await rm(output, { recursive: true, force: true }); }
});

test('access failures stay unverified, redirect destinations stay in scope, and no-pages is partial', { timeout: 60000 }, async () => {
  const site = await fixture();
  const output = await mkdtemp(join(tmpdir(), 'sitecheck-access-'));
  try {
    const options = await optionsFrom({ url: site.url, output, maxPages: 1, allowPrivate: true, timeout: 1500, paths: ['/contact'] });
    const excluded = await scan({ ...options, exclude: ['/'] });
    assert.equal(excluded.pages.length, 0);
    assert.equal(excluded.status, 'partial');
    const blocked = await scan({ ...options, url: `${site.url}private`, paths: [] });
    assert.equal(blocked.pages.length, 0);
    assert.equal(blocked.scope.robotsSkipped.length, 1);
    assert.ok(!site.requests.some(r => r.includes('/private')));
    const links = await scan({ ...options, url: `${site.url}links`, paths: [] });
    assert.equal(links.links.find(l => l.url.endsWith('/forbidden'))?.outcome, 'unverified');
    assert.equal(links.links.find(l => l.url.endsWith('/outside'))?.outcome, 'unverified');
    assert.equal(links.links.find(l => l.url.endsWith('/redirect'))?.outcome, 'ok');
    assert.equal(links.status, 'partial');
  } finally { await site.close(); await rm(output, { recursive: true, force: true }); }
});
