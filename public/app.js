'use strict';
// WebFinder front-end. Vanilla JS, talks to the Node fs API in server.js.

// ------------------------------------------------------------------ API ----
const API = {
  async info() { return (await fetch('/api/info')).json(); },
  async list(path) {
    const r = await fetch('/api/list?path=' + encodeURIComponent(path));
    if (!r.ok) throw new Error((await r.json()).error || 'list failed');
    return r.json();
  },
  post(url, body) {
    return fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'request failed');
      return j;
    });
  },
  mkdir(path, name) { return this.post('/api/mkdir', { path, name }); },
  rename(path, name) { return this.post('/api/rename', { path, name }); },
  move(paths, dest) { return this.post('/api/move', { paths, dest }); },
  copy(paths, dest) { return this.post('/api/copy', { paths, dest }); },
  duplicate(paths) { return this.post('/api/duplicate', { paths }); },
  trash(paths) { return this.post('/api/trash', { paths }); },
  open(path) { return this.post('/api/open', { path }); },
  reveal(path) { return this.post('/api/reveal', { path }); },
};
const fileURL = (p) => '/api/file?path=' + encodeURIComponent(p);

// Encode a filesystem path for the URL hash, keeping slashes readable.
function pathToHash(p) {
  return '#' + p.split('/').map(encodeURIComponent).join('/');
}
function hashToPath() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return null;
  try {
    const p = h.split('/').map(decodeURIComponent).join('/');
    return p.startsWith('/') ? p : '/' + p;
  } catch (e) { return null; }
}

// ---------------------------------------------------------------- State ----
const state = {
  cwd: '/',
  view: 'icon',                 // icon | list | column
  entries: [],
  selection: new Set(),         // set of paths
  anchor: null,                 // anchor path for shift-range
  sort: { key: 'name', dir: 1 },
  showHidden: false,
  search: '',
  history: ['/'],
  histIndex: 0,
  favourites: [],
  locations: [],
  rootName: 'Home',
  home: '/',
  clipboard: null,              // { paths:[], mode:'copy'|'cut' }
  columns: [],                  // column view: [{ path, entries, selected }]
  listColW: { date: 170, created: 170, size: 92, kind: 130 }, // resizable list-view column widths (name flexes)
  expanded: new Set(),          // list view: paths of folders expanded inline
  childCache: new Map(),        // list view: path -> raw child entries (loaded on expand)
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};

// -------------------------------------------------------------- Helpers ----
function basename(p) {
  if (p === '/') return state.rootName;
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || '/';
}
function parentPath(p) {
  if (p === '/') return '/';
  const parts = p.split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
}
function joinPath(dir, name) {
  return (dir === '/' ? '' : dir) + '/' + name;
}
function formatSize(bytes, isDir) {
  if (isDir) return '--';
  if (bytes < 1000) return bytes + ' bytes';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes, i = -1;
  do { n /= 1000; i++; } while (n >= 1000 && i < u.length - 1);
  return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
}
function formatDate(ms) {
  const d = new Date(ms), now = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  const t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (same(d, now)) return `Today at ${t}`;
  if (same(d, yest)) return `Yesterday at ${t}`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + ` at ${t}`;
}
const KIND_NAMES = {
  folder: 'Folder', app: 'Application', pdf: 'PDF Document', image: 'Image',
  video: 'Movie', audio: 'Audio', doc: 'Document', text: 'Plain Text',
  sheet: 'Spreadsheet', slides: 'Presentation', code: 'Source Code',
  archive: 'Archive', file: 'Document',
};
const kindName = (e) => KIND_NAMES[e.kind] || 'Document';
const isImage = (e) => e.kind === 'image' && e.size < 8_000_000;

function thumbHTML(e, cls) {
  if (isImage(e)) return `<img class="${cls || ''} thumb" loading="lazy" src="${fileURL(e.path)}" alt="">`;
  return Icons.iconFor(e.kind);
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2200);
}

// ---------------------------------------------------------- Data + sort ----
function visibleEntries() { return sortFilter(state.entries); }

// Apply the hidden/search filters and the active sort to a raw entries array.
// Used for the current folder and, in list view, for each expanded subfolder.
function sortFilter(entries) {
  let list = entries.slice();
  if (!state.showHidden) list = list.filter((e) => !e.hidden);
  if (state.search.trim()) {
    const q = state.search.trim().toLowerCase();
    list = list.filter((e) => e.name.toLowerCase().includes(q));
  }
  const { key, dir } = state.sort;
  list.sort((a, b) => {
    // folders first (Finder default within name sort keeps mixed; but folders-first feels right)
    if (key === 'name') {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) * dir;
    }
    let av, bv;
    if (key === 'size') { av = a.isDir ? -1 : a.size; bv = b.isDir ? -1 : b.size; }
    else if (key === 'date') { av = a.mtime; bv = b.mtime; }
    else if (key === 'created') { av = a.ctime; bv = b.ctime; }
    else if (key === 'kind') { av = kindName(a); bv = kindName(b); return String(av).localeCompare(String(bv)) * dir; }
    return (av - bv) * dir;
  });
  return list;
}

// A folder can be expanded inline in list view (everything except .app bundles).
function isExpandable(e) { return e.isDir && e.kind !== 'app'; }

// Flatten the current folder into the rows shown in list view, recursively
// splicing in the children of any expanded folders. Each row carries its
// nesting depth so the renderer can indent it.
function listRows() {
  const rows = [];
  const walk = (entries, depth) => {
    for (const e of sortFilter(entries)) {
      rows.push({ e, depth });
      if (isExpandable(e) && state.expanded.has(e.path)) {
        const kids = state.childCache.get(e.path);
        if (kids) walk(kids, depth + 1);
      }
    }
  };
  walk(state.entries, 0);
  return rows;
}

// Toggle inline expansion of a folder in list view, loading its children once.
async function toggleExpand(e) {
  if (state.expanded.has(e.path)) {
    state.expanded.delete(e.path);
    renderMain(); updateStatus();
    return;
  }
  if (!state.childCache.has(e.path)) {
    try {
      const data = await API.list(e.path);
      state.childCache.set(e.path, data.entries);
    } catch (err) { toast('Cannot open: ' + err.message); return; }
  }
  state.expanded.add(e.path);
  renderMain(); updateStatus();
}

// Reload the cached children of every still-expanded folder (after a refresh).
async function reloadExpanded() {
  for (const p of state.expanded) {
    try {
      const data = await API.list(p);
      state.childCache.set(p, data.entries);
    } catch (err) { state.expanded.delete(p); state.childCache.delete(p); }
  }
}

