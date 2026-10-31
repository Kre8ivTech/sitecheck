import { createServer } from 'node:http';
import { once } from 'node:events';

export async function fixture() {
  let fixed = false;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? '/';
    requests.push(`${request.method} ${path}`);
    if (path === '/robots.txt') { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('User-agent: *\nDisallow: /private\n'); return; }
    if (path === '/missing' && !fixed) { response.writeHead(404, { 'Content-Type': 'text/html' }); response.end('<h1>Missing page</h1>'); return; }
    if (path === '/forbidden') { response.writeHead(403); response.end('Forbidden'); return; }
    if (path === '/redirect') { response.writeHead(302, { Location: '/contact' }); response.end(); return; }
    if (path === '/outside') { response.writeHead(302, { Location: 'http://localhost:1/private' }); response.end(); return; }
    if (path === '/empty') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><html lang="en"><head><title>Empty</title></head><body></body></html>'); return; }
    const title = path === '/' && !fixed ? '' : path === '/contact' ? 'Contact | Fieldwork Studio' : 'Fieldwork Studio';
    const description = path === '/' && !fixed ? '' : '<meta name="description" content="A fictional design studio for SiteCheck’s demonstration.">';
    const body = path === '/contact' ? '<h1>Let’s make something useful.</h1><p>Tell us about your project.</p><form><label for="email">Your email</label><input id="email" name="email" type="email"><button type="button">Request a conversation</button></form>' : path === '/links' ? '<h1>Link fixtures</h1><a href="/forbidden">Restricted</a><a href="/outside">External redirect</a><a href="/redirect">Internal redirect</a>' : '<h1>Good work starts with a clear idea.</h1><p>We create thoughtful spaces for people and their ideas.</p>';
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${description}<style>body{margin:0;background:#f6f2e9;color:#223e35;font:18px/1.7 Arial,sans-serif}header{display:flex;justify-content:space-between;align-items:center;padding:30px 6vw;border-bottom:1px solid #c6cec4}nav a{margin-left:20px;color:inherit}main{padding:90px 8vw;max-width:1000px}h1{font:64px/1.1 Georgia,serif;max-width:750px}p{max-width:600px}label{display:block}input{padding:12px;border:1px solid #435a50;background:white}button{padding:14px;background:#223e35;color:white;border:0}footer{padding:30px 6vw;border-top:1px solid #c6cec4}img{width:150px;height:80px}</style></head><body><header><strong>FIELDWORK / STUDIO</strong><nav aria-label="Main"><a href="/">Home</a><a href="/contact">Contact</a><a href="/missing">Our work</a></nav></header><main>${body}${!fixed && path === '/' ? '<img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E"><button type="button" aria-label=""></button>' : ''}</main><footer>Fictional studio · SiteCheck sample site <a href="/private">Private</a><a href="/logout">Sign out</a><a href="/contact?source=footer">Tracked contact</a></footer></body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture failed to start.');
  return {
    url: `http://127.0.0.1:${address.port}/`, requests,
    fix: () => { fixed = true; },
    close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }),
  };
}
