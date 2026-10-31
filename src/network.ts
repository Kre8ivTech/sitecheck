import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import type { APIRequestContext } from 'playwright';
import { httpUrl } from './config.js';

export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === 'unicast';
  } catch { return false; }
}

export function networkGuard(allowPrivate: boolean) {
  // Per-scan cache only. This is defense in depth for a local CLI, not a
  // network-isolation boundary for running a public scanning service.
  const cache = new Map<string, Promise<void>>();
  return async (input: string): Promise<void> => {
    const url = httpUrl(input);
    if (allowPrivate) return;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let check = cache.get(hostname);
    if (!check) {
      check = (async () => {
        const addresses = await lookup(hostname, { all: true });
        if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('Private or reserved network destination blocked. Use --allow-private only for a trusted local target.');
      })();
      cache.set(hostname, check);
    }
    await check;
  };
}

export async function safeGet(request: APIRequestContext, input: string, guard: (url: string) => Promise<void>, timeout: number, origin: string) {
  let url = input;
  for (let hop = 0; hop < 6; hop++) {
    await guard(url);
    if (new URL(url).origin !== origin) throw new Error('Redirect leaves the scan origin; destination not checked.');
    const response = await request.get(url, { maxRedirects: 0, timeout, failOnStatusCode: false });
    const status = response.status();
    const location = response.headers()['location'];
    if (status >= 300 && status < 400 && location) {
      await response.dispose();
      url = httpUrl(location, url).href;
      continue;
    }
    return response;
  }
  throw new Error('Too many redirects.');
}