// ----------------------------------------------------------- Navigation ----
async function navigate(path, pushHistory = true) {
  let data;
  try {
    data = await API.list(path);
  } catch (e) { toast('Cannot open: ' + e.message); return; }
  state.cwd = data.path;
  state.entries = data.entries;
  state.expanded.clear();
  state.childCache.clear();
  state.selection.clear();
  state.anchor = null;
  state.search = ''; $('searchInput').value = '';
  if (pushHistory) {
    state.history = state.history.slice(0, state.histIndex + 1);
    state.history.push(state.cwd);
    state.histIndex = state.history.length - 1;
  }
  if (state.view === 'column') initColumns();
  // Reflect the current location in the URL so it survives reloads and is shareable.
  const hash = pathToHash(state.cwd);
  if (location.hash !== hash) { suppressHashChange = true; location.hash = hash; }
  render();
}
let suppressHashChange = false;
function goBack() { if (state.histIndex > 0) { state.histIndex--; navigate(state.history[state.histIndex], false); } }
function goForward() { if (state.histIndex < state.history.length - 1) { state.histIndex++; navigate(state.history[state.histIndex], false); } }
function goUp() { if (state.cwd !== '/') navigate(parentPath(state.cwd)); }

// ------------------------------------------------------------- Open item ----
function openEntry(e) {
  if (e.isDir && e.kind !== 'app') navigate(e.path);
  else API.open(e.path).catch((err) => toast('Open failed: ' + err.message));
}

// ------------------------------------------------------------ Selection ----
function setSelection(paths) { state.selection = new Set(paths); }
function selectedEntries() {
  if (state.view === 'column') {
    const last = state.columns[state.columns.length - 1];
    const sel = [];
    for (const c of state.columns) if (c.selected) {
      const e = c.entries.find((x) => x.path === c.selected);
      if (e) sel.length = 0, sel.push(e); // last selected wins
    }
    return sel;
  }
  // List view may show expanded children, so resolve against the flattened rows.
  const pool = state.view === 'list' ? orderedVisible() : visibleEntries();
  return pool.filter((e) => state.selection.has(e.path));
}

function handleItemClick(ev, entry, ordered) {
  ev.stopPropagation();
  const meta = ev.metaKey || ev.ctrlKey;
  const shift = ev.shiftKey;
  if (meta) {
    if (state.selection.has(entry.path)) state.selection.delete(entry.path);
    else state.selection.add(entry.path);
    state.anchor = entry.path;
  } else if (shift && state.anchor) {
    const ai = ordered.findIndex((e) => e.path === state.anchor);
    const bi = ordered.findIndex((e) => e.path === entry.path);
    const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai];
    state.selection = new Set(ordered.slice(lo, hi + 1).map((e) => e.path));
  } else {
    state.selection = new Set([entry.path]);
    state.anchor = entry.path;
  }
  renderMain();
  updateStatus();
}

// --------------------------------------------------------------- Render ----
function render() {
  renderSidebar();
  $('folderTitle').textContent = basename(state.cwd);
  $('backBtn').disabled = state.histIndex <= 0;
  $('fwdBtn').disabled = state.histIndex >= state.history.length - 1;
  document.querySelectorAll('#viewSwitch button').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === state.view));
  renderMain();
  renderPathBar();
  updateStatus();
}

function renderSidebar() {
  const sb = $('sidebar');
  sb.innerHTML = '';
  const group = (title, items) => {
    if (!items.length) return;
    sb.appendChild(el('div', 'group-title', title));
    for (const fav of items) {
      const item = el('div', 'sb-item');
      item.innerHTML = Icons.sidebarIcon(fav.icon) + `<span class="nm">${escapeHTML(fav.name)}</span>`;
      if (fav.path === state.cwd) item.classList.add('active');
      item.onclick = () => navigate(fav.path);
      makeDropTarget(item, () => fav.path);
      sb.appendChild(item);
    }
  };
  group('Favourites', state.favourites);
  group('Locations', state.locations);
}

function renderMain() {
  const c = $('content');
  c.className = 'content';
  c.innerHTML = '';
  if (state.view === 'icon') renderIcon(c);
  else if (state.view === 'list') renderList(c);
  else if (state.view === 'gallery') renderGallery(c);
  else renderColumn(c);
}

// ---- Gallery view ----
function galleryStageHTML(e) {
  if (isImage(e)) return `<img src="${fileURL(e.path)}" alt="">`;
  if (e.kind === 'pdf') return `<iframe src="${fileURL(e.path)}#toolbar=0" title="preview"></iframe>`;
  if (e.kind === 'video') return `<video controls src="${fileURL(e.path)}"></video>`;
  return `<div class="gl-bigicon">${Icons.iconFor(e.kind)}</div>`;
}
function renderGallery(c) {
  const list = visibleEntries();
  if (!list.length) { c.appendChild(emptyMsg()); return; }
  const cur = list.find((e) => state.selection.has(e.path)) || list[0];
  state.selection = new Set([cur.path]); state.anchor = cur.path;
  const view = el('div', 'galleryview');
  const stage = el('div', 'gl-stage');
  stage.innerHTML = galleryStageHTML(cur);
  stage.ondblclick = () => openEntry(cur);
  const name = el('div', 'gl-name', escapeHTML(cur.name));
  const strip = el('div', 'gl-strip');
  for (const e of list) {
    const th = el('div', 'gl-thumb' + (e.path === cur.path ? ' selected' : ''));
    th.title = e.name;
    th.innerHTML = `<div class="gl-th-img">${thumbHTML(e)}</div>`;
    th.onclick = (ev) => { ev.stopPropagation(); setSelection([e.path]); state.anchor = e.path; renderMain(); updateStatus(); };
    th.ondblclick = (ev) => { ev.stopPropagation(); openEntry(e); };
    th.oncontextmenu = (ev) => { setSelection([e.path]); state.anchor = e.path; renderMain(); showContextMenu(ev, e); };
    makeDraggable(th, e);
    if (e.isDir && e.kind !== 'app') makeDropTarget(th, () => e.path);
    strip.appendChild(th);
  }
  view.append(stage, name, strip);
  c.appendChild(view);
  const sel = strip.querySelector('.gl-thumb.selected');
  if (sel) sel.scrollIntoView({ inline: 'center', block: 'nearest' });
}

// ---- Icon view ----
function renderIcon(c) {
  const list = visibleEntries();
  const grid = el('div', 'iconview');
  if (!list.length) { c.appendChild(emptyMsg()); return; }
  for (const e of list) {
    const item = el('div', 'icon-item' + (state.selection.has(e.path) ? ' selected' : '') + (e.hidden ? ' hidden-file' : ''));
    item.innerHTML = `<div class="thumb">${thumbHTML(e)}</div><div class="label">${escapeHTML(e.name)}</div>`;
    wireItem(item, e, list);
    grid.appendChild(item);
  }
  c.appendChild(grid);
  attachMarquee(grid, list);
}

