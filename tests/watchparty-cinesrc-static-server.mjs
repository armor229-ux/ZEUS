// Optional local static server for user testing. It does not proxy services or
// serve local video files; browsers connect directly to CineSrc and Supabase.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public'));
const port = Number(process.env.PORT || 4186);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json' };
const preservedDrafts = new Set(['direct-party.html', 'direct-party.css', 'direct-party.js', 'direct-party-utils.js',
  'party.js', 'party.css', 'watchparty-player.js', 'watchparty.js']);
const cleanPages = new Map([
  ['/anime', '/anime.html'], ['/genre', '/genre.html'], ['/discover', '/browse.html'], ['/browse', '/browse.html'],
  ['/search', '/search.html'], ['/watchlist', '/watchlist.html'], ['/library', '/watchlist.html'],
  ['/settings', '/settings.html'], ['/account', '/account.html'], ['/login', '/login.html'],
  ['/movie', '/movie.html'], ['/tv', '/tv.html'], ['/watch', '/watch.html'], ['/party', '/party.html'],
  ['/terms', '/terms.html'], ['/privacy', '/privacy.html'], ['/dmca', '/dmca.html']
]);

http.createServer((request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, 'http://local.invalid').pathname); }
  catch (error) { response.writeHead(400).end(); return; }
  if (pathname === '/') pathname = '/index.html';
  else if (cleanPages.has(pathname)) pathname = cleanPages.get(pathname);
  if (pathname.includes('\0') || pathname.split('/').some(part => part.startsWith('.')) ||
      pathname.startsWith('/media/') || /\.(?:mp4|webm|m3u8|mkv|mov)$/i.test(pathname)) {
    response.writeHead(404).end(); return;
  }
  const requested = path.resolve(publicDir, '.' + pathname);
  if (!requested.startsWith(publicDir + path.sep)) { response.writeHead(404).end(); return; }
  let file, stat;
  try {
    file = fs.realpathSync(requested);
    if (!file.startsWith(publicDir + path.sep) || file.startsWith(path.join(publicDir, 'media') + path.sep) ||
        preservedDrafts.has(path.relative(publicDir, file)) || /\.(?:mp4|webm|m3u8|mkv|mov)$/i.test(file)) {
      response.writeHead(404).end(); return;
    }
    stat = fs.statSync(file);
    if (!stat.isFile()) { response.writeHead(404).end(); return; }
  } catch (error) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'content-type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': stat.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  if (request.method === 'HEAD') { response.end(); return; }
  fs.createReadStream(file).pipe(response);
}).listen(port, '0.0.0.0', () => {
  console.log(`ZEUS static test site listening on port ${port}. No video files or service proxy are served.`);
});
