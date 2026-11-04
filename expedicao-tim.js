// ============================================================
// APP EXPEDIÇÃO TIM - MÓDULO INTEGRADO CTDI
// ============================================================

const STATE = {
  reportData: [],        // array of row objects from xlsx (mapped)
  rawData: [],           // raw rows from xlsx (original)
  rawHeaders: [],        // original column headers
  columnMap: {},         // { palletId, model, qty, boxes, ... }
  lots: [],              // array of lot objects
  currentLotId: null,
  selectedForGroup: [],  // pallet IDs pending grouping
  pendingRawData: null,  // raw xlsx before confirming import
  pendingHeaders: [],
};

const COL_KEYS = [
  { key: 'palletId', label: 'Pallet ID', icon: '🔖', required: true, desc: 'Coluna que identifica o Pallet (ex: PALLET)' },
  { key: 'boxId',    label: 'Caixa',     icon: '📦', required: true, desc: 'Coluna da Caixa (ex: CAIXA)' },
  { key: 'model',    label: 'Modelo',    icon: '🏷️', required: true, desc: 'Coluna do Modelo (ex: MODELO)' },
  { key: 'serial',   label: 'Nº Série',  icon: '🔑', required: false, desc: 'Coluna do Serial (ex: SERIAL)' },
  { key: 'dest',     label: 'Destino',   icon: '📍', required: false, desc: 'Coluna de Localidade/Destino (ex: LOCALIDADE)' },
];

// Logo oficial CTDI localizado na raiz da aplicação
const CTDI_LOGO_BASE64 = "logo.png";

// ============================================================
// PADRONIZAÇÃO DE PALLET ID: P000000000 (P + 9 DÍGITOS)
// ============================================================
function standardizePalletId(id) {
  if (!id) return '';
  const str = String(id).trim();
  const digits = str.replace(/\D/g, '');
  if (digits) {
    const num = parseInt(digits, 10);
    if (!isNaN(num)) {
      return 'P' + String(num).padStart(9, '0');
    }
  }
  return str.toUpperCase();
}

// ============================================================
// INDEXAÇÃO & CONSOLIDAÇÃO INTELIGENTE
// ============================================================
function buildPalletIndex() {
  const index = {};
  for (let i = 0; i < STATE.reportData.length; i++) {
    const r = STATE.reportData[i];
    const rawId = String(r.palletId || '').trim();
    if (!rawId) continue;
    const stdId = standardizePalletId(rawId);

    if (!index[stdId]) {
      index[stdId] = {
        palletId: stdId,
        rawId: rawId,
        models: new Set(),
        boxes: new Set(),
        destinations: new Set(),
        unitCount: 0,
        serials: []
      };
    }
    const p = index[stdId];
    p.unitCount++;
    const box = r.boxId || r.boxes;
    if (box) p.boxes.add(String(box).trim());
    if (r.model) p.models.add(String(r.model).trim());
    if (r.dest) p.destinations.add(String(r.dest).trim());
    if (r.serial) p.serials.push(String(r.serial).trim());

    if (rawId !== stdId && !index[rawId]) {
      index[rawId] = p;
    }
  }
  STATE.palletIndex = index;
}

function getPalletSummary(palletId) {
  if (!STATE.palletIndex) buildPalletIndex();
  const raw = String(palletId || '').trim();
  const std = standardizePalletId(raw);
  const p = STATE.palletIndex[std] || STATE.palletIndex[raw];
  if (!p) return null;
  return {
    palletId: p.palletId,
    rawId: p.rawId,
    model: [...p.models].join(', ') || '—',
    totalUnits: p.unitCount,
    totalBoxes: p.boxes.size,
    dest: [...p.destinations].join(', ') || '—',
    boxesList: [...p.boxes],
  };
}

function getGroupSummary(palletIds) {
  if (!STATE.palletIndex) buildPalletIndex();
  const models = new Set();
  const allBoxes = new Set();
  const destinations = new Set();
  let totalUnits = 0;
  (palletIds || []).forEach(id => {
    const raw = String(id || '').trim();
    const std = standardizePalletId(raw);
    const p = STATE.palletIndex[std] || STATE.palletIndex[raw];
    if (p) {
      totalUnits += p.unitCount;
      p.boxes.forEach(b => allBoxes.add(b));
      p.models.forEach(m => models.add(m));
      p.destinations.forEach(d => destinations.add(d));
    }
  });
  return {
    totalUnits,
    totalBoxes: allBoxes.size,
    model: [...models].join(', ') || '—',
    dest: [...destinations].join(', ') || '—',
  };
}

// ============================================================
// PERSISTÊNCIA COMPLETA (INDEXEDDB + LOCALSTORAGE + BACKUP JSON)
// ============================================================
const IDB_NAME = 'ExpedicaoTimDB';
const IDB_VERSION = 1;
const IDB_STORE = 'app_state';

function openAppIDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      return reject(new Error('IndexedDB indisponível neste navegador.'));
    }
    const req = window.indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function idbSaveState(payload) {
  try {
    const db = await openAppIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([IDB_STORE], 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      store.put(payload, 'main_state');
      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
  } catch(e) {
    console.warn('IndexedDB save aviso:', e);
    return false;
  }
}

async function idbLoadState() {
  try {
    const db = await openAppIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([IDB_STORE], 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const req = store.get('main_state');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e.target.error);
    });
  } catch(e) {
    console.warn('IndexedDB load aviso:', e);
    return null;
  }
}

async function idbClearState() {
  try {
    const db = await openAppIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([IDB_STORE], 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      store.clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
  } catch(e) {
    console.warn('IndexedDB clear aviso:', e);
    return false;
  }
}

function sanitizeLots() {
  if (!Array.isArray(STATE.lots)) STATE.lots = [];
  const globalSeenPallets = new Set();
  let foundAnyDuplicate = false;

  STATE.lots.forEach(lot => {
    if (!lot) return;
    if (!Array.isArray(lot.groups)) lot.groups = [];
    lot.groups.forEach((g, idx) => {
      if (!g) return;
      if (!Array.isArray(g.palletIds)) g.palletIds = [];
      if (!g.number) g.number = idx + 1;

      const cleanPalletIds = [];
      g.palletIds.forEach(rawId => {
        const stdId = standardizePalletId(rawId);
        if (!stdId) return;
        if (!globalSeenPallets.has(stdId)) {
          globalSeenPallets.add(stdId);
          cleanPalletIds.push(stdId);
        } else {
          foundAnyDuplicate = true;
          console.warn(`[Sanitize] Pallet duplicado purgado: ${stdId} no Grupo #${g.number} do Lote #${lot.number}`);
        }
      });
      g.palletIds = cleanPalletIds;
    });

    lot.groups = lot.groups.filter(g => Array.isArray(g.palletIds) && g.palletIds.length > 0);
    lot.groups.forEach((g, idx) => { g.number = idx + 1; });
  });

  if (Array.isArray(STATE.selectedForGroup)) {
    const cleanPending = [];
    const seenPending = new Set();
    STATE.selectedForGroup.forEach(rawId => {
      const stdId = standardizePalletId(rawId);
      if (!stdId || seenPending.has(stdId) || globalSeenPallets.has(stdId)) return;
      seenPending.add(stdId);
      cleanPending.push(stdId);
    });
    STATE.selectedForGroup = cleanPending;
  }

  if (foundAnyDuplicate) {
    console.info('[Sanitize] Saneamento de pallets duplicados concluído.');
  }
}

let syncServerTimer = null;

async function syncStateWithServer(payload) {
  if (syncServerTimer) clearTimeout(syncServerTimer);
  syncServerTimer = setTimeout(async () => {
    try {
      const user = (typeof currentUser !== 'undefined' && currentUser && currentUser.username) ? currentUser.username : 'ADMIN';
      const bodyPayload = payload || {
        reportData: STATE.reportData || [],
        rawData: STATE.rawData || [],
        rawHeaders: STATE.rawHeaders || [],
        columnMap: STATE.columnMap || {},
        lots: STATE.lots || [],
        lastResponsavel: localStorage.getItem('last_exp_responsavel') || '',
        usuario: user
      };

      const res = await fetch('/api/expedicao-tim/sync-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload)
      });
      if (res.ok) {
        updateSaveIndicator('server');
      } else {
        updateSaveIndicator('local');
      }
    } catch(err) {
      console.warn('PostgreSQL sync offline (salvo localmente no navegador):', err);
      updateSaveIndicator('local');
    }
  }, 350);
}

function saveState() {
  try {
    localStorage.setItem('exp_lots', JSON.stringify(STATE.lots || []));
    localStorage.setItem('exp_colmap', JSON.stringify(STATE.columnMap || {}));
    localStorage.setItem('exp_last_saved', new Date().toISOString());
  } catch(e) {
    console.error('Erro ao salvar lotes no localStorage:', e);
  }

  try {
    localStorage.setItem('exp_report', JSON.stringify(STATE.reportData || []));
  } catch(quotaErr) {
    console.info('Relatório ultrapassa cota do localStorage (~5MB). Salvo com segurança no IndexedDB.');
  }

  try {
    localStorage.removeItem('exp_rawdata');
    localStorage.removeItem('exp_rawhdrs');
  } catch(e) {}

  const fullPayload = {
    savedAt: new Date().toISOString(),
    lots: STATE.lots || [],
    columnMap: STATE.columnMap || {},
    reportData: STATE.reportData || [],
    rawData: STATE.rawData || [],
    rawHeaders: STATE.rawHeaders || [],
    currentLotId: STATE.currentLotId || null,
    lastResponsavel: localStorage.getItem('last_exp_responsavel') || '',
    usuario: (typeof currentUser !== 'undefined' && currentUser && currentUser.username) ? currentUser.username : 'ADMIN'
  };
  idbSaveState(fullPayload);

  // Sincronizar com o banco PostgreSQL no servidor
  syncStateWithServer(fullPayload);

  buildPalletIndex();
  updateStorageBar();
  updateSaveIndicator('saving');
}

async function loadStateFromServer() {
  try {
    const res = await fetch('/api/expedicao-tim/state');
    if (!res.ok) {
      updateSaveIndicator('local');
      return;
    }
    const data = await res.json();
    if (!data || !data.success) {
      updateSaveIndicator('local');
      return;
    }

    let hasServerData = false;

    if (Array.isArray(data.reportData) && data.reportData.length > 0) {
      STATE.reportData = data.reportData;
      STATE.rawData = data.rawData || [];
      STATE.rawHeaders = data.rawHeaders || [];
      hasServerData = true;
    }

    if (data.columnMap && Object.keys(data.columnMap).length > 0) {
      STATE.columnMap = data.columnMap;
      hasServerData = true;
    }

    if (Array.isArray(data.lots)) {
      if (data.lots.length > 0 || (STATE.lots && STATE.lots.length === 0)) {
        STATE.lots = data.lots;
        hasServerData = true;
      }
    }

    if (data.lastResponsavel) {
      localStorage.setItem('last_exp_responsavel', data.lastResponsavel);
    }

    if (hasServerData) {
      sanitizeLots();
      buildPalletIndex();
      renderDashboard();
      updateStorageBar();
      updateSaveIndicator('server');

      const activePage = document.querySelector('#expedicao-tim .page.active');
      if (activePage) {
        if (activePage.id === 'page-lots') renderLotsList();
        else if (activePage.id === 'page-report') renderReportTable();
        else if (activePage.id === 'page-lot-detail' && STATE.currentLotId) renderLotDetail();
      }
    } else {
      // Se o banco central estiver vazio mas tivermos dados locais, migra automaticamente para o PostgreSQL
      if ((STATE.lots && STATE.lots.length > 0) || (STATE.reportData && STATE.reportData.length > 0)) {
        console.info('Migrando dados locais para o banco central PostgreSQL...');
        syncStateWithServer();
      } else {
        updateSaveIndicator('server');
      }
    }
  } catch(err) {
    console.warn('Banco central indisponível no momento. Usando dados locais salvos:', err);
    updateSaveIndicator('local');
  }
}