// ---- List view ----
function renderList(c) {
  const list = visibleEntries();
  const view = el('div', 'listview');
  const head = el('div', 'list-head');
  const cols = [['name', 'Name'], ['date', 'Date Modified'], ['created', 'Date Created'], ['size', 'Size'], ['kind', 'Kind']];
  const colStyle = (key) => key === 'name' ? '' : `flex:0 0 ${state.listColW[key]}px;width:${state.listColW[key]}px`;
  cols.forEach(([key, label], i) => {
    const arrow = state.sort.key === key ? `<span class="arrow">${state.sort.dir > 0 ? '▲' : '▼'}</span>` : '';
    const col = el('div', 'col ' + key, `<span class="lbl">${label}${arrow}</span>`);
    col.style.cssText = colStyle(key);
    col.onclick = () => {
      if (state.sort.key === key) state.sort.dir *= -1;
      else state.sort = { key, dir: 1 };
      renderMain();
    };
    // Drag handle on the right edge resizes this column; its right neighbour
    // absorbs the change so the divider tracks the cursor (no handle on the last).
    const nextKey = cols[i + 1] && cols[i + 1][0];
    if (nextKey) {
      const grip = el('div', 'col-resizer');
      grip.onclick = (ev) => ev.stopPropagation();
      grip.onmousedown = (ev) => startColResize(ev, key, nextKey);
      col.appendChild(grip);
    }
    head.appendChild(col);
  });
  view.appendChild(head);
  const rows = listRows();
  if (!rows.length) { c.appendChild(view); c.appendChild(emptyMsg()); return; }
  const ordered = rows.map((r) => r.e);
  for (const { e, depth } of rows) {
    const row = el('div', 'list-row' + (state.selection.has(e.path) ? ' selected' : '') + (e.hidden ? ' hidden-file' : ''));
    const expandable = isExpandable(e);
    const disc = expandable
      ? `<span class="disclosure${state.expanded.has(e.path) ? ' open' : ''}">›</span>`
      : '<span class="disclosure"></span>';
    // Indent nested rows; base padding is 10px (see .list-row .col).
    const nameStyle = depth ? ` style="padding-left:${10 + depth * 16}px"` : '';
    row.innerHTML =
      `<div class="col name"${nameStyle}>${disc}${thumbHTML(e)}<span class="nm">${escapeHTML(e.name)}</span></div>` +
      `<div class="col date" style="${colStyle('date')}">${formatDate(e.mtime)}</div>` +
      `<div class="col created" style="${colStyle('created')}">${formatDate(e.ctime)}</div>` +
      `<div class="col size" style="${colStyle('size')}">${formatSize(e.size, e.isDir)}</div>` +
      `<div class="col kind" style="${colStyle('kind')}">${kindName(e)}</div>`;
    wireItem(row, e, ordered);
    if (expandable) {
      const tri = row.querySelector('.disclosure');
      tri.onclick = (ev) => { ev.stopPropagation(); toggleExpand(e); };
    }
    view.appendChild(row);
  }
  c.appendChild(view);
}

// Drag-resize a list-view column by dragging the divider on its right edge.
// The right neighbour (`nextKey`) absorbs the width change so the divider tracks
// the cursor and columns to the left stay put. `key === 'name'` is the flexible
// fill column: it has no stored width, so only the neighbour is adjusted and the
// Name column grows/shrinks to fill the freed space.
function startColResize(ev, key, nextKey) {
  ev.preventDefault(); ev.stopPropagation();
  const startX = ev.clientX;
  const min = 56;
  const startKey = key === 'name' ? null : state.listColW[key];
  const startNext = state.listColW[nextKey];
  document.body.classList.add('col-resizing');
  const applyWidth = (k, w) => {
    state.listColW[k] = w;
    document.querySelectorAll('.listview .col.' + k).forEach((c) => {
      c.style.flex = `0 0 ${w}px`; c.style.width = w + 'px';
    });
  };
  const onMove = (e) => {
    let delta = Math.round(e.clientX - startX);
    if (startKey === null) {
      // Flexible Name column: shrink/grow only the neighbour; Name fills the rest.
      applyWidth(nextKey, Math.max(min, startNext - delta));
    } else {
      // Keep both the column and its neighbour >= min; total of the pair is fixed.
      delta = Math.max(min - startKey, Math.min(startNext - min, delta));
      applyWidth(key, startKey + delta);
      applyWidth(nextKey, startNext - delta);
    }
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.classList.remove('col-resizing');
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ---- Column (Miller) view ----
function initColumns() {
  state.columns = [{ path: state.cwd, entries: state.entries, selected: null }];
}
async function loadColumn(path) {
  const data = await API.list(path);
  return { path, entries: data.entries, selected: null };
}
function colVisible(entries) {
  let l = entries.slice();
  if (!state.showHidden) l = l.filter((e) => !e.hidden);
  l.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1)
    : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })));
  return l;
}
function renderColumn(c) {
  if (!state.columns.length) initColumns();
  const wrap = el('div', 'columnview');
  state.columns.forEach((col, ci) => {
    const pane = el('div', 'col-pane');
    for (const e of colVisible(col.entries)) {
      const row = el('div', 'col-row' + (e.hidden ? ' hidden-file' : ''));
      if (col.selected === e.path) row.classList.add(ci === state.columns.length - 1 ? 'selected' : 'selected-inactive');
      row.innerHTML = `${thumbHTML(e)}<span class="nm">${escapeHTML(e.name)}</span>${e.isDir && e.kind !== 'app' ? '<span class="chev">›</span>' : ''}`;
      row.onclick = (ev) => { ev.stopPropagation(); selectColumn(ci, e); };
      row.ondblclick = (ev) => { ev.stopPropagation(); if (!e.isDir || e.kind === 'app') openEntry(e); };
      row.oncontextmenu = (ev) => { selectColumn(ci, e); showContextMenu(ev, e); };
      makeDraggable(row, e);
      if (e.isDir && e.kind !== 'app') makeDropTarget(row, () => e.path);
      pane.appendChild(row);
    }
    wrap.appendChild(pane);
  });
  // preview pane for a selected file
  const lastCol = state.columns[state.columns.length - 1];
  if (lastCol && lastCol.selected) {
    const e = lastCol.entries.find((x) => x.path === lastCol.selected);
    if (e && (!e.isDir || e.kind === 'app')) wrap.appendChild(previewPane(e));
  }
  c.appendChild(wrap);
  c.querySelector('.columnview').scrollLeft = 99999;
}
async function selectColumn(ci, e) {
  state.columns = state.columns.slice(0, ci + 1);
  state.columns[ci].selected = e.path;
  state.selection = new Set([e.path]);
  if (e.isDir && e.kind !== 'app') {
    try { state.columns.push(await loadColumn(e.path)); } catch (_) {}
  }
  renderMain(); updateStatus();
}
function previewPane(e) {
  const pane = el('div', 'col-pane preview');
  const icon = isImage(e) ? `<img src="${fileURL(e.path)}">` : Icons.iconFor(e.kind);
  pane.innerHTML =
    `<div class="pv-icon">${icon}</div>` +
    `<div class="pv-name">${escapeHTML(e.name)}</div>` +
    `<div class="pv-meta">
      <div><span class="k">Kind</span><span class="v">${kindName(e)}</span></div>
      <div><span class="k">Size</span><span class="v">${formatSize(e.size, e.isDir)}</span></div>
      <div><span class="k">Modified</span><span class="v">${formatDate(e.mtime)}</span></div>
      <div><span class="k">Created</span><span class="v">${formatDate(e.ctime)}</span></div>
     </div>`;
  return pane;
}

