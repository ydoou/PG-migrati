'use strict';

/* ------------------------------------------------------------------ */
/* Connection form (rendered for both 'source' and 'target')          */
/* ------------------------------------------------------------------ */

function connFormHTML(conn) {
  // conn = 'source' | 'target'
  return `
    <div class="flex gap-2 text-xs mb-1">
      <button data-conn="${conn}" data-mode="url"    class="mode-btn px-2.5 py-1 rounded-md bg-ink-700 border border-ink-600">URL</button>
      <button data-conn="${conn}" data-mode="fields" class="mode-btn px-2.5 py-1 rounded-md bg-ink-700 border border-ink-600">Поля</button>
      <label class="ml-auto inline-flex items-center gap-2 text-slate-400">
        <input type="checkbox" data-conn="${conn}" data-field="ssl" class="accent-accent-500" />
        SSL
      </label>
    </div>

    <div data-conn="${conn}" data-pane="url" class="space-y-2">
      <label class="text-xs text-slate-400">Connection string</label>
      <input type="text"
             data-conn="${conn}" data-field="connectionString"
             placeholder="postgres://user:password@host:5432/database"
             class="field w-full px-3 py-2 rounded-lg text-sm font-mono" />
    </div>

    <div data-conn="${conn}" data-pane="fields" class="hidden grid grid-cols-2 gap-2">
      <div class="col-span-2">
        <label class="text-xs text-slate-400">Host</label>
        <input data-conn="${conn}" data-field="host" class="field w-full px-3 py-2 rounded-lg text-sm" placeholder="localhost" />
      </div>
      <div>
        <label class="text-xs text-slate-400">Port</label>
        <input data-conn="${conn}" data-field="port" class="field w-full px-3 py-2 rounded-lg text-sm" placeholder="5432" />
      </div>
      <div>
        <label class="text-xs text-slate-400">Database</label>
        <input data-conn="${conn}" data-field="database" class="field w-full px-3 py-2 rounded-lg text-sm" placeholder="postgres" />
      </div>
      <div>
        <label class="text-xs text-slate-400">User</label>
        <input data-conn="${conn}" data-field="user" class="field w-full px-3 py-2 rounded-lg text-sm" placeholder="postgres" />
      </div>
      <div>
        <label class="text-xs text-slate-400">Password</label>
        <input type="password" data-conn="${conn}" data-field="password" class="field w-full px-3 py-2 rounded-lg text-sm" placeholder="••••••••" />
      </div>
    </div>
  `;
}

const STATE = {
  source: { mode: 'url', ssl: false, connectionString: '', host: '', port: '', database: '', user: '', password: '' },
  target: { mode: 'url', ssl: false, connectionString: '', host: '', port: '', database: '', user: '', password: '' },
  schemas: [],          // all schemas reported by inspect
  selectedSchemas: new Set(),
  tables: [],
  job: null,
};

function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function renderConnForms() {
  for (const conn of ['source', 'target']) {
    const root = document.querySelector(`.conn-form[data-conn="${conn}"]`);
    root.innerHTML = connFormHTML(conn);
    setMode(conn, STATE[conn].mode);
  }
}

function setMode(conn, mode) {
  STATE[conn].mode = mode;
  document.querySelector(`[data-conn="${conn}"][data-pane="url"]`)
          .classList.toggle('hidden', mode !== 'url');
  document.querySelector(`[data-conn="${conn}"][data-pane="fields"]`)
          .classList.toggle('hidden', mode !== 'fields');
  $$(`.mode-btn[data-conn="${conn}"]`).forEach(btn => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('bg-accent-500', active);
    btn.classList.toggle('border-accent-500', active);
    btn.classList.toggle('text-white', active);
    btn.classList.toggle('bg-ink-700', !active);
    btn.classList.toggle('border-ink-600', !active);
  });
}

/* Capture all input changes inside connection cards */
document.addEventListener('input', (e) => {
  const t = e.target;
  if (!t.dataset || !t.dataset.conn || !t.dataset.field) return;
  const conn = t.dataset.conn, field = t.dataset.field;
  if (t.type === 'checkbox') STATE[conn][field] = t.checked;
  else STATE[conn][field] = t.value;
});

