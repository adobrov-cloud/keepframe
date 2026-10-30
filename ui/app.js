const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const dialog = window.__TAURI__.dialog;
const opener = window.__TAURI__.opener;

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = {
  view: 'import',
  lib: '',
  cards: [],
  card: null,          // selected card path
  plan: null,          // import plan for state.card
  report: null,        // last import report
  newFolders: null,    // folders touched by the last import
  verify: null,
  recs: null,          // analysis records for the library
  scope: { dupes: '*', blurry: '*', stats: '*' },
  dupes: { groups: [], i: 0, keep: {} },
  blurry: { items: [], i: 0, dec: new Map(), kept: new Set() },
  review: { items: null, kind: null, folder: '*', sel: new Set() },
  busy: false,
};

// ---------- helpers ----------

function gb(b) {
  if (b >= 1e9) return (b / 1e9).toFixed(1).replace('.', ',') + ' ГБ';
  if (b >= 1e6) return Math.round(b / 1e6) + ' МБ';
  return Math.round(b / 1e3) + ' КБ';
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many;
  return `${n.toLocaleString('ru')} ${w}`;
}
const shots = n => plural(n, 'кадр', 'кадра', 'кадров');
const files = n => plural(n, 'файл', 'файла', 'файлов');

const thumbs = new Map();
function thumb(path, size = 1400) {
  const k = path + '|' + size;
  if (!thumbs.has(k)) thumbs.set(k, invoke('thumb', { path, size }).then(convertFileSrc).catch(() => ''));
  return thumbs.get(k);
}
function fillThumbs(root, size) {
  root.querySelectorAll('img[data-path]').forEach(img => {
    thumb(img.dataset.path, size).then(src => { if (src) img.src = src; });
  });
}

let toastTimer;
function toast(html, ms = 6000) {
  const t = $('#toast');
  t.innerHTML = html;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
  return t;
}