// ---- shared item wiring ----
function wireItem(node, e, ordered) {
  node.onclick = (ev) => handleItemClick(ev, e, ordered);
  node.ondblclick = (ev) => { ev.stopPropagation(); openEntry(e); };
  node.oncontextmenu = (ev) => {
    if (!state.selection.has(e.path)) { setSelection([e.path]); state.anchor = e.path; renderMain(); }
    showContextMenu(ev, e);
  };
  makeDraggable(node, e);
  if (e.isDir && e.kind !== 'app') makeDropTarget(node, () => e.path);
}

function emptyMsg() { return el('div', 'empty', state.search ? 'No matching items' : 'This folder is empty'); }
function escapeHTML(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// --------------------------------------------------------- Path / status ----
function renderPathBar() {
  const bar = $('pathbar');
  bar.innerHTML = '';
  const parts = state.cwd === '/' ? [] : state.cwd.split('/').filter(Boolean);
  const crumbs = [{ name: state.home, path: '/' }];
  let acc = '';
  for (const p of parts) { acc += '/' + p; crumbs.push({ name: p, path: acc }); }
  crumbs.forEach((cr, i) => {
    if (i) bar.appendChild(el('span', 'sep', '›'));
    const c = el('span', 'crumb', (i === 0 ? Icons.sidebarIcon('home') : Icons.sidebarIcon('folder')) + escapeHTML(cr.name));
    c.onclick = () => navigate(cr.path);
    makeDropTarget(c, () => cr.path);
    bar.appendChild(c);
  });
}
function updateStatus() {
  const list = visibleEntries();
  const sel = selectedEntries();
  let msg = `${list.length} item${list.length === 1 ? '' : 's'}`;
  if (sel.length) msg = `${sel.length} of ${list.length} selected`;
  $('status').textContent = msg;
  updateToolbar();
}

// -------------------------------------------------------- Inline rename ----
function beginRename(entry) {
  const sel = `[data-path="${cssEscape(entry.path)}"]`;
  let host = document.querySelector('.icon-item' + sel + ' .label')
    || document.querySelector('.list-row' + sel + ' .nm')
    || document.querySelector('.col-row' + sel + ' .nm');
  if (!host) {
    // fall back: find node by matching text not reliable; re-render then retry
    return;
  }
  const input = el('input', 'rename-input');
  input.value = entry.name;
  const orig = host.innerHTML;
  host.innerHTML = '';
  host.appendChild(input);
  input.focus();
  const dot = entry.name.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  let done = false;
  const finish = async (commit) => {
    if (done) return; done = true;
    const newName = input.value.trim();
    if (commit && newName && newName !== entry.name) {
      try {
        await API.rename(entry.path, newName);
        const np = joinPath(parentPath(entry.path), newName);
        await navigate(state.cwd, false);
        setSelection([np]);
        if (state.view === 'column') initColumns();
        renderMain();
      } catch (err) { toast('Rename failed: ' + err.message); host.innerHTML = orig; }
    } else { host.innerHTML = orig; }
  };
  input.onkeydown = (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') finish(true);
    else if (ev.key === 'Escape') finish(false);
  };
  input.onblur = () => finish(true);
  input.onclick = (ev) => ev.stopPropagation();
}
function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'); }

// To make rename targetable, tag nodes with data-path. Patch render funcs:
function tagPaths() {
  // called after renderMain via mutation; instead we add data-path in wireItem
}

// ------------------------------------------------------ Drag-and-drop ----
let dragPaths = null;
function makeDraggable(node, e) {
  node.draggable = true;
  node.dataset.path = e.path;
  node.addEventListener('dragstart', (ev) => {
    if (!state.selection.has(e.path)) { setSelection([e.path]); renderMain(); }
    dragPaths = [...state.selection];
    ev.dataTransfer.effectAllowed = 'copyMove';
    ev.dataTransfer.setData('text/plain', dragPaths.join('\n'));
    // Let the file drag OUT to Finder/other apps as a real file (a copy -
    // a browser cannot delete the source as part of an OS drag).
    if (!e.isDir && dragPaths.length === 1) {
      const url = location.origin + fileURL(e.path);
      ev.dataTransfer.setData('DownloadURL', `application/octet-stream:${e.name}:${url}`);
    }
  });
  node.addEventListener('dragend', () => { dragPaths = null; });
}

// True when an OS drag carries external files (dragged in from outside).
function dragHasFiles(dt) {
  if (!dt || !dt.types) return false;
  return dt.types.includes ? dt.types.includes('Files') : [...dt.types].indexOf('Files') >= 0;
}
// Capture dropped external items synchronously (entries become invalid later).
function captureDropItems(dt) {
  const roots = [];
  if (dt.items) {
    for (const it of dt.items) {
      if (it.kind === 'file' && it.webkitGetAsEntry) {
        const en = it.webkitGetAsEntry();
        if (en) roots.push(en);
      }
    }
  }
  const files = (!roots.length && dt.files) ? [...dt.files] : [];
  return { roots, files };
}
function walkEntry(entry, prefix, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((f) => { out.push({ file: f, rel: prefix + entry.name }); resolve(); }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const kids = [];
      const read = () => reader.readEntries(async (es) => {
        if (!es.length) { for (const k of kids) await walkEntry(k, prefix + entry.name + '/', out); return resolve(); }
        kids.push(...es); read();
      }, () => resolve());
      read();
    } else resolve();
  });
}
// Upload externally-dropped files/folders into dest.
async function uploadDrop(captured, dest) {
  const { roots, files } = captured;
  const items = [];
  if (roots.length) { for (const r of roots) await walkEntry(r, '', items); }
  else for (const f of files) items.push({ file: f, rel: f.name });
  if (!items.length) return;
  toast(`Copying ${items.length} item${items.length === 1 ? '' : 's'}…`);
  let n = 0;
  for (const { file, rel } of items) {
    try {
      const r = await fetch('/api/upload?dir=' + encodeURIComponent(dest) + '&rel=' + encodeURIComponent(rel),
        { method: 'POST', body: file });
      if (r.ok) n++;
    } catch (_) { /* skip */ }
  }
  toast(`Added ${n} item${n === 1 ? '' : 's'}` + (dest !== state.cwd ? ` to ${basename(dest)}` : ''));
  await refresh();
}

