const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const dialog = window.__TAURI__.dialog;
const opener = window.__TAURI__.opener;

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

function ls(k, def = null) {
  try { return localStorage.getItem(k) ?? def; } catch { return def; }
}
function lsSet(k, v) {
  try { localStorage.setItem(k, v); } catch {}
}

// ---------- i18n ----------

const LANG = ls('lang') || (navigator.language.startsWith('ru') ? 'ru' : 'en');
const L = STRINGS[LANG];
function t(k, ...a) {
  const v = L[k] ?? STRINGS.ru[k] ?? k;
  return typeof v === 'function' ? v(...a) : v;
}
const IS_MAC = /Mac/.test(navigator.userAgent);
document.documentElement.lang = LANG;
document.documentElement.classList.toggle('mac', IS_MAC);
const revealLabel = () => (IS_MAC ? t('reveal') : LANG === 'ru' ? 'Показать в папке' : 'Show in folder');

const shots = n => t('shots', n), files = n => t('files', n);
function gb(b) {
  const [kb, mb, g] = L.units;
  if (b >= 1e9) return (b / 1e9).toFixed(1).replace('.', L.decimal) + ' ' + g;
  if (b >= 1e6) return Math.round(b / 1e6) + ' ' + mb;
  return Math.round(b / 1e3) + ' ' + kb;
}
const fmtN = n => n.toLocaleString(LANG);

// Review folders: "<prefix> (<kind>)", named in the current language; both languages are recognised.
const KINDS = { dupes: ['дубли', 'duplicates'], blurry: ['смазанные', 'blurry'], rejects: ['отсев', 'rejects'] };
const folderFor = k => (LANG === 'ru' ? `_на проверку (${KINDS[k][0]})` : `_review (${KINDS[k][1]})`);
function kindLabel(raw) {
  const k = Object.keys(KINDS).find(k => KINDS[k].includes(raw.toLowerCase()));
  return k ? t('kind_' + k) : raw;
}

// ---------- icons ----------

const ICON = {
  gallery: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor"/>',
  star: '<path d="m12 3.5 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
  import: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  mindful: '<path d="M7 7h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"/><path d="M9 3h6"/><path d="m9.5 14 2 2 3.5-4"/>',
  dupes: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  blurry: '<circle cx="12" cy="12" r="3.2"/><path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/>',
  review: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>',
  stats: '<path d="M4 20V11"/><path d="M10 20V5"/><path d="M16 20v-6"/><path d="M21 20H3"/>',
  verify: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.1 7.5 9.5 4.3-1.4 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  card: '<path d="M7 3h8l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M10 7v3M13 7v3M16 8v2"/>',
  eject: '<path d="m12 5 7 8H5z"/><path d="M5 18h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
};
const icon = (n, s = 18) =>
  `<svg class="ic" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON[n]}</svg>`;

// ---------- state ----------

const state = {
  view: ls('onboarded') ? 'import' : 'welcome',
  lib: '',
  cards: [],
  card: null,          // selected card path
  cardInfo: {},        // path -> {total, free}
  plan: null,          // import plan for state.card
  report: null,        // last import report
  newFolders: null,    // folders touched by the last import
  verify: null,
  recs: null,          // analysis records for the library
  scope: { dupes: '*', blurry: '*', stats: '*' },
  dupes: { groups: [], i: 0, keep: {} },
  blurry: { items: [], i: 0, dec: new Map(), kept: new Set() },
  mindful: null,
  review: { items: null, dir: null, folder: '*', sel: new Set() },
  videos: null,        // videos in the library
  stars: new Set(),    // favourite shots, library-relative paths
  gallery: { scope: '*', filter: 'all', open: null },
  busy: false,
};

// ---------- thumbs ----------

const thumbs = new Map();
function thumb(path, size = 1400) {
  const k = path + '|' + size;
  if (!thumbs.has(k)) thumbs.set(k, invoke('thumb', { path, size }).then(convertFileSrc).catch(() => ''));
  return thumbs.get(k);
}
function setThumb(img, size) {
  thumb(img.dataset.path, size).then(src => { if (src && !img.dataset.full) img.src = src; });
}
function fillThumbs(root, size) {
  root.querySelectorAll('img[data-path]').forEach(img => setThumb(img, size));
}
function lazyThumbs(root, size, scrollRoot = $('#main')) {
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    io.unobserve(e.target);
    setThumb(e.target, size);
  }), { root: scrollRoot, rootMargin: '400px' });
  root.querySelectorAll('img[data-path]').forEach(img => io.observe(img));
}

// Full-size original for zooming; resolves with its natural width. Loaded originals are remembered
// per path, so re-renders (toggling keep in a burst) show them straight away.
// If the webview cannot open the original, a 4000 px preview from the backend stands in.
const fullCache = new Map();
function fullRes(img) {
  const path = img.dataset.path;
  if (img._full) return img._full;
  const show = f => {
    if (f && img.isConnected) { img.dataset.full = '1'; img.src = f.src; img.dataset.nw = f.nw; }
    return f?.nw || 0;
  };
  if (!fullCache.has(path)) {
    const load = src => new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res({ src, nw: im.naturalWidth });
      im.onerror = rej;
      im.src = src;
    });
    // RAW can't be shown by the webview: go straight to the camera's embedded preview at full size.
    const viaBackend = () => invoke('thumb', { path, size: 8000 }).then(convertFileSrc).then(load);
    fullCache.set(path, (isRaw(path) ? viaBackend() : load(convertFileSrc(path)).catch(viaBackend))
      .catch(() => { fullCache.delete(path); return null; }));
  }
  img._full = fullCache.get(path).then(show);
  return img._full;
}

// ---------- toast & errors ----------

let toastTimer;
function toast(html, ms = 6000) {
  const el = $('#toast');
  el.innerHTML = html;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
  return el;
}
const msg = e => String(e).replace(/@(\w+)/g, (_, k) => t(k));
function showError(e) {
  toast(`<span style="color:var(--bad)">${t('error')}:</span> ${esc(msg(e))}`, 9000);
}

// ---------- progress ----------

let progressTask = null;
function startProgress(task, text) {
  progressTask = task;
  $('#progress').hidden = false;
  $('#ptext').textContent = text;
  $('#pnum').textContent = '';
  $('.pbar').classList.add('indet');
}
function stopProgress() {
  progressTask = null;
  $('#progress').hidden = true;
}
const speed = { t0: 0, b0: 0 };
listen('progress', ({ payload: p }) => {
  if (!progressTask) return;
  $('#ptext').textContent = p.label.startsWith('@') ? t('p_' + p.label.slice(1)) : p.label;
  if (!p.total) return;
  $('.pbar').classList.remove('indet');
  $('#pfill').style.width = (100 * p.done / p.total).toFixed(1) + '%';
  if (p.task === 'analyze') {
    $('#pnum').textContent = t('of', fmtN(p.done), fmtN(p.total));
  } else {
    const now = performance.now();
    if (!speed.t0 || p.done < speed.b0) Object.assign(speed, { t0: now, b0: p.done });
    const mbs = (p.done - speed.b0) / 1e6 / Math.max(0.5, (now - speed.t0) / 1000);
    $('#pnum').textContent = t('of', gb(p.done), gb(p.total)) + (mbs > 1 ? ' · ' + t('mbs', Math.round(mbs)) : '');
  }
});

async function task(name, text, fn) {
  if (state.busy) return;
  state.busy = true;
  speed.t0 = 0;
  startProgress(name, text);
  render();
  try {
    return await fn();
  } catch (e) {
    showError(e);
  } finally {
    state.busy = false;
    stopProgress();
    render();
  }
}

// ---------- zoom ----------
// Scroll zooms around the cursor; while zoomed, the visible area follows the cursor.
// Boxes bound together (duplicates) share one zoom, so the same spot is compared in every shot.

const Z = { s: 1, u: 0.5, v: 0.5 };
function resetZoom() { Z.s = 1; zoomReq = 0; }

function bindZoom(boxes) {
  const imgOf = b => b.querySelector('img.zimg');
  const apply = () => boxes.forEach(b => {
    const img = imgOf(b);
    if (!img) return;
    img.style.transformOrigin = `${Z.u * 100}% ${Z.v * 100}%`;
    img.style.transform = Z.s > 1 ? `scale(${Z.s})` : '';
    b.classList.toggle('zoomed', Z.s > 1);
    if (Z.s > 1) {
      if (!img.dataset.full) b.classList.add('loading');
      fullRes(img).then(() => { b.classList.remove('loading'); badge(b); });
    }
    badge(b);
  });
  const badge = b => {
    const el = b.querySelector('.zbadge'), img = imgOf(b);
    if (!el || !img) return;
    const nw = +img.dataset.nw;
    el.textContent = Z.s > 1 ? (nw ? Math.round(100 * Z.s * img.offsetWidth / nw) + '%' : '×' + Z.s.toFixed(1)) : '';
  };
  const track = (b, e) => {
    const img = imgOf(b), r = b.getBoundingClientRect();
    if (!img?.offsetWidth) return;
    Z.u = clamp((e.clientX - r.left - img.offsetLeft) / img.offsetWidth, 0, 1);
    Z.v = clamp((e.clientY - r.top - img.offsetTop) / img.offsetHeight, 0, 1);
  };
  boxes.forEach(b => {
    b.addEventListener('wheel', e => {
      e.preventDefault();
      track(b, e);
      Z.s = clamp(Z.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.003)), 1, 12);
      if (Z.s < 1.03) Z.s = 1;
      apply();
    }, { passive: false });
    b.addEventListener('mousemove', e => { track(b, e); if (Z.s > 1) apply(); });
  });
  apply();
  return apply;
}
// Jump to 1:1 pixels at (u, v), or back to fit. Zooms in at once and settles on the exact 1:1 scale
// when the original has loaded; a second click before that cancels it.
let zoomReq = 0;
async function zoom1to1(box, apply, u, v) {
  const img = box?.querySelector('img.zimg');
  if (!img) return;
  if (Z.s > 1 || zoomReq) { zoomReq = 0; Z.s = 1; return apply(); }
  const req = (zoomReq = performance.now());
  if (u != null) { Z.u = u; Z.v = v; }
  Z.s = 2;
  apply();
  const nw = await fullRes(img);
  if (zoomReq !== req) return;
  zoomReq = 0;
  Z.s = nw ? clamp(nw / img.offsetWidth, 2, 12) : 4;
  apply();
}

