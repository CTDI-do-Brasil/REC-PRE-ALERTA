const CURRENT_APP_VERSION = 'v1.5.0';

function startVersionPolling() {
    setInterval(async () => {
        try {
            const res = await fetch(`${SERVER_URL.replace(/\/$/, '')}/api/version`);
            if (res.ok) {
                const data = await res.json();
                if (data && data.version && data.version !== CURRENT_APP_VERSION) {
                    const openModals = document.querySelectorAll('.modal-overlay:not(.hidden)');
                    if (openModals.length === 0) {
                        console.log(`Nova versão detectada (${data.version}). Atualizando navegador...`);
                        window.location.reload(true);
                    }
                }
            }
        } catch (err) {
            // Silently ignore network errors
        }
    }, 120000);
}

// Initialize LocalForage Instances
const dbPreAlerta = localforage.createInstance({ name: "PreAlertaApp", storeName: "preAlerta" });
const dbRecebidos = localforage.createInstance({ name: "PreAlertaApp", storeName: "recebidos" });
const dbModelos = localforage.createInstance({ name: "PreAlertaApp", storeName: "modelos" });
const dbUsuarios = localforage.createInstance({ name: "PreAlertaApp", storeName: "usuarios" });

// Default Models
const defaultModels = [
    { name: "BCSKV630", fields: 2, rules: { serial: "BCSK" } },
    { name: "FAST 5655 V2", fields: 3, rules: { serial: "N7", pon: "SMBS" } },
    { name: "FAST 5657", fields: 3, rules: { serial: "N7", pon: "SMBS", mac: "C03C04" } },
    { name: "FAST 5670 V2", fields: 3, rules: { serial: "N7, OC", pon: "SMBS", mac: "E4C0E2, 7C1689" } },
    { name: "FGA2232", fields: 3, rules: { serial: "CP", pon: "TMBB", mac: "A0B53C, D4925E" } },
    { name: "PG2447", fields: 3, rules: { serial: "GPO", pon: "KAON", mac: "1834AF" } },
    { name: "NP5454T", fields: 3, rules: { serial: "T25", pon: "TLCT", mac: "104121" } },
    { name: "ZXHN F680", fields: 3, rules: { serial: "ZTEEQ", pon: "ZTEGC" } },
    { name: "ZXHN F6600P", fields: 3, rules: { serial: "ZTE3, ZTEGD", pon: "ZTE3, ZTEGD" } },
    { name: "BC-UM221E", fields: 2, rules: { serial: "FTTH" } },
    { name: "HG8145X6-10", fields: 3, rules: { serial: "2102315", pon: "HWTC" } },
    { name: "NP7287", fields: 3, rules: { serial: "T25", pon: "TLCTA" } }
];

// App State
let preAlertaCache = new Map();
let currentPendingUnit = null;
let currentUser = null; // { username, level: 'admin' | 'operator' }
let isProcessingRecebimento = false;
// Backend server (presign + DB) - change if deployed elsewhere
const SERVER_URL = localStorage.getItem('server_url') || (window.location.protocol === 'file:' ? 'http://localhost:4000' : window.location.origin);

async function uploadFileToMinio(file) {
    try {
        const q = `${SERVER_URL.replace(/\/$/, '')}/api/presign?filename=${encodeURIComponent(file.name)}`;
        const res = await fetch(q);
        if (!res.ok) throw new Error('presign failed');
        const json = await res.json();
        const url = json.url;
        const put = await fetch(url, { method: 'PUT', body: file });
        if (!put.ok) throw new Error('upload failed');
        console.log('Uploaded to MinIO:', json.objectName);
        return json;
    } catch (err) {
        console.error('uploadFileToMinio error', err);
        return null;
    }
}

// ============================================================
// AUTH / LOGIN
// ============================================================
const DEFAULT_ADMIN = {
    username: "RODRIGO.BARRETO",
    password: "admin",
    level: "admin",
    criadoEm: new Date().toISOString()
};

function validateUsernameFormat(username) {
    // Must be NOME.SOBRENOME: letters only separated by a single dot
    return /^[A-Z]+\.[A-Z]+$/.test(username.trim().toUpperCase());
}

async function initUsuarios() {
    // No-op since backend auto-creates default admin in Postgres
}

async function doLogin(username, password) {
    const uname = username.trim().toUpperCase();
    try {
        const q = `${SERVER_URL.replace(/\/$/, '')}/api/usuarios/login`;
        const res = await fetch(q, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: uname, password })
        });
        if (res.ok) {
            return await res.json();
        }
    } catch (err) {
        console.error('Login request failed:', err);
    }
    return null;
}

let currentSessionDay = new Date().toLocaleDateString();

function performLogout() {
    currentUser = null;
    localStorage.removeItem('preAlertaLoggedUser');
    // Navigate back to first tab
    const navLinks = document.querySelectorAll('.nav-links li');
    const tabs = document.querySelectorAll('.tab-content');
    navLinks.forEach(l => l.classList.remove('active'));
    tabs.forEach(t => t.classList.remove('active'));
    if (navLinks.length > 0) navLinks[0].classList.add('active');
    const recebimentoTab = document.getElementById('recebimento');
    if (recebimentoTab) recebimentoTab.classList.add('active');
    showLoginOverlay();
}

function applyAccessLevel(user) {
    currentUser = user;
    currentSessionDay = new Date().toLocaleDateString();
    document.getElementById('display-user-name').textContent = user.username;
    const navAdmin = document.getElementById('nav-admin');
    const navPreAlerta = document.querySelector('li[data-tab="pre-alerta"]');
    const navRelatorios = document.querySelector('li[data-tab="relatorios"]');
    const btnEditModelo = document.getElementById('btn-edit-modelo');
    const btnNovoModelo = document.getElementById('btn-novo-modelo');
    
    if (user.level === 'admin') {
        navAdmin.style.display = '';
        if (navPreAlerta) navPreAlerta.style.display = '';
        if (navRelatorios) navRelatorios.style.display = '';
        if (btnEditModelo) btnEditModelo.style.display = '';
        if (btnNovoModelo) btnNovoModelo.style.display = '';
    } else {
        navAdmin.style.display = 'none';
        if (navPreAlerta) navPreAlerta.style.display = 'none';
        if (navRelatorios) navRelatorios.style.display = 'none';
        if (btnEditModelo) btnEditModelo.style.display = 'none';
        if (btnNovoModelo) btnNovoModelo.style.display = 'none';
    }
}

function showLoginOverlay() {
    document.getElementById('login-overlay').classList.remove('hidden');
    document.getElementById('login-username').value = '';
    document.getElementById('login-password').value = '';
    document.getElementById('login-error').classList.add('hidden');
    const capsWarning = document.getElementById('login-caps-warning');
    if (capsWarning) capsWarning.style.display = 'none';
    setTimeout(() => document.getElementById('login-username').focus(), 100);
}

function hideLoginOverlay() {
    document.getElementById('login-overlay').classList.add('hidden');
    const capsWarning = document.getElementById('login-caps-warning');
    if (capsWarning) capsWarning.style.display = 'none';
}

function startMidnightLogoutCheck() {
    setInterval(() => {
        if (currentUser && currentUser.level === 'operator') {
            const today = new Date().toLocaleDateString();
            if (today !== currentSessionDay) {
                currentSessionDay = today;
                console.log("Midnight day change detected. Logging out operator profile...");
                performLogout();
            }
        }
    }, 10000); // Check every 10 seconds
}

// ============================================================
// Initialize App
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    await initUsuarios();
    setupNavigation();
    await loadModels();
    await loadPreAlertaCache();
    await updateCounters();
    await loadRecentRecebimentos();
    setupEventListeners();
    setupAuthListeners();
    setupAdminListeners();
    setupReportListeners();
    setupExpedicaoListeners();
    setupRetornoPinturaListeners();
    startMidnightLogoutCheck();
    // Check persisted login session on F5/refresh
    const savedUserStr = localStorage.getItem('preAlertaLoggedUser');
    let restoredSession = false;
    if (savedUserStr) {
        try {
            const savedUser = JSON.parse(savedUserStr);
            if (savedUser && savedUser.username) {
                applyAccessLevel(savedUser);
                hideLoginOverlay();
                restoredSession = true;
            }
        } catch (err) {
            console.warn('Invalid persisted session:', err);
        }
    }
    if (!restoredSession) {
        showLoginOverlay();
    }
    startVersionPolling();
});

// ============================================================
// Navigation Logic
// ============================================================
function setupNavigation() {
    const navLinks = document.querySelectorAll('.nav-links li');
    const tabs = document.querySelectorAll('.tab-content');

    navLinks.forEach(link => {
        link.addEventListener('click', () => {
            const target = link.dataset.tab;
            navLinks.forEach(l => l.classList.remove('active'));
            link.classList.add('active');
            tabs.forEach(tab => {
                if (tab.id === target) {
                    tab.classList.add('active');
                    if (target === 'admin') {
                        renderUsersList();
                    }
                    if (target === 'relatorios' || target === 'admin') {
                        loadAdminProductionDashboard();
                    }
                    if (target === 'expedicao-pintura') {
                        loadActivePallet();
                    }
                    if (target === 'retorno-pintura') {
                        loadRetornoPinturaData();
                    }
                }
                else tab.classList.remove('active');
            });
        });
    });
}

// ============================================================
// Auth Event Listeners
// ============================================================
function setupAuthListeners() {
    let capsLockActive = false;
    const updateCapsDisplay = (active) => {
        capsLockActive = active;
        const capsWarning = document.getElementById('login-caps-warning');
        if (!capsWarning) return;
        if (active) {
            capsWarning.style.display = 'flex';
        } else {
            capsWarning.style.display = 'none';
        }
    };

    const checkCapsLockState = (e) => {
        if (e && e.getModifierState && typeof e.getModifierState === 'function') {
            const state = e.getModifierState('CapsLock');
            updateCapsDisplay(state);
        }
    };

    const checkCapsLockChar = (e) => {
        if (e && e.key && e.key.length === 1) {
            const char = e.key;
            if (char.toLowerCase() !== char.toUpperCase()) {
                const isShift = !!e.shiftKey;
                const isUpper = char === char.toUpperCase();
                const isLower = char === char.toLowerCase();
                const capsOn = (isUpper && !isShift) || (isLower && isShift);
                updateCapsDisplay(capsOn);
            }
        }
    };

    const formLogin = document.getElementById('form-login');
    if (formLogin) {
        ['keyup', 'keydown', 'keypress', 'click', 'focusin', 'mousedown'].forEach(evt => {
            formLogin.addEventListener(evt, checkCapsLockState);
        });
        formLogin.addEventListener('keypress', checkCapsLockChar);
    }
    window.addEventListener('keydown', checkCapsLockState);
    window.addEventListener('keyup', checkCapsLockState);
    window.addEventListener('click', checkCapsLockState);

    formLogin.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('login-username').value;
        const password = document.getElementById('login-password').value;
        const user = await doLogin(username, password);
        if (user) {
            applyAccessLevel(user);
            hideLoginOverlay();
            localStorage.setItem('preAlertaLoggedUser', JSON.stringify(user));
        } else {
            document.getElementById('login-error').classList.remove('hidden');
        }
    });

    document.getElementById('btn-logout').addEventListener('click', () => {
        performLogout();
    });
}

