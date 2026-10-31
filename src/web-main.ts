import { once } from 'node:events';
import { createEgressProxy } from './egress.js';
import { createWebServer } from './web-server.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3100);
const origin = process.env.PUBLIC_ORIGIN ?? `http://localhost:${port}`;
let proxy = process.env.SITECHECK_PROXY;
const embedded = proxy ? undefined : createEgressProxy();
if (embedded) { embedded.server.listen(0, '127.0.0.1'); await once(embedded.server, 'listening'); const address = embedded.server.address(); if (!address || typeof address === 'string') throw new Error('Could not start egress proxy.'); proxy = `http://127.0.0.1:${address.port}`; }
if (host !== '127.0.0.1' && host !== 'localhost' && (!process.env.SITECHECK_PROXY || !process.env.PUBLIC_ORIGIN)) throw new Error('Public binding requires PUBLIC_ORIGIN and an isolated SITECHECK_PROXY. Use the supplied Docker Compose deployment.');
const app = await createWebServer({ data: process.env.SITECHECK_DATA ?? 'reports/web', origin, proxy: proxy!, trustProxyHops: Number(process.env.TRUST_PROXY_HOPS ?? 0) });
app.server.listen(port, host, () => console.log(`SiteCheck web interface: ${origin}`));
process.on('SIGTERM', () => { void app.close().then(() => embedded?.close()); });