function makeDropTarget(node, getDest) {
  node.addEventListener('dragover', (ev) => {
    if (dragHasFiles(ev.dataTransfer)) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
      node.classList.add('droptarget');
      return;
    }
    if (!dragPaths) return;
    const dest = getDest();
    if (dragPaths.includes(dest)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = ev.altKey ? 'copy' : 'move';
    node.classList.add('droptarget');
  });
  node.addEventListener('dragleave', () => node.classList.remove('droptarget'));
  node.addEventListener('drop', async (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    node.classList.remove('droptarget');
    const dest = getDest();
    // External files dragged in -> upload into this folder.
    if (dragHasFiles(ev.dataTransfer)) { await uploadDrop(captureDropItems(ev.dataTransfer), dest); return; }
    if (!dragPaths || dragPaths.includes(dest)) return;
    const paths = dragPaths; dragPaths = null;
    try {
      if (ev.altKey) await API.copy(paths, dest);
      else await API.move(paths, dest);
      toast(`${ev.altKey ? 'Copied' : 'Moved'} ${paths.length} item${paths.length === 1 ? '' : 's'}`);
      await refresh();
    } catch (err) { toast('Failed: ' + err.message); }
  });
}

// Drops on empty space / non-folder targets land in the current folder, and
// this stops the browser from navigating to (opening) a dropped file anywhere.
document.addEventListener('dragover', (ev) => {
  if (dragHasFiles(ev.dataTransfer)) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; }
});
document.addEventListener('drop', (ev) => {
  if (!dragHasFiles(ev.dataTransfer)) return;
  ev.preventDefault();
  uploadDrop(captureDropItems(ev.dataTransfer), state.cwd);
});

// ----------------------------------------------------- Marquee selection ----
function attachMarquee(grid, list) {
  grid.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0 || ev.target.closest('.icon-item')) return;
    const main = $('main');
    const startX = ev.pageX, startY = ev.pageY;
    const box = el('div', 'marquee');
    main.appendChild(box);
    const rects = [...grid.querySelectorAll('.icon-item')].map((n) => ({ n, r: n.getBoundingClientRect() }));
    const onMove = (m) => {
      const x = Math.min(startX, m.pageX), y = Math.min(startY, m.pageY);
      const w = Math.abs(m.pageX - startX), h = Math.abs(m.pageY - startY);
      const mr = $('main').getBoundingClientRect();
      box.style.left = (x - mr.left + $('main').scrollLeft) + 'px';
      box.style.top = (y - mr.top + $('main').scrollTop) + 'px';
      box.style.width = w + 'px'; box.style.height = h + 'px';
      const sel = new Set();
      for (const { n, r } of rects) {
        if (r.left < x + w && r.right > x && r.top < y + h && r.bottom > y) sel.add(n.dataset.path);
      }
      state.selection = sel;
      rects.forEach(({ n }) => n.classList.toggle('selected', sel.has(n.dataset.path)));
      updateStatus();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      box.remove();
    };
    if (!ev.metaKey && !ev.shiftKey) {
      state.selection.clear();
      grid.querySelectorAll('.icon-item.selected').forEach((n) => n.classList.remove('selected'));
      updateStatus();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ----------------------------------------------------------- Quick Look ----
let quickLook = null; // { list, index } when open

function orderedForView() {
  if (state.view === 'column') {
    const last = state.columns[state.columns.length - 1];
    return last ? colVisible(last.entries) : [];
  }
  if (state.view === 'list') return listRows().map((r) => r.e);
  return visibleEntries();
}

function openQuickLook() {
  const sel = selectedEntries();
  if (!sel.length) return;
  const list = orderedForView();
  let idx = list.findIndex((e) => e.path === sel[0].path);
  quickLook = idx < 0 ? { list: [sel[0]], index: 0 } : { list, index: idx };
  renderQuickLook();
}
function closeQuickLook() {
  quickLook = null;
  const bd = document.querySelector('.ql-backdrop');
  if (bd) bd.remove();
  $('main').focus();
}
function qlStep(d) {
  if (!quickLook) return;
  const n = quickLook.list.length;
  quickLook.index = (quickLook.index + d + n) % n;
  renderQuickLook();
}

function renderQuickLook() {
  if (!quickLook) return;
  document.querySelector('.ql-backdrop')?.remove();
  const e = quickLook.list[quickLook.index];
  const backdrop = el('div', 'ql-backdrop');
  const panel = el('div', 'ql-panel');

  const bar = el('div', 'ql-titlebar');
  const close = el('button', 'ql-close', '&times;');
  close.onclick = closeQuickLook;
  const title = el('span', 'ql-title', escapeHTML(e.name));
  const openBtn = el('button', 'ql-openbtn', e.isDir && e.kind !== 'app' ? 'Open Folder' : 'Open');
  openBtn.onclick = () => { closeQuickLook(); openEntry(e); };
  bar.append(close, title, openBtn);

  const body = el('div', 'ql-body');
  fillQuickLookBody(body, e);
  panel.append(bar, body);

  if (quickLook.list.length > 1) {
    const prev = el('button', 'ql-nav prev', '‹'); prev.onclick = () => qlStep(-1);
    const next = el('button', 'ql-nav next', '›'); next.onclick = () => qlStep(1);
    backdrop.append(prev, next);
  }
  backdrop.appendChild(panel);
  backdrop.onclick = (ev) => { if (ev.target === backdrop) closeQuickLook(); };
  panel.onclick = (ev) => ev.stopPropagation();
  document.body.appendChild(backdrop);
}

function fillQuickLookBody(body, e) {
  const url = fileURL(e.path);
  if (e.isDir && e.kind !== 'app') { qlInfoCard(body, e); return; }
  switch (e.kind) {
    case 'image':
      body.classList.add('media');
      body.innerHTML = `<img class="ql-img" src="${url}" alt="">`;
      return;
    case 'video':
      body.classList.add('media');
      body.innerHTML = `<video controls autoplay playsinline src="${url}"></video>`;
      return;
    case 'audio': {
      const card = el('div', 'ql-audio');
      card.innerHTML = `${Icons.iconFor('audio')}<audio controls autoplay src="${url}"></audio>`;
      body.appendChild(card);
      return;
    }
    case 'pdf':
      body.classList.add('doc');
      body.innerHTML = `<iframe src="${url}#toolbar=1" title="preview"></iframe>`;
      return;
    case 'text': case 'code':
      qlTextPreview(body, e, url);
      return;
    default:
      qlInfoCard(body, e);
  }
}

function qlTextPreview(body, e, url) {
  body.classList.add('doc');
  if (e.size > 2_000_000) { qlInfoCard(body, e, 'File is too large to preview'); return; }
  const pre = el('pre', 'ql-text', 'Loading…');
  body.appendChild(pre);
  fetch(url).then((r) => r.text()).then((t) => {
    pre.textContent = t.length > 400_000 ? t.slice(0, 400_000) + '\n\n… (truncated)' : t;
  }).catch(() => { pre.textContent = 'Could not read file.'; });
}

function qlInfoCard(body, e, note) {
  const icon = isImage(e) ? `<img src="${fileURL(e.path)}" alt="">` : Icons.iconFor(e.kind);
  body.innerHTML =
    `<div class="ql-info">
      ${icon}
      <div class="nm">${escapeHTML(e.name)}</div>
      ${note ? `<div class="meta">${escapeHTML(note)}</div>` : ''}
      <div class="meta">
        <div>${kindName(e)}</div>
        <div>${formatSize(e.size, e.isDir)}</div>
        <div>Modified ${formatDate(e.mtime)}</div>
      </div>
    </div>`;
}

// --------------------------------------------------------- Context menu ----
function showContextMenu(ev, entry) {
  ev.preventDefault();
  const menu = $('contextmenu');
  const sel = selectedEntries();
  const n = sel.length;
  const items = [];
  if (entry) {
    items.push({ label: n > 1 ? `Open ${n} Items` : 'Open', sc: '⌘O', act: () => sel.forEach(openEntry) });
    items.push({ label: `Quick Look "${entry.name.length > 22 ? entry.name.slice(0, 21) + '…' : entry.name}"`, sc: '␣', act: openQuickLook });
    items.push({ label: 'Reveal in Finder', act: () => API.reveal(entry.path) });
    items.push({ sep: true });
    items.push({ label: 'Rename', sc: '⏎', disabled: n !== 1, act: () => beginRename(sel[0]) });
    items.push({ label: 'Duplicate', sc: '⌘D', act: doDuplicate });
    items.push({ label: 'Copy', sc: '⌘C', act: () => copyToClipboard('copy') });
    items.push({ label: n > 1 ? 'Copy Paths to Clipboard' : 'Copy Path to Clipboard', sc: '⌥⌘C', act: () => copyPathToClipboard(sel.map((e) => e.path)) });
    items.push({ sep: true });
    items.push({ label: n > 1 ? `Move ${n} Items to Trash` : 'Move to Trash', sc: '⌘⌫', act: doTrash });
  } else {
    items.push({ label: 'New Folder', sc: '⇧⌘N', act: doNewFolder });
    if (state.clipboard) items.push({ label: `Paste Item${state.clipboard.paths.length === 1 ? '' : 's'}`, sc: '⌘V', act: doPaste });
    items.push({ label: 'Copy Path to Clipboard', sc: '⌥⌘C', act: () => copyPathToClipboard([state.cwd]) });
    items.push({ sep: true });
    items.push({ label: 'Show View Options', disabled: true });
    items.push({ label: state.showHidden ? 'Hide Hidden Files' : 'Show Hidden Files', sc: '⇧⌘.', act: toggleHidden });
  }
  menu.innerHTML = '';
  menu.dataset.kind = 'context';
  for (const it of items) {
    if (it.sep) { menu.appendChild(el('div', 'sep')); continue; }
    const m = el('div', 'mi' + (it.disabled ? ' disabled' : ''));
    m.innerHTML = `<span>${it.label}</span>${it.sc ? `<span class="sc">${it.sc}</span>` : ''}`;
    if (!it.disabled) m.onclick = () => { hideContextMenu(); it.act(); };
    menu.appendChild(m);
  }
  menu.hidden = false;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(ev.clientX, window.innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(ev.clientY, window.innerHeight - mh - 8) + 'px';
}
function hideContextMenu() { $('contextmenu').hidden = true; }

// Enclosing-folders dropdown: current folder at top, then each parent down to
// the root (like Cmd-clicking the window title in Finder).
function showPathMenu() {
  const menu = $('contextmenu');
  if (!menu.hidden && menu.dataset.kind === 'path') { hideContextMenu(); return; } // toggle
  const chain = [];
  let p = state.cwd;
  while (true) {
    chain.push(p);
    if (p === '/') break;
    const par = parentPath(p);
    if (par === p) break;
    p = par;
  }
  menu.innerHTML = '';
  menu.dataset.kind = 'path';
  for (const path of chain) {
    const m = el('div', 'mi mi-path' + (path === state.cwd ? ' current' : ''));
    const rootIcon = state.home === '/' ? 'home' : 'computer';
    const icon = Icons.sidebarIcon(path === '/' ? rootIcon : 'folder');
    m.innerHTML = `<span class="mi-ico">${icon}</span><span>${escapeHTML(basename(path))}</span>`;
    m.onclick = () => { hideContextMenu(); if (path !== state.cwd) navigate(path); };
    menu.appendChild(m);
  }
  menu.hidden = false;
  const r = $('pathBtn').getBoundingClientRect();
  const mw = menu.offsetWidth;
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8)) + 'px';
  menu.style.top = (r.bottom + 4) + 'px';
}