// ============================================================
// Models Logic
// ============================================================
async function syncModelsToServer(modelsList) {
    try {
        await fetch(`${SERVER_URL.replace(/\/$/, '')}/api/modelos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ models: modelsList })
        });
    } catch (err) {
        console.warn('Falha ao sincronizar modelos com o servidor:', err);
    }
}

async function loadModels() {
    let savedModels = null;
    try {
        const res = await fetch(`${SERVER_URL.replace(/\/$/, '')}/api/modelos`);
        if (res.ok) {
            const serverModels = await res.json();
            if (Array.isArray(serverModels) && serverModels.length > 0) {
                savedModels = serverModels;
                await dbModelos.setItem('lista', savedModels);
            }
        }
    } catch (err) {
        console.warn('Servidor de modelos offline, utilizando cache local:', err);
    }
    if (!savedModels || !Array.isArray(savedModels) || savedModels.length === 0) {
        savedModels = await dbModelos.getItem('lista');
    }
    if (!savedModels) {
        savedModels = [...defaultModels];
        await dbModelos.setItem('lista', savedModels);
    }

    window.modelFieldsConfig = {};
    window.modelRulesConfig = {};
    const select = document.getElementById('modelo');
    if (select) select.innerHTML = '';
    const reportSelect = document.getElementById('report-modelo');
    if (reportSelect) {
        reportSelect.innerHTML = '<option value="" style="color: black;">Todos</option>';
    }

    savedModels.forEach(model => {
        let name = model;
        let fields = 3;
        let rules = {};

        if (typeof model === 'object') {
            name = model.name;
            fields = model.fields;
            rules = model.rules || {};
        } else {
            if (name === 'BCSKV630' || name === 'BC-UM221E') fields = 2;
            const def = defaultModels.find(m => m.name === name);
            if (def) rules = def.rules;
        }

        window.modelFieldsConfig[name] = fields;
        window.modelRulesConfig[name] = rules;

        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        select.appendChild(option);

        if (reportSelect) {
            const optReport = document.createElement('option');
            optReport.value = name;
            optReport.textContent = name;
            optReport.style.color = 'black';
            reportSelect.appendChild(optReport);
        }
    });
    if (typeof updateFormFields === 'function') updateFormFields();
}

document.getElementById('btn-novo-modelo').addEventListener('click', () => {
    document.getElementById('modal-modelo-title').textContent = 'Adicionar Novo Modelo';
    document.getElementById('input-modelo-original').value = '';
    document.getElementById('input-novo-modelo').value = '';
    document.getElementById('select-modelo-campos').value = "3";
    document.getElementById('rule-serial').value = '';
    document.getElementById('rule-pon').value = '';
    document.getElementById('rule-mac').value = '';
    document.getElementById('group-rule-pon').style.display = 'block';
    document.getElementById('modal-novo-modelo').classList.remove('hidden');
    document.getElementById('input-novo-modelo').focus();
});

document.getElementById('select-modelo-campos').addEventListener('change', (e) => {
    document.getElementById('group-rule-pon').style.display = e.target.value === "2" ? 'none' : 'block';
});

document.getElementById('btn-edit-modelo').addEventListener('click', () => {
    const selected = document.getElementById('modelo').value;
    if (!selected) return;

    document.getElementById('modal-modelo-title').textContent = 'Editar Regras do Modelo';
    document.getElementById('input-modelo-original').value = selected;
    document.getElementById('input-novo-modelo').value = selected;

    const fields = window.modelFieldsConfig[selected] || 3;
    document.getElementById('select-modelo-campos').value = fields.toString();
    document.getElementById('group-rule-pon').style.display = fields === 2 ? 'none' : 'block';

    const rules = window.modelRulesConfig[selected] || {};
    document.getElementById('rule-serial').value = rules.serial || '';
    document.getElementById('rule-pon').value = rules.pon || '';
    document.getElementById('rule-mac').value = rules.mac || '';

    document.getElementById('modal-novo-modelo').classList.remove('hidden');
    document.getElementById('input-novo-modelo').focus();
});

document.getElementById('btn-cancel-modelo').addEventListener('click', () => {
    document.getElementById('modal-novo-modelo').classList.add('hidden');
});

document.getElementById('btn-save-modelo').addEventListener('click', async () => {
    const originalModel = document.getElementById('input-modelo-original').value;
    const newModel = document.getElementById('input-novo-modelo').value.trim().toUpperCase();
    const camposSelect = document.getElementById('select-modelo-campos');
    const campos = camposSelect ? parseInt(camposSelect.value, 10) : 3;

    const rSerial = document.getElementById('rule-serial').value.trim().toUpperCase();
    const rPon = document.getElementById('rule-pon').value.trim().toUpperCase();
    const rMac = document.getElementById('rule-mac').value.trim().toUpperCase();

    const rules = {};
    if (rSerial) rules.serial = rSerial;
    if (campos === 3 && rPon) rules.pon = rPon;
    if (rMac) rules.mac = rMac;

    if (newModel) {
        let savedModels = await dbModelos.getItem('lista') || [...defaultModels];
        if (originalModel) {
            savedModels = savedModels.filter(m => (typeof m === 'object' ? m.name : m) !== originalModel);
        }
        savedModels = savedModels.filter(m => (typeof m === 'object' ? m.name : m) !== newModel);
        savedModels.push({ name: newModel, fields: campos, rules: rules });
        await dbModelos.setItem('lista', savedModels);
        await syncModelsToServer(savedModels);
        await loadModels();
        document.getElementById('modelo').value = newModel;
        if (typeof updateFormFields === 'function') updateFormFields();
    }
    document.getElementById('modal-novo-modelo').classList.add('hidden');
});

// ============================================================
// Admin — Users Management
// ============================================================
async function renderUsersList() {
    const listEl = document.getElementById('users-list-table');
    if (!listEl) return;
    listEl.innerHTML = '';
    
    try {
        const q = `${SERVER_URL.replace(/\/$/, '')}/api/usuarios`;
        const res = await fetch(q);
        if (!res.ok) throw new Error('Failed to fetch users list');
        const users = await res.json();
        
        for (const u of users) {
            const tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
            
            const tdName = document.createElement('td');
            tdName.style.padding = '12px 10px';
            tdName.textContent = u.username;
            
            const tdLevel = document.createElement('td');
            tdLevel.style.padding = '12px 10px';
            tdLevel.textContent = u.level === 'admin' ? 'Administrador' : 'Operador';
            
            const tdActions = document.createElement('td');
            tdActions.style.padding = '12px 10px';
            tdActions.style.textAlign = 'right';
            
            // Reset password button
            const btnReset = document.createElement('button');
            btnReset.className = 'btn btn-secondary';
            btnReset.style.padding = '4px 8px';
            btnReset.style.fontSize = '0.8rem';
            btnReset.style.marginRight = '5px';
            btnReset.style.background = 'rgba(255, 255, 255, 0.1)';
            btnReset.style.color = 'white';
            btnReset.textContent = 'Resetar Senha';
            btnReset.addEventListener('click', async () => {
                const newPassword = prompt(`Digite a nova senha para o usuario ${u.username}:`);
                if (newPassword === null) return; // user cancelled
                if (!newPassword.trim()) {
                    alert('A senha nao pode ser vazia!');
                    return;
                }
                
                try {
                    const postUrl = `${SERVER_URL.replace(/\/$/, '')}/api/usuarios`;
                    const postRes = await fetch(postUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username: u.username, password: newPassword.trim(), level: u.level })
                    });
                    if (!postRes.ok) throw new Error('Password reset failed');
                    alert(`Senha de ${u.username} resetada com sucesso!`);
                    await renderUsersList();
                } catch (err) {
                    console.error(err);
                    alert('Erro ao resetar senha no banco de dados.');
                }
            });
            
            // Delete button
            const btnDelete = document.createElement('button');
            btnDelete.className = 'btn btn-danger';
            btnDelete.style.padding = '4px 8px';
            btnDelete.style.fontSize = '0.8rem';
            btnDelete.textContent = 'Excluir';
            btnDelete.addEventListener('click', async () => {
                if (u.username === 'RODRIGO.BARRETO') {
                    alert('O administrador padrao nao pode ser excluido!');
                    return;
                }
                if (confirm(`Tem certeza que deseja excluir o usuario ${u.username}?`)) {
                    try {
                        const delUrl = `${SERVER_URL.replace(/\/$/, '')}/api/usuarios/${encodeURIComponent(u.username)}`;
                        const delRes = await fetch(delUrl, { method: 'DELETE' });
                        if (!delRes.ok) throw new Error('User deletion failed');
                        alert(`Usuario ${u.username} excluido.`);
                        await renderUsersList();
                    } catch (err) {
                        console.error(err);
                        alert('Erro ao excluir usuario no banco de dados.');
                    }
                }
            });
            
            tdActions.appendChild(btnReset);
            tdActions.appendChild(btnDelete);
            
            tr.appendChild(tdName);
            tr.appendChild(tdLevel);
            tr.appendChild(tdActions);
            listEl.appendChild(tr);
        }
    } catch (err) {
        console.error('Failed to render users list:', err);
    }
}

async function loadAdminProductionDashboard() {
    const tbody = document.getElementById('admin-operator-stats-table');
    const updatedSpan = document.getElementById('admin-dashboard-updated');
    if (!tbody) return;

    try {
        if (updatedSpan) updatedSpan.textContent = 'Atualizando...';
        
        const res = await fetch(`${SERVER_URL.replace(/\/$/, '')}/api/recebimentos/stats/operadores`);
        if (!res.ok) throw new Error('Falha ao buscar dados de produção');
        const stats = await res.json();

        const userKeys = await dbUsuarios.keys();
        const allUsers = [];
        for (const k of userKeys) {
            const u = await dbUsuarios.getItem(k);
            if (u && u.username) allUsers.push(u.username);
        }

        const statsMap = {};
        stats.forEach(s => {
            statsMap[s.usuario] = {
                total_hoje: parseInt(s.total_hoje) || 0,
                total_ultima_hora: parseInt(s.total_ultima_hora) || 0,
                pre_alerta_hoje: parseInt(s.pre_alerta_hoje) || 0,
                fora_pre_alerta_hoje: parseInt(s.fora_pre_alerta_hoje) || 0,
                ultima_bipagem: s.ultima_bipagem ? new Date(s.ultima_bipagem).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-'
            };
        });

        allUsers.forEach(username => {
            if (!statsMap[username]) {
                statsMap[username] = {
                    total_hoje: 0,
                    total_ultima_hora: 0,
                    pre_alerta_hoje: 0,
                    fora_pre_alerta_hoje: 0,
                    ultima_bipagem: '-'
                };
            }
        });

        const combinedList = Object.keys(statsMap).map(user => ({
            usuario: user,
            ...statsMap[user]
        })).sort((a, b) => b.total_hoje - a.total_hoje);

        if (combinedList.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="padding: 20px; text-align: center; color: var(--text-secondary);">Nenhum operador registrado no sistema.</td></tr>';
        } else {
            let sumHoje = 0;
            let sumUltimaHora = 0;
            let sumPreAlerta = 0;
            let sumFora = 0;

            const rowsHtml = combinedList.map(item => {
                sumHoje += item.total_hoje;
                sumUltimaHora += item.total_ultima_hora;
                sumPreAlerta += item.pre_alerta_hoje;
                sumFora += item.fora_pre_alerta_hoje;

                return `
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                    <td style="padding: 10px; font-weight: 600;">
                        ${item.usuario}
                    </td>
                    <td style="padding: 10px; text-align: center;">
                        <span class="badge badge-primary" style="font-size: 0.9rem; padding: 4px 10px;">${item.total_hoje}</span>
                    </td>
                    <td style="padding: 10px; text-align: center;">
                        <span class="badge" style="background: rgba(59, 130, 246, 0.2); color: #60a5fa; font-size: 0.9rem; padding: 4px 10px; font-weight: 600;">${item.total_ultima_hora}</span>
                    </td>
                    <td style="padding: 10px; text-align: center; color: #10b981; font-weight: 600;">
                        ${item.pre_alerta_hoje}
                    </td>
                    <td style="padding: 10px; text-align: center; color: #f43f5e; font-weight: 600;">
                        ${item.fora_pre_alerta_hoje}
                    </td>
                    <td style="padding: 10px; text-align: right; color: var(--text-secondary);">
                        ${item.ultima_bipagem}
                    </td>
                </tr>
                `;
            }).join('');

            const totalHtml = `
                <tr style="border-top: 2px solid rgba(255,255,255,0.2); background: rgba(255, 255, 255, 0.05); font-weight: 700;">
                    <td style="padding: 14px 10px; color: #fff; text-transform: uppercase; font-size: 0.95rem;">
                        TOTAL GERAL
                    </td>
                    <td style="padding: 14px 10px; text-align: center;">
                        <span class="badge badge-primary" style="font-size: 0.95rem; padding: 5px 12px; background: #3b82f6; color: #fff;">${sumHoje}</span>
                    </td>
                    <td style="padding: 14px 10px; text-align: center;">
                        <span class="badge" style="background: rgba(59, 130, 246, 0.3); color: #93c5fd; font-size: 0.95rem; padding: 5px 12px; font-weight: 700;">${sumUltimaHora}</span>
                    </td>
                    <td style="padding: 14px 10px; text-align: center; color: #10b981; font-size: 1rem;">
                        ${sumPreAlerta}
                    </td>
                    <td style="padding: 14px 10px; text-align: center; color: #f43f5e; font-size: 1rem;">
                        ${sumFora}
                    </td>
                    <td style="padding: 14px 10px; text-align: right; color: var(--text-secondary);">
                        -
                    </td>
                </tr>
            `;

            tbody.innerHTML = rowsHtml + totalHtml;
        }

        if (updatedSpan) {
            const nowTime = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            updatedSpan.textContent = `Última atualização às ${nowTime}`;
        }
    } catch (err) {
        console.error('Erro ao carregar dashboard de produção:', err);
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="6" style="padding: 20px; text-align: center; color: #f43f5e;">Erro ao carregar dados do servidor.</td></tr>';
        }
        if (updatedSpan) updatedSpan.textContent = 'Erro na atualização';
    }
}

function setupAdminListeners() {
    const btnRefreshDash = document.getElementById('btn-refresh-dashboard');
    if (btnRefreshDash) {
        btnRefreshDash.addEventListener('click', () => {
            loadAdminProductionDashboard();
        });
    }

    // Auto-update operator production dashboard every 1 minute (60000ms) when admin tab is open
    setInterval(() => {
        const adminTab = document.getElementById('admin');
        if (adminTab && adminTab.classList.contains('active')) {
            loadAdminProductionDashboard();
        }
    }, 60000);

    document.getElementById('btn-novo-usuario').addEventListener('click', () => {
        document.getElementById('modal-usuario-title').textContent = 'Cadastrar Usuario';
        document.getElementById('input-usuario-username').value = '';
        document.getElementById('input-usuario-password').value = '';
        document.getElementById('select-usuario-level').value = 'operator';
        document.getElementById('usuario-username-error').style.display = 'none';
        document.getElementById('modal-novo-usuario').classList.remove('hidden');
        document.getElementById('input-usuario-username').focus();
    });

    document.getElementById('btn-cancel-usuario').addEventListener('click', () => {
        document.getElementById('modal-novo-usuario').classList.add('hidden');
    });

    document.getElementById('btn-save-usuario').addEventListener('click', async () => {
        const username = document.getElementById('input-usuario-username').value.trim().toUpperCase();
        const password = document.getElementById('input-usuario-password').value.trim();
        const level = document.getElementById('select-usuario-level').value;
        const errEl = document.getElementById('usuario-username-error');

        if (!validateUsernameFormat(username)) {
            errEl.style.display = 'block';
            return;
        }
        errEl.style.display = 'none';

        if (!password) {
            alert('Informe uma senha para o usuario.');
            return;
        }

        try {
            const q = `${SERVER_URL.replace(/\/$/, '')}/api/usuarios`;
            const res = await fetch(q, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password, level })
            });
            if (!res.ok) throw new Error('Failed to save user');
            document.getElementById('modal-novo-usuario').classList.add('hidden');
            alert('Usuario ' + username + ' salvo com sucesso!');
            await renderUsersList();
        } catch (err) {
            console.error(err);
            alert('Erro ao cadastrar usuario no banco de dados.');
        }
    });
}

// ============================================================
// Pre-Alerta Upload Logic
// ============================================================
async function loadPreAlertaCache() {
    try {
        const q = `${SERVER_URL.replace(/\/$/, '')}/api/pre-alerta/count`;
        const res = await fetch(q);
        if (res.ok) {
            const json = await res.json();
            document.getElementById('base-count').textContent = json.count;
        }
    } catch (err) {
        console.error('Failed to load pre-alerta count:', err);
    }
}

const uploadZone = document.getElementById('upload-zone');
const fileUpload = document.getElementById('file-upload');

uploadZone.addEventListener('click', () => fileUpload.click());

fileUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    uploadZone.innerHTML = '<p>Processando <strong>' + file.name + '</strong>...</p>';

    // upload original file to MinIO in background (presigned URL flow)
    uploadFileToMinio(file).then(info => {
        if (info) {
            // optionally show some UI or save objectName to local DB
            console.log('File stored in MinIO as', info.objectName);
        }
    }).catch(err => console.warn('MinIO upload failed', err));

    if (file.name.endsWith('.csv')) {
        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: async (results) => { await savePreAlertaData(results.data); }
        });
    } else if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
        const reader = new FileReader();
        reader.onload = async (e) => {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const jsonData = XLSX.utils.sheet_to_json(firstSheet);
            await savePreAlertaData(jsonData);
        };
        reader.readAsArrayBuffer(file);
    }
});

async function savePreAlertaData(data) {
    let itemsToImport = [];
    const cleanKey = (k) => k.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();

    for (const row of data) {
        let serialKey = Object.keys(row).find(k => cleanKey(k) === 'SERIAL');
        let codKey = Object.keys(row).find(k => {
            const ck = cleanKey(k);
            return ck === 'CODIGO' || ck === 'COD' || ck === 'TM' || ck.startsWith('CODIGO') || ck.startsWith('COD_');
        });
        let descKey = Object.keys(row).find(k => cleanKey(k).includes('DESCRI'));
        let fabKey = Object.keys(row).find(k => cleanKey(k).includes('FABRI'));

        if (serialKey && row[serialKey]) {
            const serial = String(row[serialKey]).trim().toUpperCase();
            itemsToImport.push({
                serial: serial,
                codigo: codKey ? String(row[codKey]).trim() : '',
                descricao: descKey ? String(row[descKey]).trim() : '',
                fabricante: fabKey ? String(row[fabKey]).trim() : ''
            });
        }
    }

    if (itemsToImport.length > 0) {
        try {
            const q = `${SERVER_URL.replace(/\/$/, '')}/api/pre-alerta/import`;
            const chunkSize = 1000;
            const totalItems = itemsToImport.length;
            let importedCount = 0;

            for (let i = 0; i < totalItems; i += chunkSize) {
                const chunk = itemsToImport.slice(i, i + chunkSize);
                const response = await fetch(q, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ items: chunk })
                });
                if (!response.ok) throw new Error('Chunk import failed');
                
                importedCount += chunk.length;
                const percent = Math.round((importedCount / totalItems) * 100);
                
                uploadZone.innerHTML = `
                    <p>Processando importacao...</p>
                    <div style="width: 80%; max-width: 500px; background: rgba(255,255,255,0.1); height: 10px; border-radius: 5px; margin: 15px auto; overflow: hidden;">
                        <div style="width: ${percent}%; background: var(--primary-color); height: 100%; transition: width 0.2s ease;"></div>
                    </div>
                    <p><strong>${percent}%</strong> (${importedCount} de ${totalItems} registros)</p>
                `;
            }
            
            await loadPreAlertaCache();
            uploadZone.innerHTML = `
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="1.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                <p><strong>${totalItems}</strong> registros importados com sucesso!</p>
                <p style="font-size: 0.8rem; margin-top: 8px;">Clique para carregar mais.</p>
            `;
        } catch (err) {
            console.error(err);
            uploadZone.innerHTML = `
                <p style="color: red;">Erro ao salvar os dados no banco de dados.</p>
            `;
        }
    } else {
        uploadZone.innerHTML = `
            <p style="color: orange;">Nenhum registro válido encontrado (verifique se a coluna SERIAL existe).</p>
        `;
    }
}

document.getElementById('btn-clear-base').addEventListener('click', async () => {
    if (confirm("Tem certeza que deseja apagar toda a base de Pre-Alerta?")) {
        try {
            const q = `${SERVER_URL.replace(/\/$/, '')}/api/pre-alerta/clear`;
            const response = await fetch(q, { method: 'DELETE' });
            if (!response.ok) throw new Error('Failed to clear on server');
            await loadPreAlertaCache();
            uploadZone.innerHTML = `
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                <p>Arraste o arquivo aqui ou <strong>clique para selecionar</strong></p>
            `;
        } catch (err) {
            console.error(err);
            alert('Erro ao apagar base de pré-alerta no servidor.');
        }
    }
});

// ============================================================
// Receive Logic
// ============================================================
function setupEventListeners() {
    const form = document.getElementById('form-recebimento');

    if (form) {
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            processRecebimento();
        });
    }

    const inputs = ['serial', 'pon', 'mac'];
    inputs.forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.keyCode === 13 || e.key === 'Tab' || e.keyCode === 9) {
                    e.preventDefault();
                    const modelo = document.getElementById('modelo').value;
                    const isException = (window.modelFieldsConfig[modelo] === 2);
                    setTimeout(() => {
                        if (id === 'serial') {
                            if (isException) document.getElementById('mac').focus();
                            else document.getElementById('pon').focus();
                        } else if (id === 'pon') {
                            document.getElementById('mac').focus();
                        } else if (id === 'mac') {
                            processRecebimento();
                        }
                    }, 50);
                }
            });
        }
    });

    document.getElementById('btn-modal-ok').addEventListener('click', confirmSegregar);
    document.getElementById('modelo').addEventListener('change', updateFormFields);

    const btnLimpar = document.getElementById('btn-limpar');
    if (btnLimpar) {
        btnLimpar.addEventListener('click', () => {
            document.getElementById('serial').value = '';
            document.getElementById('pon').value = '';
            document.getElementById('mac').value = '';
            hideMessage();
            document.getElementById('serial').focus();
        });
    }
}

function updateFormFields() {
    const modelo = document.getElementById('modelo').value;
    const isException = (window.modelFieldsConfig[modelo] === 2);
    const groupPon = document.getElementById('group-pon');
    if (groupPon) {
        if (isException) {
            groupPon.style.display = 'none';
            document.getElementById('pon').value = '';
        } else {
            groupPon.style.display = 'block';
        }
    }
}

function showMessage(text, type) {
    const msgEl = document.getElementById('status-message');
    msgEl.textContent = text;
    msgEl.className = 'status-message status-' + type;
    msgEl.classList.remove('hidden');
}

function hideMessage() {
    document.getElementById('status-message').classList.add('hidden');
}

function validateModelFields(modelo, serial, pon, mac) {
    const isException = (window.modelFieldsConfig[modelo] === 2);
    const rules = window.modelRulesConfig[modelo] || {};

    const checkPrefix = (value, prefixStr) => {
        if (!prefixStr) return true;
        const prefixes = prefixStr.split(',').map(p => p.trim()).filter(Boolean);
        if (prefixes.length === 0) return true;
        return prefixes.some(p => value.startsWith(p));
    };

    if (!checkPrefix(serial, rules.serial))
        return { valid: false, error: 'SERIAL deve iniciar com: ' + rules.serial };
    if (!isException && !checkPrefix(pon, rules.pon))
        return { valid: false, error: 'PON ID deve iniciar com: ' + rules.pon };
    if (!checkPrefix(mac, rules.mac))
        return { valid: false, error: 'MAC deve iniciar com: ' + rules.mac };

    if (modelo === "BC-UM221E") {
        if (serial.length >= 6) {
            const last6Serial = serial.slice(-6);
            if (!mac.endsWith(last6Serial))
                return { valid: false, error: "Para BC-UM221E, os ultimos 6 caracteres do MAC devem ser iguais aos ultimos 6 do SERIAL." };
        }
    } else if (modelo === "BCSKV630") {
        if (serial.length >= 6) {
            const last6Serial = serial.slice(-6);
            if (!mac.startsWith("149448" + last6Serial))
                return { valid: false, error: "Para BCSKV630, o MAC deve ser 149448 seguido dos ultimos 6 caracteres do SERIAL." };
        }
    } else if (modelo === "NP7287") {
        if (pon.length >= 6) {
            const last6Pon = pon.slice(-6);
            if (!mac.endsWith(last6Pon))
                return { valid: false, error: "Para NP7287, o MAC deve terminar com os mesmos ultimos caracteres do PON ID." };
        }
    } else if (modelo === "ZXHN F6600P") {
        const sIs3 = serial.startsWith("ZTE3");
        const sIsGD = serial.startsWith("ZTEGD");
        const pIs3 = pon.startsWith("ZTE3");
        const pIsGD = pon.startsWith("ZTEGD");
        if (sIs3 && pIs3) return { valid: false, error: "SERIAL e PON ID nao podem comecar ambos com ZTE3." };
        if (sIsGD && pIsGD) return { valid: false, error: "SERIAL e PON ID nao podem comecar ambos com ZTEGD." };
    }

    if (mac.length !== 12)
        return { valid: false, error: "O MAC bipado deve ter exatamente 12 caracteres (apenas letras e numeros)." };

    return { valid: true };
}

async function checkDuplicity(s, p, m) {
    // 1. Check local browser cache
    const keys = await dbRecebidos.keys();
    for (const key of keys) {
        const item = await dbRecebidos.getItem(key);
        const vals = [item.serial, item.pon, item.mac].filter(Boolean);
        if ([s, p, m].some(v => v && vals.includes(v))) {
            return item;
        }
    }
    // 2. Check PostgreSQL backend
    try {
        const q = `${SERVER_URL.replace(/\/$/, '')}/api/recebimentos/check?serial=${encodeURIComponent(s || '')}&pon=${encodeURIComponent(p || '')}&mac=${encodeURIComponent(m || '')}`;
        const res = await fetch(q);
        if (res.ok) {
            const json = await res.json();
            if (json.duplicate) {
                return {
                    serial: json.data.serial,
                    pon: json.data.pon,
                    mac: json.data.mac,
                    dataHora: json.data.datahora
                };
            }
        }
    } catch (err) {
        console.error('Backend duplicity check failed:', err);
    }
    return null;
}

async function checkPreAlertaOnServer(value) {
    if (!value) return null;
    try {
        const q = `${SERVER_URL.replace(/\/$/, '')}/api/pre-alerta/check?value=${encodeURIComponent(value)}`;
        const res = await fetch(q);
        if (res.ok) {
            const json = await res.json();
            if (json.found) return json.data;
        }
    } catch (err) {
        console.error('Failed to check pre-alerta on server:', err);
    }
    return null;
}

async function processRecebimento() {
    if (isProcessingRecebimento) return;
    isProcessingRecebimento = true;

    const btnReceber = document.getElementById('btn-receber');
    if (btnReceber) btnReceber.disabled = true;

    try {
        hideMessage();
        const modelo = document.getElementById('modelo').value;
        const isException = (window.modelFieldsConfig[modelo] === 2);

        const serial = document.getElementById('serial').value.trim().toUpperCase();
        const pon = isException ? '' : document.getElementById('pon').value.trim().toUpperCase();
        const mac = document.getElementById('mac').value.trim().toUpperCase();

        if (!serial || (!isException && !pon) || !mac) {
            showMessage('Preencha todos os campos necessarios para receber a unidade.', 'error');
            isProcessingRecebimento = false;
            if (btnReceber) btnReceber.disabled = false;
            return;
        }

        if (serial === mac) {
            showMessage('ERRO: O SERIAL e o MAC nao podem ser iguais. Limpe o campo e bipe novamente.', 'error');
            isProcessingRecebimento = false;
            if (btnReceber) btnReceber.disabled = false;
            return;
        }
        if (!isException && (serial === pon || pon === mac)) {
            showMessage('ERRO: SERIAL, PON e MAC devem ser valores diferentes. Verifique a bipagem.', 'error');
            isProcessingRecebimento = false;
            if (btnReceber) btnReceber.disabled = false;
            return;
        }

        const validacao = validateModelFields(modelo, serial, pon, mac);
        if (!validacao.valid) {
            showMessage('ERRO: ' + validacao.error, 'error');
            isProcessingRecebimento = false;
            if (btnReceber) btnReceber.disabled = false;
            return;
        }

        // Validate duplicate status and pre-alerta match in a single HTTP request!
        const validateUrl = `${SERVER_URL.replace(/\/$/, '')}/api/recebimentos/validate?serial=${encodeURIComponent(serial)}&pon=${encodeURIComponent(pon)}&mac=${encodeURIComponent(mac)}`;
        const valRes = await fetch(validateUrl);
        if (!valRes.ok) throw new Error('Validation failed');
        const validation = await valRes.json();

        // 1. Check duplicate
        if (validation.duplicate) {
            const dup = validation.duplicateData;
            const dateStr = new Date(dup.data_hora).toLocaleString('pt-BR');
            showMessage('UNIDADE JA RECEBIDA (' + dateStr + ')', 'error');
            document.getElementById('serial').value = '';
            if (!isException) document.getElementById('pon').value = '';
            document.getElementById('mac').value = '';
            document.getElementById('serial').focus();
            isProcessingRecebimento = false;
            if (btnReceber) btnReceber.disabled = false;
            return;
        }

        // 2. Setup unit data
        const unitData = {
            id: Date.now().toString(),
            modelo,
            serial,
            pon,
            mac,
            dataHora: new Date().toISOString(),
            usuario: currentUser ? currentUser.username : 'DESCONHECIDO'
        };

        // 3. Check pre-alerta match
        if (validation.preAlertaMatch) {
            const preAlertaMatch = validation.preAlertaMatch;
            unitData.noPreAlerta = true;
            unitData.matchedValue = validation.matchedValue;
            unitData.codigo = preAlertaMatch.codigo;
            unitData.descricao = preAlertaMatch.descricao;
            unitData.fabricante = preAlertaMatch.fabricante;
            await saveRecebimento(unitData);
            showMessage('RECEBIDO', 'success');
            setTimeout(hideMessage, 2000);
            isProcessingRecebimento = false;
            if (btnReceber) btnReceber.disabled = false;
        } else {
            unitData.noPreAlerta = false;
            currentPendingUnit = unitData;
            document.getElementById('modal-segregar').classList.remove('hidden');
        }
    } catch (err) {
        console.error(err);
        isProcessingRecebimento = false;
        if (btnReceber) btnReceber.disabled = false;
    }
}

async function confirmSegregar() {
    const unit = currentPendingUnit;
    if (unit) {
        currentPendingUnit = null; // Clear immediately to prevent race conditions
        const btnOk = document.getElementById('btn-modal-ok');
        if (btnOk) btnOk.disabled = true; // Disable button immediately to prevent double clicks
        
        try {
            await saveRecebimento(unit);
        } finally {
            if (btnOk) btnOk.disabled = false;
        }
    }
    document.getElementById('modal-segregar').classList.add('hidden');
    isProcessingRecebimento = false;
    const btnReceber = document.getElementById('btn-receber');
    if (btnReceber) btnReceber.disabled = false;
}

async function saveRecebimento(unitData) {
    await dbRecebidos.setItem(unitData.id, unitData);
    const isException = (window.modelFieldsConfig[unitData.modelo] === 2);
    document.getElementById('serial').value = '';
    if (!isException) document.getElementById('pon').value = '';
    document.getElementById('mac').value = '';
    document.getElementById('serial').focus();
    await updateCounters();
    await loadRecentRecebimentos();

    // send to backend to persist in Postgres (best-effort)
    (async () => {
        try {
            await fetch((SERVER_URL.replace(/\/$/, '') + '/api/recebimentos'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(unitData)
            });
        } catch (err) {
            console.warn('Failed to send recebimento to server:', err);
        }
    })();
}

async function updateCounters() {
    let countPreAlerta = 0;
    let countFora = 0;
    const todayStr = new Date().toDateString();
    const keys = await dbRecebidos.keys();
    for (const key of keys) {
        const item = await dbRecebidos.getItem(key);
        if (item && item.dataHora && new Date(item.dataHora).toDateString() === todayStr) {
            if (item.noPreAlerta) countPreAlerta++;
            else countFora++;
        }
    }
    document.getElementById('count-pre-alerta').textContent = countPreAlerta;
    document.getElementById('count-fora').textContent = countFora;
}

async function loadRecentRecebimentos() {
    const keys = await dbRecebidos.keys();
    let all = [];
    for (const key of keys) {
        all.push(await dbRecebidos.getItem(key));
    }

    all.sort((a, b) => new Date(b.dataHora) - new Date(a.dataHora));
    const recent = all.slice(0, 5);
    const listEl = document.getElementById('recent-list');
    listEl.innerHTML = '';

    recent.forEach(item => {
        const li = document.createElement('li');
        li.className = 'recent-item ' + (item.noPreAlerta ? 'pre-alerta' : 'segregado');
        const dateStr = new Date(item.dataHora).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        li.innerHTML = `
            <div class="recent-item-info">
                <strong>${item.serial}</strong>
                <span>${item.modelo}</span>
                <span style="color: var(--text-secondary)">${dateStr}</span>
                <span style="color: var(--primary-color); font-size: 0.8rem;">${item.usuario || ''}</span>
            </div>
            <span class="badge ${item.noPreAlerta ? 'badge-success' : 'badge-danger'}">
                ${item.noPreAlerta ? 'PRE-ALERTA' : 'SEGREGADO'}
            </span>
        `;
        listEl.appendChild(li);
    });
}

// ============================================================
// Reports Export
// ============================================================
function getReportDateRange() {
    const startVal = document.getElementById('report-date-start').value;
    const endVal = document.getElementById('report-date-end').value;
    return {
        start: startVal ? new Date(startVal + 'T00:00:00') : null,
        end: endVal ? new Date(endVal + 'T23:59:59') : null
    };
}

function isWithinRange(dateStr, start, end) {
    const d = new Date(dateStr);
    if (start && d < start) return false;
    if (end && d > end) return false;
    return true;
}

function setupReportListeners() {
    document.getElementById('btn-export-prealerta').addEventListener('click', async () => {
        const startVal = document.getElementById('report-date-start').value;
        const endVal = document.getElementById('report-date-end').value;
        const modeloVal = document.getElementById('report-modelo').value;
        
        let url = `${SERVER_URL.replace(/\/$/, '')}/api/recebimentos/report?noPreAlerta=true`;
        if (startVal) url += `&start=${startVal}`;
        if (endVal) url += `&end=${endVal}`;
        if (modeloVal) url += `&modelo=${encodeURIComponent(modeloVal)}`;

        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error('Failed to fetch report');
            const rows = await res.json();
            
            if (rows.length === 0) { alert("Nenhum dado encontrado para exportar nesse periodo."); return; }
            
            const data = rows.map((item, index) => ({
                ID: index + 1,
                Fabricante: item.fabricante || '',
                Modelo: item.modelo || '',
                "Serial Number": item.serial_number || '',
                "GPON ID": item.gpon_id || '',
                MAC: item.mac || '',
                "Serial_Pre_Alerta": item.matched_value || '',
                "Usuário": item.usuario || '',
                Data_Hora: new Date(item.data_hora).toLocaleString('pt-BR'),
                "Código": item.codigo || '',
                "Descrição": item.descricao || '',
                Status: item.status || 'Recebida'
            }));

            const worksheet = XLSX.utils.json_to_sheet(data);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, "Recebidos Pre-Alerta");
            XLSX.writeFile(workbook, "relatorio_pre_alerta.xlsx");
        } catch (err) {
            console.error(err);
            alert('Erro ao carregar dados do relatorio.');
        }
    });

    document.getElementById('btn-export-fora').addEventListener('click', async () => {
        const startVal = document.getElementById('report-date-start').value;
        const endVal = document.getElementById('report-date-end').value;
        const modeloVal = document.getElementById('report-modelo').value;
        
        let url = `${SERVER_URL.replace(/\/$/, '')}/api/recebimentos/report?noPreAlerta=false`;
        if (startVal) url += `&start=${startVal}`;
        if (endVal) url += `&end=${endVal}`;
        if (modeloVal) url += `&modelo=${encodeURIComponent(modeloVal)}`;

        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error('Failed to fetch report');
            const rows = await res.json();
            
            if (rows.length === 0) { alert("Nenhum dado encontrado para exportar nesse periodo."); return; }
            
            const data = rows.map((item, index) => ({
                ID: index + 1,
                Fabricante: item.fabricante || '',
                Modelo: item.modelo || '',
                "Serial Number": item.serial_number || '',
                "GPON ID": item.gpon_id || '',
                MAC: item.mac || '',
                "Serial_Pre_Alerta": item.matched_value || '',
                "Usuário": item.usuario || '',
                Data_Hora: new Date(item.data_hora).toLocaleString('pt-BR'),
                Status: item.status || 'Recebida'
            }));

            const worksheet = XLSX.utils.json_to_sheet(data);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, "Recebidos Fora Pre-Alerta");
            XLSX.writeFile(workbook, "relatorio_fora_pre_alerta.xlsx");
        } catch (err) {
            console.error(err);
            alert('Erro ao carregar dados do relatorio.');
        }
    });

    document.getElementById('btn-export-exp-pintura').addEventListener('click', async () => {
        const startVal = document.getElementById('report-date-start').value;
        const endVal = document.getElementById('report-date-end').value;
        const modeloVal = document.getElementById('report-modelo').value;
        
        let url = `${SERVER_URL.replace(/\/$/, '')}/api/expedicao-pintura/report?`;
        if (startVal) url += `&start=${startVal}`;
        if (endVal) url += `&end=${endVal}`;
        if (modeloVal) url += `&modelo=${encodeURIComponent(modeloVal)}`;

        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error('Failed to fetch report');
            const rows = await res.json();
            
            if (rows.length === 0) { alert("Nenhum dado encontrado para exportar nesse periodo."); return; }
            
            const data = rows.map((item, index) => ({
                ID: index + 1,
                "Código Pallet": item.codigo_pallet || '',
                "Status Pallet": item.pallet_status || '',
                "Data Criação Pallet": item.data_criacao ? new Date(item.data_criacao).toLocaleString('pt-BR') : '',
                "Data Fechamento Pallet": (item.pallet_status === 'FECHADO' && item.data_fechamento) ? new Date(item.data_fechamento).toLocaleString('pt-BR') : '',
                Fabricante: item.fabricante || '',
                Modelo: item.modelo || '',
                "Serial Number": item.serial_number || '',
                "GPON ID": item.gpon_id || '',
                MAC: item.mac || '',
                "Usuário Bipagem": item.usuario || '',
                "Data Bipagem": item.data_bipagem ? new Date(item.data_bipagem).toLocaleString('pt-BR') : '',
                "Status Item": item.status || ''
            }));

            const worksheet = XLSX.utils.json_to_sheet(data);
            const workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, "Itens Expedição Pintura");
            XLSX.writeFile(workbook, "relatorio_expedicao_pintura.xlsx");
        } catch (err) {
            console.error(err);
            alert('Erro ao carregar dados do relatorio.');
        }
    });

    const btnExpRetornoPintura = document.getElementById('btn-export-retorno-pintura');
    if (btnExpRetornoPintura) {
        btnExpRetornoPintura.addEventListener('click', async () => {
            const startVal = document.getElementById('report-date-start').value;
            const endVal = document.getElementById('report-date-end').value;
            const modeloVal = document.getElementById('report-modelo').value;
            
            let url = `${SERVER_URL.replace(/\/$/, '')}/api/retorno-pintura/report?`;
            if (startVal) url += `&start=${startVal}`;
            if (endVal) url += `&end=${endVal}`;
            if (modeloVal) url += `&modelo=${encodeURIComponent(modeloVal)}`;

            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error('Failed to fetch report');
                const rows = await res.json();
                
                if (rows.length === 0) { alert("Nenhum dado encontrado para exportar nesse período."); return; }
                
                const data = rows.map((item, index) => ({
                    ID: index + 1,
                    Fabricante: item.fabricante || '',
                    Modelo: item.modelo || '',
                    "Serial Number": item.serial_number || '',
                    "GPON ID": item.gpon_id || '',
                    MAC: item.mac || '',
                    "Usuário Retorno": item.usuario || '',
                    "Data Retorno": item.data_retorno ? new Date(item.data_retorno).toLocaleString('pt-BR') : '',
                    "Status": item.status || 'Retorno de Pintura'
                }));

                const worksheet = XLSX.utils.json_to_sheet(data);
                const workbook = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(workbook, worksheet, "Retorno Pintura");
                XLSX.writeFile(workbook, "relatorio_retorno_pintura.xlsx");
            } catch (err) {
                console.error(err);
                alert('Erro ao carregar dados do relatório de retorno de pintura.');
            }
        });
    }

    document.getElementById('btn-clear-recebidos').addEventListener('click', async () => {
        if (confirm("Tem certeza que deseja apagar TODO o historico de recebimentos? Faca os relatorios antes!")) {
            try {
                const q = `${SERVER_URL.replace(/\/$/, '')}/api/recebimentos/clear`;
                const response = await fetch(q, { method: 'DELETE' });
                if (!response.ok) throw new Error('Failed to clear recebimentos on server');
                await dbRecebidos.clear();
                await updateCounters();
                await loadRecentRecebimentos();
                alert("Historico apagado com sucesso no servidor e localmente.");
            } catch (err) {
                console.error(err);
                alert("Erro ao apagar historico de recebimentos no servidor.");
            }
        }
    });

    // Admin: Export Usuarios
    document.getElementById('btn-export-usuarios').addEventListener('click', async () => {
        const keys = await dbUsuarios.keys();
        const data = [];
        for (const key of keys) {
            const u = await dbUsuarios.getItem(key);
            data.push({
                USUARIO: u.username,
                NIVEL: u.level === 'admin' ? 'Administrador' : 'Operador',
                CADASTRADO_EM: u.criadoEm ? new Date(u.criadoEm).toLocaleString('pt-BR') : ''
            });
        }
        if (data.length === 0) { alert("Nenhum usuario cadastrado."); return; }
        const worksheet = XLSX.utils.json_to_sheet(data);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Usuarios");
        XLSX.writeFile(workbook, "relatorio_usuarios.xlsx");
    });

    // Admin: Export Modelos
    document.getElementById('btn-export-modelos').addEventListener('click', async () => {
        let savedModels = await dbModelos.getItem('lista') || [...defaultModels];
        const data = savedModels.map(m => {
            const name = typeof m === 'object' ? m.name : m;
            const fields = typeof m === 'object' ? m.fields : (name === 'BCSKV630' || name === 'BC-UM221E' ? 2 : 3);
            const rules = typeof m === 'object' ? (m.rules || {}) : {};
            const def = defaultModels.find(d => d.name === name);
            const finalRules = Object.keys(rules).length > 0 ? rules : (def ? def.rules || {} : {});
            return {
                MODELO: name,
                CAMPOS: fields === 2 ? '2 Campos (SERIAL, MAC)' : '3 Campos (SERIAL, PON ID, MAC)',
                PREFIXO_SERIAL: finalRules.serial || '(qualquer)',
                PREFIXO_PON: fields === 3 ? (finalRules.pon || '(qualquer)') : 'N/A',
                PREFIXO_MAC: finalRules.mac || '(qualquer)',
                REGRAS_ESPECIAIS: getRulesDescription(name)
            };
        });
        if (data.length === 0) { alert("Nenhum modelo cadastrado."); return; }
        const worksheet = XLSX.utils.json_to_sheet(data);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Modelos");
        XLSX.writeFile(workbook, "relatorio_modelos.xlsx");
    });
}

function getRulesDescription(modelo) {
    if (modelo === "BC-UM221E") return "Ultimos 6 do MAC = Ultimos 6 do SERIAL";
    if (modelo === "BCSKV630") return "MAC = '149448' + Ultimos 6 do SERIAL";
    if (modelo === "NP7287") return "MAC deve terminar com os ultimos caracteres do PON ID";
    if (modelo === "ZXHN F6600P") return "SERIAL e PON ID nao podem ter mesmo prefixo (ZTE3 ou ZTEGD)";
    return "";
}

// ============================================================
// EXPEDIÇÃO PINTURA MODULE
// ============================================================
let currentExpedicaoPallet = null;

let currentExpedicaoItems = [];

async function loadActivePallet() {
    try {
        const res = await fetch(`${SERVER_URL.replace(/\/$/, '')}/api/expedicao-pintura/active`);
        if (res.ok) {
            const data = await res.json();
            currentExpedicaoPallet = data.pallet;
            currentExpedicaoItems = data.items || [];
            renderPalletData(data.pallet, data.items || []);
            const inputScan = document.getElementById('exp-scan-input');
            if (inputScan) setTimeout(() => inputScan.focus(), 100);
        } else {
            console.error('Falha ao carregar pallet ativo:', res.statusText);
        }
    } catch (err) {
        console.error('Erro de conexão ao carregar pallet ativo:', err);
    }
}

function renderPalletData(pallet, items) {
    if (!pallet) return;
    currentExpedicaoPallet = pallet;
    currentExpedicaoItems = items || [];
    
    // Inputs & Badges
    const inputCodigo = document.getElementById('exp-codigo-pallet');
    const statPallet = document.getElementById('exp-stat-pallet');
    const resumoCodigo = document.getElementById('exp-resumo-codigo');
    const resumoStatus = document.getElementById('exp-resumo-status');
    const statTotal = document.getElementById('exp-stat-total');
    const resumoTotal = document.getElementById('exp-resumo-total');
    const tabelaCount = document.getElementById('exp-tabela-count');
    const tbody = document.getElementById('exp-itens-tbody');

    const totalUnidades = (items && items.length !== undefined) ? items.length : (pallet.total_unidades || 0);

    if (inputCodigo) inputCodigo.value = pallet.codigo_pallet;
    if (statPallet) statPallet.textContent = pallet.codigo_pallet;
    if (resumoCodigo) resumoCodigo.textContent = pallet.codigo_pallet;
    
    if (resumoStatus) {
        resumoStatus.textContent = pallet.status || 'ABERTO';
        resumoStatus.className = pallet.status === 'ABERTO' ? 'badge badge-success' : 'badge badge-danger';
    }

    // Toggle Reabrir vs Fechar buttons
    const btnFechar = document.getElementById('btn-exp-fechar-pallet');
    const btnReabrir = document.getElementById('btn-exp-reabrir-pallet');
    if (pallet.status === 'FECHADO') {
        if (btnFechar) btnFechar.style.display = 'none';
        if (btnReabrir) btnReabrir.style.display = '';
    } else {
        if (btnFechar) btnFechar.style.display = '';
        if (btnReabrir) btnReabrir.style.display = 'none';
    }

    if (statTotal) statTotal.textContent = totalUnidades;
    if (resumoTotal) resumoTotal.textContent = `${totalUnidades} Unidades`;
    if (tabelaCount) tabelaCount.textContent = `${totalUnidades} itens`;

    // Render table
    if (tbody) {
        if (!items || items.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" style="padding: 20px; text-align: center; color: var(--text-secondary);">
                        Nenhuma unidade bipada ainda neste pallet.
                    </td>
                </tr>
            `;
        } else {
            tbody.innerHTML = items.map((item, idx) => {
                const num = items.length - idx;
                const hora = item.data_bipagem ? new Date(item.data_bipagem).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
                return `
                    <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                        <td style="padding: 8px 10px; color: var(--text-secondary);">${num}</td>
                        <td style="padding: 8px 10px; font-weight: 600; color: var(--text-primary); font-family: monospace;">${item.serial_number || '---'}</td>
                        <td style="padding: 8px 10px; color: var(--primary-color);">${item.modelo || '---'}</td>
                        <td style="padding: 8px 10px; color: var(--text-secondary); font-size: 0.8rem;">${hora}</td>
                        <td style="padding: 8px 10px; text-align: right;">
                            <button onclick="handleRemoverItemPallet(${item.id})" class="btn btn-secondary" style="padding: 2px 8px; font-size: 0.75rem; background: rgba(244, 63, 94, 0.2); color: #f43f5e; border: 1px solid rgba(244, 63, 94, 0.4);" title="Remover unidade do pallet">
                                &times;
                            </button>
                        </td>
                    </tr>
                `;
            }).join('');
        }
    }
}