function showError(e) {
  toast(`<span style="color:var(--bad)">Ошибка:</span> ${esc(e)}`, 9000);
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
  $('#ptext').textContent = p.label;
  if (!p.total) return;
  $('.pbar').classList.remove('indet');
  $('#pfill').style.width = (100 * p.done / p.total).toFixed(1) + '%';
  if (p.task === 'analyze') {
    $('#pnum').textContent = `${p.done} / ${p.total}`;
  } else {
    const now = performance.now();
    if (!speed.t0 || p.done < speed.b0) Object.assign(speed, { t0: now, b0: p.done });
    const mbs = (p.done - speed.b0) / 1e6 / Math.max(0.5, (now - speed.t0) / 1000);
    $('#pnum').textContent = `${gb(p.done)} из ${gb(p.total)}${mbs > 1 ? ` · ${Math.round(mbs)} МБ/с` : ''}`;
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

function cardChips() {
  if (state.cards.length < 2) return '';
  return `<div class="chips">${state.cards.map(c =>
    `<div class="chip ${c.path === state.card ? 'on' : ''}" data-card="${esc(c.path)}">${esc(c.name)}</div>`).join('')}</div>`;
}
function bindChips(main, after) {
  main.querySelectorAll('[data-card]').forEach(el => el.onclick = () => {
    state.card = el.dataset.card;
    state.plan = null;
    state.verify = null;
    render();
    after?.();
  });
}
const noCard = `<div class="empty"><div class="big">▭</div><h2>Вставьте карту памяти</h2>
  Подключите карту через картридер — приложение найдёт её само.</div>`;

// ---------- import ----------

function scan() {
  const card = state.card;
  return task('scan', 'Читаю карту…', async () => {
    state.plan = await invoke('scan_import', { card, library: state.lib });
  });
}

function runImport() {
  const items = state.plan.items;
  return task('import', 'Копирую…', async () => {
    const rep = await invoke('run_import', { items, library: state.lib });
    state.report = rep;
    state.newFolders = rep.folders;
    state.recs = null;
    state.plan = await invoke('scan_import', { card: state.card, library: state.lib });
  }).then(() => {
    if (mindfulOn() && state.report?.photos.length) startMindful(state.report.photos);
  });
}

function viewImport(main) {
  const name = state.cards.find(c => c.path === state.card)?.name;
  let html = `<h1>Импорт с карты</h1><p class="sub">Новые кадры копируются в папки по дням съёмки, RAW — в соседнюю папку «… RAW». Каждая копия сверяется по контрольной сумме.</p>`;
  if (!state.card) { main.innerHTML = html + noCard; return; }
  html += cardChips();
  const p = state.plan;
  if (state.report) {
    const r = state.report;
    html += `<div class="panel ${r.failed.length ? 'badbox' : 'okbox'}">
      <h3>${r.failed.length ? 'Скопировано с ошибками' : 'Импорт завершён'}</h3>
      <div>Скопировано ${files(r.copied)} (${gb(r.bytes)})${r.skipped ? `, пропущено ${r.skipped} — уже были` : ''}.</div>
      ${r.failed.length ? `<div class="scroll small" style="margin-top:8px">${r.failed.map(esc).join('<br>')}</div>` : ''}
      <div class="row" style="margin-top:12px">
        ${r.photos.length ? `<button class="btn" id="goMindful">Пролистать ${shots(r.photos.length)} — оставить / в отсев</button>` : ''}
        <button class="btn" id="goDupes">Найти дубли в новых папках</button>
        <button class="btn" id="goVerify">Проверить карту перед форматированием</button>
      </div></div>`;
  }
  if (!p) { main.innerHTML = html + `<div class="mut"><span class="spin"></span> Читаю «${esc(name)}»…</div>`; bindImport(main); return; }

  html += `<div class="kpis">
    <div class="kpi"><b>${p.total.toLocaleString('ru')}</b><span>файлов на карте «${esc(name)}»</span></div>
    <div class="kpi"><b>${p.already.toLocaleString('ru')}</b><span>уже в библиотеке</span></div>
    <div class="kpi ${p.items.length ? '' : 'good'}"><b>${p.items.length.toLocaleString('ru')}</b><span>новых · ${gb(p.bytes)}</span></div>
  </div>`;
  if (p.items.length) {
    html += `<div class="panel"><table>
      <tr><th>Папка</th><th>Дата</th><th class="n">Фото</th><th class="n">RAW</th><th class="n">Видео</th><th class="n">Размер</th></tr>
      ${p.days.map(d => `<tr><td>${esc(d.folder)}</td><td class="mut">${d.date.split('-').reverse().join('.')}</td>
        <td class="n">${d.photos || ''}</td><td class="n">${d.raws || ''}</td><td class="n">${d.videos || ''}</td><td class="n">${gb(d.bytes)}</td></tr>`).join('')}
    </table></div>
    <label class="mindful"><input type="checkbox" id="mindful" ${mindfulOn() ? 'checked' : ''}>
      <span><b>Осознанный импорт</b><br><span class="mut small">После копирования сразу пролистать новые кадры: → оставить, ← в «_на проверку (отсев)» вместе с RAW.</span></span></label>
    <div class="row"><button class="btn primary" id="doImport" ${state.busy ? 'disabled' : ''}>Импортировать ${files(p.items.length)} · ${gb(p.bytes)}</button>
    <button class="btn" id="rescan" ${state.busy ? 'disabled' : ''}>Пересканировать</button></div>`;
  } else if (!state.report) {
    html += `<div class="panel okbox"><h3>Всё с этой карты уже в библиотеке</h3>
      <div class="row" style="margin-top:8px"><button class="btn" id="goVerify">Проверить по контрольным суммам перед форматированием</button></div></div>`;
  }
  main.innerHTML = html;
  bindImport(main);
}
function bindImport(main) {
  bindChips(main, scan);
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
  return task('verify', 'Считаю контрольные суммы…', async () => {
    state.verify = await invoke('verify_card', { card: state.card, library: state.lib });
  });
}

function viewVerify(main) {
  let html = `<h1>Проверка карты</h1><p class="sub">Сравнивает SHA-256 каждого файла на карте со всеми файлами библиотеки — по содержимому, не по именам. Первый раз библиотека читается целиком (несколько минут), дальше — только новые файлы.</p>`;
  if (!state.card) { main.innerHTML = html + noCard; return; }
  html += cardChips();
  const v = state.verify;
  if (v) {
    if (!v.missing.length) {
      html += `<div class="panel okbox"><h3>✓ Можно форматировать</h3>
        Все ${files(v.card_files)} с карты (${gb(v.card_bytes)}) есть в библиотеке байт в байт.
        ${v.only_in_review ? `<div class="panel warnbox" style="margin:12px 0 0"><b>${files(v.only_in_review)}</b> сейчас лежат только в папках «_на проверку». После форматирования удаление этих папок будет окончательным — сначала просмотрите их.</div>` : ''}
      </div>`;
    } else {
      html += `<div class="panel badbox"><h3>Не форматируйте: ${files(v.missing.length)} нет в библиотеке</h3>
        <div class="scroll small">${v.missing.map(m => `${esc(m.path)} <span class="mut">${gb(m.size)}</span>`).join('<br>')}</div>
        <div class="row" style="margin-top:10px"><button class="btn" id="goImport">Перейти к импорту</button></div></div>`;
    }
    html += `<div class="mut small">Список контрольных сумм: <button class="link" id="revealSums">${esc(v.checksum_file)}</button></div>`;
  }
  html += `<div class="row" style="margin-top:16px"><button class="btn ${v ? '' : 'primary'}" id="doVerify" ${state.busy ? 'disabled' : ''}>${v ? 'Проверить ещё раз' : 'Проверить карту'}</button></div>`;
  main.innerHTML = html;
  bindChips(main);
  $('#doVerify', main)?.addEventListener('click', runVerify);
  $('#goImport', main)?.addEventListener('click', () => go('import'));
  $('#revealSums', main)?.addEventListener('click', () => opener.revealItemInDir(v.checksum_file));
}

// ---------- analysis ----------

function ensureRecs() {
  if (state.recs) return Promise.resolve();
  return task('analyze', 'Анализирую библиотеку…', async () => {
    state.recs = await invoke('analyze', { library: state.lib });
  });
}

function folders() {
  return [...new Set((state.recs || []).map(r => r.folder))].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
}
function scoped(scope) {
  const recs = state.recs || [];
  if (scope === '*') return recs;
  if (scope === 'new') return recs.filter(r => (state.newFolders || []).includes(r.folder));
  return recs.filter(r => r.folder === scope);
}
function scopeSelect(id, cur) {
  const opts = [['*', 'Вся библиотека']];
  if (state.newFolders?.length) opts.push(['new', 'Новые после импорта']);
  folders().forEach(f => opts.push([f, f]));
  return `<select id="${id}">${opts.map(([v, t]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
}
function needAnalysis(main, title, sub) {
  main.innerHTML = `<h1>${title}</h1><p class="sub">${sub}</p>
    <div class="empty"><div class="big">◎</div><h2>Нужно проанализировать библиотеку</h2>
    <p>Первый раз это займёт пару минут, дальше — секунды: результаты кэшируются.</p>
    <button class="btn primary" id="doAnalyze" ${state.busy ? 'disabled' : ''}>Анализировать</button></div>`;
  $('#doAnalyze', main).onclick = () => ensureRecs();
}

function hamming(a, b) {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b), c = 0;
  while (x) { c += Number(x & 1n); x >>= 1n; }
  return c;
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

function viewDupes(main) {
  const title = 'Дубли', sub = 'Серии почти одинаковых кадров, снятых подряд. В каждой серии самый резкий отмечен зелёным — поправьте выбор, остальное уйдёт в «_на проверку (дубли)».';
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
      <div class="empty"><div class="big">✓</div><h2>Серий-дублей не найдено</h2></div>`;
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
      <b>Серия ${D.i + 1} из ${D.groups.length}</b>
      <span class="mut">${esc(g.folder)} · ${shots(g.items.length)}</span>
      ${keep.length ? '' : '<span style="color:var(--bad);font-weight:600">вся серия уйдёт в проверку</span>'}
      <span class="grow"></span>
      <button class="btn" id="prev">←</button><button class="btn" id="next">→</button>
      <button class="btn primary" id="apply" ${rej && !state.busy ? '' : 'disabled'}>Убрать ${shots(rej)} в проверку</button>
    </div>
    <div class="rv-stage">${g.items.map((r, j) => `
      <div class="shot ${keep.includes(r.path) ? 'keep' : ''}" data-j="${j}">
        <img data-path="${esc(r.path)}" alt="">
        <span class="tag">${j + 1} ${keep.includes(r.path) ? '✓ оставить' : '→ в проверку'}</span>
        <span class="fname">${esc(r.name)}</span>
      </div>`).join('')}</div>
    <div class="rv-foot"><span><kbd>клик</kbd> или <kbd>1</kbd>–<kbd>9</kbd> оставить / убрать</span>
      <span><kbd>←</kbd> <kbd>→</kbd> <kbd>пробел</kbd> листать</span><span><kbd>Z</kbd> удерживать — на весь экран</span></div>`;
  fillThumbs(main, 1400);
  D.groups[D.i + 1]?.items.forEach(r => thumb(r.path, 1400));
  $('#scope', main).onchange = e => { state.scope.dupes = e.target.value; render(); };
  $('#prev', main).onclick = () => stepDupes(-1);
  $('#next', main).onclick = () => stepDupes(1);
  $('#apply', main).onclick = () => applyMoves('дубли', dupesRejected());
  main.querySelectorAll('.shot').forEach(el => {
    el.onclick = () => toggleDupe(+el.dataset.j);
    el.onmouseenter = () => (hoverPath = g.items[+el.dataset.j].path);
  });
}
function stepDupes(d) {
  const D = state.dupes;
  D.i = Math.max(0, Math.min(D.groups.length - 1, D.i + d));
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
  try { return new Set(JSON.parse(localStorage.getItem(keptKey()) || '[]')); } catch { return new Set(); }
}
function saveKept(set) {
  try { localStorage.setItem(keptKey(), JSON.stringify([...set])); } catch {}
}


function viewBlurry(main) {
  const title = 'Смазанные', sub = 'Кадры, которые заметно мягче остальных в своей папке. Иногда это просто размытый фон — решайте глазами.';
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
  }
  const out = swipeOut(B).length, kept = B.dec.size - out;
  const head = `<div class="rv-head">${scopeSelect('scope', state.scope.blurry)}
      ${B.i < B.items.length ? `<b>Кадр ${B.i + 1} из ${B.items.length}</b>` : ''}
      <span class="mut"><span style="color:var(--bad)">✕ ${out}</span> · <span style="color:var(--ok)">✓ ${kept}</span></span>
      <span class="grow"></span>
      ${B.hidden ? `<button class="link small" id="reset">показать ещё ${shots(B.hidden)}, которые вы оставили раньше</button>` : ''}
      ${B.i < B.items.length && out ? `<button class="btn" id="apply">Применить сейчас (${out})</button>` : ''}</div>`;
  const bind = () => {
    $('#scope', main).onchange = e => { state.scope.blurry = e.target.value; render(); };
    const r = $('#reset', main);
    if (r) r.onclick = () => { saveKept(new Set()); B.stale = true; render(); };
    const a = $('#apply', main);
    if (a) a.onclick = applyBlurry;
  };

  if (!B.items.length) {
    main.innerHTML = `<h1>${title}</h1>${head}<div class="empty"><div class="big">✓</div><h2>Смазанных кадров не найдено</h2></div>`;
    return bind();
  }
  main.classList.add('fill');

  if (B.i >= B.items.length) {
    main.innerHTML = `${head}<div class="empty"><div class="big">🎉</div><h2>Всё просмотрено</h2>
      <p>${out ? `${shots(out)} уйдут в «_на проверку (смазанные)», ${shots(kept)} остаются.` : 'Вы всё оставили — переносить нечего.'}</p>
      <div class="row" style="justify-content:center;margin-top:16px">
        <button class="btn" id="back1">← Вернуться к последнему</button>
        ${out ? `<button class="btn primary" id="done" ${state.busy ? 'disabled' : ''}>Убрать ${shots(out)} в проверку</button>` : `<button class="btn primary" id="done">Готово</button>`}
      </div></div>`;
    bind();
    $('#back1', main).onclick = () => swipeBack(B);
    $('#done', main).onclick = applyBlurry;
    return;
  }

  main.innerHTML = head + swipeStage(B, r => `резкость ${Math.round(r.rel * 100)}% от обычной для папки`);
  bind();
  swipeBind(main, B);
}

// ---------- swipe (shared by blurry and mindful import) ----------

function swipeStage(S, info) {
  const r = S.items[S.i], nx = S.items[S.i + 1];
  hoverPath = r.path;
  return `<div class="tinder">
      ${nx ? `<div class="tcard under"><img data-path="${esc(nx.path)}" alt=""></div>` : ''}
      <div class="tcard" id="tcard">
        <img data-path="${esc(r.path)}" alt="">
        <span class="stamp s-out">${S.outLabel || 'В ПРОВЕРКУ'}</span><span class="stamp s-keep">ОСТАВИТЬ</span>
        <span class="fname">${esc(r.folder)} · ${esc(r.name)}${info ? ' · ' + info(r) : ''}</span>
      </div>
    </div>
    <div class="tbtns">
      <button class="round bad" id="no" title="Убрать (←)">✕</button>
      <button class="round" id="undo1" title="Вернуть предыдущий (Backspace)" ${S.i ? '' : 'disabled'}>↶</button>
      <button class="round ok" id="yes" title="Оставить (→)">✓</button>
    </div>
    <div class="rv-foot" style="justify-content:center"><span><kbd>←</kbd> ${S.outHint || 'в проверку'}</span><span><kbd>→</kbd> оставить</span>
      <span><kbd>⌫</kbd> вернуть предыдущий</span><span><kbd>Z</kbd> удерживать — на весь экран</span><span>можно тянуть карточку мышью</span></div>`;
}
function swipeBind(main, S) {
  fillThumbs(main, 1400);
  S.items.slice(S.i + 2, S.i + 5).forEach(x => thumb(x.path, 1400));
  $('#no', main).onclick = () => swipeDecide(S, 'out');
  $('#yes', main).onclick = () => swipeDecide(S, 'keep');
  $('#undo1', main).onclick = () => swipeBack(S);
  dragCard($('#tcard', main), S);
}
function swipeOut(S) {
  return [...S.dec].filter(([, d]) => d === 'out').map(([p]) => p);
}

let flying = null;
// A keypress during the fly-out finishes it at once, so fast swiping never drops a decision.
function land() {
  if (!flying) return;
  const f = flying;
  flying = null;
  clearTimeout(f.timer);
  f.S.i++;
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
  render();
}
function dragCard(card, S) {
  let x0 = null, dx = 0;
  card.onpointerdown = e => { x0 = e.clientX; dx = 0; card.setPointerCapture(e.pointerId); card.style.transition = 'none'; };
  card.onpointermove = e => {
    if (x0 === null) return;
    dx = e.clientX - x0;
    card.style.transform = `translateX(${dx}px) rotate(${dx / 25}deg)`;
    card.classList.toggle('go-out', dx < -40);
    card.classList.toggle('go-keep', dx > 40);
  };
  card.onpointerup = card.onpointercancel = () => {
    if (x0 === null) return;
    x0 = null;
    if (Math.abs(dx) > 120) return swipeDecide(S, dx < 0 ? 'out' : 'keep');
    card.style.transition = 'transform .18s';
    card.style.transform = '';
    card.classList.remove('go-out', 'go-keep');
  };
}

// ---------- mindful import ----------

function mindfulOn() {
  try { return localStorage.getItem('mindful') === '1'; } catch { return false; }
}
function setMindful(v) {
  try { localStorage.setItem('mindful', v ? '1' : '0'); } catch {}
}
function startMindful(photos) {
  state.mindful = {
    items: photos.map(p => {
      const parts = p.split(/[\\/]/);
      return { path: p, name: parts.pop(), folder: parts.pop() };
    }),
    i: 0,
    dec: new Map(),
    outLabel: 'В ОТСЕВ',
    outHint: 'в отсев',
  };
  go('mindful');
}

function viewMindful(main) {
  const M = state.mindful;
  if (M && !M.items.length && state.busy) {
    main.innerHTML = `<h1>Отбор после импорта</h1><div class="empty"><span class="spin"></span><h2>Переношу в отсев…</h2></div>`;
    return;
  }
  if (!M?.items.length) {
    main.innerHTML = `<h1>Отбор после импорта</h1><div class="empty"><div class="big">◎</div><h2>Нечего отбирать</h2>
      <p>Включите «осознанный импорт» на экране импорта — после копирования сюда попадут новые кадры.</p></div>`;
    return;
  }
  main.classList.add('fill');
  const out = swipeOut(M).length, kept = M.dec.size - out;
  const head = `<div class="rv-head"><b>Отбор после импорта</b>
      ${M.i < M.items.length ? `<span class="mut">кадр ${M.i + 1} из ${M.items.length}</span>` : ''}
      <span class="mut"><span style="color:var(--bad)">✕ ${out}</span> · <span style="color:var(--ok)">✓ ${kept}</span></span>
      <span class="grow"></span>
      ${M.i < M.items.length && out ? `<button class="btn" id="apply">Применить сейчас (${out})</button>` : ''}</div>`;
  if (M.i >= M.items.length) {
    const rest = M.items.length;
    main.innerHTML = `${head}<div class="empty"><div class="big">🎉</div><h2>Все ${shots(rest)} просмотрены</h2>
      <p>${out ? `${shots(kept)} остаются в папках по дням, ${shots(out)} вместе с RAW уйдут в «_на проверку (отсев)».` : 'Вы всё оставили — переносить нечего.'}</p>
      <div class="row" style="justify-content:center;margin-top:16px">
        <button class="btn" id="back1">← Вернуться к последнему</button>
        <button class="btn primary" id="done" ${state.busy ? 'disabled' : ''}>${out ? `Убрать ${shots(out)} в отсев` : 'Готово'}</button>
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
  if (!out.length) { M.items = M.items.slice(M.i); M.i = 0; M.dec = new Map(); if (!M.items.length) { state.mindful = null; go('import'); } else render(); return; }
  // Keep the undecided tail so the pass can continue after an early apply.
  const done = new Set(M.items.slice(0, M.i).map(r => r.path));
  M.items = M.items.filter(r => !done.has(r.path));
  M.i = 0;
  M.dec = new Map();
  if (state.report) state.report.photos = state.report.photos.filter(p => !out.includes(p));
  return applyMoves('отсев', out).then(() => { if (!M.items.length) { state.mindful = null; go('import'); } });
}

function applyBlurry() {
  const B = state.blurry;
  const blurryOut = () => swipeOut(B);
  const keptNow = [...B.dec].filter(([, d]) => d === 'keep').map(([p]) => p);
  if (keptNow.length) { keptNow.forEach(p => B.kept.add(p)); saveKept(B.kept); }
  const out = blurryOut();
  if (!out.length) { B.stale = true; return render(); }
  return applyMoves('смазанные', out);
}

// ---------- moves ----------

function applyMoves(kind, paths) {
  if (!paths.length) return;
  return task('move', 'Переношу…', async () => {
    const n = await invoke('move_to_review', { library: state.lib, kind, paths });
    const gone = new Set(paths);
    if (state.recs) state.recs = state.recs.filter(r => !gone.has(r.path));
    state.dupes.groups = [];
    state.blurry.stale = true;
    state.review.items = null;
    const dir = await invoke('review_dir', { library: state.lib, kind });
    const t = toast(`Перенесено ${files(n)} в «${esc(dir.split(/[\\/]/).pop())}» <button class="btn" id="tReveal">Показать</button><button class="btn" id="tUndo">Отменить</button>`, 12000);
    $('#tReveal', t).onclick = () => opener.revealItemInDir(dir);
    $('#tUndo', t).onclick = undo;
  });
}

function undo() {
  $('#toast').hidden = true;
  return task('undo', 'Возвращаю…', async () => {
    const n = await invoke('undo_last', { library: state.lib });
    state.recs = null;
    state.review.items = null;
    state.dupes.groups = [];
    state.blurry.stale = true;
    toast(`Возвращено ${files(n)}`);
    await invoke('analyze', { library: state.lib }).then(r => (state.recs = r));
  });
}

// ---------- review folders ----------

function lazyThumbs(root, size) {
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    io.unobserve(e.target);
    thumb(e.target.dataset.path, size).then(src => { if (src) e.target.src = src; });
  }), { root: $('#main'), rootMargin: '400px' });
  root.querySelectorAll('img[data-path]').forEach(img => io.observe(img));
}