/* Mode + test buttons */
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn.classList.contains('mode-btn')) {
    setMode(btn.dataset.conn, btn.dataset.mode);
    return;
  }
  if (btn.dataset.action === 'test') {
    await testConnection(btn.dataset.conn);
    return;
  }
});

/* ------------------------------------------------------------------ */
/* API helpers                                                         */
/* ------------------------------------------------------------------ */

function buildConnPayload(conn) {
  const s = STATE[conn];
  if (s.mode === 'url') {
    return { connectionString: s.connectionString.trim(), ssl: !!s.ssl };
  }
  return {
    host: s.host.trim(),
    port: s.port ? Number(s.port) : 5432,
    user: s.user,
    password: s.password,
    database: s.database,
    ssl: !!s.ssl,
  };
}

async function testConnection(conn) {
  const status = document.querySelector(`[data-conn="${conn}"][data-role="status"]`);
  status.textContent = 'Проверяю…';
  status.className = 'mt-3 text-xs text-slate-400';
  try {
    const r = await fetch('/api/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection: buildConnPayload(conn) }),
    });
    const data = await r.json();
    if (data.ok) {
      status.innerHTML = `<span class="text-emerald-400">✓ ${escapeHtml(data.db)}</span>
        <span class="text-slate-500"> · ${escapeHtml(data.usr)} · ${escapeHtml((data.version || '').split(' on ')[0])}</span>`;
    } else {
      status.innerHTML = `<span class="text-rose-400">✗ ${escapeHtml(data.error || 'connection failed')}</span>`;
    }
  } catch (err) {
    status.innerHTML = `<span class="text-rose-400">✗ ${escapeHtml(err.message)}</span>`;
  }
}