// Sort-by dropdown (the toolbar "arrange" button).
function showArrangeMenu() {
  const menu = $('contextmenu');
  if (!menu.hidden && menu.dataset.kind === 'arrange') { hideContextMenu(); return; }
  menu.innerHTML = ''; menu.dataset.kind = 'arrange';
  menu.appendChild(el('div', 'menu-hdr', 'Sort By'));
  for (const [key, label] of [['name', 'Name'], ['date', 'Date Modified'], ['created', 'Date Created'], ['size', 'Size'], ['kind', 'Kind']]) {
    const active = state.sort.key === key;
    const m = el('div', 'mi');
    m.innerHTML = `<span>${active ? '✓ ' : '  '}${label}</span><span class="sc">${active ? (state.sort.dir > 0 ? '▲' : '▼') : ''}</span>`;
    m.onclick = () => {
      hideContextMenu();
      if (state.sort.key === key) state.sort.dir *= -1; else state.sort = { key, dir: 1 };
      renderMain();
    };
    menu.appendChild(m);
  }
  menu.hidden = false;
  const r = $('arrangeBtn').getBoundingClientRect();
  const mw = menu.offsetWidth;
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8)) + 'px';
  menu.style.top = (r.bottom + 4) + 'px';
}

// Enable/disable toolbar buttons based on selection.
function updateToolbar() {
  const tb = $('trashBtn');
  if (tb) tb.disabled = selectedEntries().length === 0;
}

// ------------------------------------------------------------- Actions ----
async function refresh() {
  const keep = [...state.selection];
  const data = await API.list(state.cwd);
  state.entries = data.entries;
  state.selection = new Set(keep.filter((p) => data.entries.some((e) => e.path === p)));
  if (state.expanded.size) await reloadExpanded();
  if (state.view === 'column') {
    // reload columns from root chain
    await reloadColumns();
  }
  renderMain(); updateStatus();
}
async function reloadColumns() {
  const paths = state.columns.map((c) => c.path);
  const selecteds = state.columns.map((c) => c.selected);
  state.columns = [];
  for (let i = 0; i < paths.length; i++) {
    try {
      const col = await loadColumn(paths[i]);
      col.selected = selecteds[i];
      state.columns.push(col);
    } catch (_) { break; }
  }
}

