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

function applyAccessLevel(user) {
    currentUser = user;
    document.getElementById('display-user-name').textContent = user.username;
    const navAdmin = document.getElementById('nav-admin');
    const navPreAlerta = document.querySelector('li[data-tab="pre-alerta"]');
    const navRelatorios = document.querySelector('li[data-tab="relatorios"]');
    
    if (user.level === 'admin') {
        navAdmin.style.display = '';
        if (navPreAlerta) navPreAlerta.style.display = '';
        if (navRelatorios) navRelatorios.style.display = '';
    } else {
        navAdmin.style.display = 'none';
        if (navPreAlerta) navPreAlerta.style.display = 'none';
        if (navRelatorios) navRelatorios.style.display = 'none';
    }
}

function showLoginOverlay() {
    document.getElementById('login-overlay').classList.remove('hidden');
    document.getElementById('login-username').value = '';
    document.getElementById('login-password').value = '';
    document.getElementById('login-error').classList.add('hidden');
    setTimeout(() => document.getElementById('login-username').focus(), 100);
}

function hideLoginOverlay() {
    document.getElementById('login-overlay').classList.add('hidden');
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
    // Show login overlay at start
    showLoginOverlay();
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
                    if (target === 'admin') renderUsersList();
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
    const formLogin = document.getElementById('form-login');
    formLogin.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('login-username').value;
        const password = document.getElementById('login-password').value;
        const user = await doLogin(username, password);
        if (user) {
            applyAccessLevel(user);
            hideLoginOverlay();
        } else {
            document.getElementById('login-error').classList.remove('hidden');
        }
    });

    document.getElementById('btn-logout').addEventListener('click', () => {
        currentUser = null;
        // Navigate back to first tab
        const navLinks = document.querySelectorAll('.nav-links li');
        const tabs = document.querySelectorAll('.tab-content');
        navLinks.forEach(l => l.classList.remove('active'));
        tabs.forEach(t => t.classList.remove('active'));
        navLinks[0].classList.add('active');
        document.getElementById('recebimento').classList.add('active');
        showLoginOverlay();
    });
}

// ============================================================
// Models Logic
// ============================================================
async function loadModels() {
    let savedModels = await dbModelos.getItem('lista');
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

function setupAdminListeners() {
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
    for (const row of data) {
        let serialKey = Object.keys(row).find(k => k.trim().toUpperCase() === 'SERIAL');
        let codKey = Object.keys(row).find(k => k.trim().toUpperCase() === 'CODIGO');
        let descKey = Object.keys(row).find(k => k.trim().toUpperCase().includes('DESCRI'));
        let fabKey = Object.keys(row).find(k => k.trim().toUpperCase().includes('FABRI'));

        if (serialKey && row[serialKey]) {
            const serial = String(row[serialKey]).trim().toUpperCase();
            itemsToImport.push({
                serial: serial,
                codigo: codKey ? String(row[codKey]) : '',
                descricao: descKey ? String(row[descKey]) : '',
                fabricante: fabKey ? String(row[fabKey]) : ''
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
    if (currentPendingUnit) {
        await saveRecebimento(currentPendingUnit);
        currentPendingUnit = null;
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
    const keys = await dbRecebidos.keys();
    for (const key of keys) {
        const item = await dbRecebidos.getItem(key);
        if (item.noPreAlerta) countPreAlerta++;
        else countFora++;
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
                "Usuário": item.usuario || '',
                Data_Hora: new Date(item.data_hora).toLocaleString('pt-BR'),
                "Código": item.codigo || '',
                "Descrição": item.descricao || ''
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
                "Usuário": item.usuario || '',
                Data_Hora: new Date(item.data_hora).toLocaleString('pt-BR')
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