function loadState() {
  try {
    STATE.lots       = JSON.parse(localStorage.getItem('exp_lots')   || '[]');
    STATE.columnMap  = JSON.parse(localStorage.getItem('exp_colmap') || '{}');
    STATE.reportData = JSON.parse(localStorage.getItem('exp_report') || '[]');
    localStorage.removeItem('exp_rawdata');
    localStorage.removeItem('exp_rawhdrs');
  } catch(e) {
    console.warn('Erro ao carregar do localStorage:', e);
  }

  sanitizeLots();
  buildPalletIndex();

  idbLoadState().then(saved => {
    if (!saved) return;
    let needsRefresh = false;

    if (Array.isArray(saved.reportData) && saved.reportData.length > (STATE.reportData ? STATE.reportData.length : 0)) {
      STATE.reportData = saved.reportData;
      if (Array.isArray(saved.rawData) && saved.rawData.length > 0) {
        STATE.rawData = saved.rawData;
        STATE.rawHeaders = saved.rawHeaders || [];
      }
      needsRefresh = true;
    }

    if (saved.columnMap && Object.keys(saved.columnMap).length > Object.keys(STATE.columnMap || {}).length) {
      STATE.columnMap = saved.columnMap;
      needsRefresh = true;
    }

    if (Array.isArray(saved.lots) && saved.lots.length > 0) {
      if (!STATE.lots || STATE.lots.length === 0 || saved.lots.length >= STATE.lots.length) {
        STATE.lots = saved.lots;
        needsRefresh = true;
      }
    }

    if (saved.lastResponsavel && !localStorage.getItem('last_exp_responsavel')) {
      localStorage.setItem('last_exp_responsavel', saved.lastResponsavel);
    }

    if (needsRefresh) {
      sanitizeLots();
      buildPalletIndex();
      renderDashboard();
      updateStorageBar();

      const activePage = document.querySelector('#expedicao-tim .page.active');
      if (activePage) {
        if (activePage.id === 'page-lots') renderLotsList();
        else if (activePage.id === 'page-report') renderReportTable();
        else if (activePage.id === 'page-lot-detail' && STATE.currentLotId) renderLotDetail();
      }
    }
  }).catch(err => {
    console.warn('IndexedDB load warning:', err);
  }).finally(() => {
    // Após carregar localmente, sincroniza com o banco central PostgreSQL
    loadStateFromServer();
  });
}

function updateStorageBar() {
  try {
    const lotsCount = (STATE.lots || []).length;
    const reportCount = (STATE.reportData || []).length;
    const reportStr = localStorage.getItem('exp_report') || '';
    const lotsStr   = localStorage.getItem('exp_lots') || '';
    const approxBytes = Math.max(reportStr.length + lotsStr.length, (reportCount * 120) + (lotsCount * 500));
    const kb = Math.round(approxBytes / 1024);

    const pctEl = document.getElementById('storage-pct');
    const fillEl = document.getElementById('storage-fill');
    const statusEl = document.getElementById('storage-status-text');

    if (pctEl) {
      if (kb < 1024) pctEl.textContent = `${kb} KB`;
      else pctEl.textContent = `${(kb / 1024).toFixed(1)} MB`;
    }
    if (fillEl) {
      const pct = Math.min(100, Math.max(approxBytes > 0 ? 12 : 0, Math.round((kb / 5000) * 100)));
      fillEl.style.width = pct + '%';
    }
    if (statusEl) {
      statusEl.textContent = `${lotsCount} lote(s) · ${reportCount} linha(s)`;
    }
  } catch(e) { console.warn(e); }
}

function updateSaveIndicator(mode) {
  const badge = document.getElementById('topbar-badge');
  if (badge) {
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (mode === 'server') {
      badge.innerHTML = `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#10b981;margin-right:4px;"></span> Banco PostgreSQL (${timeStr})`;
      badge.title = 'Todas as informações estão sincronizadas e salvas no banco de dados central PostgreSQL!';
      badge.style.borderColor = 'rgba(16,185,129,0.4)';
      badge.style.color = '#6ee7b7';
    } else if (mode === 'saving') {
      badge.innerHTML = `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#3b82f6;margin-right:4px;"></span> Salvando...`;
      badge.title = 'Salvando no banco de dados...';
    } else if (mode === 'local') {
      badge.innerHTML = `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#f59e0b;margin-right:4px;"></span> Salvo Local (${timeStr})`;
      badge.title = 'Salvo no navegador local (offline). Sincronizará com o banco assim que a conexão restabelecer.';
      badge.style.borderColor = 'rgba(245,158,11,0.4)';
      badge.style.color = '#fcd34d';
    } else {
      badge.innerHTML = `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#10b981;margin-right:4px;"></span> Salvo (${timeStr})`;
      badge.title = 'Salvo no banco de dados central e navegador.';
    }
  }
}