async function doNewFolder() {
  try {
    const r = await API.mkdir(state.cwd, 'untitled folder');
    await refresh();
    setSelection([r.path]);
    renderMain();
    setTimeout(() => beginRename({ path: r.path, name: basename(r.path) }), 30);
  } catch (e) { toast('New Folder failed: ' + e.message); }
}
async function doTrash() {
  const sel = selectedEntries();
  if (!sel.length) return;
  try {
    await API.trash(sel.map((e) => e.path));
    toast(`Moved ${sel.length} item${sel.length === 1 ? '' : 's'} to Trash`);
    state.selection.clear();
    await refresh();
  } catch (e) { toast('Trash failed: ' + e.message); }
}
async function doDuplicate() {
  const sel = selectedEntries();
  if (!sel.length) return;
  try {
    const r = await API.duplicate(sel.map((e) => e.path));
    await refresh();
    setSelection(r.paths);
    renderMain();
  } catch (e) { toast('Duplicate failed: ' + e.message); }
}
function copyToClipboard(mode) {
  const sel = selectedEntries();
  if (!sel.length) return;
  state.clipboard = { paths: sel.map((e) => e.path), mode };
  toast(`Copied ${sel.length} item${sel.length === 1 ? '' : 's'}`);
}
// Backslash-escape characters that are special to POSIX shells (zsh/bash) so
// the copied path can be pasted straight into a terminal, e.g. a path with
// spaces becomes  /Users/mark/Shared\ drives  rather than breaking `cd`.
function shellEscapePath(p) {
  return p.replace(/[ \t"'`$&|;<>()*?#~!\\\[\]{}]/g, '\\$&');
}
async function copyPathToClipboard(paths) {
  if (!paths || !paths.length) return;
  const text = paths.map(shellEscapePath).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast(paths.length === 1 ? 'Copied path to clipboard' : `Copied ${paths.length} paths to clipboard`);
  } catch (e) {
    toast('Copy path failed: ' + e.message);
  }
}
async function doPaste() {
  if (!state.clipboard) return;
  try {
    const r = await API.copy(state.clipboard.paths, state.cwd);
    await refresh();
    setSelection(r.paths); renderMain();
  } catch (e) { toast('Paste failed: ' + e.message); }
}
function toggleHidden() { state.showHidden = !state.showHidden; if (state.view === 'column') reloadColumns().then(renderMain); renderMain(); updateStatus(); }
function setView(v) {
  state.view = v;
  if (v === 'column') initColumns();
  render();
  $('main').focus();
}

// ----------------------------------------------------------- Keyboard ----
function orderedVisible() {
  if (state.view === 'column') return [];
  if (state.view === 'list') return listRows().map((r) => r.e);
  return visibleEntries();
}
function moveSelection(delta, cols) {
  const list = orderedVisible();
  if (!list.length) return;
  let idx = list.findIndex((e) => state.selection.has(e.path));
  if (idx < 0) idx = delta > 0 ? -1 : 0;
  let ni = idx + delta * (cols || 1);
  ni = Math.max(0, Math.min(list.length - 1, ni));
  const e = list[ni];
  setSelection([e.path]); state.anchor = e.path;
  renderMain(); updateStatus();
  const node = document.querySelector(`.icon-item[data-path="${cssEscape(e.path)}"],.list-row[data-path="${cssEscape(e.path)}"]`);
  if (node) node.scrollIntoView({ block: 'nearest' });
}
// List view: Right expands a collapsed folder (or steps into an expanded one);
// Left collapses an expanded folder, else selects the parent of a nested row.
function listExpandKey() {
  const sel = selectedEntries();
  if (sel.length !== 1) return;
  const e = sel[0];
  if (isExpandable(e) && !state.expanded.has(e.path)) toggleExpand(e);
  else if (isExpandable(e) && state.expanded.has(e.path)) moveSelection(1);
}
function listCollapseKey() {
  const sel = selectedEntries();
  if (sel.length !== 1) return;
  const e = sel[0];
  if (isExpandable(e) && state.expanded.has(e.path)) { toggleExpand(e); return; }
  const parent = parentPath(e.path);
  if (parent !== state.cwd && state.expanded.has(parent)) {
    setSelection([parent]); state.anchor = parent;
    renderMain(); updateStatus();
    const node = document.querySelector(`.list-row[data-path="${cssEscape(parent)}"]`);
    if (node) node.scrollIntoView({ block: 'nearest' });
  }
}
function iconCols() {
  const items = document.querySelectorAll('.icon-item');
  if (items.length < 2) return 1;
  const top = items[0].offsetTop; let c = 0;
  for (const it of items) { if (it.offsetTop === top) c++; else break; }
  return Math.max(1, c);
}

// Select first/last item (Home/End) in icon/list/gallery views.
function selectEdge(which) {
  const list = orderedVisible();
  if (!list.length) return;
  const e = which === 'first' ? list[0] : list[list.length - 1];
  setSelection([e.path]); state.anchor = e.path;
  renderMain(); updateStatus();
  const node = document.querySelector(`[data-path="${cssEscape(e.path)}"]`);
  if (node) node.scrollIntoView({ block: 'nearest' });
}

// ---- Column-view arrow navigation ----
function activeColIndex() {
  for (let i = state.columns.length - 1; i >= 0; i--) if (state.columns[i].selected) return i;
  return Math.max(0, state.columns.length - 1);
}
function colNav(dir) {
  if (!state.columns.length) return;
  const ai = activeColIndex();
  const col = state.columns[ai];
  const items = colVisible(col.entries);
  if (dir === 'down' || dir === 'up') {
    if (!items.length) return;
    let idx = items.findIndex((e) => e.path === col.selected);
    if (idx < 0) idx = dir === 'down' ? -1 : 0;
    idx = Math.max(0, Math.min(items.length - 1, idx + (dir === 'down' ? 1 : -1)));
    selectColumn(ai, items[idx]);
  } else if (dir === 'right') {
    const cur = items.find((e) => e.path === col.selected) || items[0];
    if (!cur) return;
    if (cur.isDir && cur.kind !== 'app') {
      const child = state.columns[ai + 1];
      const kids = child ? colVisible(child.entries) : [];
      if (kids.length) selectColumn(ai + 1, kids[0]);
    } else openEntry(cur);
  } else if (dir === 'left') {
    if (ai > 0) {
      const parent = state.columns[ai - 1];
      const pItem = colVisible(parent.entries).find((e) => e.path === parent.selected);
      if (pItem) selectColumn(ai - 1, pItem);
    }
  }
}

// Type-ahead find: type a name to jump to the first matching item.
let typeBuf = '';
let typeTimer = null;
function typeAhead(ch) {
  clearTimeout(typeTimer);
  typeBuf += ch.toLowerCase();
  typeTimer = setTimeout(() => { typeBuf = ''; }, 800);
  if (state.view === 'column') {
    const ai = activeColIndex();
    const col = state.columns[ai];
    if (!col) return;
    const pick = colVisible(col.entries).find((e) => e.name.toLowerCase().startsWith(typeBuf));
    if (pick) selectColumn(ai, pick);
    return;
  }
  const pick = visibleEntries().find((e) => e.name.toLowerCase().startsWith(typeBuf));
  if (pick) {
    setSelection([pick.path]); state.anchor = pick.path;
    renderMain(); updateStatus();
    const node = document.querySelector(`[data-path="${cssEscape(pick.path)}"]`);
    if (node) node.scrollIntoView({ block: 'nearest' });
  }
}

document.addEventListener('keydown', (ev) => {
  if (ev.target.tagName === 'INPUT') return;
  const meta = ev.metaKey || ev.ctrlKey;
  const k = ev.key;
  // Quick Look intercepts keys while open.
  if (quickLook) {
    if (k === ' ' || k === 'Escape') { ev.preventDefault(); closeQuickLook(); }
    else if (k === 'ArrowRight' || k === 'ArrowDown') { ev.preventDefault(); qlStep(1); }
    else if (k === 'ArrowLeft' || k === 'ArrowUp') { ev.preventDefault(); qlStep(-1); }
    else if (k === 'Enter') { ev.preventDefault(); const e = quickLook.list[quickLook.index]; closeQuickLook(); openEntry(e); }
    return;
  }
  if (k === ' ') { ev.preventDefault(); openQuickLook(); return; }
  if (meta && k.toLowerCase() === 'a') { ev.preventDefault(); const all = state.view === 'list' ? orderedVisible() : visibleEntries(); setSelection(all.map((e) => e.path)); renderMain(); updateStatus(); return; }
  if (meta && k === 'ArrowUp') { ev.preventDefault(); goUp(); return; }
  if (meta && k === 'ArrowDown') { ev.preventDefault(); selectedEntries().forEach(openEntry); return; }
  if (meta && k === '[') { ev.preventDefault(); goBack(); return; }
  if (meta && k === ']') { ev.preventDefault(); goForward(); return; }
  if (meta && k.toLowerCase() === 'n' && ev.shiftKey) { ev.preventDefault(); doNewFolder(); return; }
  if (meta && k.toLowerCase() === 'd') { ev.preventDefault(); doDuplicate(); return; }
  if (meta && ev.altKey && ev.code === 'KeyC') { ev.preventDefault(); const s = selectedEntries(); copyPathToClipboard(s.length ? s.map((e) => e.path) : [state.cwd]); return; }
  if (meta && k.toLowerCase() === 'c') { ev.preventDefault(); copyToClipboard('copy'); return; }
  if (meta && k.toLowerCase() === 'v') { ev.preventDefault(); doPaste(); return; }
  if (meta && k.toLowerCase() === 'o') { ev.preventDefault(); selectedEntries().forEach(openEntry); return; }
  if (meta && k === '.') { ev.preventDefault(); toggleHidden(); return; }
  if ((k === 'Backspace' || k === 'Delete') && (meta || k === 'Delete')) { ev.preventDefault(); doTrash(); return; }
  if (k === 'Enter') { ev.preventDefault(); const s = selectedEntries(); if (s.length === 1) beginRename(s[0]); return; }
  if (k === 'Escape') { hideContextMenu(); state.selection.clear(); renderMain(); updateStatus(); return; }
  // arrow navigation
  if (state.view === 'icon') {
    if (k === 'ArrowRight') { ev.preventDefault(); moveSelection(1); }
    else if (k === 'ArrowLeft') { ev.preventDefault(); moveSelection(-1); }
    else if (k === 'ArrowDown') { ev.preventDefault(); moveSelection(1, iconCols()); }
    else if (k === 'ArrowUp') { ev.preventDefault(); moveSelection(-1, iconCols()); }
  } else if (state.view === 'list') {
    if (k === 'ArrowDown') { ev.preventDefault(); moveSelection(1); }
    else if (k === 'ArrowUp') { ev.preventDefault(); moveSelection(-1); }
    else if (k === 'ArrowRight') { ev.preventDefault(); listExpandKey(); }
    else if (k === 'ArrowLeft') { ev.preventDefault(); listCollapseKey(); }
  } else if (state.view === 'gallery') {
    if (k === 'ArrowRight' || k === 'ArrowDown') { ev.preventDefault(); moveSelection(1); }
    else if (k === 'ArrowLeft' || k === 'ArrowUp') { ev.preventDefault(); moveSelection(-1); }
  } else if (state.view === 'column') {
    if (k === 'ArrowDown') { ev.preventDefault(); colNav('down'); }
    else if (k === 'ArrowUp') { ev.preventDefault(); colNav('up'); }
    else if (k === 'ArrowRight') { ev.preventDefault(); colNav('right'); }
    else if (k === 'ArrowLeft') { ev.preventDefault(); colNav('left'); }
  }
  // Home / End jump to first / last (non-column views).
  if (state.view !== 'column' && (k === 'Home' || k === 'End')) {
    ev.preventDefault(); selectEdge(k === 'Home' ? 'first' : 'last'); return;
  }
  // Type-ahead find: a bare printable character jumps to a matching name.
  if (!meta && !ev.altKey && k.length === 1 && k !== ' ') { ev.preventDefault(); typeAhead(k); }
});

// type-to-search-ish: clicking empty clears selection + hides menu
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('.contextmenu')) hideContextMenu();
});
$('main').addEventListener('click', (ev) => {
  if (ev.target.closest('.icon-item,.list-row,.col-row,.gl-thumb')) return;
  state.selection.clear(); state.anchor = null;
  if (state.view !== 'column') renderMain();
  updateStatus();
});
$('main').addEventListener('contextmenu', (ev) => {
  if (ev.target.closest('.icon-item,.list-row,.col-row,.gl-thumb')) return;
  state.selection.clear(); renderMain();
  showContextMenu(ev, null);
});