// ---------- cards ----------

async function pollCards() {
  try {
    const cards = await invoke('list_cards');
    const key = JSON.stringify(cards.map(c => c.path));
    if (key !== JSON.stringify(state.cards.map(c => c.path))) {
      state.cards = cards;
      if (!cards.some(c => c.path === state.card)) {
        state.card = cards[0]?.path ?? null;
        state.plan = null;
        state.verify = null;
      }
      if (['import', 'verify'].includes(state.view)) render();
      if (state.view === 'import' && state.card && !state.plan && !state.busy) scan();
    }
  } catch (_) {}
}

function cardInfo(card) {
  if (!card || card in state.cardInfo) return state.cardInfo[card];
  state.cardInfo[card] = null;
  invoke('card_info', { card }).then(i => {
    state.cardInfo[card] = i;
    if (['import', 'verify'].includes(state.view)) render();
  }).catch(() => {});
}

function cardBox() {
  const c = state.cards.find(c => c.path === state.card);
  if (!c) return '';
  const info = cardInfo(c.path);
  const used = info ? info.total - info.free : 0;
  return `<div class="cardbox">
    <div class="cb-ic">${icon('card', 26)}</div>
    <div class="grow"><b>${esc(c.name)}</b>
      <div class="mut small">${info ? t('card_used', gb(used), gb(info.total)) : esc(c.path)}</div>
      ${info ? `<div class="cap"><i style="width:${(100 * used / info.total).toFixed(1)}%"></i></div>` : ''}</div>
    ${state.cards.length > 1 ? `<div class="chips">${state.cards.map(x =>
      `<div class="chip ${x.path === state.card ? 'on' : ''}" data-card="${esc(x.path)}">${esc(x.name)}</div>`).join('')}</div>` : ''}
    <button class="btn" id="eject" ${state.busy ? 'disabled' : ''}>${icon('eject', 15)} ${t('eject')}</button>
  </div>`;
}
function bindCard(main, after) {
  main.querySelectorAll('[data-card]').forEach(el => el.onclick = () => {
    state.card = el.dataset.card;
    state.plan = null;
    state.verify = null;
    render();
    after?.();
  });
  $('#eject', main)?.addEventListener('click', async () => {
    const c = state.cards.find(c => c.path === state.card);
    try {
      await invoke('eject_card', { card: c.path });
      toast(t('ejected', esc(c.name)));
      pollCards();
    } catch (e) { showError(e); }
  });
}
const noCard = () => `<div class="empty"><div class="big">${icon('card', 54)}</div><h2>${t('no_card')}</h2>${t('no_card_sub')}</div>`;

// ---------- welcome ----------

function viewWelcome(main) {
  document.body.classList.add('welcome');
  main.innerHTML = `<div class="welcome-box">
    <div class="logo">${icon('sparkle', 34)}</div>
    <h1>Photo Sorter</h1>
    <p class="sub">${t('welcome_tag')}</p>
    <div class="panel"><h3>${t('welcome_lang')}</h3>
      <div class="seg">${['ru', 'en'].map(l => `<button data-lang="${l}" class="${l === LANG ? 'on' : ''}">${l === 'ru' ? 'Русский' : 'English'}</button>`).join('')}</div></div>
    <div class="panel"><h3>${t('welcome_lib')}</h3><div class="mut small" style="margin-bottom:10px">${t('welcome_lib_sub')}</div>
      <div class="pathrow">${icon('folder', 16)}<span>${esc(state.lib)}</span><button class="btn" id="pick">${t('change')}</button></div></div>
    <button class="btn primary big" id="start">${t('welcome_go')}</button>
  </div>`;
  bindLang(main);
  $('#pick', main).onclick = pickLibrary;
  $('#start', main).onclick = () => {
    lsSet('onboarded', '1');
    document.body.classList.remove('welcome');
    go('import');
  };
}
function bindLang(main) {
  main.querySelectorAll('[data-lang]').forEach(b => (b.onclick = () => {
    if (b.dataset.lang === LANG) return;
    lsSet('lang', b.dataset.lang);
    location.reload();
  }));
}
async function pickLibrary() {
  const dir = await dialog.open({ directory: true, defaultPath: state.lib });
  if (!dir) return;
  try {
    const s = await invoke('set_library', { library: dir });
    setLib(s.library);
    await loadStars();
    render();
  } catch (e) { showError(e); }
}

// ---------- import ----------

function scan() {
  const card = state.card;
  return task('scan', t('task_scan'), async () => {
    state.plan = await invoke('scan_import', { card, library: state.lib });
  });
}

function runImport() {
  const items = state.plan.items;
  return task('import', t('task_import'), async () => {
    const rep = await invoke('run_import', { items, library: state.lib });
    state.report = rep;
    state.newFolders = rep.folders;
    state.recs = null;
    state.videos = null;
    delete state.cardInfo[state.card];
    state.plan = await invoke('scan_import', { card: state.card, library: state.lib });
  }).then(() => {
    if (mindfulOn() && state.report?.photos.length) startMindful(state.report.photos);
  });
}

const isRaw = n => /\.(raf|fp2|dng|cr2|cr3|crw|nef|nrw|arw|srf|sr2|orf|rw2|rwl|raw|pef|x3f|3fr|fff|iiq|srw|mrw|kdc|dcr|erf|mef|mos|gpr)$/i.test(n);
const isViewable = n => /\.(jpe?g|hif|heic|heif)$/i.test(n);
function fmtDay(d) {
  const dt = new Date(d + 'T12:00:00');
  return isNaN(dt) ? d : dt.toLocaleDateString(LANG, { weekday: 'short', day: 'numeric', month: 'long' });
}

function viewImport(main) {
  const name = state.cards.find(c => c.path === state.card)?.name;
  let html = `<h1>${t('import_title')}</h1><p class="sub">${t('import_sub')}</p>`;
  if (!state.card) { main.innerHTML = html + noCard(); return; }
  html += cardBox();
  const p = state.plan;
  if (state.report) {
    const r = state.report;
    html += `<div class="panel ${r.failed.length ? 'badbox' : 'okbox'}">
      <h3>${r.failed.length ? t('rep_errors') : t('rep_done')}</h3>
      <div>${t('rep_line', files(r.copied), gb(r.bytes), r.skipped)}</div>
      ${r.failed.length ? `<div class="scroll small" style="margin-top:8px">${r.failed.map(f => esc(msg(f))).join('<br>')}</div>` : ''}
      <div class="row" style="margin-top:12px">
        ${r.photos.length ? `<button class="btn" id="goMindful">${t('go_mindful', shots(r.photos.length))}</button>` : ''}
        <button class="btn" id="goDupes">${t('go_dupes')}</button>
        <button class="btn" id="goVerify">${t('go_verify')}</button>
      </div></div>`;
  }
  if (!p) { main.innerHTML = html + `<div class="mut"><span class="spin"></span> ${t('reading', esc(name))}</div>`; bindImport(main); return; }

  html += `<div class="kpis">
    <div class="kpi"><b>${fmtN(p.total)}</b><span>${t('k_on_card', esc(name))}</span></div>
    <div class="kpi"><b>${fmtN(p.already)}</b><span>${t('k_already')}</span></div>
    <div class="kpi ${p.items.length ? 'accent' : 'good'}"><b>${fmtN(p.items.length)}</b><span>${t('k_new', gb(p.bytes))}</span></div>
  </div>`;
  if (p.items.length) {
    const byDay = {};
    // Preview strip: the day's JPEG/HEIF shots, or its RAWs when shot RAW-only.
    const raws = {};
    p.items.forEach(it => {
      if (it.kind === 'photo' && isViewable(it.name)) (byDay[it.dest_dir] ||= []).push(it);
      if (it.kind === 'raw') (raws[it.dest_dir.replace(/ RAW$/, '')] ||= []).push(it);
    });
    for (const [d, list] of Object.entries(raws)) if (!byDay[d]) byDay[d] = list;
    html += `<div class="days">${p.days.map(d => {
      const ph = byDay[d.folder] || [], show = ph.slice(0, 14);
      return `<div class="day">
        <div class="day-h"><b>${esc(d.folder)}</b><span class="mut">${fmtDay(d.date)}</span><span class="grow"></span>
          <span class="mut small">${t('day_counts', d.photos, d.raws, d.videos, d.others)} · ${gb(d.bytes)}</span></div>
        ${show.length ? `<div class="filmrow">${show.map(it => `<img data-path="${esc(it.src)}" alt="">`).join('')}
          ${ph.length > show.length ? `<span class="morebox">${t('more', ph.length - show.length)}</span>` : ''}</div>` : ''}
      </div>`;
    }).join('')}</div>
    <label class="mindful"><input type="checkbox" id="mindful" ${mindfulOn() ? 'checked' : ''}>
      <span><b>${t('mindful')}</b><br><span class="mut small">${t('mindful_sub')}</span></span></label>
    <div class="row"><button class="btn primary" id="doImport" ${state.busy ? 'disabled' : ''}>${t('do_import', files(p.items.length), gb(p.bytes))}</button>
    <button class="btn" id="rescan" ${state.busy ? 'disabled' : ''}>${t('rescan')}</button></div>`;
  } else if (!state.report) {
    html += `<div class="panel okbox"><h3>${t('all_in_lib')}</h3>
      <div class="row" style="margin-top:8px"><button class="btn" id="goVerify">${t('verify_sums')}</button></div></div>`;
  }
  main.innerHTML = html;
  lazyThumbs(main, 320);
  bindImport(main);
}
function bindImport(main) {
  bindCard(main, scan);
  $('#doImport', main)?.addEventListener('click', runImport);
  $('#mindful', main)?.addEventListener('change', e => setMindful(e.target.checked));
  $('#goMindful', main)?.addEventListener('click', () => {
    const M = state.mindful;
    M?.items.length && M.i < M.items.length ? go('mindful') : startMindful(state.report.photos);
  });
  $('#rescan', main)?.addEventListener('click', () => { state.plan = null; scan(); });
  $('#goVerify', main)?.addEventListener('click', () => go('verify'));
  $('#goDupes', main)?.addEventListener('click', () => { state.scope.dupes = 'new'; state.dupes.groups = []; go('dupes'); });
}