async function handleRemoverItemPallet(itemId) {
    if (!confirm("Deseja realmente remover esta unidade do pallet? O status dela no sistema retornará para 'Recebida'.")) return;
    try {
        const res = await fetch(`${SERVER_URL.replace(/\/$/, '')}/api/expedicao-pintura/item/${itemId}`, {
            method: 'DELETE'
        });
        if (res.ok) {
            const data = await res.json();
            showExpedicaoStatus(`Unidade <strong>${data.serial || ''}</strong> removida do pallet e seu status retornou para 'Recebida'.`, false);
            if (currentExpedicaoPallet) {
                await selecionarPalletAberto(currentExpedicaoPallet.codigo_pallet);
            } else {
                await loadActivePallet();
            }
        } else {
            alert("Erro ao remover item do pallet.");
        }
    } catch (err) {
        console.error("Erro ao remover item:", err);
    }
}

function showExpedicaoStatus(message, isError = false) {
    const statusMsg = document.getElementById('exp-status-message');
    if (!statusMsg) return;
    statusMsg.className = `status-message ${isError ? 'status-error' : 'status-success'}`;
    statusMsg.innerHTML = message;
    statusMsg.classList.remove('hidden');
    if (!isError) {
        setTimeout(() => {
            statusMsg.classList.add('hidden');
        }, 5000);
    }
}

