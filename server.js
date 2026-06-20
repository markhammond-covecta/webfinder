'use strict';

// WebFinder - a browser-based macOS Finder, serving the real filesystem.
// Zero external dependencies: built on Node's http/fs/path only.

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const url = require('url');
const { execFile } = require('child_process');

// ROOT is the only directory WebFinder can touch. Defaults to the whole disk
// ('/') so all drives and the real Finder sidebar shortcuts are reachable; set
// WEBFINDER_ROOT to confine it (e.g. WEBFINDER_ROOT=$HOME for home only).
const ROOT = process.env.WEBFINDER_ROOT
  ? path.resolve(process.env.WEBFINDER_ROOT)
  : '/';
const PORT = parseInt(process.env.PORT || '4567', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const TRASH_DIR = path.join(os.homedir(), '.Trash');
const HELPER = path.join(__dirname, 'helper', 'webfinder-helper');
// Prefix used for the "stays within ROOT" check ('/' when ROOT is the disk).
const ROOT_PREFIX = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
const inRoot = (p) => p === ROOT || p.startsWith(ROOT_PREFIX);

// ---------------------------------------------------------------------------
// Path safety: every filesystem operation must resolve inside ROOT.
// ---------------------------------------------------------------------------

// Resolve a client-supplied path (relative to ROOT) to an absolute path that
// is guaranteed to live within ROOT. Throws on traversal attempts.
function safeResolve(rel) {
  const abs = path.resolve(ROOT, '.' + path.sep + (rel || ''));
  const normalised = path.normalize(abs);
  if (!inRoot(normalised)) {
    const err = new Error('Path escapes root');
    err.status = 403;
    throw err;
  }
  return normalised;
}

// Convert an absolute path back to a ROOT-relative path for the client.
function toRel(abs) {
  if (abs === ROOT) return '/';
  return '/' + path.relative(ROOT, abs).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// File metadata
// ---------------------------------------------------------------------------

const KIND_BY_EXT = {
  // images
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  svg: 'image', heic: 'image', bmp: 'image', tiff: 'image', ico: 'image',
  // video
  mp4: 'video', mov: 'video', avi: 'video', mkv: 'video', webm: 'video', m4v: 'video',
  // audio
  mp3: 'audio', wav: 'audio', aac: 'audio', flac: 'audio', m4a: 'audio', ogg: 'audio',
  // documents
  pdf: 'pdf',
  doc: 'doc', docx: 'doc', pages: 'doc', rtf: 'doc', txt: 'text', md: 'text',
  xls: 'sheet', xlsx: 'sheet', numbers: 'sheet', csv: 'sheet',
  ppt: 'slides', pptx: 'slides', key: 'slides',
  // code
  js: 'code', ts: 'code', jsx: 'code', tsx: 'code', py: 'code', rb: 'code',
  go: 'code', rs: 'code', java: 'code', c: 'code', h: 'code', cpp: 'code',
  css: 'code', html: 'code', json: 'code', xml: 'code', yml: 'code', yaml: 'code',
  sh: 'code', php: 'code',
  // archives
  zip: 'archive', tar: 'archive', gz: 'archive', rar: 'archive', '7z': 'archive', dmg: 'archive',
  // apps
  app: 'app',
};

function kindFor(name, isDir) {
  if (isDir) {
    if (name.endsWith('.app')) return 'app';
    return 'folder';
  }
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return KIND_BY_EXT[ext] || 'file';
}

async function entryInfo(dir, name) {
  const abs = path.join(dir, name);
  let st;
  try {
    st = await fsp.lstat(abs);
  } catch {
    return null;
  }
  let isDir = st.isDirectory();
  let isSymlink = st.isSymbolicLink();
  let target = null;
  if (isSymlink) {
    try {
      const real = await fsp.stat(abs);
      isDir = real.isDirectory();
      target = await fsp.readlink(abs);
    } catch {
      // dangling symlink
    }
  }
  const kind = kindFor(name, isDir);
  return {
    name,
    path: toRel(abs),
    isDir,
    isSymlink,
    symlinkTarget: target,
    size: st.size,
    mtime: st.mtimeMs,
    ctime: st.birthtimeMs || st.ctimeMs,
    kind,
    hidden: name.startsWith('.'),
  };
}

async function listDir(rel) {
  const dir = safeResolve(rel);
  const names = await fsp.readdir(dir);
  const entries = [];
  for (const name of names) {
    const info = await entryInfo(dir, name);
    if (info) entries.push(info);
  }
  return { path: toRel(dir), entries };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

// Pick a non-colliding destination path by appending " copy", " copy 2", etc.
async function uniquePath(destDir, baseName) {
  let candidate = path.join(destDir, baseName);
  if (!(await exists(candidate))) return candidate;
  const ext = path.extname(baseName);
  const stem = path.basename(baseName, ext);
  let n = 2;
  // First the bare " copy", then numbered.
  candidate = path.join(destDir, `${stem} copy${ext}`);
  if (!(await exists(candidate))) return candidate;
  while (await exists(candidate)) {
    candidate = path.join(destDir, `${stem} copy ${n}${ext}`);
    n++;
  }
  return candidate;
}

async function exists(p) {
  try { await fsp.lstat(p); return true; } catch { return false; }
}

async function mkdir(parentRel, name) {
  const parent = safeResolve(parentRel);
  const target = await uniquePath(parent, name || 'untitled folder');
  await fsp.mkdir(target);
  return toRel(target);
}

async function rename(rel, newName) {
  const abs = safeResolve(rel);
  if (!newName || newName.includes('/') || newName === '.' || newName === '..') {
    const e = new Error('Invalid name'); e.status = 400; throw e;
  }
  const dest = path.join(path.dirname(abs), newName);
  safeResolve(toRel(dest)); // re-validate
  if (await exists(dest)) { const e = new Error('Name already exists'); e.status = 409; throw e; }
  await fsp.rename(abs, dest);
  return toRel(dest);
}

async function move(srcRels, destDirRel) {
  const destDir = safeResolve(destDirRel);
  const results = [];
  for (const srcRel of srcRels) {
    const src = safeResolve(srcRel);
    if (src === destDir || destDir.startsWith(src + path.sep)) continue; // no move into self
    const dest = await uniquePath(destDir, path.basename(src));
    await moveAcross(src, dest);
    results.push(toRel(dest));
  }
  return results;
}

// rename, falling back to copy+remove across volumes.
async function moveAcross(src, dest) {
  try {
    await fsp.rename(src, dest);
  } catch (e) {
    if (e.code === 'EXDEV') {
      await copyRecursive(src, dest);
      await fsp.rm(src, { recursive: true, force: true });
    } else {
      throw e;
    }
  }
}

async function copyRecursive(src, dest) {
  await fsp.cp(src, dest, { recursive: true });
}

async function copyInto(srcRels, destDirRel) {
  const destDir = safeResolve(destDirRel);
  const results = [];
  for (const srcRel of srcRels) {
    const src = safeResolve(srcRel);
    const dest = await uniquePath(destDir, path.basename(src));
    await copyRecursive(src, dest);
    results.push(toRel(dest));
  }
  return results;
}

async function duplicate(rels) {
  const results = [];
  for (const rel of rels) {
    const src = safeResolve(rel);
    const dir = path.dirname(src);
    const dest = await uniquePath(dir, path.basename(src));
    await copyRecursive(src, dest);
    results.push(toRel(dest));
  }
  return results;
}

// Move to ~/.Trash, the way Finder does, with collision handling.
async function trash(rels) {
  await fsp.mkdir(TRASH_DIR, { recursive: true });
  const results = [];
  for (const rel of rels) {
    const src = safeResolve(rel);
    let dest = path.join(TRASH_DIR, path.basename(src));
    if (await exists(dest)) {
      const ext = path.extname(src);
      const stem = path.basename(src, ext);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      dest = path.join(TRASH_DIR, `${stem} ${stamp}${ext}`);
    }
    await moveAcross(src, dest);
    results.push(path.basename(src));
  }
  return results;
}

async function newFile(parentRel, name) {
  const parent = safeResolve(parentRel);
  const target = await uniquePath(parent, name || 'untitled.txt');
  await fsp.writeFile(target, '', { flag: 'wx' });
  return toRel(target);
}

// Open a file/folder with the macOS default application.
function openNative(rel) {
  const abs = safeResolve(rel);
  return new Promise((resolve, reject) => {
    execFile('open', [abs], (err) => (err ? reject(err) : resolve()));
  });
}

// Reveal target's enclosing folder selection in the real Finder (handy).
function revealNative(rel) {
  const abs = safeResolve(rel);
  return new Promise((resolve, reject) => {
    execFile('open', ['-R', abs], (err) => (err ? reject(err) : resolve()));
  });
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e7) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Stream a real file to the browser (for preview / download / opening in tab).
async function serveFile(res, rel, query) {
  const abs = safeResolve(rel);
  const st = await fsp.stat(abs);
  if (st.isDirectory()) { sendJSON(res, 400, { error: 'Is a directory' }); return; }
  const ext = path.extname(abs).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  if (query.download === '1') {
    headers['Content-Disposition'] =
      `attachment; filename="${encodeURIComponent(path.basename(abs))}"`;
  }
  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  fs.createReadStream(abs).pipe(res);
}

// Receive a dragged-in file: the raw request body is the file's bytes.
// ?dir = destination folder, ?rel = path within it (may contain subfolders,
// e.g. when a folder is dropped). Streams straight to disk - never buffered as
// a string, so binary files stay intact.
async function handleUpload(req, res, query) {
  const dirRel = query.dir || '/';
  // Normalise rel: strip leading slashes, drop any '..' segments.
  const rel = String(query.rel || query.name || 'upload')
    .replace(/^\/+/, '')
    .split('/').filter((s) => s && s !== '..' && s !== '.').join('/');
  if (!rel) { sendJSON(res, 400, { error: 'missing name' }); return; }
  let abs = safeResolve((dirRel === '/' ? '' : dirRel) + '/' + rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  // Avoid clobbering an existing top-level file (folder merges are allowed).
  if (!rel.includes('/') && await exists(abs)) {
    abs = await uniquePath(path.dirname(abs), path.basename(abs));
  }
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(abs);
    req.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
    req.on('error', reject);
  });
  sendJSON(res, 200, { path: toRel(abs) });
}

async function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { sendJSON(res, 403, { error: 'forbidden' }); return; }
  try {
    const data = await fsp.readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const { pathname, query } = parsed;
  try {
    // ---- API ----
    if (pathname === '/api/info') {
      return sendJSON(res, 200, {
        root: ROOT, home: os.homedir(),
        rootName: rootDisplayName(),
        homePath: inRoot(os.homedir()) ? toRel(os.homedir()) : null,
        favourites: await buildFavourites(),
        locations: locations(),
      });
    }
    if (pathname === '/api/list' && req.method === 'GET') {
      return sendJSON(res, 200, await listDir(query.path || '/'));
    }
    if (pathname === '/api/file' && req.method === 'GET') {
      return await serveFile(res, query.path || '', query);
    }
    if (pathname === '/api/upload' && req.method === 'POST') {
      return await handleUpload(req, res, query);
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      switch (pathname) {
        case '/api/mkdir':    return sendJSON(res, 200, { path: await mkdir(body.path, body.name) });
        case '/api/newfile':  return sendJSON(res, 200, { path: await newFile(body.path, body.name) });
        case '/api/rename':   return sendJSON(res, 200, { path: await rename(body.path, body.name) });
        case '/api/move':     return sendJSON(res, 200, { paths: await move(body.paths, body.dest) });
        case '/api/copy':     return sendJSON(res, 200, { paths: await copyInto(body.paths, body.dest) });
        case '/api/duplicate':return sendJSON(res, 200, { paths: await duplicate(body.paths) });
        case '/api/trash':    return sendJSON(res, 200, { trashed: await trash(body.paths) });
        case '/api/open':     await openNative(body.path); return sendJSON(res, 200, { ok: true });
        case '/api/reveal':   await revealNative(body.path); return sendJSON(res, 200, { ok: true });
        default: break;
      }
    }
    // ---- static ----
    if (req.method === 'GET') return await serveStatic(res, pathname);
    sendJSON(res, 404, { error: 'Not found' });
  } catch (e) {
    sendJSON(res, e.status || 500, { error: e.message || String(e) });
  }
});

// Choose a sidebar glyph from a folder's name / path.
function iconForFav(absPath, name) {
  const home = os.homedir();
  if (absPath === '/') return 'computer';
  if (absPath === home) return 'home';
  if (absPath.startsWith('/Volumes/')) return 'drive';
  const n = name.toLowerCase();
  const known = ['desktop', 'documents', 'downloads', 'pictures', 'music', 'movies', 'videos', 'applications'];
  if (known.includes(n)) return n === 'videos' ? 'movies' : n;
  if (absPath === '/Applications') return 'applications';
  return 'folder';
}

// Ask the native helper for the user's real Finder sidebar favourites.
function finderSidebar() {
  return new Promise((resolve) => {
    execFile(HELPER, ['sidebar'], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

// Default favourites when the helper is unavailable (built from common folders).
function fallbackFavourites() {
  const home = os.homedir();
  const out = [];
  if (inRoot('/')) out.push({ name: 'Macintosh HD', path: '/', icon: 'computer' });
  if (inRoot(home)) out.push({ name: path.basename(home) || 'Home', path: toRel(home), icon: 'home' });
  for (const name of ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Movies']) {
    const p = path.join(home, name);
    if (inRoot(p) && fs.existsSync(p)) out.push({ name, path: toRel(p), icon: name.toLowerCase() });
  }
  if (inRoot('/Applications') && fs.existsSync('/Applications')) {
    out.push({ name: 'Applications', path: toRel('/Applications'), icon: 'applications' });
  }
  return out;
}

// Build the favourites list, preferring the real Finder sidebar, filtered to
// items that exist and live within ROOT.
async function buildFavourites() {
  const sidebar = await finderSidebar();
  if (!sidebar || !sidebar.length) return fallbackFavourites();
  const out = [];
  const seen = new Set();
  for (const item of sidebar) {
    const abs = path.resolve(item.path);
    if (!inRoot(abs) || seen.has(abs)) continue;
    if (!fs.existsSync(abs)) continue;
    seen.add(abs);
    out.push({ name: item.name, path: toRel(abs), icon: iconForFav(abs, item.name) });
  }
  return out.length ? out : fallbackFavourites();
}

const isDirSafe = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// Friendly display name for a ~/Library/CloudStorage provider directory.
function cloudName(dir) {
  if (dir.startsWith('GoogleDrive-')) return 'Google Drive';
  if (dir.startsWith('OneDrive-')) return 'OneDrive - ' + dir.slice('OneDrive-'.length);
  if (dir === 'OneDrive') return 'OneDrive';
  if (dir.startsWith('Dropbox')) return 'Dropbox';
  if (dir.startsWith('Box-')) return 'Box';
  return dir;
}

// Cloud providers, iCloud Drive, and mounted volumes - shown under "Locations",
// just like Finder.
function locations() {
  const home = os.homedir();
  const out = [];

  // iCloud Drive
  const icloud = path.join(home, 'Library/Mobile Documents/com~apple~CloudDocs');
  if (inRoot(icloud) && isDirSafe(icloud)) {
    out.push({ name: 'iCloud Drive', path: toRel(icloud), icon: 'icloud' });
  }

  // Cloud storage providers (Google Drive, OneDrive, Dropbox, ...)
  const cs = path.join(home, 'Library/CloudStorage');
  try {
    for (const d of fs.readdirSync(cs)) {
      if (d.startsWith('.')) continue;
      const p = path.join(cs, d);
      if (inRoot(p) && isDirSafe(p)) out.push({ name: cloudName(d), path: toRel(p), icon: 'cloud' });
    }
  } catch { /* none */ }

  // Mounted volumes / external drives
  try {
    for (const v of fs.readdirSync('/Volumes')) {
      const p = path.join('/Volumes', v);
      if (inRoot(p) && isDirSafe(p)) out.push({ name: v, path: toRel(p), icon: 'drive' });
    }
  } catch { /* /Volumes unreadable */ }

  return out;
}

// Display name for the ROOT-relative '/' (the title shown for the top level).
function rootDisplayName() {
  if (ROOT === '/') {
    try {
      const vols = fs.readdirSync('/Volumes');
      // The boot volume is the one /Volumes/<name> points at '/'.
      for (const v of vols) {
        try { if (fs.realpathSync(path.join('/Volumes', v)) === '/') return v; } catch {}
      }
    } catch {}
    return 'Macintosh HD';
  }
  return path.basename(ROOT) || ROOT;
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  WebFinder running at  http://localhost:${PORT}`);
  console.log(`  Serving:              ${ROOT}`);
  console.log(`  Deletes go to:        ${TRASH_DIR}\n`);
});