async function loadReview() {
  state.review.items = await invoke('list_review', { library: state.lib });
  state.review.sel.clear();
}

async function viewReview(main) {
  const R = state.review;
  const title = 'На проверке', sub = 'Сюда приложение откладывает кадры вместо удаления. Посмотрите и верните нужное; когда уверены, что остальное не нужно, — удалите папку в Finder.';
  if (!R.items) {
    main.innerHTML = `<h1>${title}</h1><p class="sub">${sub}</p><div class="empty"><span class="spin"></span></div>`;
    try { await loadReview(); } catch (e) { return showError(e); }
    if (state.view !== 'review') return;
  }
  const kinds = [...new Set(R.items.map(i => i.kind))];
  if (!kinds.length) {
    main.innerHTML = `<h1>${title}</h1><p class="sub">${sub}</p><div class="empty"><div class="big">✓</div><h2>Папки проверки пусты</h2></div>`;
    return;
  }
  if (!kinds.includes(R.kind)) { R.kind = kinds[0]; R.folder = '*'; }
  const ofKind = R.items.filter(i => i.kind === R.kind);
  const fl = [...new Set(ofKind.map(i => i.folder))].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
  if (R.folder !== '*' && !fl.includes(R.folder)) R.folder = '*';
  const shown = ofKind.filter(i => R.folder === '*' || i.folder === R.folder);
  const sum = a => a.reduce((t, i) => t + i.size + i.raw_size, 0);
  const sel = [...R.sel].filter(p => ofKind.some(i => i.path === p));
  main.innerHTML = `<h1>${title}</h1><p class="sub">${sub}</p>
    <div class="chips">${kinds.map(k => {
      const a = R.items.filter(i => i.kind === k);
      return `<div class="chip ${k === R.kind ? 'on' : ''}" data-kind="${esc(k)}">${esc(k)} · ${shots(a.length)} · ${gb(sum(a))}</div>`;
    }).join('')}</div>
    <div class="row" style="margin-bottom:16px">
      <select id="rfolder"><option value="*">Все папки (${ofKind.length})</option>${fl.map(f =>
        `<option value="${esc(f)}" ${f === R.folder ? 'selected' : ''}>${esc(f)} (${ofKind.filter(i => i.folder === f).length})</option>`).join('')}</select>
      <span class="mut">${gb(sum(shown))} вместе с RAW</span><span class="grow"></span>
      <button class="btn" id="rall">${shown.every(i => R.sel.has(i.path)) ? 'Снять выделение' : 'Выбрать все'}</button>
      <button class="btn" id="rshow">Показать в Finder</button>
      <button class="btn primary" id="rback" ${sel.length && !state.busy ? '' : 'disabled'}>Вернуть ${shots(sel.length)} в библиотеку</button>
    </div>
    <div class="grid">${shown.map(i => `
      <div class="cell ${R.sel.has(i.path) ? 'back' : ''}" data-path="${esc(i.path)}">
        <img data-path="${esc(i.path)}" alt=""><span class="tag">${R.sel.has(i.path) ? '↩ вернуть' : esc(i.folder)}</span>
        <span class="fname">${esc(i.name)}${i.raws ? ' + RAW' : ''}</span></div>`).join('')}</div>
    <div class="rv-foot"><span><kbd>клик</kbd> выбрать для возврата</span><span><kbd>двойной клик</kbd> открыть в Просмотре</span>
      <span>наведите и удерживайте <kbd>Z</kbd> — на весь экран</span></div>`;
  lazyThumbs(main, 640);
  main.querySelectorAll('.chip[data-kind]').forEach(c => (c.onclick = () => { R.kind = c.dataset.kind; R.folder = '*'; render(); }));
  $('#rfolder', main).onchange = e => { R.folder = e.target.value; render(); };
  $('#rall', main).onclick = () => {
    const all = shown.every(i => R.sel.has(i.path));
    shown.forEach(i => (all ? R.sel.delete(i.path) : R.sel.add(i.path)));
    render();
  };
  $('#rshow', main).onclick = async () => {
    const dir = await invoke('review_dir', { library: state.lib, kind: R.kind });
    opener.revealItemInDir(R.folder === '*' ? dir : dir + '/' + R.folder);
  };
  $('#rback', main).onclick = () => restoreSelected([...R.sel].filter(p => ofKind.some(i => i.path === p)));
  main.querySelectorAll('.cell').forEach(el => {
    const p = el.dataset.path;
    el.onclick = () => {
      R.sel.has(p) ? R.sel.delete(p) : R.sel.add(p);
      const on = R.sel.has(p);
      el.classList.toggle('back', on);
      el.querySelector('.tag').textContent = on ? '↩ вернуть' : R.items.find(i => i.path === p).folder;
      const n = [...R.sel].filter(q => ofKind.some(i => i.path === q)).length;
      const b = $('#rback', main);
      b.textContent = `Вернуть ${shots(n)} в библиотеку`;
      b.disabled = !n || state.busy;
    };
    el.ondblclick = () => opener.openPath(p);
    el.onmouseenter = () => (hoverPath = p);
  });
}