function showUnidadeNaoRecebidaModal(msg) {
    const modal = document.getElementById('modal-unidade-nao-recebida');
    const text = document.getElementById('modal-unidade-nao-recebida-text');
    if (text && msg) {
        text.textContent = msg;
    }
    if (modal) {
        modal.classList.remove('hidden');
    }
}

/* ==========================================================================
   GERADOR VETORIAL SVG DE CÓDIGO DE BARRAS CODE 128 (100% OFFLINE / NATIVO)
   ========================================================================== */
function generateCode128SvgHtml(text, height = 70, scale = 3.2) {
  const patterns = [
    '11011001100','11001101100','11001100110','10010011000','10010001100','10001001100','10011001000','10011000100','10001100100','11001001000',
    '11001000100','11000100100','10110011100','10011011100','10011001110','10111001100','10011101100','10011100110','11001110010','11001011100',
    '11001001110','11011100100','11001110100','11101101110','11101001100','11100101100','11100100110','11101100100','11100110100','11100110010',
    '11011011000','11011000110','11000110110','10100011000','10001011000','10001000110','10110001000','10001101000','10001100010','11010001000',
    '11000101000','11000100010','10110111000','10110001110','10001101110','10111011000','10111000110','10001110110','11101110110','11010001110',
    '11000101110','11011101000','11011100010','11011101110','11101011000','11101000110','11100010110','11101101000','11101100010','11100011010',
    '11101111010','11001000010','11110001010','10100110000','10100001100','10010110000','10010000110','10000101100','10000100110','10110010000',
    '10110000100','10011010000','10011000010','10000110100','10000110010','11000010010','11001010000','11110111010','11000010100','10001111010',
    '10100111100','10010111100','10010011110','10111100100','10011110100','10011110010','11110100100','11110010100','11110010010','11011011110',
    '11011110110','11110110110','10101111000','10100011110','10001011110','10111101000','10111100010','11110101000','11110100010','10111011110',
    '10111101110','11101011110','11110101110','11010000100','11010010000','11010011100','1100011101011'
  ];

  const START_B = 104;
  const STOP = 106;
  const str = String(text || '').trim();

  let checksum = START_B;
  let bitString = patterns[START_B];

  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i) - 32;
    if (code >= 0 && code < patterns.length) {
      checksum += code * (i + 1);
      bitString += patterns[code];
    }
  }

  const checkCode = checksum % 103;
  bitString += patterns[checkCode];
  bitString += patterns[STOP];

  const width = bitString.length * scale;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
  svg += `<rect width="100%" height="100%" fill="#fff"/>`;

  let posX = 0;
  for (let i = 0; i < bitString.length; i++) {
    if (bitString[i] === '1') {
      svg += `<rect x="${posX}" y="0" width="${scale}" height="${height}" fill="#000"/>`;
    }
    posX += scale;
  }
  svg += `</svg>`;
  return svg;
}