async function inspectSource() {
  const list = $('#schemas-list');
  const summary = $('#tables-summary');
  list.innerHTML = '<span class="text-slate-400">Анализирую…</span>';
  summary.textContent = '';
  try {
    const r = await fetch('/api/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection: buildConnPayload('source') }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error);

    STATE.schemas = data.schemas;
    STATE.tables = data.tables;
    STATE.selectedSchemas = new Set(data.schemas); // select all by default

    if (data.schemas.length === 0) {
      list.innerHTML = '<span class="text-amber-400">В исходной БД нет пользовательских схем.</span>';
      return;
    }
    list.innerHTML = data.schemas.map(s => `
      <label class="inline-flex items-center gap-2 px-2.5 py-1 rounded-lg border border-ink-700 bg-ink-900/60 cursor-pointer hover:border-ink-600">
        <input type="checkbox" data-schema="${escapeAttr(s)}" checked class="accent-accent-500" />
        <span class="font-mono text-slate-200">${escapeHtml(s)}</span>
      </label>
    `).join('');

    list.querySelectorAll('input[data-schema]').forEach(input => {
      input.addEventListener('change', () => {
        if (input.checked) STATE.selectedSchemas.add(input.dataset.schema);
        else STATE.selectedSchemas.delete(input.dataset.schema);
        renderTablesSummary();
      });
    });
    renderTablesSummary();
  } catch (err) {
    list.innerHTML = `<span class="text-rose-400">✗ ${escapeHtml(err.message)}</span>`;
  }
}

function renderTablesSummary() {
  const sel = STATE.selectedSchemas;
  const tables = STATE.tables.filter(t => sel.has(t.schema));
  const totalRows = tables.reduce((acc, t) => acc + Number(t.approxRows || 0), 0);
  $('#tables-summary').innerHTML =
    `<span class="text-slate-300">${tables.length}</span> таблиц(ы) к копированию · ` +
    `~<span class="text-slate-300">${formatNumber(totalRows)}</span> строк (приблизительно)`;
}

/* ------------------------------------------------------------------ */
/* Run migration                                                       */
/* ------------------------------------------------------------------ */

async function runMigration() {
  const runBtn = $('#btn-run');
  runBtn.disabled = true;

  const includeSchemas = STATE.selectedSchemas.size > 0
    ? Array.from(STATE.selectedSchemas)
    : null;

  const body = {
    source: buildConnPayload('source'),
    target: buildConnPayload('target'),
    includeSchemas,
    cleanTarget:     $('#opt-clean').checked,
    skipExtensions:  $('#opt-skip-ext').checked,
    skipIndexes:     $('#opt-skip-idx').checked,
    skipViews:       $('#opt-skip-views').checked,
    disableTriggers: $('#opt-triggers').checked,
  };

  try {
    const r = await fetch('/api/migrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error);

    showProgress();
    subscribe(data.jobId);
  } catch (err) {
    runBtn.disabled = false;
    appendLog('error', err.message);
  }
}

function showProgress() {
  $('#progress-section').classList.remove('hidden');
  $('#log').innerHTML = '';
  $('#summary').classList.add('hidden');
  $('#summary').innerHTML = '';
  setTablesProgress(0, 0);
  setCurrentTableProgress(null, 0);
  setPhase('connect', 'Подключение…');
}

function subscribe(jobId) {
  const es = new EventSource(`/api/migrate/${jobId}/events`);
  es.onmessage = (msg) => {
    let evt;
    try { evt = JSON.parse(msg.data); } catch { return; }
    handleEvent(evt);
  };
  es.onerror = () => {
    es.close();
  };
}

let copiedTables = 0;
let totalTables = 0;

function handleEvent(evt) {
  if (evt.type === 'phase') {
    setPhase(evt.phase, evt.message);
    // Reset bars when entering a post-data phase so the same UI can be reused.
    if (['constraints', 'indexes', 'views'].includes(evt.phase)) {
      setMainBarLabel(phaseLabel(evt.phase));
      setTablesProgress(0, 0);
      setCurrentTable(null);
    } else if (evt.phase === 'data' || evt.phase === 'tables') {
      setMainBarLabel('Таблицы');
    }
  } else if (evt.type === 'log') {
    appendLog(evt.level || 'info', evt.message);
  } else if (evt.type === 'progress') {
    if (evt.scope === 'overall') {
      copiedTables = evt.copiedTables || 0;
      totalTables = evt.totalTables || totalTables;
      setTablesProgress(copiedTables, totalTables);
      if (evt.currentTable) setCurrentTable(evt.currentTable);
    } else if (evt.scope === 'table') {
      const label = `${evt.schema}.${evt.table}`;
      setCurrentTable(label, evt.bytes);
      if (evt.finished) {
        copiedTables += 1;
        setTablesProgress(copiedTables, totalTables);
      }
    } else if (evt.scope === 'post') {
      // Constraints / indexes / views progress: reuse the main progress bar.
      setMainBarLabel(phaseLabel(evt.phase));
      setTablesProgress(evt.current, evt.total);
      if (evt.currentName) {
        $('#current-table-label').textContent = `Сейчас: ${evt.currentName}`;
        $('#current-table-bytes').textContent = '';
        // Pseudo-progress within the current item.
        const pct = evt.total > 0 ? Math.round((evt.current / evt.total) * 100) : 0;
        $('#current-table-progress').style.width = pct + '%';
      }
    }
  } else if (evt.type === 'done') {
    setPhase('done', 'Миграция завершена');
    document.getElementById('phase-indicator').style.animation = 'none';
    document.getElementById('phase-indicator').style.background = '#10b981';
    showSummary(evt.summary, evt.tables);
    $('#btn-run').disabled = false;
  } else if (evt.type === 'error') {
    setPhase('error', 'Ошибка');
    document.getElementById('phase-indicator').style.animation = 'none';
    document.getElementById('phase-indicator').style.background = '#f43f5e';
    appendLog('error', evt.message);
    $('#btn-run').disabled = false;
  }
}

function setPhase(_phase, message) {
  $('#phase-title').textContent = message;
}

function setTablesProgress(done, total) {
  $('#tables-progress-label').textContent = `${done} / ${total}`;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  $('#tables-progress').style.width = pct + '%';
  $('#overall-stats').textContent = total > 0 ? `${pct}%` : '';
}

function setMainBarLabel(label) {
  const el = $('#main-bar-label');
  if (el) el.textContent = label;
}

function phaseLabel(phase) {
  return ({
    constraints: 'Ограничения',
    indexes:     'Индексы',
    views:       'Представления',
    tables:      'Таблицы',
    data:        'Таблицы',
  })[phase] || 'Прогресс';
}

function setCurrentTable(name, bytes) {
  $('#current-table-label').textContent = name ? `Сейчас: ${name}` : 'Текущая таблица';
  if (bytes != null) {
    $('#current-table-bytes').textContent = formatBytes(bytes);
    // The single-table bar is intentionally pseudo-indeterminate: we don't
    // know the total bytes ahead of time, so we use a saturating curve.
    const pct = Math.min(100, Math.round(100 * (1 - Math.exp(-bytes / (8 * 1024 * 1024)))));
    $('#current-table-progress').style.width = pct + '%';
  } else {
    $('#current-table-bytes').textContent = '';
    $('#current-table-progress').style.width = '0%';
  }
}

function setCurrentTableProgress(name, pct) {
  setCurrentTable(name);
  $('#current-table-progress').style.width = (pct || 0) + '%';
}

function appendLog(level, message) {
  const log = $('#log');
  const colors = {
    info:  'text-slate-300',
    warn:  'text-amber-300',
    error: 'text-rose-300',
  };
  const prefix = { info: '·', warn: '!', error: '✗' }[level] || '·';
  const div = document.createElement('div');
  div.className = `log-line ${colors[level] || 'text-slate-300'}`;
  div.textContent = `${prefix} ${message}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function showSummary(summary, tables) {
  if (!summary) return;
  const failed = (tables || []).filter(t => !t.ok);
  const ok = (tables || []).filter(t => t.ok);
  const totalBytes = ok.reduce((a, t) => a + (t.bytes || 0), 0);

  const node = $('#summary');
  node.classList.remove('hidden');
  node.innerHTML = `
    <div class="flex items-center justify-between mb-2">
      <h3 class="font-semibold text-emerald-300">Готово</h3>
      <span class="text-xs text-slate-400">${ok.length} / ${summary.tables} таблиц перенесено</span>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
      <div class="p-2 rounded-lg bg-ink-900/60 border border-ink-700">
        <div class="text-slate-400 text-xs">Схемы</div>
        <div class="font-semibold">${summary.schemas}</div>
      </div>
      <div class="p-2 rounded-lg bg-ink-900/60 border border-ink-700">
        <div class="text-slate-400 text-xs">Таблицы</div>
        <div class="font-semibold">${summary.copiedTables} / ${summary.tables}</div>
      </div>
      <div class="p-2 rounded-lg bg-ink-900/60 border border-ink-700">
        <div class="text-slate-400 text-xs">Объём данных</div>
        <div class="font-semibold">${formatBytes(totalBytes)}</div>
      </div>
      <div class="p-2 rounded-lg bg-ink-900/60 border border-ink-700">
        <div class="text-slate-400 text-xs">Ограничения / индексы</div>
        <div class="font-semibold">${summary.constraints} / ${
          summary.indexes > 0
            ? `${summary.createdIndexes ?? summary.indexes}/${summary.indexes}`
            : '0'
        }</div>
        ${summary.failedIndexes ? `<div class="text-xs text-amber-300 mt-0.5">Не удалось: ${summary.failedIndexes}</div>` : ''}
      </div>
    </div>
    ${failed.length > 0 ? `
      <div class="mt-3 text-xs">
        <div class="text-rose-300 font-medium mb-1">С ошибками: ${failed.length}</div>
        <ul class="list-disc list-inside text-rose-200/80 space-y-0.5">
          ${failed.map(t => `<li>${escapeHtml(t.schema)}.${escapeHtml(t.name)} — ${escapeHtml(t.error || '')}</li>`).join('')}
        </ul>
      </div>` : ''}
  `;
}

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function escapeAttr(s) { return escapeHtml(s); }

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  const u = ['KB','MB','GB','TB'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(2) + ' ' + u[i];
}
function formatNumber(n) {
  return Number(n).toLocaleString('ru-RU');
}

/* ------------------------------------------------------------------ */
/* Wire up                                                             */
/* ------------------------------------------------------------------ */

renderConnForms();
$('#btn-inspect').addEventListener('click', inspectSource);
$('#btn-run').addEventListener('click', runMigration);
$('#btn-clear-log').addEventListener('click', () => { $('#log').innerHTML = ''; });
