import { createEgressProxy } from './egress.js';
const proxy = createEgressProxy();
proxy.server.listen(Number(process.env.PORT ?? 3128), '0.0.0.0', () => console.log('SiteCheck public-web egress proxy ready.'));
process.on('SIGTERM', () => void proxy.close());