/* ==========================================================================
   FUNÇÃO PRINCIPAL DE IMPRESSÃO DA FOLHA A4 DO PALLET (COM QR CODE)
   ========================================================================== */
function imprimirFolhaA4PalletGenerica(dados) {
  const {
    palletId = 'PP00000001',
    modelo = 'HG6145F3',
    dataHora = new Date().toLocaleString('pt-BR'),
    totalUnidades = 0,
    listaUnidades = [],
    logoUrl = 'logo.png'
  } = dados;

  const barcodeSvgHtml = generateCode128SvgHtml(palletId, 68, 3.2);
  const qrContent = (listaUnidades && listaUnidades.length > 0) ? listaUnidades.join(';') : palletId;

  const printWindow = window.open('', '_blank', 'width=1100,height=850');
  if (!printWindow) {
    alert("Por favor, permita pop-ups no navegador para abrir a folha de impressão!");
    return;
  }

  const printHtml = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Identificação do Pallet - ${palletId}</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Arial', 'Helvetica', sans-serif;
    }
    body {
      background-color: #fff;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 0;
      margin: 0;
    }
    .no-print {
      padding: 12px;
      text-align: center;
      background: #0f172a;
      width: 100%;
    }
    .btn-print {
      background-color: #0284c7;
      color: #fff;
      border: none;
      padding: 10px 26px;
      font-size: 16px;
      font-weight: bold;
      border-radius: 6px;
      cursor: pointer;
    }
    .btn-print:hover {
      background-color: #0369a1;
    }
    .page-a4 {
      width: 297mm;
      height: 200mm;
      background: white;
      padding: 8mm 14mm;
      position: relative;
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
      overflow: hidden;
    }
    .header-logo {
      position: absolute;
      top: 8mm;
      right: 14mm;
    }
    .header-logo img {
      height: 48px;
      width: auto;
    }
    .pallet-header {
      text-align: center;
      margin-top: 1mm;
      margin-bottom: 5mm;
    }
    .pallet-title {
      font-size: 34pt;
      font-weight: 900;
      letter-spacing: 2px;
      color: #000;
      line-height: 1;
    }
    .pallet-code {
      font-size: 52pt;
      font-weight: 900;
      letter-spacing: 3px;
      color: #000;
      margin: 2px 0 4px 0;
      line-height: 1;
    }
    .barcode-container {
      display: flex;
      justify-content: center;
      align-items: center;
      margin-top: 4px;
    }
    .barcode-container svg {
      max-width: 520px;
      height: 68px;
    }
    
    .content-grid {
      display: flex;
      gap: 12mm;
      margin-top: 2mm;
      flex: 1;
    }
    
    .card-lote {
      flex: 1.1;
      border: 2.5px solid #000;
      border-radius: 10px;
      padding: 18px 22px;
      display: flex;
      flex-direction: column;
      justify-content: space-around;
      background: #fdfdfd;
    }
    .data-group {
      margin-bottom: 12px;
    }
    .data-group:last-child {
      margin-bottom: 0;
    }
    .data-label {
      font-size: 11pt;
      font-weight: 800;
      color: #555;
      text-transform: uppercase;
      margin-bottom: 4px;
      letter-spacing: 1px;
    }
    .data-value-model {
      font-size: 24pt;
      font-weight: 900;
      color: #000;
      line-height: 1.1;
    }
    .data-value-date {
      font-size: 18pt;
      font-weight: 800;
      color: #000;
      line-height: 1.2;
    }
    .data-value-units {
      font-size: 26pt;
      font-weight: 900;
      color: #000;
      letter-spacing: 1px;
    }
    
    .card-qrcode {
      flex: 1.2;
      border: 2.5px solid #000;
      border-radius: 10px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: #fdfdfd;
    }
    .qrcode-header {
      font-size: 15pt;
      font-weight: 900;
      color: #000;
      text-align: center;
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 2px solid #000;
      text-transform: uppercase;
      letter-spacing: 1px;
      width: 100%;
    }
    #qrcode-target {
      display: flex;
      justify-content: center;
      align-items: center;
      margin: auto;
      padding: 6px;
      background: #fff;
    }
    #qrcode-target canvas, #qrcode-target img {
      max-width: 220px;
      max-height: 220px;
    }
    .qrcode-footer {
      font-size: 10pt;
      font-weight: 800;
      color: #333;
      text-align: center;
      margin-top: 6px;
      letter-spacing: 0.5px;
    }
    
    @media print {
      @page {
        size: A4 landscape;
        margin: 0;
      }
      body {
        background: none;
        padding: 0;
      }
      .no-print {
        display: none !important;
      }
      .page-a4 {
        width: 100vw;
        height: 100vh;
        box-shadow: none;
        padding: 8mm 14mm;
        page-break-after: avoid;
      }
    }
  </style>
