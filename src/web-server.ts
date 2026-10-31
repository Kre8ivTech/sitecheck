import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { networkGuard } from './network.js';
import { httpUrl } from './config.js';
import { webPage, webScript, webStyles } from './web-ui.js';
import type { ScanReport } from './types.js';

export interface Job {
  id: string; owner: string; url: string; createdAt: number;
  status: 'queued' | 'running' | 'complete' | 'partial' | 'failed' | 'cancelled';
  progress: string; error?: string; summary?: { pages: number; findings: number; high: number; broken: number };
}
type Runner = (job: Job, directory: string, signal: AbortSignal, progress: (text: string) => void) => Promise<ScanReport>;
interface Settings { data: string; origin: string; proxy: string; runner?: Runner; validate?: (url: string) => Promise<void>; ttlMs?: number; rateLimit?: number; trustProxyHops?: number }
const digest = (input: string) => createHash('sha256').update(input).digest('hex');
const terminal = (job: Job) => !['queued', 'running'].includes(job.status);
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

export async function runWorker(job: Job, directory: string, signal: AbortSignal, progress: (text: string) => void, proxy: string): Promise<ScanReport> {
  const input = join(directory, 'input.json');
  await writeFile(input, JSON.stringify({ url: job.url, output: directory }), { mode: 0o600 });
  const source = import.meta.url.endsWith('.ts');
  const worker = fileURLToPath(new URL(source ? './web-worker.ts' : './web-worker.js', import.meta.url));
  const child = spawn(process.execPath, [...(source ? ['--import', 'tsx'] : []), worker, input], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    // Do not pass hosting credentials into a process that opens untrusted sites.
    env: { PATH: process.env.PATH, HOME: directory, TMPDIR: '/tmp', NODE_ENV: 'production', PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright'), SITECHECK_PROXY: proxy },
  });
  const terminate = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ } } };
  signal.addEventListener('abort', terminate, { once: true });
  let pending = '', stderr = '';
  child.stdout.on('data', chunk => {
    pending += String(chunk);
    const lines = pending.split('\n'); pending = lines.pop()!.slice(-2048);
    for (const line of lines) { try { const event = JSON.parse(line); if (typeof event.progress === 'string') progress(event.progress.slice(0, 500)); } catch { /* non-progress output */ } }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-3000); });
  try {
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 && !signal.aborted ? resolve() : reject(new Error(signal.aborted ? 'Scan stopped.' : stderr || 'The scan could not finish.'))); });
    const raw = await readFile(join(directory, 'report.json'), 'utf8');
    return JSON.parse(raw) as ScanReport;
  } finally { signal.removeEventListener('abort', terminate); terminate(); await rm(input, { force: true }); }
}

