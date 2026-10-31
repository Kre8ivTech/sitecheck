import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { isPublicAddress } from './network.js';

export async function publicDestination(host: string, port: number, resolve = lookup): Promise<string> {
  if (![80, 443].includes(port)) throw new Error('Only public web ports are allowed.');
  const addresses = await resolve(host.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('Private or reserved address blocked.');
  return (addresses.find(item => item.family === 4) ?? addresses[0])!.address;
}

export function createEgressProxy() {
  const sockets = new Set<net.Socket>();
  const proxy = http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url?.startsWith('/validate?')) {
        const input = new URL(request.url, 'http://egress').searchParams.get('url');
        const target = new URL(input ?? '');
        if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid URL.');
        await publicDestination(target.hostname, Number(target.port || (target.protocol === 'https:' ? 443 : 80)));
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"public":true}'); return;
      }
      if (!['GET', 'HEAD'].includes(request.method ?? '')) throw new Error('Method blocked.');
      const target = new URL(request.url ?? '');
      if (target.protocol !== 'http:' || target.username || target.password) throw new Error('Invalid proxy target.');
      const address = await publicDestination(target.hostname, Number(target.port || 80));
      const headers: http.OutgoingHttpHeaders = { ...request.headers, host: target.host };
      delete headers['proxy-authorization']; delete headers['proxy-connection'];
      const upstream = http.request({ hostname: address, port: Number(target.port || 80), method: request.method, path: target.pathname + target.search,
        headers, timeout: 15000,
      }, remote => {
        response.writeHead(remote.statusCode ?? 502, { ...remote.headers, 'connection': 'close' });
        let bytes = 0;
        remote.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) { upstream.destroy(); response.destroy(); } });
        remote.pipe(response);
      });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      response.on('close', () => upstream.destroy());
      upstream.end();
    } catch { response.writeHead(403); response.end('Destination blocked.'); }
  });
  proxy.on('connect', async (request, client, head) => {
    try {
      const target = new URL(`http://${request.url}`);
      if (target.username || target.password || target.pathname !== '/') throw new Error('Invalid tunnel.');
      const port = Number(target.port || 80);
      if (port !== 443) throw new Error('Only HTTPS tunnels allowed.');
      // Connect to the exact validated address: no second DNS resolution.
      const address = await publicDestination(target.hostname, port);
      const remote = net.connect({ host: address, port });
      sockets.add(remote);
      remote.setTimeout(20000, () => remote.destroy());
      const lifetime = setTimeout(() => remote.destroy(), 90000);
      lifetime.unref();
      let bytes = 0;
      remote.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) remote.destroy(); });
      remote.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client); });
      remote.on('error', () => client.destroy());
      client.on('error', () => remote.destroy());
      client.on('close', () => remote.destroy());
      remote.on('close', () => { clearTimeout(lifetime); sockets.delete(remote); client.destroy(); });
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  proxy.on('connection', socket => { sockets.add(socket); socket.setTimeout(30000, () => socket.destroy()); socket.on('close', () => sockets.delete(socket)); });
  proxy.headersTimeout = 10000;
  proxy.requestTimeout = 20000;
  proxy.maxConnections = 64;
  return { server: proxy, close: () => { for (const socket of sockets) socket.destroy(); return new Promise<void>(resolve => proxy.close(() => resolve())); } };
}