// ---------- verify ----------

function runVerify() {
  return task('verify', t('task_verify'), async () => {
    state.verify = await invoke('verify_card', { card: state.card, library: state.lib });
  });
}

function viewVerify(main) {
  let html = `<h1>${t('verify_title')}</h1><p class="sub">${t('verify_sub')}</p>`;
  if (!state.card) { main.innerHTML = html + noCard(); return; }
  html += cardBox();
  const v = state.verify;
  if (v) {
    if (!v.missing.length) {
      html += `<div class="panel okbox"><h3>${t('v_ok')}</h3>
        ${t('v_ok_line', files(v.card_files), gb(v.card_bytes))}
        ${v.only_in_review ? `<div class="panel warnbox" style="margin:12px 0 0">${t('v_review', files(v.only_in_review))}</div>` : ''}
      </div>`;
    } else {
      html += `<div class="panel badbox"><h3>${t('v_bad', files(v.missing.length))}</h3>
        <div class="scroll small">${v.missing.map(m => `${esc(m.path)} <span class="mut">${gb(m.size)}</span>`).join('<br>')}</div>
        <div class="row" style="margin-top:10px"><button class="btn" id="goImport">${t('go_import')}</button></div></div>`;
    }
    html += `<div class="mut small">${t('v_sums')} <button class="link" id="revealSums">${esc(v.checksum_file)}</button></div>`;
  }
  html += `<div class="row" style="margin-top:16px"><button class="btn ${v ? '' : 'primary'}" id="doVerify" ${state.busy ? 'disabled' : ''}>${v ? t('v_again') : t('v_run')}</button></div>`;
  main.innerHTML = html;
  bindCard(main);
  $('#doVerify', main)?.addEventListener('click', runVerify);
  $('#goImport', main)?.addEventListener('click', () => go('import'));
  $('#revealSums', main)?.addEventListener('click', () => opener.revealItemInDir(v.checksum_file));
}

// ---------- analysis ----------

function ensureRecs() {
  if (state.recs) return Promise.resolve();
  return task('analyze', t('task_analyze'), async () => {
    state.recs = await invoke('analyze', { library: state.lib });
  });
}