export async function createWebServer(settings: Settings) {
  const data = resolve(settings.data);
  await mkdir(data, { recursive: true, mode: 0o700 });
  const jobs = new Map<string, Job>();
  const rates = new Map<string, { start: number; count: number }>();
  const ttl = settings.ttlMs ?? 60 * 60 * 1000;
  const active = new Map<string, AbortController>();
  const runner: Runner = settings.runner ?? ((job, directory, signal, progress) => runWorker(job, directory, signal, progress, settings.proxy));
  const validate = settings.validate ?? (async (url: string) => {
    if (!settings.proxy) return networkGuard(false)(url);
    const endpoint = new URL('/validate', settings.proxy); endpoint.searchParams.set('url', url);
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Public destination validation failed.');
  });
  let accepting = true;
  for (const item of await readdir(data, { withFileTypes: true })) {
    if (!item.isDirectory() || !uuid.test(item.name)) continue;
    try {
      const job = JSON.parse(await readFile(join(data, item.name, 'job.json'), 'utf8')) as Job;
      if (job.id !== item.name || Date.now() - job.createdAt > ttl) { await rm(join(data, item.name), { recursive: true, force: true }); continue; }
      if (!terminal(job)) { job.status = 'failed'; job.error = 'The service restarted before this scan finished. Please run it again.'; }
      jobs.set(job.id, job);
    } catch { await rm(join(data, item.name), { recursive: true, force: true }); }
  }
  const save = async (job: Job) => { await writeFile(join(data, job.id, 'job.json'), JSON.stringify(job), { mode: 0o600 }); };
  const pump = () => {
    if (!accepting || active.size) return;
    const job = [...jobs.values()].find(item => item.status === 'queued');
    if (!job) return;
    const controller = new AbortController(); active.set(job.id, controller);
    job.status = 'running'; job.progress = 'Opening your website…';
    const timeout = setTimeout(() => controller.abort(), 120000); timeout.unref();
    void (async () => {
      try {
        await save(job);
        const report = await runner(job, join(data, job.id), controller.signal, text => { job.progress = text; });
        if (controller.signal.aborted) throw new Error('Scan stopped.');
        job.status = report.status;
        job.progress = 'Your report is ready.';
        job.summary = { pages: report.pages.filter(page => !page.error).length, findings: report.findings.length, high: report.findings.filter(f => f.severity === 'high').length, broken: report.links.filter(l => l.outcome === 'broken').length };
      } catch (error) {
        await writeFile(join(data, job.id, 'worker-error.log'), (error instanceof Error ? error.message : String(error)).slice(0, 4000), { mode: 0o600 }).catch(() => {});
        if (job.status !== 'cancelled') { job.status = 'failed'; job.error = controller.signal.aborted ? 'This scan reached its two-minute limit. Try a smaller or faster page.' : 'We could not scan this website. Check the address and whether it allows automated visitors, then try again.'; }
      } finally {
        clearTimeout(timeout); active.delete(job.id);
        await save(job).catch(() => {});
        if (['failed', 'cancelled'].includes(job.status)) { await rm(join(data, job.id, 'screenshots'), { recursive: true, force: true }); await rm(join(data, job.id, 'report.html'), { force: true }); await rm(join(data, job.id, 'report.json'), { force: true }); }
        pump();
      }
    })();
  };
  const cleanup = async () => {
    for (const [id, job] of jobs) if (terminal(job) && Date.now() - job.createdAt >= ttl) { jobs.delete(id); await rm(join(data, id), { recursive: true, force: true }); }
    for (const [key, entry] of rates) if (Date.now() - entry.start >= 3600000) rates.delete(key);
  };
  const timer = setInterval(() => void cleanup().catch(() => {}), 30000); timer.unref();
  const send = (response: ServerResponse, status: number, body: string, type = 'application/json') => {
    response.writeHead(status, { 'Content-Type': `${type}; charset=utf-8` }); response.end(body);
  };
  const json = (response: ServerResponse, status: number, body: unknown) => send(response, status, JSON.stringify(body));
  const readBody = async (request: IncomingMessage) => {
    if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('Send JSON.');
    let body = '';
    for await (const chunk of request) { body += String(chunk); if (Buffer.byteLength(body) > 2048) throw new Error('Request is too large.'); }
    return JSON.parse(body) as Record<string, unknown>;
  };
  const ownerFor = (request: IncomingMessage, response: ServerResponse) => {
    const cookie = request.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith('sitecheck_session='))?.split('=')[1];
    const token = cookie && /^[a-f0-9]{64}$/.test(cookie) ? cookie : randomBytes(32).toString('hex');
    if (token !== cookie) response.setHeader('Set-Cookie', `sitecheck_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=7200${settings.origin.startsWith('https:') ? '; Secure' : ''}`);
    return digest(token);
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const path = new URL(request.url ?? '/', settings.origin).pathname;
      if (request.method === 'GET' && path === '/health') return json(response, 200, { status: accepting ? 'ok' : 'stopping', version: '0.2.0' });
      const owner = ownerFor(request, response);
      if (request.method === 'GET' && path === '/') return send(response, 200, webPage(), 'text/html');
      if (request.method === 'GET' && path === '/app.css') return send(response, 200, webStyles, 'text/css');
      if (request.method === 'GET' && path === '/app.js') return send(response, 200, webScript, 'text/javascript');
      if (request.method === 'POST' && path === '/api/scans') {
        if (request.headers.origin !== settings.origin) return json(response, 403, { error: 'Please start your scan from this website.' });
        const forwarded = request.headers['x-forwarded-for'];
        const hops = settings.trustProxyHops ?? 0;
        const chain = typeof forwarded === 'string' ? forwarded.split(',').map(value => value.trim()) : [];
        const address = (hops > 0 && chain.length >= hops ? chain[chain.length - hops] : request.socket.remoteAddress) ?? 'unknown';
        const key = digest(address);
        const rate = rates.get(key);
        if (rate && Date.now() - rate.start < 3600000 && rate.count >= (settings.rateLimit ?? 6)) { response.setHeader('Retry-After', '3600'); return json(response, 429, { error: 'You’ve reached the hourly scan limit. Please try again later.' }); }
        if ([...jobs.values()].filter(job => !terminal(job)).length >= 4) return json(response, 503, { error: 'The scan queue is full. Please try again in a few minutes.' });
        if (jobs.size >= 100) return json(response, 503, { error: 'SiteCheck is at capacity. Please try again later.' });
        const body = await readBody(request);
        if (body.permission !== true) return json(response, 400, { error: 'Confirm that you have permission to scan this website.' });
        if (typeof body.url !== 'string' || body.url.length > 2048) return json(response, 400, { error: 'Enter a website address.' });
        if (/^[a-z][a-z\d+.-]*:/i.test(body.url.trim()) && !/^https?:\/\//i.test(body.url.trim())) return json(response, 400, { error: 'Use an HTTP or HTTPS website address.' });
        let url: URL;
        try { url = httpUrl(/^https?:\/\//i.test(body.url.trim()) ? body.url.trim() : `https://${body.url.trim()}`); }
        catch { return json(response, 400, { error: 'Enter a valid HTTP or HTTPS website address.' }); }
        if ((url.port && !['80', '443'].includes(url.port)) || url.search) return json(response, 400, { error: 'Use a public website URL without query parameters or a custom port.' });
        try { await Promise.race([validate(url.href), new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('Timed out')), 5000); timeout.unref(); })]); }
        catch { return json(response, 400, { error: 'This address is unavailable or does not point to a public website. Private network addresses cannot be scanned.' }); }
        // Check limits again after asynchronous validation.
        const currentRate = rates.get(key);
        if (currentRate && Date.now() - currentRate.start < 3600000 && currentRate.count >= (settings.rateLimit ?? 6)) return json(response, 429, { error: 'You’ve reached the hourly scan limit.' });
        if ([...jobs.values()].filter(job => !terminal(job)).length >= 4 || jobs.size >= 100) return json(response, 503, { error: 'The scan queue is full. Please try again shortly.' });
        rates.set(key, currentRate && Date.now() - currentRate.start < 3600000 ? { ...currentRate, count: currentRate.count + 1 } : { start: Date.now(), count: 1 });
        const job: Job = { id: randomUUID(), owner, url: url.href, createdAt: Date.now(), status: 'queued', progress: 'Waiting for a scan slot…' };
        await mkdir(join(data, job.id), { mode: 0o700 });
        await save(job); jobs.set(job.id, job); pump();
        return json(response, 202, { id: job.id });
      }
      const match = /^\/api\/scans\/([^/]+)(?:\/(report|report\.json))?$/.exec(path);
      if (match && uuid.test(match[1]!)) {
        const job = jobs.get(match[1]!);
        if (!job || job.owner !== owner || Date.now() - job.createdAt >= ttl) return json(response, 404, { error: 'This report is unavailable or has expired. Run a new scan to create another.' });
        if (request.method === 'DELETE' && !match[2]) {
          if (request.headers.origin !== settings.origin) return json(response, 403, { error: 'Please return to SiteCheck.' });
          if (!terminal(job)) { job.status = 'cancelled'; job.progress = 'Scan cancelled.'; active.get(job.id)?.abort(); await save(job); pump(); }
          return json(response, 200, { status: job.status });
        }
        if (request.method === 'GET' && !match[2]) return json(response, 200, { id: job.id, url: job.url, status: job.status, progress: job.progress, error: job.error, summary: job.summary, expiresAt: job.createdAt + ttl });
        if (request.method === 'GET' && match[2] && ['complete', 'partial'].includes(job.status)) {
          if (match[2] === 'report') {
            if (new URL(request.url!, settings.origin).searchParams.get('download') === '1') response.setHeader('Content-Disposition', 'attachment; filename="sitecheck-report.html"');
            response.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-downloads allow-modals allow-popups; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
            return send(response, 200, await readFile(join(data, job.id, 'report.html'), 'utf8'), 'text/html');
          }
          response.setHeader('Content-Disposition', 'attachment; filename="sitecheck-report.json"');
          return send(response, 200, await readFile(join(data, job.id, 'report.json'), 'utf8'));
        }
        return json(response, 409, { error: 'Your report is not ready yet.' });
      }
      return json(response, 404, { error: 'Page not found.' });
    } catch { if (!response.headersSent) json(response, 400, { error: 'We could not process this request. Please check your details and try again.' }); else response.end(); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return { server, cleanup, close: async () => { accepting = false; clearInterval(timer); for (const controller of active.values()) controller.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