</head>
<body>
  <div class="no-print">
    <button class="btn-print" onclick="window.print()">
      🖨️ Imprimir Folha A4 do Pallet (${palletId})
    </button>
  </div>

  <div class="page-a4">
    <div class="header-logo">
      <img src="${logoUrl}" alt="CTDI" onerror="this.style.display='none'">
    </div>

    <div class="pallet-header">
      <div class="pallet-title">PALLET #</div>
      <div class="pallet-code">${palletId}</div>
      <div class="barcode-container">
        ${barcodeSvgHtml}
      </div>
    </div>

    <div class="content-grid">
      <div class="card-lote">
        <div class="data-group">
          <div class="data-label">Modelo do Equipamento:</div>
          <div class="data-value-model">${modelo}</div>
        </div>
        <div class="data-group">
          <div class="data-label">Data e Hora:</div>
          <div class="data-value-date">${dataHora}</div>
        </div>
        <div class="data-group">
          <div class="data-label">Total de Unidades:</div>
          <div class="data-value-units">${totalUnidades} UNIDADES</div>
        </div>
      </div>

      <div class="card-qrcode">
        <div class="qrcode-header">Relação de Unidades (${totalUnidades})</div>
        <div id="qrcode-target"></div>
        <div class="qrcode-footer">${totalUnidades} UNIDADES CODIFICADAS</div>
      </div>
    </div>
  </div>

  <script>
    window.addEventListener('load', () => {
      try {
        new QRCode(document.getElementById("qrcode-target"), {
          text: ${JSON.stringify(qrContent)},
          width: 210,
          height: 210,
          correctLevel: QRCode.CorrectLevel.M
        });
      } catch (err) {
        console.error("Erro ao gerar QRCode:", err);
      }
      setTimeout(() => {
        window.print();
      }, 500);
    });
  <\/script>