function restoreSelected(paths) {
  if (!paths.length) return;
  return task('restore', 'Возвращаю в библиотеку…', async () => {
    const n = await invoke('restore_from_review', { library: state.lib, paths });
    await loadReview();
    const t = toast(`Возвращено ${files(n)} на свои места <button class="btn" id="tUndo">Отменить</button>`, 12000);
    $('#tUndo', t).onclick = undo;
    render();
    state.dupes.groups = [];
    state.blurry.stale = true;
    if (state.recs) state.recs = await invoke('analyze', { library: state.lib });
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
  const title = 'Статистика';
  if (!state.recs) return needAnalysis(main, title, 'Сводка по настройкам съёмки и типичным проблемам.');
  const recs = scoped(state.scope.stats);
  const n = recs.length || 1;
  const pct = c => Math.round(100 * c / n) + '%';
  const shutter = r => (r.t ? 1 / r.t : null);

  const isoRows = bucket(recs, r => r.iso, [0, 400, 800, 1600, 3200, 6400, 12800], (a, b) => (b ? `${a || '≤'}–${b}` : `${a}+`));
  isoRows[0][0] = '< 400';
  const fRows = bucket(recs, r => r.f, [0, 2, 2.8, 4, 5.6, 8, 11], (a, b) => (b ? `f/${a}–${b}` : `f/${a}+`));
  fRows[0][0] = '< f/2';
  const tRows = bucket(recs, shutter, [0, 30, 60, 125, 250, 1000], (a, b) => (b ? `1/${a}–1/${b}` : `1/${a}+`));
  tRows[0][0] = 'длиннее 1/30';
  const flRows = bucket(recs, r => r.fl, [0, 18, 24, 35, 45, 55, 100], (a, b) => (b ? `${a}–${b} мм` : `${a}+ мм`));

  const issues = [];
  const add = (list, title, text) => list.length && issues.push({ list, title, text });
  add(recs.filter(r => r.iso >= 3200 && r.t && r.t <= 1 / 100), 'Высокий ISO при быстрой выдержке',
    'ISO 3200+ при выдержке 1/100 и короче. Для неподвижных сцен можно 1/30–1/60 (стабилизатор), ISO упадёт в 2–4 раза. В настройках авто-ISO: ISO AUTO SETTING → MIN. SHUTTER SPEED.');
  add(recs.filter(r => r.fl && r.t && r.t > 1 / (1.5 * r.fl) && r.t > 1 / 60), 'Риск смаза движения',
    'Выдержка длиннее 1/60 и длиннее «1/фокусное». Для детей в движении нужна 1/250.');
  add(recs.filter(r => r.f >= 11), 'Очень закрытая диафрагма (f/11+)',
    'Дифракция смягчает картинку, а ISO растёт. Часто — случайно задетый диск.');
  add(recs.filter(r => r.hi > 0.03), 'Пересвеченные участки',
    'Больше 3% кадра в белом. Попробуйте экспокоррекцию −2/3 или DR400; из RAF часть деталей можно вытянуть.');
  add(recs.filter(r => r.lo > 0.05), 'Провалы в тенях', 'Больше 5% кадра в чёрном.');
  const ends = recs.filter(r => r.fl && (Math.round(r.fl) <= 16 || Math.round(r.fl) >= 50)).length;

  main.innerHTML = `<h1>${title}</h1>
    <div class="row" style="margin:6px 0 18px">${scopeSelect('scope', state.scope.stats)}</div>
    <div class="kpis">
      <div class="kpi"><b>${recs.length.toLocaleString('ru')}</b><span>кадров JPG</span></div>
      <div class="kpi"><b>${pct(recs.filter(r => r.iso >= 3200).length)}</b><span>с ISO 3200+</span></div>
      <div class="kpi"><b>${pct(recs.filter(r => r.vertical).length)}</b><span>вертикальных</span></div>
      <div class="kpi"><b>${pct(ends)}</b><span>на крайних фокусных зума</span></div>
    </div>
    <div class="charts">
      <div class="panel"><h3>ISO</h3>${bars(isoRows, k => /^(3200|6400|12800)/.test(k))}</div>
      <div class="panel"><h3>Выдержка</h3>${bars(tRows, k => k.startsWith('длиннее'))}</div>
      <div class="panel"><h3>Диафрагма</h3>${bars(fRows, k => k.includes('f/11'))}</div>
      <div class="panel"><h3>Фокусное расстояние</h3>${bars(flRows)}</div>
    </div>
    <div class="panel"><h3>На что обратить внимание</h3>
      ${issues.length ? issues.map(i => `<div class="issue"><div class="cnt">${i.list.length}</div><div>
        <b>${i.title}</b> <span class="mut">· ${pct(i.list.length)}</span><p>${i.text}</p></div></div>`).join('') : '<div class="mut">Ничего подозрительного.</div>'}
    </div>`;
  $('#scope', main).onchange = e => { state.scope.stats = e.target.value; render(); };
}

// ---------- settings ----------

async function viewSettings(main) {
  const undoN = await invoke('undo_count', { library: state.lib }).catch(() => 0);
  if (state.view !== 'settings') return;
  main.innerHTML = `<h1>Настройки</h1><p class="sub">Библиотека — папка, куда импортируются фото и где ищутся дубли.</p>
    <div class="panel"><h3>Папка библиотеки</h3><div style="margin-bottom:10px">${esc(state.lib)}</div>
      <div class="row"><button class="btn" id="pick">Изменить…</button><button class="btn" id="reveal">Показать в Finder</button></div></div>
    <div class="panel"><h3>Перемещения в «_на проверку»</h3>
      <div class="mut" style="margin-bottom:10px">В истории ${plural(undoN, 'действие', 'действия', 'действий')}. Отмена возвращает файлы на прежние места.</div>
      <button class="btn" id="undo" ${undoN && !state.busy ? '' : 'disabled'}>Отменить последнее перемещение</button></div>
    <div class="panel"><h3>Кэш анализа</h3><div class="mut" style="margin-bottom:10px">Пересчитать, если папки менялись вручную.</div>
      <button class="btn" id="reanalyze" ${state.busy ? 'disabled' : ''}>Обновить анализ</button></div>`;
  $('#pick', main).onclick = async () => {
    const dir = await dialog.open({ directory: true, defaultPath: state.lib });
    if (!dir) return;
    try {
      const s = await invoke('set_library', { library: dir });
      setLib(s.library);
      render();
    } catch (e) { showError(e); }
  };
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
  }
  state.lib = lib;
  $('#lib').textContent = lib;
  $('#lib').title = lib;
}

// ---------- routing & keys ----------

const views = { import: viewImport, verify: viewVerify, dupes: viewDupes, blurry: viewBlurry, review: viewReview, mindful: viewMindful, stats: viewStats, settings: viewSettings };
function render() {
  const main = $('#main');
  main.classList.remove('fill');
  views[state.view](main);
}
function go(v) {
  state.view = v;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $('#main').scrollTop = 0;
  render();
  if (v === 'import' && state.card && !state.plan) scan();
}
document.querySelectorAll('#nav button').forEach(b => (b.onclick = () => go(b.dataset.view)));

let hoverPath = null;
addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.target.tagName === 'SELECT') return;
  const k = e.key.toLowerCase();
  if ((k === 'z' || k === 'я') && hoverPath && !e.repeat && ['dupes', 'blurry', 'review', 'mindful'].includes(state.view)) {
    const z = $('#zoom');
    z.querySelector('img').src = '';
    thumb(hoverPath, 2400).then(src => (z.querySelector('img').src = src));
    z.hidden = false;
    return;
  }
  const S = { blurry: state.blurry, mindful: state.mindful }[state.view];
  if (S?.items?.length) {
    if (k === 'arrowleft') { e.preventDefault(); swipeDecide(S, 'out'); }
    else if (k === 'arrowright') { e.preventDefault(); swipeDecide(S, 'keep'); }
    else if (k === 'backspace' || k === 'arrowup') { e.preventDefault(); swipeBack(S); }
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
  const s = await invoke('get_settings');
  setLib(s.library);
  render();
  await pollCards();
  setInterval(pollCards, 2500);
})();