// ============================================================
// BACKUP MANUAL & RESTAURAÇÃO (JSON)
// ============================================================
function exportDataBackup() {
  try {
    const backupObj = {
      app: 'APP EXPEDIÇÃO TIM',
      version: '1.0',
      exportedAt: new Date().toISOString(),
      reportData: STATE.reportData || [],
      rawData: STATE.rawData || [],
      rawHeaders: STATE.rawHeaders || [],
      columnMap: STATE.columnMap || {},
      lots: STATE.lots || [],
      currentLotId: STATE.currentLotId || null,
      lastResponsavel: localStorage.getItem('last_exp_responsavel') || ''
    };
    const jsonStr = JSON.stringify(backupObj, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateStr = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `backup_expedicao_tim_${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Backup baixado com sucesso!', 'success');
  } catch(err) {
    console.error('Erro ao exportar backup:', err);
    showToast('Falha ao exportar backup: ' + err.message, 'danger');
  }
}

function triggerRestoreBackup() {
  const input = document.getElementById('backup-file-input');
  if (input) {
    input.value = '';
    input.click();
  }
}

function importDataBackup(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data || typeof data !== 'object') {
        throw new Error('Formato de arquivo JSON inválido.');
      }
      if (!confirm('Deseja restaurar as informações deste backup? Todos os lotes e relatórios serão carregados.')) {
        return;
      }

      if (Array.isArray(data.reportData)) STATE.reportData = data.reportData;
      if (Array.isArray(data.rawData)) STATE.rawData = data.rawData;
      if (Array.isArray(data.rawHeaders)) STATE.rawHeaders = data.rawHeaders;
      if (data.columnMap && typeof data.columnMap === 'object') STATE.columnMap = data.columnMap;
      if (Array.isArray(data.lots)) STATE.lots = data.lots;
      if (data.currentLotId) STATE.currentLotId = data.currentLotId;
      if (data.lastResponsavel) localStorage.setItem('last_exp_responsavel', data.lastResponsavel);

      sanitizeLots();
      buildPalletIndex();
      saveState();

      renderDashboard();
      renderLotsList();
      if (STATE.reportData.length > 0) renderReportTable();
      updateStorageBar();

      showToast(`Backup restaurado com sucesso! (${STATE.lots.length} lotes carregados)`, 'success');
    } catch(err) {
      console.error('Erro ao restaurar backup:', err);
      showToast('Erro ao restaurar backup: ' + err.message, 'danger');
    }
  };
  reader.readAsText(file);
}

// ============================================================
// NAVIGATION (INTERNA DA EXPEDIÇÃO TIM)
// ============================================================
const PAGE_TITLES = {
  dashboard:  ['Dashboard', 'Visão geral do sistema de expedição'],
  import:     ['Importar Relatório', 'Carregue o arquivo de embalagem .xlsx'],
  report:     ['Dados Importados', 'Visão consolidada de pallets do relatório'],
  lots:       ['Lotes de Expedição', 'Criação e gestão de lotes'],
  'lot-detail': ['Detalhe do Lote', 'Bipagem e agrupamento de pallets'],
};

function showPage(page) {
  const scope = document.getElementById('expedicao-tim');
  if (!scope) return;

  scope.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  scope.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const el = scope.querySelector('#page-' + page);
  if (el) el.classList.add('active');

  const navEl = scope.querySelector('#nav-' + page);
  if (navEl) navEl.classList.add('active');

  const [title, sub] = PAGE_TITLES[page] || [page, ''];
  const tEl = document.getElementById('topbar-title');
  const sEl = document.getElementById('topbar-subtitle');
  if (tEl) tEl.textContent = title;
  if (sEl) sEl.textContent = sub;

  if (page === 'dashboard')   renderDashboard();
  if (page === 'report')      renderReportTable();
  if (page === 'lots')        renderLotsList();
  if (page === 'lot-detail')  renderLotDetail();
}

// ============================================================
// AUDIO FEEDBACK & TOAST
// ============================================================
function playBeep(type = 'error') {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    if (type === 'error') {
      osc.frequency.setValueAtTime(260, ctx.currentTime);
      osc.frequency.setValueAtTime(180, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.35);
    } else if (type === 'success') {
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.25);
    }
  } catch(e) {
    // AudioContext silenciosamente ignorado se o navegador exigir interação prévia
  }
}

function showToast(msg, type = 'success') {
  const icons = { success:'✅', error:'❌', warning:'⚠️', info:'ℹ️' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type]||'ℹ️'}</span><span class="toast-msg">${msg}</span>`;
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ============================================================
// MODAL
// ============================================================
function openModal(id) { 
  const el = document.getElementById(id);
  if (el) el.classList.add('open'); 
}
function closeModal(id) { 
  const el = document.getElementById(id);
  if (el) el.classList.remove('open'); 
}

// ============================================================
// FILE IMPORT
// ============================================================
let UPLOAD_ZONE = null;

function handleFileUpload(e) {
  const file = e.target.files && e.target.files[0];
  if (file) processFile(file);
}

function processFile(file) {
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const workbook = XLSX.read(e.target.result, { type: 'array' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const raw = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });

      if (!raw.length) { showToast('Planilha vazia ou sem dados.', 'error'); return; }

      STATE.pendingRawData = raw;
      STATE.pendingHeaders = Object.keys(raw[0]);
      showImportPreview(file.name, raw);
    } catch(err) {
      showToast('Erro ao ler arquivo: ' + err.message, 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

function showImportPreview(filename, raw) {
  const fEl = document.getElementById('import-filename');
  const rEl = document.getElementById('import-rows-count');
  const prev = document.getElementById('import-preview');
  const upZ = document.getElementById('upload-zone');
  if (fEl) fEl.textContent = '📄 ' + filename;
  if (rEl) rEl.textContent = raw.length + ' linhas encontradas (seriais/peças)';
  if (prev) prev.style.display = 'block';
  if (upZ) upZ.style.display = 'none';

  buildColumnMapping(STATE.pendingHeaders);
  buildPreviewTable(raw.slice(0, 10), STATE.pendingHeaders);
}

function buildColumnMapping(headers) {
  const grid = document.getElementById('col-map-grid');
  if (!grid) return;
  grid.innerHTML = '';
  COL_KEYS.forEach(col => {
    const guessed = autoGuessColumn(col.key, headers);
    const sampleVal = (STATE.pendingRawData && STATE.pendingRawData[0])
      ? String(STATE.pendingRawData[0][guessed] || '').slice(0, 28)
      : '';
    grid.innerHTML += `
      <div class="form-group" style="margin:0">
        <label class="form-label">${col.icon} ${col.label}${col.required ? ' <span style="color:var(--exp-danger)">*</span>' : ''}</label>
        <div style="font-size:11px;color:var(--exp-text-muted);margin-bottom:4px;">${col.desc || ''}</div>
        <select class="form-select" id="colmap-${col.key}" onchange="updateColSample('${col.key}', this)">
          <option value="">-- Selecione --</option>
          ${headers.map(h => {
            const sv = (STATE.pendingRawData && STATE.pendingRawData[0]) ? String(STATE.pendingRawData[0][h]||'').slice(0,20) : '';
            return `<option value="${h}" ${h===guessed?'selected':''}>${h} ${sv ? '→ '+sv : ''}</option>`;
          }).join('')}
        </select>
        <div id="sample-${col.key}" style="font-size:11px;color:#93c5fd;margin-top:4px;min-height:16px;">${sampleVal ? '📄 Exemplo: '+sampleVal : ''}</div>
      </div>`;
  });
}

function updateColSample(colKey, sel) {
  const h = sel.value;
  const sampleDiv = document.getElementById('sample-' + colKey);
  if (!sampleDiv) return;
  if (!h) { sampleDiv.textContent = ''; return; }
  const raw = STATE.pendingRawData || STATE.rawData || [];
  const val = raw[0] ? String(raw[0][h] || '').slice(0, 40) : '';
  sampleDiv.textContent = val ? '📄 Exemplo: ' + val : '';
}

function autoGuessColumn(key, headers) {
  const patterns = {
    palletId: ['pallet', 'pallet id', 'pallet_id', 'id pallet', 'id_pallet', 'plt'],
    boxId:    ['caixa', 'caixas', 'box', 'boxes', 'id caixa', 'id_caixa', 'cod_caixa', 'volume', 'embalagem'],
    model:    ['modelo', 'model', 'cod produto', 'cod_produto', 'codigo produto', 'sku', 'referencia'],
    serial:   ['serial', 'serie', 'série', 'numero serie', 'nº serie', 'nr serie', 'mac'],
    dest:     ['localidade', 'destino', 'dest', 'destination', 'cliente', 'operadora', 'carrier'],
  };
  const lower = headers.map(h => h.toLowerCase().trim());
  const matches = patterns[key] || [];
  for (const p of matches) {
    const idx = lower.findIndex(h => h === p);
    if (idx >= 0) return headers[idx];
  }
  for (const p of matches) {
    const idx = lower.findIndex(h => h.includes(p));
    if (idx >= 0) return headers[idx];
  }
  return '';
}

function buildPreviewTable(rows, headers) {
  const table = document.getElementById('preview-table');
  if (!table) return;
  table.innerHTML = `
    <thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r=>`<tr>${headers.map(h=>`<td>${r[h]??''}</td>`).join('')}</tr>`).join('')}</tbody>`;
}

function cancelImport() {
  STATE.pendingRawData = null;
  STATE.pendingHeaders = [];
  const prev = document.getElementById('import-preview');
  const upZ = document.getElementById('upload-zone');
  const fInput = document.getElementById('file-input');
  if (prev) prev.style.display = 'none';
  if (upZ) upZ.style.display = 'block';
  if (fInput) fInput.value = '';
}

function confirmImport() {
  const map = {};
  let valid = true;
  COL_KEYS.forEach(col => {
    const sel = document.getElementById('colmap-' + col.key);
    if (sel) {
      map[col.key] = sel.value || null;
      if (col.required && !sel.value) valid = false;
    }
  });
  if (!valid) { showToast('Mapeie todas as colunas obrigatórias (*) antes de confirmar.', 'warning'); return; }

  STATE.columnMap = map;
  STATE.rawData    = STATE.pendingRawData;
  STATE.rawHeaders = STATE.pendingHeaders;
  STATE.reportData = applyMapToRaw(STATE.rawData, map);

  buildPalletIndex();
  saveState();

  const totalPallets = Object.keys(STATE.palletIndex || {}).length;
  showToast(`${STATE.reportData.length} peças consolidadas em ${totalPallets} pallets!`, 'success');
  cancelImport();
  showPage('report');
}

function applyMapToRaw(rawRows, map) {
  return rawRows.map((row, idx) => {
    const obj = { _idx: idx };
    COL_KEYS.forEach(col => {
      obj[col.key] = map[col.key] ? (row[map[col.key]] ?? '') : '';
    });
    if (!obj.boxId && obj.boxes) obj.boxId = obj.boxes;
    return obj;
  }).filter(r => r.palletId !== '');
}

function openRemap() {
  if (!STATE.rawHeaders.length || !STATE.rawData.length) {
    const grid = document.getElementById('remap-col-grid');
    if (grid) grid.innerHTML = '';
    const samplesDiv = document.getElementById('remap-samples');
    if (samplesDiv) {
      samplesDiv.innerHTML = `
        <div style="background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:var(--exp-radius-md);padding:14px;">
          <div style="font-size:13px;font-weight:700;color:#fcd34d;margin-bottom:6px;">⚠️ Reimportação Recomendada</div>
          <div style="font-size:12px;color:var(--exp-text-secondary);line-height:1.6;">
            Para aplicar o novo mapeamento com consolidação automática de caixas e peças,
            por favor <strong>reimporte o seu arquivo .xlsx</strong>.<br>
            O sistema já vai detectar automaticamente as colunas corretas (PALLET, CAIXA, MODELO, etc).
          </div>
          <div style="margin-top:14px;">
            <button class="btn btn-primary" onclick="closeModal('modal-remap');showPage('import')">📥 Ir para Importar Relatório</button>
          </div>
        </div>`;
    }
    openModal('modal-remap');
    return;
  }

  const grid = document.getElementById('remap-col-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const sampleRow = STATE.rawData[0] || {};

  COL_KEYS.forEach(col => {
    const current = STATE.columnMap[col.key] || autoGuessColumn(col.key, STATE.rawHeaders);
    grid.innerHTML += `
      <div class="form-group" style="margin:0">
        <label class="form-label">${col.icon} ${col.label}${col.required ? ' <span style="color:var(--exp-danger)">*</span>' : ''}</label>
        <div style="font-size:10px;color:var(--exp-text-muted);margin-bottom:2px;">${col.desc || ''}</div>
        <select class="form-select" id="remap-${col.key}" onchange="updateColSample('remap-s-${col.key}', this)">
          <option value="">-- Nenhuma --</option>
          ${STATE.rawHeaders.map(h => {
            const sv = String(sampleRow[h]||'').slice(0,22);
            return `<option value="${h}" ${h===current?'selected':''}>${h}${sv?' → '+sv:''}</option>`;
          }).join('')}
        </select>
        <div id="remap-s-${col.key}" style="font-size:10px;color:#93c5fd;margin-top:3px;min-height:14px;">
          ${current && sampleRow[current] ? '📄 Ex: '+String(sampleRow[current]).slice(0,40) : ''}
        </div>
      </div>`;
  });

  const samplesDiv = document.getElementById('remap-samples');
  if (samplesDiv) {
    samplesDiv.innerHTML = `
      <div style="font-size:11px;font-weight:700;color:var(--exp-text-muted);margin-bottom:6px;">📋 Valores de exemplo (1ª linha do arquivo):</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;">
        ${STATE.rawHeaders.map(h => `
          <div style="background:rgba(255,255,255,0.04);border:1px solid var(--exp-border);border-radius:6px;padding:4px 8px;">
            <span style="font-size:10px;color:var(--exp-text-muted);">${h}:</span>
            <span style="font-size:11px;font-weight:600;margin-left:4px;">${String(sampleRow[h]||'').slice(0,20)}</span>
          </div>`).join('')}
      </div>`;
  }

  openModal('modal-remap');
}

function applyRemap() {
  const map = {};
  let valid = true;
  COL_KEYS.forEach(col => {
    const sel = document.getElementById('remap-' + col.key);
    if (sel) {
      map[col.key] = sel.value || null;
      if (col.required && !sel.value) valid = false;
    }
  });
  if (!valid) { showToast('Mapeie todas as colunas obrigatórias (*).', 'warning'); return; }

  STATE.columnMap  = map;
  STATE.reportData = applyMapToRaw(STATE.rawData, map);
  buildPalletIndex();
  saveState();
  closeModal('modal-remap');
  const totalPallets = Object.keys(STATE.palletIndex || {}).length;
  showToast(`Mapeamento atualizado! ${totalPallets} pallets consolidados.`, 'success');
  renderReportTable();
}

// ============================================================
// TABELA DE DADOS IMPORTADOS (CONSOLIDAÇÃO POR PALLET)
// ============================================================
function renderReportTable() {
  if (!STATE.palletIndex) buildPalletIndex();
  const wrap = document.getElementById('report-table-wrap');
  if (!wrap) return;
  const search = (document.getElementById('report-search')?.value || '').toLowerCase();
  const meta = document.getElementById('report-meta');

  const pallets = Object.values(STATE.palletIndex || {});
  if (!pallets.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📋</div><h3>Nenhum dado importado</h3><p>Importe um relatório de embalagem primeiro.</p></div>`;
    if (meta) meta.textContent = '';
    const remapBtn = document.getElementById('btn-remap');
    if (remapBtn) remapBtn.style.display = 'none';
    return;
  }
  const remapBtn = document.getElementById('btn-remap');
  if (remapBtn) remapBtn.style.display = 'inline-flex';

  const filtered = search
    ? pallets.filter(p => p.palletId.toLowerCase().includes(search) || [...p.models].some(m => m.toLowerCase().includes(search)) || [...p.destinations].some(d => d.toLowerCase().includes(search)))
    : pallets;

  const totalUnits = pallets.reduce((acc, p) => acc + p.unitCount, 0);
  const totalBoxes = pallets.reduce((acc, p) => acc + p.boxes.size, 0);
  if (meta) {
    meta.textContent = `${filtered.length} de ${pallets.length} pallets consolidados (${totalUnits} peças, ${totalBoxes} caixas no total)`;
  }

  wrap.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>🔖 Pallet ID</th>
          <th>🏷️ Modelo</th>
          <th>🔢 Qtd. Peças (Unidades)</th>
          <th>📦 Qtd. Caixas</th>
          <th>📍 Destino / Localidade</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>${filtered.map(p => {
        const loc = findPalletGlobalLocation(p.palletId);
        const statusBadge = loc
          ? `<span class="badge badge-green font-mono" title="Lote #${loc.lotNumber} (${loc.lotStatus})">Lote #${loc.lotNumber}</span>`
          : '<span class="badge badge-blue">Disponível</span>';
        return `<tr ${loc ? 'style="opacity:.65"' : ''}>
          <td><span class="badge badge-blue font-mono">${p.palletId}</span></td>
          <td>${[...p.models].join(', ') || '—'}</td>
          <td><strong style="color:#6ee7b7">${p.unitCount}</strong></td>
          <td><strong style="color:#fcd34d">${p.boxes.size}</strong></td>
          <td>${[...p.destinations].join(', ') || '—'}</td>
          <td>${statusBadge}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
}

function findPalletGlobalLocation(rawPalletId) {
  const stdId = standardizePalletId(rawPalletId);
  if (!stdId) return null;

  // 1. Checa em todos os lotes e grupos (aberto, finalizado ou expedido)
  for (const lot of (STATE.lots || [])) {
    if (!lot || !Array.isArray(lot.groups)) continue;
    for (const grp of lot.groups) {
      if (!grp || !Array.isArray(grp.palletIds)) continue;
      const match = grp.palletIds.some(id => standardizePalletId(id) === stdId);
      if (match) {
        return {
          found: true,
          type: 'group',
          palletId: stdId,
          lotId: lot.id,
          lotNumber: lot.number,
          lotDest: lot.dest || '',
          lotStatus: lot.status || 'aberto',
          groupId: grp.id,
          groupNumber: grp.number,
          isCurrentLot: Boolean(STATE.currentLotId && lot.id === STATE.currentLotId)
        };
      }
    }
  }

  // 2. Checa se está na lista de seleção pendente (área de agrupamento) do lote ativo
  if (Array.isArray(STATE.selectedForGroup)) {
    const inPending = STATE.selectedForGroup.some(id => standardizePalletId(id) === stdId);
    if (inPending) {
      const curLot = getCurrentLot();
      return {
        found: true,
        type: 'pending',
        palletId: stdId,
        lotId: curLot ? curLot.id : null,
        lotNumber: curLot ? curLot.number : null,
        lotDest: curLot ? curLot.dest : '',
        lotStatus: curLot ? curLot.status : 'aberto',
        isCurrentLot: true
      };
    }
  }

  return null;
}

function isInAnyLot(palletId) {
  return findPalletGlobalLocation(palletId) !== null;
}

function clearReport() {
  if (!confirm('Tem certeza que deseja apagar todos os dados importados?')) return;
  STATE.reportData = [];
  STATE.rawData = [];
  STATE.rawHeaders = [];
  STATE.columnMap = {};
  STATE.palletIndex = {};
  saveState();
  fetch('/api/expedicao-tim/report', { method: 'DELETE' }).catch(err => console.warn('Erro ao limpar do banco:', err));
  renderReportTable();
  showToast('Dados do relatório removidos do banco e da tela.', 'warning');
}

// ============================================================
// LOTS
// ============================================================
function openNewLotModal() {
  const destEl = document.getElementById('lot-dest');
  const obsEl = document.getElementById('lot-obs');
  if (destEl) destEl.value = '';
  if (obsEl) obsEl.value = '';
  openModal('modal-new-lot');
}

function createNewLot() {
  const destEl = document.getElementById('lot-dest');
  const dest = destEl ? destEl.value.trim() : '';
  if (!dest) { showToast('Informe o destino do lote.', 'warning'); return; }

  const obsEl = document.getElementById('lot-obs');
  const lot = {
    id: 'LOT-' + Date.now(),
    number: STATE.lots.length + 1,
    dest,
    obs: obsEl ? obsEl.value.trim() : '',
    createdAt: new Date().toLocaleString('pt-BR'),
    status: 'aberto',
    groups: [],
  };
  STATE.lots.unshift(lot);
  saveState();
  closeModal('modal-new-lot');
  showToast(`Lote #${lot.number} criado com sucesso!`, 'success');
  openLotDetail(lot.id);
}

function openLotDetail(lotId) {
  STATE.currentLotId = lotId;
  STATE.selectedForGroup = [];
  showPage('lot-detail');
}

function getCurrentLot() {
  return STATE.lots.find(l => l.id === STATE.currentLotId);
}

// ============================================================
// SCANNING (BIPAGEM COM ENTER AUTOMÁTICO)
// ============================================================
let scanDebounceTimer = null;

function handleScanInput(e) {
  const val = e.target.value.trim();
  if (scanDebounceTimer) clearTimeout(scanDebounceTimer);
  if (!val) return;

  if (STATE.palletIndex && STATE.palletIndex[val]) {
    scanDebounceTimer = setTimeout(() => {
      processScan();
    }, 60);
    return;
  }

  if (val.length >= 3) {
    scanDebounceTimer = setTimeout(() => {
      processScan();
    }, 180);
  }
}

function handleScanKey(e) {
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    if (scanDebounceTimer) clearTimeout(scanDebounceTimer);
    processScan();
  }
}

let isProcessingScan = false;

function processScan() {
  if (scanDebounceTimer) clearTimeout(scanDebounceTimer);
  if (isProcessingScan) return;

  const lot = getCurrentLot();
  if (!lot) return;
  if (lot.status !== 'aberto') {
    playBeep('error');
    showToast('Este lote já foi finalizado ou expedido.', 'warning');
    return;
  }

  const input = document.getElementById('scan-input');
  if (!input) return;
  const raw = input.value.trim();
  if (!raw) return;

  // IMEDIATO: Limpa o input no instante zero para travar disparo duplo de Enter ou leitor rápido
  input.value = '';
  isProcessingScan = true;

  try {
    const ids = raw.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    const batchSeen = new Set();
    let addedAny = false;

    for (const rawId of ids) {
      if (!rawId) continue;
      const palletId = standardizePalletId(rawId);
      if (!palletId) continue;

      if (batchSeen.has(palletId)) {
        playBeep('error');
        showToast(`⚠️ Pallet ${palletId} duplicado na mesma leitura.`, 'warning');
        continue;
      }
      batchSeen.add(palletId);

      // Trava Global de Unicidade: impede duplicar no mesmo lote OU em qualquer outro lote da expedição!
      const loc = findPalletGlobalLocation(palletId);
      if (loc) {
        playBeep('error');
        if (loc.isCurrentLot) {
          if (loc.type === 'pending') {
            showToast(`⚠️ Pallet ${palletId} já está na área de agrupamento deste lote!`, 'warning');
          } else {
            showToast(`⚠️ Pallet ${palletId} já está adicionado ao Grupo #${loc.groupNumber} deste lote!`, 'warning');
          }
        } else {
          const stMap = { aberto: 'Em Aberto', finalizado: 'Finalizado', expedido: 'Expedido' };
          const st = stMap[loc.lotStatus] || loc.lotStatus;
          showToast(`🚫 Bloqueado: Pallet ${palletId} já foi bipado no Lote #${loc.lotNumber} (${loc.lotDest || 'Sem destino'} · ${st})!`, 'error');
        }
        continue;
      }

      const p = getPalletSummary(palletId);
      if (!p && STATE.reportData.length > 0) {
        showToast(`Pallet ${palletId} não encontrado no relatório importado.`, 'info');
      }

      if (p && p.totalBoxes >= 30) {
        const group = {
          id: 'GRP-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
          number: lot.groups.length + 1,
          palletIds: [palletId],
          createdAt: new Date().toLocaleString('pt-BR'),
        };
        lot.groups.push(group);
        saveState();
        playBeep('success');
        showToast(`✅ Pallet completo ${palletId} (${p.totalBoxes} caixas) adicionado automaticamente ao lote!`, 'success');
        addedAny = true;
      } else {
        STATE.selectedForGroup.push(palletId);
        saveState();
        playBeep('success');
        const bCount = p ? p.totalBoxes : 0;
        showToast(`📦 Pallet ${palletId} com ${bCount} caixa(s) adicionado à área de agrupamento.`, 'info');
        addedAny = true;
      }
    }

    if (addedAny) {
      renderLotDetail();
    }
  } finally {
    isProcessingScan = false;
    setTimeout(() => {
      const inp = document.getElementById('scan-input');
      if (inp) inp.focus();
    }, 50);
  }
}

function toggleGroupSelection(palletId) {
  const stdId = standardizePalletId(palletId);
  const idx = STATE.selectedForGroup.findIndex(id => standardizePalletId(id) === stdId);
  if (idx >= 0) {
    STATE.selectedForGroup.splice(idx, 1);
  } else {
    const loc = findPalletGlobalLocation(stdId);
    if (loc && loc.type === 'group') {
      playBeep('error');
      showToast(`Pallet ${stdId} já está alocado no Grupo #${loc.groupNumber} do Lote #${loc.lotNumber}!`, 'warning');
      return;
    }
    STATE.selectedForGroup.push(stdId);
  }
  saveState();
  renderPendingGroup();
}

function clearSelection() {
  STATE.selectedForGroup = [];
  saveState();
  renderLotDetail();
}

function createGroup() {
  const lot = getCurrentLot();
  if (!lot || !STATE.selectedForGroup || STATE.selectedForGroup.length === 0) return;

  // Deduplica usando standardizePalletId e valida se nenhum já está alocado
  const uniqueIds = [];
  const seenInGroup = new Set();
  for (const rawId of STATE.selectedForGroup) {
    const stdId = standardizePalletId(rawId);
    if (!stdId || seenInGroup.has(stdId)) continue;
    seenInGroup.add(stdId);

    const loc = findPalletGlobalLocation(stdId);
    if (loc && loc.type === 'group') {
      showToast(`Pallet ${stdId} já está alocado em um grupo e foi desconsiderado.`, 'warning');
      continue;
    }
    uniqueIds.push(stdId);
  }

  if (uniqueIds.length === 0) {
    STATE.selectedForGroup = [];
    saveState();
    renderLotDetail();
    showToast('Nenhum pallet válido restante para agrupar.', 'warning');
    return;
  }

  const sum = getGroupSummary(uniqueIds);
  if (sum.totalBoxes > 30) {
    if (!confirm(`Atenção: A soma das caixas selecionadas (${sum.totalBoxes} caixas) ultrapassa o limite padrão de 30 caixas por pallet físico. Deseja agrupar mesmo assim?`)) {
      return;
    }
  }

  const group = {
    id: 'GRP-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
    number: lot.groups.length + 1,
    palletIds: uniqueIds,
    createdAt: new Date().toLocaleString('pt-BR'),
  };
  lot.groups.push(group);
  STATE.selectedForGroup = [];
  saveState();
  playBeep('success');
  showToast(`Grupo #${group.number} formado com ${group.palletIds.length} pallet(s) (${sum.totalBoxes} caixas, ${sum.totalUnits} peças).`, 'success');
  renderLotDetail();
}

function ungroup(groupId) {
  const lot = getCurrentLot();
  if (!lot) return;
  const grp = lot.groups.find(g => g.id === groupId);
  if (!grp) return;

  lot.groups = lot.groups.filter(g => g.id !== groupId);
  lot.groups.forEach((g, i) => g.number = i + 1);

  grp.palletIds.forEach(id => {
    const stdId = standardizePalletId(id);
    if (!stdId) return;
    if (!STATE.selectedForGroup.some(selId => standardizePalletId(selId) === stdId)) {
      STATE.selectedForGroup.push(stdId);
    }
  });

  saveState();
  renderLotDetail();
  showToast(`Grupo #${grp.number} desagrupado! Os pallets voltaram para a seleção pendente.`, 'info');
}

function removeGroup(groupId) {
  const lot = getCurrentLot();
  if (!lot) return;
  if (!confirm('Deseja remover este grupo do lote?')) return;
  lot.groups = lot.groups.filter(g => g.id !== groupId);
  lot.groups.forEach((g, i) => g.number = i + 1);
  saveState();
  renderLotDetail();
  showToast('Grupo removido do lote.', 'warning');
}

function finalizeLot() {
  const lot = getCurrentLot();
  if (!lot) return;
  if (!lot.groups.length) { showToast('Adicione ao menos um grupo antes de finalizar.', 'warning'); return; }
  if (!confirm(`Finalizar o lote #${lot.number}? Não será possível adicionar mais pallets diretamente.`)) return;
  lot.status = 'finalizado';
  saveState();
  showToast(`Lote #${lot.number} finalizado com sucesso! Agora você pode expedir este lote.`, 'success');
  renderLotDetail();
  renderLotsList();
  renderDashboard();
}

function reopenLot(lotId) {
  const lot = lotId ? STATE.lots.find(l => l.id === lotId) : getCurrentLot();
  if (!lot) return;
  if (!confirm(`Reabrir o lote #${lot.number}? O status voltará para "Em Aberto" e permitirá adicionar pallets.`)) return;
  lot.status = 'aberto';
  saveState();
  renderLotDetail();
  renderLotsList();
  renderDashboard();
  showToast(`Lote #${lot.number} reaberto com sucesso.`, 'info');
}

function revertExpedicao(lotId) {
  const lot = lotId ? STATE.lots.find(l => l.id === lotId) : getCurrentLot();
  if (!lot) return;
  if (!confirm(`Deseja estornar a expedição do lote #${lot.number}? O status voltará para "Finalizado".`)) return;

  const allPalletIds = (lot.groups || []).flatMap(g => (g.palletIds || []).map(standardizePalletId));
  const palletSet = new Set(allPalletIds);
  const lotSerials = new Set();
  allPalletIds.forEach(pId => {
    const p = STATE.palletIndex ? STATE.palletIndex[pId] : null;
    if (p && Array.isArray(p.serials)) {
      p.serials.forEach(s => { const c = String(s||'').trim(); if (c) lotSerials.add(c); });
    }
  });
  (STATE.reportData || []).forEach(r => {
    if (palletSet.has(standardizePalletId(r.palletId)) && r.serial) {
      const c = String(r.serial).trim();
      if (c) lotSerials.add(c);
    }
  });

  const loteIdent = (lot.expeditionData && lot.expeditionData.loteIdent) ? lot.expeditionData.loteIdent : `${lot.number}_${new Date().getFullYear().toString().slice(-2)}`;

  lot.status = 'finalizado';
  saveState();
  renderLotDetail();
  renderLotsList();
  renderDashboard();

  fetch(`/api/expedicao-tim/lote/${encodeURIComponent(lot.id)}/estornar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      loteIdent,
      serials: Array.from(lotSerials)
    })
  }).then(r => r.json()).then(res => {
    if (res && res.revertedUnits !== undefined) {
      console.info(`[Estorno] ${res.revertedUnits} unidades retornadas para 'Recebida'.`);
    }
  }).catch(err => console.warn('Erro ao notificar backend sobre estorno:', err));

  showToast(`Expedição do lote #${lot.number} estornada.`, 'warning');
}

let CURRENT_EXP_LOT_ID = null;
let CURRENT_ROMANEIO_LOT_ID = null;

function openExpedirModal(lotId) {
  const lot = lotId ? STATE.lots.find(l => l.id === lotId) : getCurrentLot();
  if (!lot) return;
  CURRENT_EXP_LOT_ID = lot.id;

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const defaultDataHora = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}  ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const yearSuffix = now.getFullYear().toString().slice(-2);
  const defaultLoteIdent = `${lot.number}_${yearSuffix}`;
  const defaultVolume = `${pad(lot.groups.length)} / PALLETS`;

  const exp = lot.expeditionData || {};
  const lastResp = localStorage.getItem('last_exp_responsavel') || '';

  const respEl = document.getElementById('exp-responsavel');
  const dtEl = document.getElementById('exp-datahora');
  const cliEl = document.getElementById('exp-cliente');
  const destEl = document.getElementById('exp-destino');
  const nfEl = document.getElementById('exp-nf');
  const natEl = document.getElementById('exp-natureza');
  const volEl = document.getElementById('exp-volume');
  const identEl = document.getElementById('exp-lote-ident');
  const transpEl = document.getElementById('exp-transportadora');
  const motEl = document.getElementById('exp-motorista');
  const rgEl = document.getElementById('exp-rgcpf');
  const placaEl = document.getElementById('exp-placa');
  const ajudEl = document.getElementById('exp-ajudante');

  if (respEl) respEl.value = exp.responsavel || lastResp;
  if (dtEl) dtEl.value = exp.dataHora || defaultDataHora;
  if (cliEl) cliEl.value = exp.cliente || 'TIM';
  if (destEl) destEl.value = exp.destino || lot.dest || '';
  if (nfEl) nfEl.value = exp.nf || '';
  if (natEl) natEl.value = exp.natureza || 'RETORNO DE CONSERTO';
  if (volEl) volEl.value = exp.volume || defaultVolume;
  if (identEl) identEl.value = exp.loteIdent || defaultLoteIdent;
  if (transpEl) transpEl.value = exp.transportadora || '';
  if (motEl) motEl.value = exp.motorista || '';
  if (rgEl) rgEl.value = exp.rgCpf || '';
  if (placaEl) placaEl.value = exp.placa || '';
  if (ajudEl) ajudEl.value = exp.ajudante || '';

  openModal('modal-expedir-lote');
}

function confirmExpedicao() {
  const lot = CURRENT_EXP_LOT_ID ? STATE.lots.find(l => l.id === CURRENT_EXP_LOT_ID) : getCurrentLot();
  if (!lot) return;

  const responsavel = document.getElementById('exp-responsavel')?.value.trim() || '';
  const dataHora = document.getElementById('exp-datahora')?.value.trim() || '';
  const cliente = document.getElementById('exp-cliente')?.value.trim() || 'TIM';
  const destino = document.getElementById('exp-destino')?.value.trim() || lot.dest || '';
  const nf = document.getElementById('exp-nf')?.value.trim() || '';
  const natureza = document.getElementById('exp-natureza')?.value.trim() || 'RETORNO DE CONSERTO';
  const volume = document.getElementById('exp-volume')?.value.trim() || '';
  const loteIdent = document.getElementById('exp-lote-ident')?.value.trim() || `${lot.number}_${new Date().getFullYear().toString().slice(-2)}`;
  const transportadora = document.getElementById('exp-transportadora')?.value.trim() || '';
  const motorista = document.getElementById('exp-motorista')?.value.trim() || '';
  const rgCpf = document.getElementById('exp-rgcpf')?.value.trim() || '';
  const placa = document.getElementById('exp-placa')?.value.trim() || '';
  const ajudante = document.getElementById('exp-ajudante')?.value.trim() || '';

  if (responsavel) {
    localStorage.setItem('last_exp_responsavel', responsavel);
  }

  lot.expeditionData = {
    responsavel,
    dataHora,
    cliente,
    destino,
    nf,
    natureza,
    volume,
    loteIdent,
    transportadora,
    motorista,
    rgCpf,
    placa,
    ajudante,
    expedidoEm: new Date().toISOString()
  };
  lot.status = 'expedido';

  // Coletar pallets e seriais de todas as unidades contidas no lote
  const allPalletIds = (lot.groups || []).flatMap(g => (g.palletIds || []).map(standardizePalletId));
  const palletSet = new Set(allPalletIds);
  const lotSerials = new Set();

  allPalletIds.forEach(pId => {
    const p = STATE.palletIndex ? STATE.palletIndex[pId] : null;
    if (p && Array.isArray(p.serials)) {
      p.serials.forEach(s => {
        const clean = String(s || '').trim();
        if (clean) lotSerials.add(clean);
      });
    }
  });

  (STATE.reportData || []).forEach(r => {
    if (palletSet.has(standardizePalletId(r.palletId)) && r.serial) {
      const clean = String(r.serial).trim();
      if (clean) lotSerials.add(clean);
    }
  });

  const serialsArray = Array.from(lotSerials);

  // Notificar backend para atualizar status das unidades para 'Expedida' no banco de dados
  fetch(`/api/expedicao-tim/lote/${encodeURIComponent(lot.id)}/expedir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expeditionData: lot.expeditionData,
      serials: serialsArray,
      pallets: allPalletIds
    })
  }).then(r => r.json()).then(res => {
    if (res && res.updatedUnits !== undefined) {
      console.info(`[Expedição] ${res.updatedUnits} unidades marcadas com status 'Expedida' no banco de dados.`);
    }
  }).catch(err => {
    console.warn('Erro ao notificar backend sobre unidades expedidas:', err);
  });

  saveState();
  closeModal('modal-expedir-lote');
  renderLotDetail();
  renderLotsList();
  renderDashboard();

  showToast(`Lote #${lot.number} expedido com sucesso! Romaneio gerado.`, 'success');
  openRomaneioModal(lot.id);
}

function openRomaneioModal(lotId) {
  const lot = lotId ? STATE.lots.find(l => l.id === lotId) : getCurrentLot();
  if (!lot) return;
  CURRENT_ROMANEIO_LOT_ID = lot.id;

  const preview = document.getElementById('romaneio-paper-preview');
  if (preview) {
    preview.innerHTML = buildRomaneioHtml(lot);
  }
  openModal('modal-romaneio');
}

function editCurrentExpedition() {
  closeModal('modal-romaneio');
  if (CURRENT_ROMANEIO_LOT_ID) {
    openExpedirModal(CURRENT_ROMANEIO_LOT_ID);
  }
}

function buildRomaneioHtml(lot) {
  const exp = lot.expeditionData || {};
  const yearSuffix = new Date().getFullYear().toString().slice(-2);
  const loteIdent = exp.loteIdent || `${lot.number}_${yearSuffix}`;
  const pad = n => String(n).padStart(2, '0');
  const volumeStr = exp.volume || `___${pad(lot.groups.length)}___ / _PALLETS`;

  let totalUnits = 0;
  let totalBoxes = 0;
  const allPalletIds = [];
  const modelMap = {};

  const rowsHtml = lot.groups.map((g, idx) => {
    const summary = getGroupSummary(g.palletIds);
    const units = summary.totalUnits || 0;
    const boxes = summary.totalBoxes || 0;
    totalUnits += units;
    totalBoxes += boxes;

    const stdPalletIds = g.palletIds.map(standardizePalletId);
    stdPalletIds.forEach(id => allPalletIds.push(id));
    const palletName = stdPalletIds.join('/');

    const mName = summary.model && summary.model !== '—' ? summary.model : 'MODELO NÃO ESPECIFICADO';
    if (!modelMap[mName]) {
      modelMap[mName] = { pallets: 0, boxes: 0, units: 0 };
    }
    modelMap[mName].pallets += 1;
    modelMap[mName].boxes += boxes;
    modelMap[mName].units += units;

    return `
      <tr>
        <td style="border:1px solid #000;padding:5px 6px;text-align:center;font-size:12px;font-weight:bold;color:#000;">${pad(g.number || idx + 1)}</td>
        <td class="pallet-code-cell" style="border:1px solid #000;padding:5px 8px;text-align:center;font-size:12px;font-family:monospace,Arial,sans-serif;font-weight:bold;color:#000;word-break:break-all;">${palletName}</td>
        <td style="border:1px solid #000;padding:5px 8px;text-align:center;font-size:11.5px;color:#000;">${summary.model || '—'}</td>
        <td style="border:1px solid #000;padding:5px 6px;text-align:center;font-size:12px;font-weight:bold;color:#92400e;">${boxes} cx</td>
        <td style="border:1px solid #000;padding:5px 8px;text-align:center;font-size:12px;font-weight:bold;color:#000;">${units > 0 ? units : '#N/D'}</td>
      </tr>
    `;
  }).join('');

  const modelEntries = Object.entries(modelMap);
  const modelRowsHtml = modelEntries.map(([mName, mData]) => `
    <tr>
      <td style="border:1px solid #000;padding:5px 8px;font-size:11.5px;font-weight:600;color:#000;">${mName}</td>
      <td style="border:1px solid #000;padding:5px 6px;text-align:center;font-size:11.5px;color:#000;">${mData.pallets}</td>
      <td style="border:1px solid #000;padding:5px 6px;text-align:center;font-size:11.5px;font-weight:bold;color:#92400e;">${mData.boxes} cx</td>
      <td style="border:1px solid #000;padding:5px 8px;text-align:center;font-size:11.5px;font-weight:bold;color:#000;">${mData.units}</td>
    </tr>
  `).join('');

  return `
    <div class="romaneio-paper" id="romaneio-paper" style="background:#ffffff;color:#000000;padding:28px 36px;font-family:Arial,Helvetica,sans-serif;border-radius:4px;max-width:640px;margin:0 auto;box-shadow:0 4px 20px rgba(0,0,0,0.35);text-align:left;">
      <!-- CTDI Logo -->
      <div style="display:flex;justify-content:center;margin-bottom:18px;">
        <img src="${CTDI_LOGO_BASE64}" alt="CTDI" style="max-height:54px;max-width:260px;object-fit:contain;display:block;" />
      </div>

      <!-- Fields list -->
      <div style="font-size:12px;color:#000000;line-height:1.75;font-weight:bold;text-align:left;">
        <div class="rom-field-row" style="margin-bottom:2px;display:flex;align-items:flex-end;text-align:left;">
          <span class="rom-label" style="white-space:nowrap;margin-right:6px;text-align:left;">RESPONSÁVEL EXPEDIÇÃO:</span>
          <span class="rom-val" style="flex:1;border-bottom:1px solid #000;padding-bottom:1px;min-height:16px;text-align:left;">${exp.responsavel || ''}</span>
        </div>
        <div class="rom-field-row" style="margin-bottom:2px;display:flex;align-items:flex-end;text-align:left;">
          <span class="rom-label" style="white-space:nowrap;margin-right:6px;text-align:left;">DATA E HORA:</span>
          <span class="rom-val" style="flex:1;border-bottom:1px solid #000;padding-bottom:1px;min-height:16px;text-align:left;">${exp.dataHora || ''}</span>
        </div>
        <div class="rom-field-row" style="margin-bottom:2px;display:flex;align-items:flex-end;text-align:left;">
          <span class="rom-label" style="white-space:nowrap;margin-right:6px;text-align:left;">CLIENTE:</span>
          <span class="rom-val" style="flex:1;border-bottom:1px solid #000;padding-bottom:1px;min-height:16px;text-align:left;">${exp.cliente || 'TIM'}</span>
        </div>
        <div class="rom-field-row" style="margin-bottom:2px;display:flex;align-items:flex-end;text-align:left;">
          <span class="rom-label" style="white-space:nowrap;margin-right:6px;text-align:left;">DESTINO:</span>
          <span class="rom-val" style="flex:1;border-bottom:1px solid #000;padding-bottom:1px;min-height:16px;text-align:left;">${exp.destino || ''}</span>
        </div>
        <div class="rom-field-row" style="margin-bottom:2px;display:flex;align-items:flex-end;text-align:left;">
          <span class="rom-label" style="white-space:nowrap;margin-right:6px;text-align:left;">NF:</span>
          <span class="rom-val" style="flex:1;border-bottom:1px solid #000;padding-bottom:1px;min-height:16px;text-align:left;">${exp.nf || ''}</span>
        </div>

        <div style="height:8px;"></div>

        <div class="rom-field-row" style="margin-bottom:2px;display:flex;align-items:flex-end;text-align:left;">
          <span class="rom-label" style="white-space:nowrap;margin-right:6px;text-align:left;">NATUREZA OPERAÇÃO:</span>
          <span class="rom-val" style="flex:1;border-bottom:1px solid #000;padding-bottom:1px;min-height:16px;text-align:left;">${exp.natureza || 'RETORNO DE CONSERTO'}</span>
        </div>

        <div style="height:8px;"></div>

        <div class="rom-field-row" style="margin-bottom:2px;display:flex;align-items:flex-end;text-align:left;">
          <span class="rom-label" style="white-space:nowrap;margin-right:6px;text-align:left;">VOLUME:</span>
          <span class="rom-val" style="flex:1;border-bottom:1px solid #000;padding-bottom:1px;min-height:16px;text-align:left;">${volumeStr}</span>
        </div>
        <div class="rom-field-row" style="margin-bottom:2px;display:flex;align-items:flex-end;text-align:left;">
          <span class="rom-label" style="white-space:nowrap;margin-right:6px;text-align:left;">TRANSPORTADORA:</span>
          <span class="rom-val" style="flex:1;border-bottom:1px solid #000;padding-bottom:1px;min-height:16px;text-align:left;">${exp.transportadora || ''}</span>
        </div>
        <div class="rom-field-row" style="margin-bottom:2px;display:flex;align-items:flex-end;text-align:left;">
          <span class="rom-label" style="white-space:nowrap;margin-right:6px;text-align:left;">MOTORISTA:</span>
          <span class="rom-val" style="flex:1;border-bottom:1px solid #000;padding-bottom:1px;min-height:16px;text-align:left;">${exp.motorista || ''}</span>
        </div>
        <div class="rom-field-row" style="margin-bottom:2px;display:flex;align-items:flex-end;text-align:left;">
          <span class="rom-label" style="white-space:nowrap;margin-right:6px;text-align:left;">RG/CPF:</span>
          <span class="rom-val" style="flex:1;border-bottom:1px solid #000;padding-bottom:1px;min-height:16px;text-align:left;">${exp.rgCpf || ''}</span>
        </div>
        <div class="rom-field-row" style="margin-bottom:2px;display:flex;align-items:flex-end;text-align:left;">
          <span class="rom-label" style="white-space:nowrap;margin-right:6px;text-align:left;">PLACA VEÍCULO:</span>
          <span class="rom-val" style="flex:1;border-bottom:1px solid #000;padding-bottom:1px;min-height:16px;text-align:left;">${exp.placa || ''}</span>
        </div>
        <div class="rom-field-row" style="margin-bottom:2px;display:flex;align-items:flex-end;text-align:left;">
          <span class="rom-label" style="white-space:nowrap;margin-right:6px;text-align:left;">AJUDANTE:</span>
          <span class="rom-val" style="flex:1;border-bottom:1px solid #000;padding-bottom:1px;min-height:16px;text-align:left;">${exp.ajudante || ''}</span>
        </div>
        <div class="rom-field-row" style="margin-bottom:2px;display:flex;align-items:flex-end;text-align:left;">
          <span class="rom-label" style="white-space:nowrap;margin-right:6px;text-align:left;">ASSINATURA:</span>
          <span class="rom-val" style="flex:1;border-bottom:1px solid #000;padding-bottom:1px;min-height:16px;text-align:left;"></span>
        </div>
      </div>

      <!-- Resumo Rápido (Cards de Doca) -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:16px;margin-bottom:12px;">
        <div style="border:1px solid #000;padding:5px;text-align:center;background:#f8fafc;border-radius:3px;">
          <div style="font-size:9.5px;font-weight:bold;text-transform:uppercase;color:#475569;">Pallets Físicos</div>
          <div style="font-size:15px;font-weight:900;color:#1e3a8a;">${pad(lot.groups.length)}</div>
        </div>
        <div style="border:1px solid #000;padding:5px;text-align:center;background:#f8fafc;border-radius:3px;">
          <div style="font-size:9.5px;font-weight:bold;text-transform:uppercase;color:#475569;">Pallet IDs</div>
          <div style="font-size:15px;font-weight:900;color:#581c87;">${pad(allPalletIds.length)}</div>
        </div>
        <div style="border:1px solid #000;padding:5px;text-align:center;background:#f8fafc;border-radius:3px;">
          <div style="font-size:9.5px;font-weight:bold;text-transform:uppercase;color:#475569;">Total Caixas</div>
          <div style="font-size:15px;font-weight:900;color:#92400e;">${totalBoxes}</div>
        </div>
        <div style="border:1px solid #000;padding:5px;text-align:center;background:#f8fafc;border-radius:3px;">
          <div style="font-size:9.5px;font-weight:bold;text-transform:uppercase;color:#475569;">Total Peças</div>
          <div style="font-size:15px;font-weight:900;color:#065f46;">${totalUnits}</div>
        </div>
      </div>

      <!-- Table Detalhada -->
      <div style="margin-top:8px;">
        <table style="width:100%;border-collapse:collapse;border:1.5px solid #000;font-family:Arial,Helvetica,sans-serif;">
          <thead>
            <tr style="background:#D9E1F2;">
              <th style="border:1px solid #000;padding:5px 4px;text-align:center;font-size:11.5px;font-weight:bold;color:#000;width:38px;">PLT</th>
              <th style="border:1px solid #000;padding:5px 8px;text-align:center;font-size:11.5px;font-weight:bold;color:#000;">PALLETS LOTE ${loteIdent}</th>
              <th style="border:1px solid #000;padding:5px 8px;text-align:center;font-size:11.5px;font-weight:bold;color:#000;">MODELO</th>
              <th style="border:1px solid #000;padding:5px 6px;text-align:center;font-size:11.5px;font-weight:bold;color:#000;width:55px;">CXS</th>
              <th style="border:1px solid #000;padding:5px 8px;text-align:center;font-size:11.5px;font-weight:bold;color:#000;width:65px;">QTD</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
            <tr style="background:#ffffff;font-weight:bold;">
              <td colspan="3" style="border:1.5px solid #000;padding:6px 8px;text-align:center;font-size:12px;color:#000;">TOTAL GERAL (${pad(lot.groups.length)} VOLUMES)</td>
              <td style="border:1.5px solid #000;padding:6px 6px;text-align:center;font-size:12px;color:#92400e;">${totalBoxes} cx</td>
              <td style="border:1.5px solid #000;padding:6px 8px;text-align:center;font-size:12px;color:#000;">${totalUnits > 0 ? totalUnits : '#N/D'}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Resumo Consolidado por Modelo (Subtotal) -->
      ${modelEntries.length > 0 ? `
      <div style="margin-top:14px;border:1.5px solid #000;border-radius:3px;overflow:hidden;">
        <div style="background:#E2E8F0;padding:5px 10px;font-size:11px;font-weight:bold;color:#000;border-bottom:1px solid #000;">
          📋 RESUMO CONSOLIDADO POR MODELO DE EQUIPAMENTO (AUDITORIA / NOTA FISCAL):
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:11.5px;color:#000;font-family:Arial,Helvetica,sans-serif;">
          <thead>
            <tr style="background:#f8fafc;border-bottom:1px solid #000;">
              <th style="border:1px solid #000;padding:5px 8px;text-align:left;font-weight:bold;color:#000;">MODELO / EQUIPAMENTO</th>
              <th style="border:1px solid #000;padding:5px 6px;text-align:center;font-weight:bold;width:75px;color:#000;">PALLETS</th>
              <th style="border:1px solid #000;padding:5px 6px;text-align:center;font-weight:bold;width:75px;color:#000;">CAIXAS</th>
              <th style="border:1px solid #000;padding:5px 8px;text-align:center;font-weight:bold;width:85px;color:#000;">TOTAL PEÇAS</th>
            </tr>
          </thead>
          <tbody>
            ${modelRowsHtml}
            <tr style="font-weight:bold;background:#ffffff;border-top:1.5px solid #000;">
              <td style="border:1px solid #000;padding:5px 8px;color:#000;">TOTAL GERAL DO LOTE</td>
              <td style="border:1px solid #000;padding:5px 6px;text-align:center;color:#000;">${pad(lot.groups.length)}</td>
              <td style="border:1px solid #000;padding:5px 6px;text-align:center;color:#92400e;">${totalBoxes} cx</td>
              <td style="border:1px solid #000;padding:5px 8px;text-align:center;color:#000;">${totalUnits}</td>
            </tr>
          </tbody>
        </table>
      </div>
      ` : ''}

    </div>
  `;
}

function printRomaneio(lotId) {
  const lot = lotId ? STATE.lots.find(l => l.id === lotId) : (CURRENT_ROMANEIO_LOT_ID ? STATE.lots.find(l => l.id === CURRENT_ROMANEIO_LOT_ID) : getCurrentLot());
  if (!lot) return;

  const html = buildRomaneioHtml(lot);
  const printEl = document.getElementById('print-only-container');
  if (printEl) {
    printEl.innerHTML = html;
  }
  window.print();
}

function exportRomaneioXLSX(lotId) {
  const lot = lotId ? STATE.lots.find(l => l.id === lotId) : (CURRENT_ROMANEIO_LOT_ID ? STATE.lots.find(l => l.id === CURRENT_ROMANEIO_LOT_ID) : getCurrentLot());
  if (!lot) return;

  const exp = lot.expeditionData || {};
  const yearSuffix = new Date().getFullYear().toString().slice(-2);
  const loteIdent = exp.loteIdent || `${lot.number}_${yearSuffix}`;
  const pad = n => String(n).padStart(2, '0');
  const volumeStr = exp.volume || `${pad(lot.groups.length)} / PALLETS`;

  const aoa = [
    ['CTDI', '', '', '', ''],
    ['RESPONSÁVEL EXPEDIÇÃO:', exp.responsavel || '', '', '', ''],
    ['DATA E HORA:', exp.dataHora || '', '', '', ''],
    ['CLIENTE:', exp.cliente || 'TIM', '', '', ''],
    ['DESTINO:', exp.destino || lot.dest || '', '', '', ''],
    ['NF:', exp.nf || '', '', '', ''],
    ['', '', '', '', ''],
    ['NATUREZA OPERAÇÃO:', exp.natureza || 'RETORNO DE CONSERTO', '', '', ''],
    ['', '', '', '', ''],
    ['VOLUME:', volumeStr, '', '', ''],
    ['TRANSPORTADORA:', exp.transportadora || '', '', '', ''],
    ['MOTORISTA:', exp.motorista || '', '', '', ''],
    ['RG/CPF:', exp.rgCpf || '', '', '', ''],
    ['PLACA VEÍCULO:', exp.placa || '', '', '', ''],
    ['AJUDANTE:', exp.ajudante || '', '', '', ''],
    ['ASSINATURA:', '', '', '', ''],
    ['', '', '', '', ''],
    ['PLT', 'PALLETS LOTE ' + loteIdent, 'MODELO', 'CAIXAS', 'QTD']
  ];

  let totalUnits = 0;
  let totalBoxes = 0;
  const modelMap = {};

  lot.groups.forEach((g, idx) => {
    const summary = getGroupSummary(g.palletIds);
    const units = summary.totalUnits || 0;
    const boxes = summary.totalBoxes || 0;
    totalUnits += units;
    totalBoxes += boxes;

    const stdPalletIds = g.palletIds.map(standardizePalletId);
    const palletName = stdPalletIds.join('/');
    aoa.push([pad(g.number || idx + 1), palletName, summary.model, boxes, units]);

    const mName = summary.model && summary.model !== '—' ? summary.model : 'MODELO NÃO ESPECIFICADO';
    if (!modelMap[mName]) {
      modelMap[mName] = { pallets: 0, boxes: 0, units: 0 };
    }
    modelMap[mName].pallets += 1;
    modelMap[mName].boxes += boxes;
    modelMap[mName].units += units;
  });

  aoa.push(['TOTAL GERAL', `${pad(lot.groups.length)} VOLUMES`, '', totalBoxes, totalUnits]);
  aoa.push(['', '', '', '', '']);
  aoa.push(['RESUMO CONSOLIDADO POR MODELO (AUDITORIA / NOTA FISCAL)', '', '', '', '']);
  aoa.push(['MODELO / EQUIPAMENTO', '', 'PALLETS', 'CAIXAS', 'TOTAL PEÇAS']);

  Object.entries(modelMap).forEach(([mName, mData]) => {
    aoa.push([mName, '', mData.pallets, mData.boxes, mData.units]);
  });
  aoa.push(['TOTAL GERAL DO LOTE', '', pad(lot.groups.length), totalBoxes, totalUnits]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 10 }, { wch: 38 }, { wch: 28 }, { wch: 12 }, { wch: 14 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Romaneio');
  XLSX.writeFile(wb, `Romaneio_Lote_${loteIdent}.xlsx`);
  showToast('Romaneio Excel baixado com sucesso!', 'success');
}

// ============================================================
// RENDER DETALHE DO LOTE
// ============================================================
function renderLotDetail() {
  const lot = getCurrentLot();
  if (!lot) return;

  const titleEl = document.getElementById('lot-detail-title');
  const subEl = document.getElementById('lot-detail-subtitle');
  if (titleEl) titleEl.textContent = `Lote #${lot.number} — ${lot.dest}`;
  if (subEl) subEl.textContent = `Criado em ${lot.createdAt}${lot.obs ? ' · ' + lot.obs : ''}`;

  const isAberto = lot.status === 'aberto';
  const isFinalized = lot.status === 'finalizado';
  const isExpedido = lot.status === 'expedido';

  const actionsEl = document.getElementById('lot-detail-actions');
  if (actionsEl) {
    if (isAberto) {
      actionsEl.innerHTML = `<button class="btn btn-danger btn-sm" onclick="finalizeLot()" id="btn-finalize">✅ Finalizar Lote</button>`;
    } else if (isFinalized) {
      actionsEl.innerHTML = `
        <button class="btn btn-ghost btn-sm" onclick="reopenLot('${lot.id}')" title="Reabrir lote para adicionar mais pallets">↩️ Reabrir Lote</button>
        <button class="btn btn-primary btn-sm" onclick="openExpedirModal('${lot.id}')" style="background:#10b981;border-color:#10b981;font-weight:700;">🚀 Expedir Lote</button>
      `;
    } else if (isExpedido) {
      actionsEl.innerHTML = `
        <button class="btn btn-ghost btn-sm" onclick="revertExpedicao('${lot.id}')" title="Desfazer expedição e voltar para finalizado">↩️ Estornar</button>
        <button class="btn btn-ghost btn-sm" onclick="openExpedirModal('${lot.id}')" title="Editar dados da expedição">✏️ Editar Dados</button>
        <button class="btn btn-primary btn-sm" onclick="openRomaneioModal('${lot.id}')">📄 Ver Romaneio</button>
        <button class="btn btn-primary btn-sm" onclick="printRomaneio('${lot.id}')" style="background:#059669;border-color:#059669;">🖨️ Imprimir</button>
      `;
    }
  }

  const scanBox = document.getElementById('scan-box-area');
  if (scanBox) {
    scanBox.style.display = isAberto ? 'block' : 'none';
  }

  const allPalletIds = lot.groups.flatMap(g => g.palletIds);
  const lotSummary = getGroupSummary(allPalletIds);

  let statusLabel = '🟡 Em Aberto';
  let statusColor = '#fcd34d';
  let statusBorder = 'rgba(245,158,11,.3)';

  if (isFinalized) {
    statusLabel = '🔒 Finalizado (Pronto p/ Expedir)';
    statusColor = '#93c5fd';
    statusBorder = 'rgba(59,130,246,.3)';
  } else if (isExpedido) {
    const dataHoraStr = lot.expeditionData && lot.expeditionData.dataHora ? ` · ${lot.expeditionData.dataHora}` : '';
    statusLabel = `🚀 Expedido${dataHoraStr}`;
    statusColor = '#6ee7b7';
    statusBorder = 'rgba(16,185,129,.3)';
  }

  const sumGrid = document.getElementById('lot-summary-grid');
  if (sumGrid) {
    sumGrid.innerHTML = `
      <div class="summary-card accent-blue"><div class="s-val">${lot.groups.length}</div><div class="s-label">Grupos / Pallets Físicos</div></div>
      <div class="summary-card accent-purple"><div class="s-val">${allPalletIds.length}</div><div class="s-label">Pallet IDs Bipados</div></div>
      <div class="summary-card accent-green"><div class="s-val">${lotSummary.totalUnits || '0'}</div><div class="s-label">Total de Peças (Unidades)</div></div>
      <div class="summary-card accent-yellow"><div class="s-val">${lotSummary.totalBoxes || '0'}</div><div class="s-label">Total de Caixas</div></div>
      <div class="summary-card" style="border-color:${statusBorder}">
        <div class="s-val" style="color:${statusColor};font-size:13px;">${statusLabel}</div>
        <div class="s-label">Status do Lote</div>
      </div>`;
  }

  renderPendingGroup();

  const container = document.getElementById('lot-groups-container');
  if (container) {
    if (!lot.groups.length) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📦</div><h3>Nenhum pallet adicionado</h3><p>Bipe os pallets acima para compor o lote.</p></div>`;
      return;
    }

    container.innerHTML = lot.groups.map(group => {
      const grpSummary = getGroupSummary(group.palletIds);

      return `
        <div class="card mb-4">
          <div class="card-header">
            <div>
              <span class="card-title">📦 Grupo ${group.number} (Pallet Físico) &nbsp;·&nbsp;</span>
              <span class="badge badge-blue">${group.palletIds.length} Pallet ID(s)</span>
              <span class="badge badge-purple" style="margin-left:4px;">${grpSummary.model}</span>
            </div>
            <div class="flex gap-2 items-center">
              <span class="text-sm text-muted">${group.createdAt}</span>
              ${isAberto ? `
                <button class="btn btn-ghost btn-sm" onclick="ungroup('${group.id}')" title="Desagrupar para poder agrupar com outros pallets">🔓 Desagrupar</button>
                <button class="btn btn-danger btn-sm btn-icon" onclick="removeGroup('${group.id}')" title="Remover grupo do lote">🗑️</button>
              ` : ''}
            </div>
          </div>
          <div class="card-body">
            <div style="display:flex;gap:24px;margin-bottom:14px;flex-wrap:wrap;background:rgba(255,255,255,0.02);padding:10px 16px;border-radius:var(--exp-radius-md);border:1px solid var(--exp-border);">
              <div><span class="text-sm text-muted">Peças / Unidades: </span><strong style="color:#6ee7b7;font-size:15px;">${grpSummary.totalUnits}</strong></div>
              <div><span class="text-sm text-muted">Caixas Consolidadas: </span><strong style="color:#fcd34d;font-size:15px;">${grpSummary.totalBoxes}</strong></div>
              <div><span class="text-sm text-muted">Modelo(s): </span><strong>${grpSummary.model}</strong></div>
            </div>
            <div class="table-wrap">
              <table>
                <thead><tr>
                  <th>Pallet ID Bipado</th>
                  <th>Modelo</th>
                  <th>Qtd. Peças</th>
                  <th>Qtd. Caixas</th>
                  <th>Destino</th>
                  <th>Status</th>
                </tr></thead>
                <tbody>
                  ${group.palletIds.map(id => {
                    const p = getPalletSummary(id);
                    return `
                    <tr>
                      <td><span class="badge badge-blue font-mono">${id}</span></td>
                      <td>${p ? p.model : '<span class="text-muted">—</span>'}</td>
                      <td>${p ? `<strong style="color:#6ee7b7">${p.totalUnits}</strong>` : '<span class="text-muted">—</span>'}</td>
                      <td>${p ? `<strong style="color:#fcd34d">${p.totalBoxes}</strong>` : '<span class="text-muted">—</span>'}</td>
                      <td>${p ? p.dest : '<span class="text-muted">—</span>'}</td>
                      <td>${p ? '<span class="badge badge-green">✔ Localizado</span>' : '<span class="badge badge-red">⚠ Não encontrado</span>'}</td>
                    </tr>`;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  if (isAberto) {
    setTimeout(() => {
      const inp = document.getElementById('scan-input');
      if (inp && document.activeElement !== inp) inp.focus();
    }, 60);
  }
}

function renderPendingGroup() {
  const wrap = document.getElementById('pending-group-wrap');
  const list = document.getElementById('pending-group-list');
  const counter = document.getElementById('pending-group-counter');
  const sel = STATE.selectedForGroup;

  if (!wrap || !list) return;

  if (!sel.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';

  const sum = getGroupSummary(sel);
  if (counter) {
    const is30 = sum.totalBoxes === 30;
    const over30 = sum.totalBoxes > 30;
    const color = over30 ? '#ef4444' : (is30 ? '#10b981' : '#fcd34d');
    counter.innerHTML = `Total selecionado: <strong style="color:${color};font-size:13px;">${sum.totalBoxes} / 30 caixas</strong> (${sum.totalUnits} peças)${is30 ? ' · 🎯 Pallet completo!' : ''}${over30 ? ' · ⚠️ Excede 30 caixas!' : ''}`;
  }

  list.innerHTML = sel.map(id => {
    const p = getPalletSummary(id);
    return `
      <div class="pallet-scan-item selected" onclick="toggleGroupSelection('${id}')">
        <span class="check-icon">✅</span>
        <div style="flex:1">
          <div class="pallet-id">${id}</div>
          <div class="pallet-meta">${p ? `Modelo: ${p.model} · <strong style="color:#6ee7b7">${p.totalUnits} peças</strong> · <strong style="color:#fcd34d">${p.totalBoxes} caixas</strong> · Destino: ${p.dest}` : '<span style="color:#fca5a5">⚠ Pallet não encontrado no relatório</span>'}</div>
        </div>
        <span style="font-size:11px;color:var(--exp-text-muted)">Clique para remover</span>
      </div>`;
  }).join('');
}

// ============================================================
// RENDER LISTA DE LOTES
// ============================================================
function renderLotsList() {
  const container = document.getElementById('lots-list');
  if (!container) return;
  if (!STATE.lots.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🚚</div><h3>Nenhum lote criado</h3><p>Clique em "Novo Lote" para começar.</p></div>`;
    return;
  }

  container.innerHTML = STATE.lots.map(lot => {
    const allPalletIds = lot.groups.flatMap(g => g.palletIds);
    const lotSummary = getGroupSummary(allPalletIds);

    let badgeClass = 'badge-yellow';
    let badgeText = '🟡 Em Aberto';
    let quickAction = '';

    if (lot.status === 'finalizado') {
      badgeClass = 'badge-finalizado';
      badgeText = '🔒 Finalizado';
      quickAction = `<button class="btn btn-primary btn-sm" style="font-size:11px;padding:4px 8px;background:#10b981;border-color:#10b981;" onclick="event.stopPropagation();openExpedirModal('${lot.id}')">🚀 Expedir</button>`;
    } else if (lot.status === 'expedido') {
      badgeClass = 'badge-expedido';
      badgeText = '🚀 Expedido';
      quickAction = `<button class="btn btn-primary btn-sm" style="font-size:11px;padding:4px 8px;" onclick="event.stopPropagation();openRomaneioModal('${lot.id}')">📄 Romaneio</button>`;
    }

    return `
      <div class="lot-card mb-4" onclick="openLotDetail('${lot.id}')">
        <div>
          <div class="lot-num">Lote #${lot.number} — ${lot.dest}</div>
          <div class="lot-date">📅 ${lot.createdAt}${lot.expeditionData && lot.expeditionData.dataHora ? ' · Expedido em ' + lot.expeditionData.dataHora : ''}</div>
          <div class="lot-stats">
            ${lot.groups.length} grupo(s) / pallet(s) físico(s) · ${allPalletIds.length} pallet ID(s) · <strong style="color:#6ee7b7">${lotSummary.totalUnits} peças</strong> · <strong style="color:#fcd34d">${lotSummary.totalBoxes} caixas</strong>
            ${lotSummary.model ? '· ' + lotSummary.model : ''}
          </div>
        </div>
        <div class="flex flex-col items-center gap-2">
          <span class="badge ${badgeClass}">${badgeText}</span>
          ${quickAction}
        </div>
      </div>`;
  }).join('');
}

// ============================================================
// DASHBOARD
// ============================================================
function renderDashboard() {
  try {
    if (!STATE.palletIndex) buildPalletIndex();
    const lots = Array.isArray(STATE.lots) ? STATE.lots : [];
    const totalLots = lots.length;
    const openLots = lots.filter(l => l && l.status === 'aberto').length;
    const finLots = lots.filter(l => l && l.status === 'finalizado').length;
    const expLots = lots.filter(l => l && l.status === 'expedido').length;

    const expedidoPalletIds = lots.filter(l => l && l.status === 'expedido').flatMap(l => (l && Array.isArray(l.groups) ? l.groups : []).flatMap(g => (g && Array.isArray(g.palletIds) ? g.palletIds : [])));
    const expSummary = getGroupSummary(expedidoPalletIds);

    const statsGrid = document.getElementById('stats-grid');
    if (statsGrid) {
      statsGrid.innerHTML = `
        <div class="stat-card blue"><div class="stat-card-icon">🚚</div><div class="stat-card-value">${totalLots}</div><div class="stat-card-label">Lotes Criados</div></div>
        <div class="stat-card yellow"><div class="stat-card-icon">🟡</div><div class="stat-card-value">${openLots}</div><div class="stat-card-label">Lotes em Aberto</div></div>
        <div class="stat-card blue"><div class="stat-card-icon">🔒</div><div class="stat-card-value">${finLots}</div><div class="stat-card-label">Lotes Finalizados</div></div>
        <div class="stat-card green"><div class="stat-card-icon">🚀</div><div class="stat-card-value">${expLots}</div><div class="stat-card-label">Lotes Expedidos (${expSummary.totalUnits} peças)</div></div>`;
    }

    const dashLots = document.getElementById('dash-lots');
    if (dashLots) {
      const recent = lots.slice(0, 5);
      if (!recent.length) {
        dashLots.innerHTML = `<div class="empty-state" style="padding:30px"><div class="empty-state-icon">🚚</div><h3>Nenhum lote</h3><p>Crie o primeiro lote de expedição.</p></div>`;
      } else {
        dashLots.innerHTML = `<div style="padding:12px;display:flex;flex-direction:column;gap:8px;">${recent.map(lot => {
          const ids = (lot && Array.isArray(lot.groups) ? lot.groups : []).flatMap(g => (g && Array.isArray(g.palletIds) ? g.palletIds : []));
          const sum = getGroupSummary(ids);
          let badgeClass = 'badge-yellow';
          let badgeText = '🟡';
          if (lot.status === 'finalizado') {
            badgeClass = 'badge-finalizado';
            badgeText = '🔒';
          } else if (lot.status === 'expedido') {
            badgeClass = 'badge-expedido';
            badgeText = '🚀';
          }
          return `<div class="lot-card" onclick="openLotDetail('${lot.id}')">
            <div>
              <div class="lot-num">Lote #${lot.number || 1} — ${lot.dest || 'Sem destino'}</div>
              <div class="lot-date">${lot.createdAt || ''}${lot.expeditionData && lot.expeditionData.dataHora ? ' · ' + lot.expeditionData.dataHora : ''}</div>
              <div class="lot-stats">${(lot.groups||[]).length} grupo(s) · ${ids.length} pallet(s) · ${sum.totalUnits} peças · ${sum.totalBoxes} caixas</div>
            </div>
            <span class="badge ${badgeClass}">${badgeText}</span>
          </div>`;
        }).join('')}</div>`;
      }
    }

    const repSum = document.getElementById('dash-report-summary');
    if (repSum) {
      if (!STATE.reportData || !STATE.reportData.length) {
        repSum.innerHTML = `<div class="empty-state" style="padding:20px"><div class="empty-state-icon">📋</div><h3>Nenhum dado</h3><p>Importe o relatório de embalagem.</p></div>`;
      } else {
        const pallets = Object.values(STATE.palletIndex || {});
        const totalBoxesInReport = pallets.reduce((acc, p) => acc + (p && p.boxes ? p.boxes.size : 0), 0);
        const models = [...new Set(pallets.flatMap(p => (p && p.models ? [...p.models] : [])))];

        repSum.innerHTML = `
          <div class="summary-grid" style="grid-template-columns:1fr 1fr;margin-bottom:14px;">
            <div class="summary-card accent-blue"><div class="s-val">${pallets.length}</div><div class="s-label">Pallets Únicos</div></div>
            <div class="summary-card accent-green"><div class="s-val">${STATE.reportData.length}</div><div class="s-label">Peças (Seriais)</div></div>
            <div class="summary-card accent-yellow"><div class="s-val">${totalBoxesInReport}</div><div class="s-label">Caixas Únicas</div></div>
            <div class="summary-card accent-purple"><div class="s-val">${models.length}</div><div class="s-label">Modelos</div></div>
          </div>
          <div class="text-sm text-muted">Modelos: ${models.slice(0,5).join(', ')}${models.length>5?'...':''}</div>`;
      }
    }
  } catch(err) {
    console.error('Erro na renderização do Dashboard:', err);
  }
}

// ============================================================
// INIT EXPEDIÇÃO TIM
// ============================================================
function initExpedicaoTim() {
  UPLOAD_ZONE = document.getElementById('upload-zone');
  if (UPLOAD_ZONE) {
    UPLOAD_ZONE.addEventListener('dragover', e => { e.preventDefault(); UPLOAD_ZONE.classList.add('drag-over'); });
    UPLOAD_ZONE.addEventListener('dragleave', () => UPLOAD_ZONE.classList.remove('drag-over'));
    UPLOAD_ZONE.addEventListener('drop', e => {
      e.preventDefault(); UPLOAD_ZONE.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) processFile(file);
    });
  }

  window.addEventListener('beforeunload', () => {
    saveState();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      saveState();
    }
  });

  loadState();
  updateStorageBar();
  updateSaveIndicator();
  renderDashboard();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initExpedicaoTim);
} else {
  initExpedicaoTim();
}