</body>
</html>
  `;

  printWindow.document.open();
  printWindow.document.write(printHtml);
  printWindow.document.close();
}

function setupExpedicaoListeners() {
    // Form Bipar Unidade
    const formBipar = document.getElementById('form-expedicao-bipar');
    const inputScan = document.getElementById('exp-scan-input');
    const btnLimpar = document.getElementById('btn-exp-limpar');
    const btnNovoPallet = document.getElementById('btn-exp-novo-pallet');
    const btnAbertos = document.getElementById('btn-exp-abertos');
    const btnRefresh = document.getElementById('btn-exp-refresh');
    const btnImprimir = document.getElementById('btn-exp-imprimir');
    const btnFecharPallet = document.getElementById('btn-exp-fechar-pallet');
    const btnModalUnidadeOk = document.getElementById('btn-modal-unidade-ok');
    const btnFecharModalPallets = document.getElementById('btn-fechar-modal-pallets');

    // Limpar campo
    const limparCampos = () => {
        if (inputScan) {
            inputScan.value = '';
            inputScan.focus();
        }
    };

    if (btnLimpar) {
        btnLimpar.addEventListener('click', limparCampos);
    }

    // Modal Unidade Não Recebida OK
    if (btnModalUnidadeOk) {
        btnModalUnidadeOk.addEventListener('click', () => {
            document.getElementById('modal-unidade-nao-recebida').classList.add('hidden');
            limparCampos();
        });
    }

    // Modal Pallets Abertos Fechar
    if (btnFecharModalPallets) {
        btnFecharModalPallets.addEventListener('click', () => {
            document.getElementById('modal-pallets-abertos').classList.add('hidden');
            if (inputScan) inputScan.focus();
        });
    }

    // Novo Pallet
    if (btnNovoPallet) {
        btnNovoPallet.addEventListener('click', async () => {
            if (!confirm("Deseja criar um novo Pallet? A numeração sequencial será gerada automaticamente.")) return;
            try {
                const res = await fetch(`${SERVER_URL.replace(/\/$/, '')}/api/expedicao-pintura/novo-pallet`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ usuario: currentUser?.username || 'OPERADOR' })
                });
                if (res.ok) {
                    const data = await res.json();
                    currentExpedicaoPallet = data.pallet;
                    currentExpedicaoItems = data.items || [];
                    renderPalletData(data.pallet, data.items || []);
                    showExpedicaoStatus(`Novo pallet <strong>${data.pallet.codigo_pallet}</strong> criado com sucesso!`, false);
                    limparCampos();
                } else {
                    alert("Erro ao criar novo pallet.");
                }
            } catch (err) {
                console.error("Erro ao criar novo pallet:", err);
            }
        });
    }

    // Listar Histórico de Pallets (Abertos e Fechados)
    let allPalletsCache = [];
    const renderPalletsModalTable = (list) => {
        const tbody = document.getElementById('pallets-abertos-tbody');
        if (!tbody) return;
        if (!list || list.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" style="padding: 16px; text-align: center; color: var(--text-secondary);">Nenhum pallet encontrado.</td></tr>`;
            return;
        }
        tbody.innerHTML = list.map(p => `
            <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                <td style="padding: 10px; font-weight: 700; color: var(--primary-color);">${p.codigo_pallet}</td>
                <td style="padding: 10px; text-align: center;">
                    <span class="badge ${p.status === 'ABERTO' ? 'badge-success' : 'badge-danger'}" style="font-size: 0.75rem;">
                        ${p.status || 'ABERTO'}
                    </span>
                </td>
                <td style="padding: 10px; text-align: center; color: #fbbf24; font-weight: 600;">${p.total_unidades || 0}</td>
                <td style="padding: 10px; text-align: right;">
                    <button onclick="selecionarPalletAberto('${p.codigo_pallet}')" class="btn btn-primary" style="padding: 4px 10px; font-size: 0.8rem;">
                        Selecionar
                    </button>
                </td>
            </tr>
        `).join('');
    };

    const inputBuscaPallets = document.getElementById('input-busca-pallets');
    if (inputBuscaPallets) {
        inputBuscaPallets.addEventListener('input', (e) => {
            const termo = e.target.value.trim().toUpperCase();
            if (!termo) {
                renderPalletsModalTable(allPalletsCache);
            } else {
                const filtrados = allPalletsCache.filter(p => p.codigo_pallet.toUpperCase().includes(termo));
                renderPalletsModalTable(filtrados);
            }
        });
    }

    if (btnAbertos) {
        btnAbertos.addEventListener('click', async () => {
            try {
                const res = await fetch(`${SERVER_URL.replace(/\/$/, '')}/api/expedicao-pintura/pallets-todos`);
                if (res.ok) {
                    allPalletsCache = await res.json();
                    if (inputBuscaPallets) inputBuscaPallets.value = '';
                    renderPalletsModalTable(allPalletsCache);
                    document.getElementById('modal-pallets-abertos').classList.remove('hidden');
                }
            } catch (err) {
                console.error("Erro ao buscar pallets:", err);
            }
        });
    }

    // Reabrir Pallet
    const btnReabrirPallet = document.getElementById('btn-exp-reabrir-pallet');
    if (btnReabrirPallet) {
        btnReabrirPallet.addEventListener('click', async () => {
            if (!currentExpedicaoPallet) return;
            const cod = currentExpedicaoPallet.codigo_pallet;
            if (!confirm(`Deseja realmente reabrir o Pallet ${cod} para continuar adicionando ou ajustando unidades?`)) return;

            try {
                const res = await fetch(`${SERVER_URL.replace(/\/$/, '')}/api/expedicao-pintura/reabrir-pallet`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ codigo_pallet: cod })
                });
                if (res.ok) {
                    showExpedicaoStatus(`Pallet <strong>${cod}</strong> reaberto com sucesso!`, false);
                    await selecionarPalletAberto(cod);
                } else {
                    alert("Erro ao reabrir o pallet.");
                }
            } catch (err) {
                console.error("Erro ao reabrir pallet:", err);
            }
        });
    }

    // Refresh Pallet
    if (btnRefresh) {
        btnRefresh.addEventListener('click', loadActivePallet);
    }

    // Imprimir Folha Atual Manualmente
    if (btnImprimir) {
        btnImprimir.addEventListener('click', () => {
            if (!currentExpedicaoPallet) {
                alert("Nenhum pallet selecionado.");
                return;
            }
            const items = currentExpedicaoItems || [];
            const modelosUnicos = [...new Set(items.map(i => i.modelo).filter(Boolean))];
            const modeloTexto = modelosUnicos.length === 1 ? modelosUnicos[0] : (modelosUnicos.length > 1 ? modelosUnicos.join(', ') : 'QUALQUER MODELO');
            const listaSeriais = items.map(i => i.serial_number || i.gpon_id || i.mac).filter(Boolean);

            imprimirFolhaA4PalletGenerica({
                palletId: currentExpedicaoPallet.codigo_pallet,
                modelo: modeloTexto,
                dataHora: new Date().toLocaleString('pt-BR'),
                totalUnidades: items.length,
                listaUnidades: listaSeriais,
                logoUrl: 'logo.png'
            });
        });
    }

    // Fechar Pallet & Imprimir Automaticamente
    if (btnFecharPallet) {
        btnFecharPallet.addEventListener('click', async () => {
            if (!currentExpedicaoPallet) return;
            const cod = currentExpedicaoPallet.codigo_pallet;
            const itemsToPrint = [...(currentExpedicaoItems || [])];
            const total = itemsToPrint.length;
            
            if (!confirm(`Deseja realmente fechar o Pallet ${cod} com ${total} unidades?`)) return;

            try {
                const res = await fetch(`${SERVER_URL.replace(/\/$/, '')}/api/expedicao-pintura/fechar-pallet`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ codigo_pallet: cod, usuario: currentUser?.username })
                });
                if (res.ok) {
                    showExpedicaoStatus(`Pallet <strong>${cod}</strong> fechado com sucesso! Abrindo folha de impressão...`, false);
                    
                    // Dispara impressão da folha A4 com QR Code
                    const modelosUnicos = [...new Set(itemsToPrint.map(i => i.modelo).filter(Boolean))];
                    const modeloTexto = modelosUnicos.length === 1 ? modelosUnicos[0] : (modelosUnicos.length > 1 ? modelosUnicos.join(', ') : 'DIVERSOS');
                    const listaSeriais = itemsToPrint.map(i => i.serial_number || i.gpon_id || i.mac).filter(Boolean);

                    imprimirFolhaA4PalletGenerica({
                        palletId: cod,
                        modelo: modeloTexto,
                        dataHora: new Date().toLocaleString('pt-BR'),
                        totalUnidades: total,
                        listaUnidades: listaSeriais,
                        logoUrl: 'logo.png'
                    });

                    // Automaticamente carrega ou cria o próximo pallet
                    await loadActivePallet();
                } else {
                    alert("Erro ao fechar o pallet.");
                }
            } catch (err) {
                console.error("Erro ao fechar pallet:", err);
            }
        });
    }

    // Bipagem Submit
    if (formBipar) {
        formBipar.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!currentExpedicaoPallet) {
                alert("Nenhum pallet ativo selecionado.");
                return;
            }

            const valorScan = inputScan?.value.trim().toUpperCase() || '';

            if (!valorScan) {
                showExpedicaoStatus("Bipe o Serial, GPON ou MAC da unidade.", true);
                if (inputScan) inputScan.focus();
                return;
            }

            try {
                const res = await fetch(`${SERVER_URL.replace(/\/$/, '')}/api/expedicao-pintura/bipar`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        codigo_pallet: currentExpedicaoPallet.codigo_pallet,
                        scan: valorScan,
                        serial: valorScan,
                        usuario: currentUser?.username || 'OPERADOR'
                    })
                });

                const data = await res.json();

                if (!res.ok || !data.success) {
                    const errorMsg = data.error || 'Erro na bipagem.';
                    if (data.code === 'UNIDADE_NAO_RECEBIDA' || errorMsg.toLowerCase().includes('não recebida')) {
                        showExpedicaoStatus(`⚠️ <strong>UNIDADE NÃO RECEBIDA</strong>: Esta unidade não consta na base de recebimento.`, true);
                        showUnidadeNaoRecebidaModal(`A unidade "${valorScan}" não foi recebida no sistema.`);
                    } else {
                        showExpedicaoStatus(`❌ ${errorMsg}`, true);
                    }
                    if (inputScan) {
                        inputScan.select();
                        inputScan.focus();
                    }
                    return;
                }

                // Sucesso
                currentExpedicaoItems = data.items || [];
                renderPalletData(currentExpedicaoPallet, data.items);
                showExpedicaoStatus(`✅ Unidade <strong>${data.item.serial_number}</strong> (${data.item.modelo}) adicionada ao Pallet ${currentExpedicaoPallet.codigo_pallet}!`, false);
                limparCampos();
            } catch (err) {
                console.error("Erro ao bipar unidade para o pallet:", err);
                showExpedicaoStatus("Erro de comunicação com o servidor.", true);
            }
        });
    }
}