// ----------------------------------------------------------- Toolbar ----
$('backBtn').onclick = goBack;
$('fwdBtn').onclick = goForward;
$('newFolderBtn').onclick = doNewFolder;
$('pathBtn').onclick = (ev) => { ev.stopPropagation(); showPathMenu(); };
$('trashBtn').onclick = doTrash;
$('arrangeBtn').onclick = (ev) => { ev.stopPropagation(); showArrangeMenu(); };
$('sidebarToggle').onclick = () => {
  const hidden = document.querySelector('.body').classList.toggle('no-sidebar');
  $('sidebarToggle').title = hidden ? 'Show Sidebar' : 'Hide Sidebar';
};
document.querySelectorAll('#viewSwitch button').forEach((b) => b.onclick = () => setView(b.dataset.view));
$('searchInput').addEventListener('input', (e) => { state.search = e.target.value; renderMain(); updateStatus(); });
$('searchInput').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; state.search = ''; renderMain(); e.target.blur(); } });

// ------------------------------------------------------------- Boot ----
(async function boot() {
  try {
    const info = await API.info();
    state.rootName = info.rootName || 'Home';
    state.home = info.homePath || '/';
    state.favourites = info.favourites || [];
    state.locations = info.locations || [];
    state._start = info.homePath || '/';
  } catch (e) { /* offline */ }
  // A path in the URL hash (e.g. from a reload or shared link) wins over home.
  await navigate(hashToPath() || state._start || '/', true);
  $('main').focus();
})();

// Browser back/forward changes the hash directly; honour it unless we set it ourselves.
window.addEventListener('hashchange', () => {
  if (suppressHashChange) { suppressHashChange = false; return; }
  const p = hashToPath();
  if (p && p !== state.cwd) navigate(p, true);
});