function folders() {
  return [...new Set((state.recs || []).map(r => r.folder))].sort((a, b) => a.localeCompare(b, LANG, { numeric: true }));
}
function scoped(scope) {
  const recs = state.recs || [];
  if (scope === '*') return recs;
  if (scope === 'new') return recs.filter(r => (state.newFolders || []).includes(r.folder));
  return recs.filter(r => r.folder === scope);
}
function scopeSelect(id, cur) {
  const opts = [['*', t('scope_all')]];
  if (state.newFolders?.length) opts.push(['new', t('scope_new')]);
  folders().forEach(f => opts.push([f, f]));
  return `<select id="${id}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}
function needAnalysis(main, title, sub) {
  main.innerHTML = `<h1>${title}</h1><p class="sub">${sub}</p>
    <div class="empty"><div class="big">${icon('blurry', 54)}</div><h2>${t('need_analysis')}</h2>
    <p>${t('need_analysis_sub')}</p>
    <button class="btn primary" id="doAnalyze" ${state.busy ? 'disabled' : ''}>${t('analyze')}</button></div>`;
  $('#doAnalyze', main).onclick = () => ensureRecs();
}

function hamming(a, b) {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b), c = 0;
  while (x) { c += Number(x & 1n); x >>= 1n; }
  return c;
}

function progressBar(i, n) {
  return `<div class="pbar thin"><i style="width:${(100 * Math.min(i, n) / Math.max(1, n)).toFixed(1)}%"></i></div>`;
}

// ---------- dupes ----------

function findBursts(recs) {
  const by = {};
  recs.forEach(r => (by[r.folder] ||= []).push(r));
  const groups = [];
  for (const list of Object.values(by)) {
    list.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || a.name.localeCompare(b.name));
    let g = [list[0]];
    const flush = () => { if (g.length > 1) groups.push(g); };
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      const close = a.ts != null && b.ts != null && b.ts - a.ts <= 15;
      if (close && hamming(a.dhash, b.dhash) <= 12) g.push(b);
      else { flush(); g = [b]; }
    }
    flush();
  }
  return groups.map(items => ({
    key: items.map(r => r.path).join('|'),
    folder: items[0].folder,
    items,
    best: items.reduce((m, r) => (r.sharp > m.sharp ? r : m)).path,
  }));
}

function dupesKeep(g) {
  return state.dupes.keep[g.key] ?? [g.best];
}
function dupesRejected() {
  return state.dupes.groups.flatMap(g => g.items.filter(r => !dupesKeep(g).includes(r.path)).map(r => r.path));
}

let dupesApply = null;
function viewDupes(main) {
  const title = t('dupes_title'), sub = t('dupes_sub');
  if (!state.recs) return needAnalysis(main, title, sub);
  const D = state.dupes;
  if (!D.groups.length || D.scope !== state.scope.dupes) {
    D.groups = findBursts(scoped(state.scope.dupes));
    D.scope = state.scope.dupes;
    D.i = 0;
    D.keep = {};
  }
  if (!D.groups.length) {
    main.innerHTML = `<h1>${title}</h1><div class="row" style="margin-bottom:20px">${scopeSelect('scope', state.scope.dupes)}</div>
      <div class="empty"><div class="big">${icon('check', 54)}</div><h2>${t('no_dupes')}</h2></div>`;
    $('#scope', main).onchange = e => { state.scope.dupes = e.target.value; render(); };
    return;
  }
  main.classList.add('fill');
  D.i = Math.min(D.i, D.groups.length - 1);
  const g = D.groups[D.i];
  const keep = dupesKeep(g);
  const rej = dupesRejected().length;
  main.innerHTML = `
    <div class="rv-head">
      ${scopeSelect('scope', state.scope.dupes)}
      <b>${t('series_n', D.i + 1, D.groups.length)}</b>
      <span class="mut">${esc(g.folder)} · ${shots(g.items.length)}</span>
      ${keep.length ? '' : `<span class="warn-txt">${t('all_out')}</span>`}
      <span class="grow"></span>
      <button class="btn" id="prev">←</button><button class="btn" id="next">→</button>
      <button class="btn primary" id="apply" ${rej && !state.busy ? '' : 'disabled'}>${t('move_n', shots(rej))}</button>
    </div>
    ${progressBar(D.i + 1, D.groups.length)}
    <div class="rv-stage">${g.items.map((r, j) => `
      <div class="shot zoom ${keep.includes(r.path) ? 'keep' : ''}" data-j="${j}">
        <img class="zimg" data-path="${esc(r.path)}" alt="">
        <span class="tag">${j + 1} ${keep.includes(r.path) ? t('keep_tag') : t('out_tag')}</span>
        <span class="zbadge"></span>
        <span class="fname">${esc(r.name)}</span>
      </div>`).join('')}</div>
    <div class="strip" id="strip">${D.groups.map((x, i) => {
      const edited = x.key in D.keep, none = !dupesKeep(x).length;
      return `<div class="sitem ${i === D.i ? 'cur' : ''} ${none ? 'none' : ''}" data-i="${i}">
        <img data-path="${esc(x.best)}" alt=""><span>${x.items.length}</span>${edited ? '<i></i>' : ''}</div>`;
    }).join('')}</div>
    <div class="rv-foot"><span><kbd>${t('h_click')}</kbd> ${t('h_or')} <kbd>1</kbd>–<kbd>9</kbd> ${t('h_toggle')}</span>
      <span><kbd>←</kbd> <kbd>→</kbd> <kbd>${t('h_space')}</kbd> ${t('h_page')}</span>
      <span><kbd>${t('h_wheel')}</kbd> ${t('h_zoom_sync')}</span><span><kbd>Z</kbd> ${t('h_hold')}</span></div>`;
  const stage = $('.rv-stage', main), strip = $('#strip', main);
  fillThumbs(stage, 1400);
  D.groups[D.i + 1]?.items.forEach(r => thumb(r.path, 1400));
  lazyThumbs(strip, 200, strip);
  strip.querySelector('.cur')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  strip.querySelectorAll('.sitem').forEach(el => (el.onclick = () => { D.i = +el.dataset.i; resetZoom(); render(); }));
  dupesApply = bindZoom([...stage.querySelectorAll('.zoom')]);
  $('#scope', main).onchange = e => { state.scope.dupes = e.target.value; render(); };
  $('#prev', main).onclick = () => stepDupes(-1);
  $('#next', main).onclick = () => stepDupes(1);
  $('#apply', main).onclick = () => applyMoves('dupes', dupesRejected());
  stage.querySelectorAll('.shot').forEach(el => {
    el.onclick = () => toggleDupe(+el.dataset.j);
    el.onmouseenter = () => (hoverPath = g.items[+el.dataset.j].path);
  });
}
function stepDupes(d) {
  const D = state.dupes;
  const i = clamp(D.i + d, 0, D.groups.length - 1);
  if (i === D.i) return;
  D.i = i;
  resetZoom();
  render();
}
function toggleDupe(j) {
  const g = state.dupes.groups[state.dupes.i];
  const r = g?.items[j];
  if (!r) return;
  const k = dupesKeep(g);
  state.dupes.keep[g.key] = k.includes(r.path) ? k.filter(p => p !== r.path) : [...k, r.path];
  render();
}

// ---------- blurry ----------

function findBlurry(recs) {
  if (recs.length < 10) return [];
  const all = (state.recs || []).map(r => r.sharp).sort((a, b) => a - b);
  const p15 = all[Math.floor(all.length * 0.15)];
  const med = {};
  const by = {};
  recs.forEach(r => (by[r.folder] ||= []).push(r.sharp));
  for (const [f, v] of Object.entries(by)) { v.sort((a, b) => a - b); med[f] = v[Math.floor(v.length / 2)]; }
  return recs
    .filter(r => r.sharp < p15 && r.sharp < 0.35 * med[r.folder])
    .sort((a, b) => a.sharp - b.sharp)
    .map(r => ({ ...r, rel: r.sharp / med[r.folder] }));
}

// Frames the user swiped right on stay hidden from later passes.
const keptKey = () => 'blurry-kept:' + state.lib;
function loadKept() {
  try { return new Set(JSON.parse(ls(keptKey(), '[]'))); } catch { return new Set(); }
}
function saveKept(set) {
  lsSet(keptKey(), JSON.stringify([...set]));
}

function viewBlurry(main) {
  const title = t('blurry_title'), sub = t('blurry_sub');
  if (!state.recs) return needAnalysis(main, title, sub);
  const B = state.blurry;
  if (B.scope !== state.scope.blurry || B.stale) {
    B.kept = loadKept();
    const found = findBlurry(scoped(state.scope.blurry));
    B.hidden = found.filter(r => B.kept.has(r.path)).length;
    B.items = found.filter(r => !B.kept.has(r.path));
    B.i = 0;
    B.dec = new Map();
    B.scope = state.scope.blurry;
    B.stale = false;
    B.loupe = true;
    B.outLabel = t('stamp_out');
    B.outHint = t('h_out');
  }
  const out = swipeOut(B).length, kept = B.dec.size - out;
  const head = `<div class="rv-head">${scopeSelect('scope', state.scope.blurry)}
      ${B.i < B.items.length ? `<b>${t('shot_n', B.i + 1, B.items.length)}</b>` : ''}
      ${tally(out, kept)}
      <span class="grow"></span>
      ${B.hidden ? `<button class="link small" id="reset">${t('show_kept', shots(B.hidden))}</button>` : ''}
      ${B.i < B.items.length && out ? `<button class="btn" id="apply">${t('apply_now', out)}</button>` : ''}</div>
      ${B.items.length ? progressBar(B.i, B.items.length) : ''}`;
  const bind = () => {
    $('#scope', main).onchange = e => { state.scope.blurry = e.target.value; render(); };
    $('#reset', main)?.addEventListener('click', () => { saveKept(new Set()); B.stale = true; render(); });
    $('#apply', main)?.addEventListener('click', applyBlurry);
  };

  if (!B.items.length) {
    main.innerHTML = `<h1>${title}</h1>${head}<div class="empty"><div class="big">${icon('check', 54)}</div><h2>${t('no_blurry')}</h2></div>`;
    return bind();
  }
  main.classList.add('fill');

  if (B.i >= B.items.length) {
    main.innerHTML = `${head}<div class="empty"><div class="big">🎉</div><h2>${t('all_seen')}</h2>
      <p>${out ? t('blurry_end', shots(out), shots(kept)) : t('nothing_out')}</p>
      <div class="row" style="justify-content:center;margin-top:16px">
        <button class="btn" id="back1">${t('back_last')}</button>
        <button class="btn primary" id="done" ${state.busy ? 'disabled' : ''}>${out ? t('move_n', shots(out)) : t('done')}</button>
      </div></div>`;
    bind();
    $('#back1', main).onclick = () => swipeBack(B);
    $('#done', main).onclick = applyBlurry;
    return;
  }

  main.innerHTML = head + swipeStage(B, r => t('sharpness', Math.round(r.rel * 100)));
  bind();
  swipeBind(main, B);
}
const tally = (out, kept) =>
  `<span class="mut tally"><span class="bad-txt">✕ ${out}</span> · <span class="ok-txt">✓ ${kept}</span></span>`;

// ---------- swipe (shared by blurry and mindful import) ----------

let swipeZoom = null;
function swipeStage(S, info) {
  const r = S.items[S.i], nx = S.items[S.i + 1];
  hoverPath = r.path;
  const loupe = S.loupe && r.sharp_u != null;
  return `<div class="tinder">
      ${nx ? `<div class="tcard under"><img data-path="${esc(nx.path)}" alt=""></div>` : ''}
      <div class="tcard zoom" id="tcard">
        <img class="zimg" data-path="${esc(r.path)}" alt="">
        <span class="stamp s-out">${S.outLabel}</span><span class="stamp s-keep">${S.keepLabel || t('stamp_keep')}</span>
        <div class="exif" id="exif" ${exifOn() ? '' : 'hidden'}></div>
        <span class="zbadge"></span>
        <span class="fname">${esc(r.folder)} · ${esc(r.name)}${info ? ' · ' + info(r) : ''}</span>
      </div>
      ${loupe ? `<div class="loupe" id="loupe" title="${t('loupe')}" hidden><img alt=""><span>${t('loupe')}</span></div>` : ''}
    </div>
    <div class="tbtns">
      <button class="round bad" id="no" title="${S.outHint} (←)">✕</button>
      <button class="round" id="undo1" title="${t('t_back')}" ${S.i ? '' : 'disabled'}>↶</button>
      <button class="round ok" id="yes" title="${S.keepHint || t('h_keep')} (→)">✓</button>
    </div>
    <div class="rv-foot" style="justify-content:center"><span><kbd>←</kbd> ${S.outHint}</span><span><kbd>→</kbd> ${S.keepHint || t('h_keep')}</span>
      <span><kbd>⌫</kbd> ${t('h_prev')}</span><span><kbd>${t('h_wheel')}</kbd> ${t('h_zoom')}</span>
      <span><kbd>${t('h_click')}</kbd> / <kbd>${t('h_space')}</kbd> ${t('h_1to1')}</span><span><kbd>I</kbd> ${t('h_info')}</span><span>${t('h_drag')}</span></div>`;
}
function swipeBind(main, S) {
  const r = S.items[S.i], card = $('#tcard', main);
  fillThumbs(main, 1400);
  S.items.slice(S.i + 2, S.i + 5).forEach(x => thumb(x.path, 1400));
  $('#no', main).onclick = () => swipeDecide(S, 'out');
  $('#yes', main).onclick = () => swipeDecide(S, 'keep');
  $('#undo1', main).onclick = () => swipeBack(S);
  dragCard(card, S);
  const apply = bindZoom([card]);
  swipeZoom = { card, apply };
  fillExif(r);
  const lp = $('#loupe', main);
  if (lp) {
    const img = lp.querySelector('img'), im = new Image();
    let src;
    im.onload = () => {
      if (!lp.isConnected) return;
      const w = lp.clientWidth, h = lp.clientHeight;
      Object.assign(img.style, { width: im.naturalWidth + 'px', height: im.naturalHeight + 'px',
        left: w / 2 - r.sharp_u * im.naturalWidth + 'px', top: h / 2 - r.sharp_v * im.naturalHeight + 'px' });
      img.src = src;
      lp.hidden = false;
    };
    (isRaw(r.path) ? invoke('thumb', { path: r.path, size: 8000 }).then(convertFileSrc) : Promise.resolve(convertFileSrc(r.path)))
      .then(u => { src = u; im.src = u; }).catch(() => {});
    lp.onclick = () => { Z.s = 1; zoom1to1(card, apply, r.sharp_u, r.sharp_v); };
  }
}

// Shot settings overlay; analysis records already carry them, imported shots ask the backend.
const exifOn = () => ls('exif', '1') === '1';
const shutter = s => (!s ? null : s >= 0.5 ? `${+s.toFixed(1)} s` : `1/${Math.round(1 / s)}`);
async function fillExif(r) {
  const el = $('#exif');
  if (!el) return;
  const x = r.iso != null ? r : await invoke('photo_info', { path: r.path }).catch(() => ({}));
  if (!el.isConnected) return;
  el.innerHTML = [x.model, x.iso && `ISO ${x.iso}`, shutter(x.t), x.f && `f/${+x.f.toFixed(1)}`,
    x.fl && `${Math.round(x.fl)} ${t('mm')}`, x.ev ? `${x.ev > 0 ? '+' : ''}${x.ev.toFixed(1)} EV` : null]
    .filter(Boolean).map(s => `<span>${esc(s)}</span>`).join('');
}
function toggleExif() {
  lsSet('exif', exifOn() ? '0' : '1');
  const el = $('#exif');
  if (el) el.hidden = !exifOn();
}

function swipeOut(S) {
  return [...S.dec].filter(([, d]) => d === 'out').map(([p]) => p);
}
function swipeKept(S) {
  return [...S.dec].filter(([, d]) => d === 'keep').map(([p]) => p);
}

let flying = null;
// A keypress during the fly-out finishes it at once, so fast swiping never drops a decision.
function land() {
  if (!flying) return;
  const f = flying;
  flying = null;
  clearTimeout(f.timer);
  f.S.i++;
  resetZoom();
  render();
}
function swipeDecide(S, d) {
  land();
  const card = $('#tcard');
  if (!card || S.i >= S.items.length) return;
  S.dec.set(S.items[S.i].path, d);
  card.style.transition = 'transform .22s ease-in, opacity .22s';
  card.style.transform = `translateX(${d === 'out' ? -130 : 130}%) rotate(${d === 'out' ? -18 : 18}deg)`;
  card.style.opacity = '0';
  card.classList.add(d === 'out' ? 'go-out' : 'go-keep');
  flying = { S, timer: setTimeout(land, 200) };
}
function swipeBack(S) {
  land();
  if (!S.i) return;
  S.i--;
  S.dec.delete(S.items[S.i].path);
  resetZoom();
  render();
}
function dragCard(card, S) {
  // While zoomed the card does not swipe: the mouse only steers the zoomed view, a click zooms back out.
  let x0 = null, dx = 0, zoomed = false;
  card.onpointerdown = e => {
    x0 = e.clientX; dx = 0; zoomed = Z.s > 1;
    card.setPointerCapture(e.pointerId);
    card.style.transition = 'none';
  };
  card.onpointermove = e => {
    if (x0 === null) return;
    dx = e.clientX - x0;
    if (zoomed) return;
    card.style.transform = `translateX(${dx}px) rotate(${dx / 25}deg)`;
    card.classList.toggle('go-out', dx < -40);
    card.classList.toggle('go-keep', dx > 40);
  };
  card.onpointerup = card.onpointercancel = e => {
    if (x0 === null) return;
    x0 = null;
    if (!zoomed && Math.abs(dx) > 120) return swipeDecide(S, dx < 0 ? 'out' : 'keep');
    // A click without dragging toggles 100% at the clicked spot (Z.u/Z.v follow the cursor).
    if (e.type === 'pointerup' && Math.abs(dx) < 5 && e.target.closest('.tcard') === card && swipeZoom?.card === card) {
      card.style.transform = '';
      card.classList.remove('go-out', 'go-keep');
      const img = card.querySelector('img.zimg'), r = card.getBoundingClientRect();
      const u = Z.s > 1 ? null : clamp((e.clientX - r.left - img.offsetLeft) / img.offsetWidth, 0, 1);
      const v = Z.s > 1 ? null : clamp((e.clientY - r.top - img.offsetTop) / img.offsetHeight, 0, 1);
      return zoom1to1(card, swipeZoom.apply, u, v);
    }
    card.style.transition = 'transform .18s';
    card.style.transform = '';
    card.classList.remove('go-out', 'go-keep');
  };
}

// ---------- mindful import ----------

const mindfulOn = () => ls('mindful') === '1';
const setMindful = v => lsSet('mindful', v ? '1' : '0');
function startMindful(photos) {
  state.mindful = {
    items: photos.map(p => {
      const parts = p.split(/[\\/]/);
      return { path: p, name: parts.pop(), folder: parts.pop() };
    }),
    i: 0,
    dec: new Map(),
    outLabel: t('stamp_rej'),
    outHint: t('h_rej'),
  };
  go('mindful');
}

function viewMindful(main) {
  const M = state.mindful;
  if (M && !M.items.length && state.busy) {
    main.innerHTML = `<h1>${t('mindful_title')}</h1><div class="empty"><span class="spin"></span><h2>${t('moving_rej')}</h2></div>`;
    return;
  }
  if (!M?.items.length) {
    main.innerHTML = `<h1>${t('mindful_title')}</h1><div class="empty"><div class="big">${icon('mindful', 54)}</div><h2>${t('nothing_pick')}</h2>
      <p>${t('nothing_pick_sub')}</p></div>`;
    return;
  }
  main.classList.add('fill');
  const out = swipeOut(M).length, kept = M.dec.size - out;
  const head = `<div class="rv-head"><b>${t('mindful_title')}</b>
      ${M.i < M.items.length ? `<span class="mut">${t('shot_n', M.i + 1, M.items.length)}</span>` : ''}
      ${tally(out, kept)}
      <span class="grow"></span>
      ${M.i < M.items.length && out ? `<button class="btn" id="apply">${t('apply_now', out)}</button>` : ''}</div>
      ${progressBar(M.i, M.items.length)}`;
  if (M.i >= M.items.length) {
    main.innerHTML = `${head}<div class="empty"><div class="big">🎉</div><h2>${t('all_seen_n', shots(M.items.length))}</h2>
      <p>${out ? t('mindful_end', shots(kept), shots(out)) : t('nothing_out')}</p>
      <div class="row" style="justify-content:center;margin-top:16px">
        <button class="btn" id="back1">${t('back_last')}</button>
        <button class="btn primary" id="done" ${state.busy ? 'disabled' : ''}>${out ? t('move_rej_n', shots(out)) : t('done')}</button>
      </div></div>`;
    $('#back1', main).onclick = () => swipeBack(M);
    $('#done', main).onclick = applyMindful;
    return;
  }
  main.innerHTML = head + swipeStage(M);
  $('#apply', main)?.addEventListener('click', applyMindful);
  swipeBind(main, M);
}
function applyMindful() {
  const M = state.mindful, out = swipeOut(M);
  if (!out.length) {
    M.items = M.items.slice(M.i);
    M.i = 0;
    M.dec = new Map();
    if (!M.items.length) { state.mindful = null; go('import'); } else render();
    return;
  }
  // Keep the undecided tail so the pass can continue after an early apply.
  const done = new Set(M.items.slice(0, M.i).map(r => r.path));
  M.items = M.items.filter(r => !done.has(r.path));
  M.i = 0;
  M.dec = new Map();
  if (state.report) state.report.photos = state.report.photos.filter(p => !out.includes(p));
  return applyMoves('rejects', out).then(() => { if (!M.items.length) { state.mindful = null; go('import'); } });
}

function applyBlurry() {
  const B = state.blurry;
  const keptNow = [...B.dec].filter(([, d]) => d === 'keep').map(([p]) => p);
  if (keptNow.length) { keptNow.forEach(p => B.kept.add(p)); saveKept(B.kept); }
  const out = swipeOut(B);
  if (!out.length) { B.stale = true; return render(); }
  return applyMoves('blurry', out);
}

// ---------- moves ----------

function applyMoves(kind, paths) {
  if (!paths.length) return;
  const folder = folderFor(kind);
  return task('move', t('task_move'), async () => {
    const n = await invoke('move_to_review', { library: state.lib, folder, paths });
    const gone = new Set(paths);
    if (state.recs) state.recs = state.recs.filter(r => !gone.has(r.path));
    state.dupes.groups = [];
    state.blurry.stale = true;
    state.review.items = null;
    const dir = await invoke('review_dir', { library: state.lib, folder });
    const el = toast(`${t('moved', files(n), esc(folder))} <button class="btn" id="tReveal">${t('show')}</button><button class="btn" id="tUndo">${t('undo')}</button>`, 12000);
    $('#tReveal', el).onclick = () => opener.revealItemInDir(dir);
    $('#tUndo', el).onclick = undo;
    loadReview().then(updateNav).catch(() => {});
  });
}

function undo() {
  $('#toast').hidden = true;
  return task('undo', t('task_undo'), async () => {
    const n = await invoke('undo_last', { library: state.lib });
    state.recs = null;
    state.review.items = null;
    state.dupes.groups = [];
    state.blurry.stale = true;
    toast(t('returned', files(n)));
    await invoke('analyze', { library: state.lib }).then(r => (state.recs = r));
    loadReview().then(updateNav).catch(() => {});
  });
}

// ---------- review folders ----------

async function loadReview() {
  state.review.items = await invoke('list_review', { library: state.lib });
  state.review.sel.clear();
}

async function viewReview(main) {
  const R = state.review;
  const title = t('review_title'), sub = t('review_sub');
  if (!R.items) {
    main.innerHTML = `<h1>${title}</h1><p class="sub">${sub}</p><div class="empty"><span class="spin"></span></div>`;
    try { await loadReview(); } catch (e) { return showError(e); }
    if (state.view !== 'review') return;
    updateNav();
  }
  const dirs = [...new Set(R.items.map(i => i.dir))];
  if (!dirs.length) {
    main.innerHTML = `<h1>${title}</h1><p class="sub">${sub}</p><div class="empty"><div class="big">${icon('check', 54)}</div><h2>${t('review_empty')}</h2></div>`;
    return;
  }
  if (!dirs.includes(R.dir)) { R.dir = dirs[0]; R.folder = '*'; }
  const ofDir = R.items.filter(i => i.dir === R.dir);
  const fl = [...new Set(ofDir.map(i => i.folder))].sort((a, b) => a.localeCompare(b, LANG, { numeric: true }));
  if (R.folder !== '*' && !fl.includes(R.folder)) R.folder = '*';
  const shown = ofDir.filter(i => R.folder === '*' || i.folder === R.folder);
  const sum = a => a.reduce((s, i) => s + i.size + i.raw_size, 0);
  const selIn = () => [...R.sel].filter(p => ofDir.some(i => i.path === p));
  main.innerHTML = `<h1>${title}</h1><p class="sub">${sub}</p>
    <div class="chips">${dirs.map(d => {
      const a = R.items.filter(i => i.dir === d);
      return `<div class="chip ${d === R.dir ? 'on' : ''}" data-dir="${esc(d)}" title="${esc(d)}">${esc(kindLabel(a[0].kind))} · ${shots(a.length)} · ${gb(sum(a))}</div>`;
    }).join('')}</div>
    <div class="row" style="margin-bottom:16px">
      <select id="rfolder"><option value="*">${t('all_folders', ofDir.length)}</option>${fl.map(f =>
        `<option value="${esc(f)}" ${f === R.folder ? 'selected' : ''}>${esc(f)} (${ofDir.filter(i => i.folder === f).length})</option>`).join('')}</select>
      <span class="mut">${t('with_raw', gb(sum(shown)))}</span><span class="grow"></span>
      <button class="btn" id="rall">${shown.every(i => R.sel.has(i.path)) ? t('sel_none') : t('sel_all')}</button>
      <button class="btn" id="rshow">${revealLabel()}</button>
      <button class="btn" id="rswipe" ${shown.length && !state.busy ? '' : 'disabled'}>${t('review_swipe', shots(shown.length))}</button>
      <button class="btn primary" id="rback" ${selIn().length && !state.busy ? '' : 'disabled'}>${t('restore_n', shots(selIn().length))}</button>
    </div>
    <div class="grid">${shown.map(i => `
      <div class="cell ${R.sel.has(i.path) ? 'back' : ''}" data-path="${esc(i.path)}">
        <img data-path="${esc(i.path)}" alt=""><span class="tag">${R.sel.has(i.path) ? t('back_tag') : esc(i.folder)}</span>
        <span class="fname">${esc(i.name)}${i.raws ? ' + RAW' : ''}</span></div>`).join('')}</div>
    <div class="rv-foot"><span><kbd>${t('h_click')}</kbd> ${t('h_select')}</span><span><kbd>${t('h_dbl')}</kbd> ${t('h_open')}</span>
      <span><kbd>Z</kbd> ${t('h_hold')}</span></div>`;
  lazyThumbs(main, 640);
  main.querySelectorAll('.chip[data-dir]').forEach(c => (c.onclick = () => { R.dir = c.dataset.dir; R.folder = '*'; render(); }));
  $('#rfolder', main).onchange = e => { R.folder = e.target.value; render(); };
  $('#rall', main).onclick = () => {
    const all = shown.every(i => R.sel.has(i.path));
    shown.forEach(i => (all ? R.sel.delete(i.path) : R.sel.add(i.path)));
    render();
  };
  $('#rshow', main).onclick = async () => {
    const dir = await invoke('review_dir', { library: state.lib, folder: R.dir });
    opener.revealItemInDir(R.folder === '*' ? dir : dir + '/' + R.folder);
  };
  $('#rback', main).onclick = () => restoreSelected(selIn());
  $('#rswipe', main).onclick = () => startReviewSwipe(shown);
  main.querySelectorAll('.cell').forEach(el => {
    const p = el.dataset.path;
    el.onclick = () => {
      R.sel.has(p) ? R.sel.delete(p) : R.sel.add(p);
      const on = R.sel.has(p);
      el.classList.toggle('back', on);
      el.querySelector('.tag').textContent = on ? t('back_tag') : R.items.find(i => i.path === p).folder;
      const n = selIn().length, b = $('#rback', main);
      b.textContent = t('restore_n', shots(n));
      b.disabled = !n || state.busy;
    };
    el.ondblclick = () => opener.openPath(p);
    el.onmouseenter = () => (hoverPath = p);
  });
}

function restoreSelected(paths) {
  if (!paths.length) return;
  return task('restore', t('task_restore'), async () => {
    const n = await invoke('restore_from_review', { library: state.lib, paths });
    await loadReview();
    const el = toast(`${t('returned_home', files(n))} <button class="btn" id="tUndo">${t('undo')}</button>`, 12000);
    $('#tUndo', el).onclick = undo;
    render();
    state.dupes.groups = [];
    state.blurry.stale = true;
    if (state.recs) state.recs = await invoke('analyze', { library: state.lib });
  });
}

// Swipe through a review folder: → returns the shot (and its RAW) to the library, ← leaves it in review.
function startReviewSwipe(items) {
  state.rswipe = {
    items: items.map(i => ({ path: i.path, name: i.name, folder: i.folder })),
    i: 0,
    dec: new Map(),
    outLabel: t('stamp_stay'),
    outHint: t('h_stay'),
    keepLabel: t('stamp_return'),
    keepHint: t('h_return'),
  };
  go('rswipe');
}

function viewRSwipe(main) {
  const S = state.rswipe;
  if (S && !S.items.length && state.busy) {
    main.innerHTML = `<h1>${t('rs_title')}</h1><div class="empty"><span class="spin"></span><h2>${t('task_restore')}</h2></div>`;
    return;
  }
  if (!S?.items.length) { state.rswipe = null; state.view = 'review'; return viewReview(main); }
  main.classList.add('fill');
  const back = swipeKept(S).length, stay = S.dec.size - back;
  const head = `<div class="rv-head"><button class="btn" id="rsBack">${t('back_to_review')}</button><b>${t('rs_title')}</b>
      ${S.i < S.items.length ? `<span class="mut">${t('shot_n', S.i + 1, S.items.length)}</span>` : ''}
      ${tally(stay, back)}
      <span class="grow"></span>
      ${S.i < S.items.length && back ? `<button class="btn" id="apply">${t('return_now', back)}</button>` : ''}</div>
      ${progressBar(S.i, S.items.length)}`;
  const bind = () => {
    $('#rsBack', main).onclick = () => go('review');
    $('#apply', main)?.addEventListener('click', applyRSwipe);
  };
  if (S.i >= S.items.length) {
    main.innerHTML = `${head}<div class="empty"><div class="big">🎉</div><h2>${t('all_seen_n', shots(S.items.length))}</h2>
      <p>${back ? t('rs_end', shots(back), shots(stay)) : t('rs_nothing')}</p>
      <div class="row" style="justify-content:center;margin-top:16px">
        <button class="btn" id="back1">${t('back_last')}</button>
        <button class="btn primary" id="done" ${state.busy ? 'disabled' : ''}>${back ? t('restore_n', shots(back)) : t('done')}</button>
      </div></div>`;
    bind();
    $('#back1', main).onclick = () => swipeBack(S);
    $('#done', main).onclick = applyRSwipe;
    return;
  }
  main.innerHTML = head + swipeStage(S);
  bind();
  swipeBind(main, S);
}
function applyRSwipe() {
  const S = state.rswipe, back = swipeKept(S);
  // Keep the undecided tail so the pass can continue after an early apply.
  const done = new Set(S.items.slice(0, S.i).map(r => r.path));
  S.items = S.items.filter(r => !done.has(r.path));
  S.i = 0;
  S.dec = new Map();
  if (!back.length) { if (S.items.length) render(); else go('review'); return; }
  return restoreSelected(back).then(() => { if (!S.items.length) go('review'); });
}

// ---------- gallery ----------

const relPath = p => (p.startsWith(state.lib) ? p.slice(state.lib.length).replace(/^[\\/]/, '') : p);
const isStar = p => state.stars.has(relPath(p));
async function loadStars() {
  state.stars = new Set(await invoke('get_stars', { library: state.lib }).catch(() => []));
}
async function toggleStar(path) {
  try {
    state.stars = new Set(await invoke('set_star', { library: state.lib, path, on: !isStar(path) }));
  } catch (e) { showError(e); }
  render();
}

// Photos come from the analysis records (one per shot, RAW-only included), videos from their own listing.
let galleryMemo = { recs: null, videos: null, items: [] };
function galleryItems() {
  if (galleryMemo.recs !== state.recs || galleryMemo.videos !== state.videos) {
    const items = (state.recs || []).map(r => ({ path: r.path, folder: r.folder, name: r.name, ts: r.ts ?? r.mtime, vertical: r.vertical, rec: r }))
      .concat((state.videos || []).map(v => ({ path: v.path, folder: v.folder, name: v.name, ts: v.mtime, video: true })));
    // Display order: newest day first, shots inside a day in shooting order (RAW-only shots join their day).
    const dayOf = it => it.folder.replace(/ RAW$/, ''), start = {};
    items.forEach(it => { const d = dayOf(it); start[d] = Math.min(start[d] ?? Infinity, it.ts); });
    items.sort((a, b) => start[dayOf(b)] - start[dayOf(a)] || dayOf(a).localeCompare(dayOf(b)) || a.ts - b.ts || a.name.localeCompare(b.name));
    galleryMemo = { recs: state.recs, videos: state.videos, items };
  }
  return galleryMemo.items;
}
function galleryShown() {
  const G = state.gallery;
  return galleryItems().filter(it =>
    (G.scope === '*' || it.folder.replace(/ RAW$/, '') === G.scope) &&
    (G.filter === 'all' || (G.filter === 'stars' ? isStar(it.path) : it.video)));
}
const fmtTs = (ts, o) => new Date(ts * 1000).toLocaleDateString(LANG, { timeZone: 'UTC', ...o });

function viewGallery(main) {
  const G = state.gallery, title = t('gallery_title');
  if (!state.recs) return needAnalysis(main, title, '');
  if (!state.videos) {
    invoke('list_videos', { library: state.lib }).then(v => { state.videos = v; if (state.view === 'gallery') render(); }).catch(() => {});
    state.videos = [];
  }
  const shown = galleryShown();
  if (G.open != null) return viewViewer(main, shown);
  const h = +ls('gsize', '180');
  // Newest day first; shots inside a day in shooting order. RAW-only shots join their day.
  const groups = new Map();
  shown.forEach((it, i) => {
    const day = it.folder.replace(/ RAW$/, '');
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push([it, i]);
  });
  const days = [...groups];
  const photos = shown.filter(i => !i.video).length, vids = shown.length - photos;
  const days4sel = [...new Set(galleryItems().map(i => i.folder.replace(/ RAW$/, '')))].sort((a, b) => a.localeCompare(b, LANG, { numeric: true }));
  main.innerHTML = `<div class="g-top"><h1>${title}</h1><span class="mut">${t('g_count', photos && shots(photos), vids && t('videos', vids))}</span>
      <span class="grow"></span>
      <select id="gscope"><option value="*">${t('scope_all')}</option>${days4sel.map(d => `<option value="${esc(d)}" ${d === G.scope ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select>
      <div class="seg">${['all', 'stars', 'videos'].map(f => `<button data-f="${f}" class="${G.filter === f ? 'on' : ''}">${t('g_' + f)}</button>`).join('')}</div>
      <input type="range" id="gsize" min="110" max="340" step="10" value="${h}" title="${t('g_size')}"></div>
    ${shown.length ? days.map(([day, list]) => `<section class="g-day">
      <div class="g-h"><b>${esc(day)}</b><span class="mut">${fmtTs(list[0][0].ts, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })} · ${list.length}</span></div>
      <div class="g-row" style="--h:${h}px">${list.map(([it, i]) => {
        const a = it.video ? 16 / 9 : it.vertical ? 2 / 3 : 3 / 2;
        return `<div class="gt ${it.video ? 'vid' : ''}" data-i="${i}" style="flex:${a} 1 ${Math.round(a * h)}px">
          <img data-path="${esc(it.path)}" alt="">${it.video ? `<span class="gv">${icon('play', 22)}</span>` : ''}
          ${isStar(it.path) ? `<span class="gs">${icon('star', 14)}</span>` : ''}</div>`;
      }).join('')}<i class="g-fill"></i></div></section>`).join('')
    : `<div class="empty"><div class="big">${icon(G.filter === 'stars' ? 'star' : 'gallery', 54)}</div><h2>${t('g_empty')}</h2>${G.filter === 'stars' ? t('g_empty_stars') : ''}</div>`}`;
  lazyThumbs(main, h > 220 ? 800 : 480);
  $('#gscope', main).onchange = e => { G.scope = e.target.value; render(); };
  main.querySelectorAll('[data-f]').forEach(b => (b.onclick = () => { G.filter = b.dataset.f; render(); }));
  $('#gsize', main).oninput = e => {
    lsSet('gsize', e.target.value);
    main.querySelectorAll('.g-row').forEach(r => r.style.setProperty('--h', e.target.value + 'px'));
    main.querySelectorAll('.gt').forEach(el => {
      const [a] = el.style.flex.split(' ');
      el.style.flex = `${a} 1 ${Math.round(+a * e.target.value)}px`;
    });
  };
  $('#gsize', main).onchange = () => render();
  main.querySelectorAll('.gt').forEach(el => {
    const it = shown[+el.dataset.i];
    el.onclick = () => (it.video ? opener.openPath(it.path) : openViewer(+el.dataset.i));
    el.onmouseenter = () => (hoverPath = it.path);
  });
  if (G.scrollTo) { main.querySelector(`.gt[data-i="${G.scrollTo}"]`)?.scrollIntoView({ block: 'center' }); G.scrollTo = null; }
}

let viewerZoom = null;
function openViewer(i) {
  state.gallery.open = i;
  resetZoom();
  render();
}
function closeViewer() {
  state.gallery.scrollTo = state.gallery.open;
  state.gallery.open = null;
  resetZoom();
  render();
}
function stepViewer(d) {
  const shown = galleryShown().filter(i => !i.video);
  const G = state.gallery, all = galleryShown();
  const cur = all[G.open];
  let k = shown.indexOf(cur) + d;
  if (k < 0 || k >= shown.length) return;
  G.open = all.indexOf(shown[k]);
  resetZoom();
  render();
}
function viewViewer(main, shown) {
  const G = state.gallery;
  const it = shown[G.open];
  if (!it || it.video) { G.open = null; return viewGallery(main); }
  const photos = shown.filter(i => !i.video), k = photos.indexOf(it);
  main.classList.add('fill');
  hoverPath = it.path;
  const star = isStar(it.path);
  main.innerHTML = `<div class="viewer">
    <div class="rv-head"><button class="btn" id="vClose" title="${t('v_close')}">←</button>
      <b>${esc(it.name)}</b><span class="mut">${esc(it.folder)} · ${fmtTs(it.ts, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
      <span class="mut">${t('of', k + 1, photos.length)}</span><span class="grow"></span>
      <button class="btn ${star ? 'starred' : ''}" id="vStar" title="${star ? t('v_unstar') : t('v_star')}">${icon('star', 15)}</button>
      <button class="btn" id="vReveal">${revealLabel()}</button>
      <button class="btn" id="vOpen">${t('v_open')}</button>
      <button class="btn" id="vReject" ${state.busy ? 'disabled' : ''}>${t('v_reject')}</button></div>
    <div class="v-stage zoom" id="vbox">
      <img class="zimg" data-path="${esc(it.path)}" alt="">
      <div class="exif" id="exif" ${exifOn() ? '' : 'hidden'}></div><span class="zbadge"></span>
      ${k > 0 ? '<button class="v-nav l" id="vPrev">‹</button>' : ''}${k < photos.length - 1 ? '<button class="v-nav r" id="vNext">›</button>' : ''}
    </div>
    <div class="rv-foot" style="justify-content:center"><span><kbd>←</kbd> <kbd>→</kbd> ${t('h_nav')}</span>
      <span><kbd>${t('h_wheel')}</kbd> ${t('h_zoom')}</span><span><kbd>${t('h_click')}</kbd> / <kbd>${t('h_space')}</kbd> ${t('h_1to1')}</span>
      <span><kbd>F</kbd> ${t('h_star')}</span><span><kbd>I</kbd> ${t('h_info')}</span><span><kbd>⌫</kbd> ${t('h_reject')}</span><span><kbd>Esc</kbd> ${t('h_close')}</span></div>
  </div>`;
  const box = $('#vbox', main);
  fillThumbs(box, 1400);
  [photos[k - 1], photos[k + 1]].forEach(n => n && thumb(n.path, 1400));
  const apply = bindZoom([box]);
  viewerZoom = { box, apply };
  fillExif(it.rec || it);
  box.onclick = e => {
    if (e.target.closest('.v-nav')) return;
    const img = box.querySelector('img.zimg'), r = box.getBoundingClientRect();
    const u = clamp((e.clientX - r.left - img.offsetLeft) / img.offsetWidth, 0, 1);
    const v = clamp((e.clientY - r.top - img.offsetTop) / img.offsetHeight, 0, 1);
    zoom1to1(box, apply, Z.s > 1 ? null : u, Z.s > 1 ? null : v);
  };
  $('#vPrev', main)?.addEventListener('click', () => stepViewer(-1));
  $('#vNext', main)?.addEventListener('click', () => stepViewer(1));
  $('#vClose', main).onclick = closeViewer;
  $('#vStar', main).onclick = () => toggleStar(it.path);
  $('#vReveal', main).onclick = () => opener.revealItemInDir(it.path);
  $('#vOpen', main).onclick = () => opener.openPath(it.path);
  $('#vReject', main).onclick = () => rejectFromViewer(it);
}
function rejectFromViewer(it) {
  const G = state.gallery;
  const photos = galleryShown().filter(i => !i.video), k = photos.indexOf(it);
  const next = photos[k + 1] || photos[k - 1];
  applyMoves('rejects', [it.path])?.then(() => {
    const all = galleryShown();
    G.open = next ? all.findIndex(i => i.path === next.path) : null;
    if (G.open < 0) G.open = null;
    render();
  });
}

// ---------- stats ----------

function bars(rows, hot = () => false) {
  const max = Math.max(1, ...rows.map(r => r[1]));
  return `<div class="bars">${rows.map(([k, v]) => `<div class="bar ${hot(k) ? 'hot' : ''}"><span>${esc(k)}</span>
    <div class="track"><i style="width:${(100 * v / max).toFixed(1)}%"></i></div><span class="v">${v}</span></div>`).join('')}</div>`;
}
function bucket(recs, val, edges, label) {
  const rows = edges.map((e, i) => [label(e, edges[i + 1]), 0]);
  recs.forEach(r => {
    const v = val(r);
    if (v == null) return;
    let i = edges.findIndex((e, j) => v >= e && (j === edges.length - 1 || v < edges[j + 1]));
    if (i < 0) i = 0;
    rows[i][1]++;
  });
  return rows;
}

function viewStats(main) {
  const title = t('stats_title');
  if (!state.recs) return needAnalysis(main, title, t('stats_sub'));
  const recs = scoped(state.scope.stats);
  const n = recs.length || 1;
  const pct = c => Math.round(100 * c / n) + '%';
  const speed = r => (r.t ? 1 / r.t : null);
  const mm = t('mm');

  const isoRows = bucket(recs, r => r.iso, [0, 400, 800, 1600, 3200, 6400, 12800], (a, b) => (b ? `${a || '≤'}–${b}` : `${a}+`));
  isoRows[0][0] = '< 400';
  const fRows = bucket(recs, r => r.f, [0, 2, 2.8, 4, 5.6, 8, 11], (a, b) => (b ? `f/${a}–${b}` : `f/${a}+`));
  fRows[0][0] = '< f/2';
  const tRows = bucket(recs, speed, [0, 30, 60, 125, 250, 1000], (a, b) => (b ? `1/${a}–1/${b}` : `1/${a}+`));
  tRows[0][0] = t('slower');
  const flRows = bucket(recs, r => r.fl, [0, 18, 24, 35, 45, 55, 100], (a, b) => (b ? `${a}–${b} ${mm}` : `${a}+ ${mm}`));

  const issues = [];
  const add = (list, k) => list.length && issues.push({ list, title: t(k), text: t(k + '_t') });
  add(recs.filter(r => r.iso >= 3200 && r.t && r.t <= 1 / 100), 'i_iso');
  add(recs.filter(r => r.fl && r.t && r.t > 1 / (1.5 * r.fl) && r.t > 1 / 60), 'i_motion');
  add(recs.filter(r => r.f >= 11), 'i_f11');
  add(recs.filter(r => r.hi > 0.03), 'i_hi');
  add(recs.filter(r => r.lo > 0.05), 'i_lo');
  const ends = recs.filter(r => r.fl && (Math.round(r.fl) <= 16 || Math.round(r.fl) >= 50)).length;

  main.innerHTML = `<h1>${title}</h1>
    <div class="row" style="margin:6px 0 18px">${scopeSelect('scope', state.scope.stats)}</div>
    <div class="kpis">
      <div class="kpi"><b>${fmtN(recs.length)}</b><span>${t('k_jpg')}</span></div>
      <div class="kpi"><b>${pct(recs.filter(r => r.iso >= 3200).length)}</b><span>${t('k_iso')}</span></div>
      <div class="kpi"><b>${pct(recs.filter(r => r.vertical).length)}</b><span>${t('k_vert')}</span></div>
      <div class="kpi"><b>${pct(ends)}</b><span>${t('k_ends')}</span></div>
    </div>
    <div class="charts">
      <div class="panel"><h3>${t('c_iso')}</h3>${bars(isoRows, k => /^(3200|6400|12800)/.test(k))}</div>
      <div class="panel"><h3>${t('c_shutter')}</h3>${bars(tRows, k => k === t('slower'))}</div>
      <div class="panel"><h3>${t('c_aperture')}</h3>${bars(fRows, k => k.includes('f/11'))}</div>
      <div class="panel"><h3>${t('c_focal')}</h3>${bars(flRows)}</div>
    </div>
    <div class="panel"><h3>${t('issues')}</h3>
      ${issues.length ? issues.map(i => `<div class="issue"><div class="cnt">${i.list.length}</div><div>
        <b>${i.title}</b> <span class="mut">· ${pct(i.list.length)}</span><p>${i.text}</p></div></div>`).join('') : `<div class="mut">${t('no_issues')}</div>`}
    </div>`;
  $('#scope', main).onchange = e => { state.scope.stats = e.target.value; render(); };
}

// ---------- settings ----------

async function viewSettings(main) {
  const undoN = await invoke('undo_count', { library: state.lib }).catch(() => 0);
  if (state.view !== 'settings') return;
  main.innerHTML = `<h1>${t('settings_title')}</h1><p class="sub">${t('settings_sub')}</p>
    <div class="panel"><h3>${t('s_lang')}</h3><div class="mut small" style="margin-bottom:10px">${t('s_lang_sub')}</div>
      <div class="seg">${['ru', 'en'].map(l => `<button data-lang="${l}" class="${l === LANG ? 'on' : ''}">${l === 'ru' ? 'Русский' : 'English'}</button>`).join('')}</div></div>
    <div class="panel"><h3>${t('s_lib')}</h3>
      <div class="pathrow">${icon('folder', 16)}<span>${esc(state.lib)}</span>
        <button class="btn" id="pick">${t('change')}</button><button class="btn" id="reveal">${revealLabel()}</button></div></div>
    <div class="panel"><h3>${t('s_moves')}</h3>
      <div class="mut" style="margin-bottom:10px">${t('s_moves_sub', t('actions', undoN))}</div>
      <button class="btn" id="undo" ${undoN && !state.busy ? '' : 'disabled'}>${t('s_undo')}</button></div>
    <div class="panel"><h3>${t('s_cache')}</h3><div class="mut" style="margin-bottom:10px">${t('s_cache_sub')}</div>
      <button class="btn" id="reanalyze" ${state.busy ? 'disabled' : ''}>${t('s_reanalyze')}</button></div>`;
  bindLang(main);
  $('#pick', main).onclick = pickLibrary;
  $('#reveal', main).onclick = () => opener.revealItemInDir(state.lib);
  $('#undo', main).onclick = undo;
  $('#reanalyze', main).onclick = () => { state.recs = null; ensureRecs(); };
}

function setLib(lib) {
  if (lib !== state.lib) {
    state.recs = null;
    state.plan = null;
    state.dupes.groups = [];
    state.blurry.stale = true;
    state.review.items = null;
    state.videos = null;
    state.gallery.open = null;
  }
  state.lib = lib;
  $('#lib').textContent = lib;
  $('#lib').title = lib;
}

// ---------- nav ----------

const NAV = ['gallery', 'import', 'mindful', 'dupes', 'blurry', 'review', 'stats', 'verify'];
function buildNav() {
  const item = v => `<button data-view="${v}">${icon(v)}<span class="lbl">${t('nav_' + v)}</span><span class="badge" id="b-${v}"></span></button>`;
  $('#nav').innerHTML = `<div class="brand" data-tauri-drag-region>Photo Sorter</div>
    ${NAV.map(item).join('')}<div class="spacer" data-tauri-drag-region></div>${item('settings')}<div id="lib" class="lib"></div>`;
  $('#nav').querySelectorAll('button[data-view]').forEach(b => (b.onclick = () => go(b.dataset.view)));
}

// Badge counts are recomputed only when the analysis records change.
let badgeMemo = { recs: null, dupes: 0, blurry: 0 };
function updateNav() {
  if (state.recs !== badgeMemo.recs) {
    const kept = loadKept();
    badgeMemo = {
      recs: state.recs,
      dupes: state.recs ? findBursts(state.recs).length : 0,
      blurry: state.recs ? findBlurry(state.recs).filter(r => !kept.has(r.path)).length : 0,
    };
  }
  const M = state.mindful, left = M ? M.items.length - M.i : 0;
  const counts = { dupes: badgeMemo.dupes, blurry: badgeMemo.blurry, review: state.review.items?.length || 0, mindful: left };
  NAV.concat('settings').forEach(v => {
    const b = $(`#nav [data-view="${v}"]`);
    if (!b) return;
    b.classList.toggle('active', state.view === v || (v === 'review' && state.view === 'rswipe'));
    const el = $('#b-' + v);
    el.textContent = counts[v] ? fmtN(counts[v]) : '';
  });
  $('#nav [data-view="mindful"]').hidden = !(left > 0 || state.view === 'mindful');
}

// ---------- routing & keys ----------

const views = { welcome: viewWelcome, gallery: viewGallery, import: viewImport, verify: viewVerify, dupes: viewDupes, blurry: viewBlurry,
  review: viewReview, rswipe: viewRSwipe, mindful: viewMindful, stats: viewStats, settings: viewSettings };
function render() {
  const main = $('#main');
  main.classList.remove('fill');
  views[state.view](main);
  updateNav();
}
function go(v) {
  state.view = v;
  const main = $('#main');
  main.scrollTop = 0;
  main.classList.remove('enter');
  void main.offsetWidth;
  main.classList.add('enter');
  resetZoom();
  render();
  if (v === 'import' && state.card && !state.plan) scan();
}

let hoverPath = null;
addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || ['SELECT', 'INPUT'].includes(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (state.view === 'gallery' && state.gallery.open != null) {
    const it = galleryShown()[state.gallery.open];
    if (!it) return;
    if (k === 'escape') { e.preventDefault(); if (Z.s > 1) { resetZoom(); viewerZoom?.apply(); } else closeViewer(); }
    else if (k === 'arrowright') { e.preventDefault(); stepViewer(1); }
    else if (k === 'arrowleft') { e.preventDefault(); stepViewer(-1); }
    else if (k === ' ') { e.preventDefault(); if (viewerZoom?.box.isConnected) zoom1to1(viewerZoom.box, viewerZoom.apply); }
    else if (k === 'f' || k === 'а') toggleStar(it.path);
    else if (k === 'i' || k === 'ш') toggleExif();
    else if (k === 'backspace' || k === 'delete') { e.preventDefault(); if (!state.busy) rejectFromViewer(it); }
    else if (k === '0') { resetZoom(); viewerZoom?.apply(); }
    return;
  }
  const swipe = { blurry: state.blurry, mindful: state.mindful, rswipe: state.rswipe }[state.view];
  if ((k === 'z' || k === 'я') && hoverPath && !e.repeat && ['dupes', 'blurry', 'review', 'mindful', 'rswipe'].includes(state.view)) {
    const z = $('#zoom');
    z.querySelector('img').src = '';
    thumb(hoverPath, 2400).then(src => (z.querySelector('img').src = src));
    z.hidden = false;
    return;
  }
  if (k === 'escape' || k === '0') {
    if (Z.s > 1) { resetZoom(); (state.view === 'dupes' ? dupesApply : swipeZoom?.apply)?.(); }
    return;
  }
  if (swipe?.items?.length && swipe.i < swipe.items.length) {
    if (k === 'arrowleft') { e.preventDefault(); swipeDecide(swipe, 'out'); }
    else if (k === 'arrowright') { e.preventDefault(); swipeDecide(swipe, 'keep'); }
    else if (k === 'backspace' || k === 'arrowup') { e.preventDefault(); swipeBack(swipe); }
    else if (k === ' ') { e.preventDefault(); if (swipeZoom?.card.isConnected) zoom1to1(swipeZoom.card, swipeZoom.apply); }
    else if (k === 'i' || k === 'ш') toggleExif();
  } else if (swipe?.items?.length && k === 'backspace') {
    e.preventDefault();
    swipeBack(swipe);
  }
  if (state.view === 'dupes' && state.dupes.groups.length) {
    if (k === 'arrowright' || k === ' ') { e.preventDefault(); stepDupes(1); }
    else if (k === 'arrowleft') stepDupes(-1);
    else if (/^[1-9]$/.test(k)) toggleDupe(+k - 1);
  }
});
addEventListener('keyup', e => {
  if (['z', 'я'].includes(e.key.toLowerCase())) $('#zoom').hidden = true;
});

(async () => {
  buildNav();
  const s = await invoke('get_settings');
  setLib(s.library);
  if (state.view === 'welcome') document.body.classList.add('welcome');
  render();
  loadReview().then(updateNav).catch(() => {});
  loadStars();
  await pollCards();
  setInterval(pollCards, 2500);
})();
