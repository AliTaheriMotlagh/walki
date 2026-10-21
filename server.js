'use strict';

// Local dev server: serves public/ and the same /api routes Vercel runs
// (lib/walki.js). Without Redis env vars it keeps channels in memory.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { handle } = require('./lib/walki');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

function serve(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return handle(req, res);

  let file;
  try {
    file = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (!file || file.endsWith('/')) file += 'index.html';
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end();
  }

  fs.stat(full, (err, stat) => {
    // Unknown paths fall back to the app shell so share links always open.
    const target = !err && stat.isFile() ? full : path.join(PUBLIC, 'index.html');
    const ext = path.extname(target);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'permissions-policy': 'microphone=(self)',
    });
    fs.createReadStream(target).pipe(res);
  });
}

// Optional local HTTPS (needed for microphone access on phones over a LAN).
const keyPath = process.env.SSL_KEY || path.join(__dirname, 'certs', 'key.pem');
const certPath = process.env.SSL_CERT || path.join(__dirname, 'certs', 'cert.pem');
const useTls = fs.existsSync(keyPath) && fs.existsSync(certPath);
const server = useTls
  ? https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, serve)
  : http.createServer(serve);

server.listen(PORT, () => {
  console.log(`walki running on ${useTls ? 'https' : 'http'}://localhost:${PORT}`);
});