window.selecionarPalletAberto = async function(codigo) {
    try {
        const res = await fetch(`${SERVER_URL.replace(/\/$/, '')}/api/expedicao-pintura/pallet/${encodeURIComponent(codigo)}`);
        if (res.ok) {
            const data = await res.json();
            currentExpedicaoPallet = data.pallet;
            currentExpedicaoItems = data.items || [];
            renderPalletData(data.pallet, data.items || []);
            document.getElementById('modal-pallets-abertos').classList.add('hidden');
            showExpedicaoStatus(`Pallet ativo alterado para <strong>${codigo}</strong>.`, false);
            const inputScan = document.getElementById('exp-scan-input');
            if (inputScan) inputScan.focus();
        }
    } catch (err) {
        console.error("Erro ao selecionar pallet:", err);
    }
};

// ============================================================
// RETORNO PINTURA MODULE
// ============================================================

let retornoPinturaRecentes = [];

function playAudioFeedback(isError = false) {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        if (!isError) {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(880, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
            gain.gain.setValueAtTime(0.3, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.16);
        } else {
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(220, ctx.currentTime);
            gain.gain.setValueAtTime(0.4, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + 0.32);
        }
    } catch (e) {
        // Ignora caso bloqueado pelo navegador
    }
}

async function loadRetornoPinturaData() {
    try {
        const [statsRes, recentesRes] = await Promise.all([
            fetch(`${SERVER_URL.replace(/\/$/, '')}/api/retorno-pintura/stats`),
            fetch(`${SERVER_URL.replace(/\/$/, '')}/api/retorno-pintura/recentes`)
        ]);

        if (statsRes.ok) {
            const stats = await statsRes.json();
            const statHoje = document.getElementById('retorno-stat-hoje');
            const statTotal = document.getElementById('retorno-stat-total');
            if (statHoje) statHoje.textContent = stats.total_hoje || 0;
            if (statTotal) statTotal.textContent = stats.total || 0;
        }

        if (recentesRes.ok) {
            retornoPinturaRecentes = await recentesRes.json();
            renderRetornoRecentes(retornoPinturaRecentes);
        }

        const inputScan = document.getElementById('retorno-scan-input');
        if (inputScan) setTimeout(() => inputScan.focus(), 100);
    } catch (err) {
        console.error('Erro ao carregar dados do Retorno de Pintura:', err);
    }
}

function renderRetornoRecentes(items) {
    const tbody = document.getElementById('retorno-recentes-tbody');
    const countEl = document.getElementById('retorno-recentes-count');
    if (!tbody) return;

    if (!items || items.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="9" style="text-align: center; padding: 25px; color: var(--text-secondary);">Nenhuma unidade bipada ainda no retorno.</td>
            </tr>
        `;
        if (countEl) countEl.textContent = '0 unidades na lista';
        return;
    }

    if (countEl) countEl.textContent = `${items.length} ${items.length === 1 ? 'unidade' : 'unidades'} na lista`;

    tbody.innerHTML = items.map((item, index) => {
        const dataHoraStr = item.data_retorno ? new Date(item.data_retorno).toLocaleString('pt-BR') : '---';
        return `
            <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                <td style="padding: 10px 14px; color: var(--text-secondary); font-size: 0.8rem;">${index + 1}</td>
                <td style="padding: 10px 14px; font-weight: 700; color: #fff; font-family: monospace; letter-spacing: 0.5px;">${item.serial_number || '---'}</td>
                <td style="padding: 10px 14px; color: #94a3b8; font-family: monospace;">${item.gpon_id || '---'}</td>
                <td style="padding: 10px 14px; color: #94a3b8; font-family: monospace;">${item.mac || '---'}</td>
                <td style="padding: 10px 14px; color: #cbd5e1; font-weight: 500;">${item.modelo || '---'}</td>
                <td style="padding: 10px 14px; color: var(--text-secondary);">${item.fabricante || '---'}</td>
                <td style="padding: 10px 14px; color: var(--text-secondary); font-size: 0.85rem;">${dataHoraStr}</td>
                <td style="padding: 10px 14px; color: var(--text-secondary);">${item.usuario || 'OPERADOR'}</td>
                <td style="padding: 10px 14px; text-align: center;">
                    <span class="badge" style="background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); padding: 3px 8px; border-radius: 6px; font-size: 0.75rem; font-weight: 600;">Retorno de Pintura</span>
                </td>
            </tr>
        `;
    }).join('');
}

function showRetornoStatus(message, isError = false) {
    const el = document.getElementById('retorno-status-message');
    if (!el) return;

    el.innerHTML = message;
    el.className = `status-message ${isError ? 'status-error' : 'status-success'}`;
    el.classList.remove('hidden');

    playAudioFeedback(isError);
}

function setupRetornoPinturaListeners() {
    const form = document.getElementById('form-retorno-pintura');
    const inputScan = document.getElementById('retorno-scan-input');
    const btnLimpar = document.getElementById('btn-retorno-limpar');

    if (btnLimpar && inputScan) {
        btnLimpar.addEventListener('click', () => {
            inputScan.value = '';
            const statusEl = document.getElementById('retorno-status-message');
            if (statusEl) statusEl.classList.add('hidden');
            inputScan.focus();
        });
    }

    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();

            const codigo = inputScan ? inputScan.value.trim().toUpperCase() : '';
            if (!codigo) {
                showRetornoStatus('⚠️ Por favor, bipe o Serial Number, MAC ou GPON ID da unidade.', true);
                if (inputScan) inputScan.focus();
                return;
            }

            try {
                const res = await fetch(`${SERVER_URL.replace(/\/$/, '')}/api/retorno-pintura/bipar`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        codigo: codigo,
                        usuario: currentUser?.username || 'OPERADOR'
                    })
                });

                const data = await res.json();

                if (!res.ok || !data.success) {
                    const errorMsg = data.error || 'Erro ao registrar retorno de pintura.';
                    if (data.code === 'STATUS_INVALIDO') {
                        showRetornoStatus(`❌ <strong>STATUS INVÁLIDO</strong>: ${errorMsg}`, true);
                    } else if (data.code === 'UNIDADE_NAO_ENCONTRADA') {
                        showRetornoStatus(`⚠️ <strong>NÃO ENCONTRADA</strong>: ${errorMsg}`, true);
                    } else {
                        showRetornoStatus(`❌ ${errorMsg}`, true);
                    }

                    if (inputScan) {
                        inputScan.select();
                        inputScan.focus();
                    }
                    return;
                }

                // Sucesso
                showRetornoStatus(`✅ Unidade <strong>${data.item.serial_number}</strong> (${data.item.modelo}) registrada com sucesso no <strong>Retorno de Pintura</strong>!`, false);

                // Atualiza contadores e lista
                if (data.stats) {
                    const statHoje = document.getElementById('retorno-stat-hoje');
                    const statTotal = document.getElementById('retorno-stat-total');
                    if (statHoje) statHoje.textContent = data.stats.total_hoje || 0;
                    if (statTotal) statTotal.textContent = data.stats.total || 0;
                }

                if (data.recentItems) {
                    retornoPinturaRecentes = data.recentItems;
                    renderRetornoRecentes(retornoPinturaRecentes);
                }

                if (inputScan) {
                    inputScan.value = '';
                    inputScan.focus();
                }
            } catch (err) {
                console.error('Erro de comunicação ao registrar retorno de pintura:', err);
                showRetornoStatus('❌ Erro de comunicação com o servidor. Tente novamente.', true);
                if (inputScan) inputScan.focus();
            }
        });
    }
}


