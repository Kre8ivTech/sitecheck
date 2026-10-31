import { readFile } from 'node:fs/promises';
import { optionsFrom } from './config.js';
import { scan } from './scanner.js';

try {
  const controller = new AbortController();
  process.on('SIGTERM', () => controller.abort());
  const input = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as { url: string; output: string };
  const options = await optionsFrom({ url: input.url, output: input.output, maxPages: 3, maxLinks: 20, timeout: 10000 });
  await scan(options, text => console.log(JSON.stringify({ progress: text })), { proxyServer: process.env.SITECHECK_PROXY, sandbox: true, signal: controller.signal });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
