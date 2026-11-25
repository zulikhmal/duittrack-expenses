import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DEV_VARS_PATH = path.join(ROOT_DIR, '.dev.vars');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function loadDevVars(filePath) {
  const vars = {};
  if (!fs.existsSync(filePath)) return vars;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) vars[key] = val;
  }
  return vars;
}

const envVars = {
  ...loadDevVars(DEV_VARS_PATH),
  ...process.env
};

function serveStaticAsset(req) {
  const reqUrl = new URL(req.url);
  let pathname = decodeURIComponent(reqUrl.pathname);
  if (pathname === '/') pathname = '/index.html';

  const resolvedPath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!resolvedPath.startsWith(PUBLIC_DIR + path.sep) && resolvedPath !== PUBLIC_DIR) {
    return new Response('Forbidden', { status: 403 });
  }

  let targetFile = resolvedPath;
  if (!fs.existsSync(targetFile) || fs.statSync(targetFile).isDirectory()) {
    const htmlCandidate = `${targetFile}.html`;
    if (fs.existsSync(htmlCandidate) && fs.statSync(htmlCandidate).isFile()) {
      targetFile = htmlCandidate;
    } else {
      return new Response('Not Found', { status: 404 });
    }
  }

  const ext = path.extname(targetFile).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const body = fs.readFileSync(targetFile);
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': contentType }
  });
}

const workerEnv = {
  ...envVars,
  ASSETS: {
    fetch: async (request) => serveStaticAsset(request)
  }
};

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';

const server = http.createServer(async (req, res) => {
  try {
    const origin = `http://${req.headers.host || `${host}:${port}`}`;
    const fullUrl = new URL(req.url || '/', origin).toString();

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    const hasBody = rawBody && req.method !== 'GET' && req.method !== 'HEAD';

    const webReq = new Request(fullUrl, {
      method: req.method,
      headers: req.headers,
      body: hasBody ? rawBody : undefined
    });

    const webRes = await worker.fetch(webReq, workerEnv, {});
    res.statusCode = webRes.status;
    webRes.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    const resBuf = Buffer.from(await webRes.arrayBuffer());
    res.end(resBuf);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: false, error: err?.message || 'Dev server error' }));
  }
});

server.listen(port, host, () => {
  console.log(`DuitTrack dev server running at http://${host}:${port}`);
});
