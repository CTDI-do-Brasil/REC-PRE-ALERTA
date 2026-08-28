require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Minio = require('minio');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increased limit to support bulk imports of large spreadsheets
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve frontend static files directly from the root
app.use(express.static(__dirname));

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || 'localhost';
const MINIO_PORT = process.env.MINIO_PORT ? parseInt(process.env.MINIO_PORT, 10) : 9000;
const MINIO_USE_SSL = (process.env.MINIO_USE_SSL || 'false').toLowerCase() === 'true';
const MINIO_BUCKET = process.env.MINIO_BUCKET || 'prealerta';
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || '';
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || '';

const minioClient = new Minio.Client({
  endPoint: MINIO_ENDPOINT,
  port: MINIO_PORT,
  useSSL: MINIO_USE_SSL,
  accessKey: MINIO_ACCESS_KEY,
  secretKey: MINIO_SECRET_KEY
});

const DATABASE_URL = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING || '';
const pool = new Pool({ connectionString: DATABASE_URL });

const SECOND_DATABASE_URL = process.env.SECOND_DATABASE_URL || '';
const secondPool = SECOND_DATABASE_URL ? new Pool({ connectionString: SECOND_DATABASE_URL }) : null;

async function ensureDBAndMinIO() {
  // 1. Ensure Postgres tables exist
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS pre_alertas (
      serial TEXT PRIMARY KEY,
      codigo TEXT,
      descricao TEXT,
      fabricante TEXT
    )`);

    // Check if table 'recebimentos' exists and has column 'serial' (old schema)
    const checkOldSchema = await client.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'recebimentos' AND column_name = 'serial'
    `);
    if (checkOldSchema.rows.length > 0) {
      await client.query(`ALTER TABLE recebimentos RENAME TO recebimentos_old`);
      console.log('Renamed old recebimentos table to recebimentos_old.');
    }

    // Create recebimentos table with exact requested column order
    await client.query(`CREATE TABLE IF NOT EXISTS recebimentos (
      id SERIAL PRIMARY KEY,
      fabricante TEXT,
      modelo TEXT,
      serial_number TEXT,
      gpon_id TEXT,
      mac TEXT,
      usuario TEXT,
      data_hora TIMESTAMP,
      no_pre_alerta BOOLEAN,
      matched_value TEXT,
      codigo TEXT,
      descricao TEXT
    )`);

    // Migrate data from recebimentos_old to the new table
    const checkOldTable = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'recebimentos_old'
      )
    `);
    if (checkOldTable.rows[0].exists) {
      console.log('Migrating data from recebimentos_old to new recebimentos table...');
      try {
        await client.query(`
          INSERT INTO recebimentos (fabricante, modelo, serial_number, gpon_id, mac, usuario, data_hora, no_pre_alerta, matched_value, codigo, descricao)
          SELECT fabricante, modelo, serial, pon, mac, usuario, datahora, no_pre_alerta, matched_value, codigo, descricao
          FROM recebimentos_old
        `);
        await client.query(`ALTER TABLE recebimentos_old RENAME TO recebimentos_migrated`);
        console.log('Data migration complete. Renamed recebimentos_old to recebimentos_migrated.');
      } catch (migrationErr) {
        console.error('Error during data migration:', migrationErr);
      }
    }

    await client.query(`CREATE TABLE IF NOT EXISTS usuarios (
      username TEXT PRIMARY KEY,
      password TEXT,
      level TEXT,
      criado_em TIMESTAMP
    )`);

    const userCount = await client.query('SELECT COUNT(*)::int as count FROM usuarios');
    if (userCount.rows[0].count === 0) {
      await client.query(`
        INSERT INTO usuarios(username, password, level, criado_em)
        VALUES('RODRIGO.BARRETO', 'admin', 'admin', NOW())
      `);
      console.log('Default admin user created.');
    }

    await client.query(`CREATE TABLE IF NOT EXISTS modelos (
      name TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )`);

    // Clean up unwanted test/seed models from database
    const unwantedSeeds = ['GP1100X', 'H803A', 'EG8145V5', 'HG8145V5', 'EG8145V5-V2', 'HG8145V5-V2', 'HG8010H', 'EG8010H'];
    await client.query('DELETE FROM modelos WHERE name = ANY($1)', [unwantedSeeds]);

    // Ensure all 12 real CTDI default models exist in database
    for (const m of DEFAULT_MODELS_SEED) {
      await client.query(
        'INSERT INTO modelos(name, data, updated_at) VALUES($1, $2, NOW()) ON CONFLICT(name) DO NOTHING',
        [m.name, JSON.stringify(m)]
      );
    }

    // Ensure Pallets Pintura tables and sequence
    await client.query(`CREATE SEQUENCE IF NOT EXISTS seq_pallet_pintura START WITH 1`);
    await client.query(`CREATE TABLE IF NOT EXISTS pallets_pintura (
      id SERIAL PRIMARY KEY,
      codigo_pallet TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'ABERTO',
      data_criacao TIMESTAMP DEFAULT NOW(),
      data_fechamento TIMESTAMP,
      usuario_criacao TEXT,
      total_unidades INTEGER DEFAULT 0
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS pallet_pintura_itens (
      id SERIAL PRIMARY KEY,
      pallet_id INTEGER REFERENCES pallets_pintura(id) ON DELETE CASCADE,
      codigo_pallet TEXT NOT NULL,
      serial_number TEXT NOT NULL,
      gpon_id TEXT,
      mac TEXT,
      modelo TEXT,
      fabricante TEXT,
      data_bipagem TIMESTAMP DEFAULT NOW(),
      usuario TEXT,
      status TEXT DEFAULT 'Em Pallet'
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pallet_itens_serial ON pallet_pintura_itens(serial_number)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pallet_itens_codigo ON pallet_pintura_itens(codigo_pallet)`);

    // Ensure Retorno de Pintura table
    await client.query(`CREATE TABLE IF NOT EXISTS retorno_pintura_itens (
      id SERIAL PRIMARY KEY,
      recebimento_id INTEGER,
      serial_number TEXT NOT NULL,
      gpon_id TEXT,
      mac TEXT,
      modelo TEXT,
      fabricante TEXT,
      data_retorno TIMESTAMP DEFAULT NOW(),
      usuario TEXT,
      status TEXT DEFAULT 'Retorno de Pintura'
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_retorno_itens_serial ON retorno_pintura_itens(serial_number)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_retorno_itens_data ON retorno_pintura_itens(data_retorno)`);

    // Ensure status column in recebimentos and pallet_pintura_itens
    await client.query(`ALTER TABLE recebimentos ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'Recebida'`);
    await client.query(`UPDATE recebimentos SET status = 'Recebida' WHERE status IS NULL`);
    await client.query(`ALTER TABLE pallet_pintura_itens ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'Em Pallet'`);

    console.log('Postgres tables verified/created successfully.');
  } catch (err) {
    console.error('Error establishing database tables:', err);
  } finally {
    client.release();
  }

  // 2. Ensure MinIO bucket exists
  try {
    if (MINIO_ACCESS_KEY && MINIO_SECRET_KEY) {
      const exists = await minioClient.bucketExists(MINIO_BUCKET);
      if (!exists) {
        await minioClient.makeBucket(MINIO_BUCKET);
        console.log(`MinIO bucket "${MINIO_BUCKET}" created successfully.`);
      } else {
        console.log(`MinIO bucket "${MINIO_BUCKET}" already exists.`);
      }
    } else {
      console.warn('MinIO credentials missing. Skipping bucket auto-creation.');
    }
  } catch (err) {
    console.error('Error ensuring MinIO bucket exists:', err);
  }
}

ensureDBAndMinIO().catch(err => console.error('Error in initialization:', err));

function presignPut(objectName, expires = 60 * 60) {
  return new Promise((resolve, reject) => {
    minioClient.presignedPutObject(MINIO_BUCKET, objectName, expires, function(err, presignedUrl) {
      if (err) return reject(err);
      resolve(presignedUrl);
    });
  });
}

// REST API Endpoints

// MinIO Presign Upload
app.get('/api/presign', async (req, res) => {
  try {
    const filename = req.query.filename || 'upload.bin';
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const objectName = `${Date.now()}__${safe}`;
    const url = await presignPut(objectName, 60 * 60); // 1 hour expiration
    res.json({ url, objectName, bucket: MINIO_BUCKET });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not generate presigned url' });
  }
});

// Import Pre-Alerta sheet items
app.post('/api/pre-alerta/import', async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'Invalid payload, expected an items array.' });
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      if (!item.serial) continue;
      await client.query(
        `INSERT INTO pre_alertas(serial, codigo, descricao, fabricante)
         VALUES($1, $2, $3, $4)
         ON CONFLICT (serial) DO UPDATE SET
           codigo = EXCLUDED.codigo,
           descricao = EXCLUDED.descricao,
           fabricante = EXCLUDED.fabricante`,
        [item.serial.trim().toUpperCase(), item.codigo || '', item.descricao || '', item.fabricante || '']
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, count: items.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error importing pre-alerta data:', err);
    res.status(500).json({ error: 'Failed to import data into database.' });
  } finally {
    client.release();
  }
});

// Clear Pre-Alerta table
app.delete('/api/pre-alerta/clear', async (req, res) => {
  try {
    await pool.query('DELETE FROM pre_alertas');
    res.json({ ok: true });
  } catch (err) {
    console.error('Error clearing pre-alerta data:', err);
    res.status(500).json({ error: 'Failed to clear data from database.' });
  }
});

// Get Pre-Alerta total count
app.get('/api/pre-alerta/count', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*)::int as count FROM pre_alertas');
    res.json({ count: result.rows[0].count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB count error' });
  }
});

// Check if value (serial/pon/mac) exists in Pre-Alerta
app.get('/api/pre-alerta/check', async (req, res) => {
  const { value } = req.query;
  if (!value) return res.status(400).json({ error: 'Missing query parameter "value"' });
  const cleanVal = value.trim().toUpperCase();

  try {
    const result = await pool.query(
      'SELECT * FROM pre_alertas WHERE serial = $1',
      [cleanVal]
    );
    if (result.rows.length > 0) {
      return res.json({ found: true, data: result.rows[0] });
    }
    res.json({ found: false });
  } catch (err) {
    console.error('Error checking pre-alerta:', err);
    res.status(500).json({ error: 'Database check error.' });
  }
});

// Validate scan: checks duplicity and pre-alerta match in one database trip
app.get('/api/recebimentos/validate', async (req, res) => {
  const { serial, pon, mac } = req.query;
  const s = (serial || '').trim().toUpperCase();
  const p = (pon || '').trim().toUpperCase();
  const m = (mac || '').trim().toUpperCase();

  try {
    // 1. Check duplicity in Postgres
    const dupResult = await pool.query(
      `SELECT * FROM recebimentos 
       WHERE (serial_number IS NOT NULL AND serial_number = $1)
          OR (gpon_id IS NOT NULL AND gpon_id = $2)
          OR (mac IS NOT NULL AND mac = $3)
       LIMIT 1`,
      [s || null, p || null, m || null]
    );

    if (dupResult.rows.length > 0) {
      return res.json({ 
        duplicate: true, 
        duplicateData: dupResult.rows[0] 
      });
    }

    // 2. Check Pre-Alerta match in Postgres
    let preAlertaMatch = null;
    let matchedValue = '';

    const checkValues = [s, p, m].filter(Boolean);
    if (checkValues.length > 0) {
      // Find match
      const matchResult = await pool.query(
        'SELECT * FROM pre_alertas WHERE serial = ANY($1)',
        [checkValues]
      );
      if (matchResult.rows.length > 0) {
        preAlertaMatch = matchResult.rows[0];
        matchedValue = preAlertaMatch.serial;
      }
    }

    res.json({
      duplicate: false,
      preAlertaMatch,
      matchedValue
    });
  } catch (err) {
    console.error('Error validating scan:', err);
    res.status(500).json({ error: 'Validation database error.' });
  }
});

// Save scan results
app.post('/api/recebimentos', async (req, res) => {
  const body = req.body;
  if (!body) return res.status(400).json({ error: 'Invalid payload' });
  try {
    const query = `INSERT INTO recebimentos(fabricante, modelo, serial_number, gpon_id, mac, usuario, data_hora, no_pre_alerta, matched_value, codigo, descricao, status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`;
    const params = [
      body.fabricante || null,
      body.modelo,
      body.serial,
      body.pon || null,
      body.mac,
      body.usuario || null,
      body.dataHora ? new Date(body.dataHora) : new Date(),
      body.noPreAlerta || false,
      body.matchedValue || null,
      body.codigo || null,
      body.descricao || null,
      'Recebida'
    ];
    await pool.query(query, params);

    // Update second database if configured (ONLY for model PG2447)
    if (secondPool && body.mac && body.serial && body.modelo && body.modelo.trim().toUpperCase() === 'PG2447') {
      const serialUpper = body.serial.trim().toUpperCase();
      if (serialUpper.startsWith('GPO')) {
        try {
          const cleanMac = body.mac.trim();
          const secondQuery = `
            UPDATE etiquetas_scan_onu
            SET cpe_sn = $1
            WHERE UPPER(mac) = UPPER($2) AND UPPER(cpe_sn) = 'N/A'
          `;
          const updateRes = await secondPool.query(secondQuery, [body.serial.trim(), cleanMac]);
          console.log(`Second DB Sync for MAC ${cleanMac}: updated ${updateRes.rowCount} rows.`);
        } catch (secondDbErr) {
          console.error('Error updating second database:', secondDbErr);
          // We ignore the error as requested, so the main save operation doesn't fail
        }
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Error saving recebimento:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// Fetch recebimentos report data from Postgres
app.get('/api/recebimentos/report', async (req, res) => {
  const { start, end, noPreAlerta, modelo } = req.query;
  try {
    let query = 'SELECT * FROM recebimentos WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (start) {
      query += ` AND data_hora >= $${paramIndex}`;
      params.push(`${start} 00:00:00`);
      // or directly formatted string which is timezone-independent
      paramIndex++;
    }
    if (end) {
      query += ` AND data_hora <= $${paramIndex}`;
      params.push(`${end} 23:59:59`);
      paramIndex++;
    }
    if (noPreAlerta !== undefined) {
      query += ` AND no_pre_alerta = $${paramIndex}`;
      params.push(noPreAlerta === 'true');
      paramIndex++;
    }
    if (modelo) {
      query += ` AND modelo = $${paramIndex}`;
      params.push(modelo);
      paramIndex++;
    }

    query += ' ORDER BY id ASC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching report data:', err);
    res.status(500).json({ error: 'Failed to fetch report data.' });
  }
});

// Retroactive legacy sync endpoint
app.get('/api/admin/sync-legacy', async (req, res) => {
  if (!secondPool) {
    return res.status(400).json({ error: 'Second database connection is not configured.' });
  }
  try {
    // 1. Get all recebimentos of model PG2447 with serial starting with 'GPO' and a valid mac
    const selectQuery = `
      SELECT serial_number, mac 
      FROM recebimentos 
      WHERE serial_number ILIKE 'GPO%' AND UPPER(modelo) = 'PG2447' AND mac IS NOT NULL AND TRIM(mac) != ''
    `;
    const { rows } = await pool.query(selectQuery);
    
    let totalUpdated = 0;
    
    // 2. Loop and update the second DB
    for (const row of rows) {
      const serial = row.serial_number.trim();
      const mac = row.mac.trim();
      
      const updateQuery = `
        UPDATE etiquetas_scan_onu
        SET cpe_sn = $1
        WHERE UPPER(mac) = UPPER($2) AND UPPER(cpe_sn) = 'N/A'
      `;
      const updateRes = await secondPool.query(updateQuery, [serial, mac]);
      totalUpdated += updateRes.rowCount;
    }
    
    res.json({
      success: true,
      totalFound: rows.length,
      totalUpdated: totalUpdated
    });
  } catch (err) {
    console.error('Error during legacy sync:', err);
    res.status(500).json({ error: 'Legacy sync database error.', details: err.message });
  }
});

// Fetch operator production dashboard stats for a specific date (defaulting to today in YYYY-MM-DD)
app.get('/api/recebimentos/stats/operadores', async (req, res) => {
  const { date } = req.query;
  const targetDate = date || new Date().toISOString().split('T')[0];
  const startTimestamp = `${targetDate} 00:00:00`;
  const endTimestamp = `${targetDate} 23:59:59`;

  try {
    const result = await pool.query(
      `SELECT 
         COALESCE(usuario, 'DESCONHECIDO') AS usuario,
         COUNT(*) AS total_hoje,
         COUNT(CASE WHEN data_hora >= NOW() - INTERVAL '1 hour' THEN 1 END) AS total_ultima_hora,
         COUNT(CASE WHEN no_pre_alerta = true THEN 1 END) AS pre_alerta_hoje,
         COUNT(CASE WHEN no_pre_alerta = false THEN 1 END) AS fora_pre_alerta_hoje,
         MAX(data_hora) AS ultima_bipagem
       FROM recebimentos
       WHERE data_hora >= $1 AND data_hora <= $2
       GROUP BY COALESCE(usuario, 'DESCONHECIDO')
       ORDER BY total_hoje DESC, ultima_bipagem DESC`,
      [startTimestamp, endTimestamp]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching operator stats:', err);
    res.status(500).json({ error: 'Failed to fetch operator stats.' });
  }
});

// Clear recebimentos history in Postgres
app.delete('/api/recebimentos/clear', async (req, res) => {
  try {
    await pool.query('DELETE FROM recebimentos');
    res.json({ ok: true });
  } catch (err) {
    console.error('Error clearing recebimentos:', err);
    res.status(500).json({ error: 'Failed to clear recebimentos.' });
  }
});

// External API to query scanned units by Serial Number, MAC or GPON ID (protected with x-api-key)
app.get('/api/external/units', async (req, res) => {
  const apiKeyHeader = req.headers['x-api-key'];
  const expectedApiKey = process.env.API_KEY || process.env.EXTERNAL_API_KEY || 'ctdi_76ep96llk6zF63CJgd1iXggfb2JCJr0VfgRr';

  if (!apiKeyHeader || apiKeyHeader !== expectedApiKey) {
    return res.status(401).json({ error: 'Unauthorized. Invalid or missing x-api-key.' });
  }

  const { search } = req.query;
  if (!search) return res.status(400).json({ error: 'Missing query parameter "search"' });
  const cleanVal = search.trim().toUpperCase();

  try {
    const result = await pool.query(
      `SELECT id, fabricante, modelo, serial_number, gpon_id, mac, usuario, data_hora, no_pre_alerta, matched_value, codigo, descricao
       FROM recebimentos 
       WHERE UPPER(serial_number) = $1 
          OR UPPER(gpon_id) = $1 
          OR UPPER(mac) = $1
       ORDER BY data_hora DESC`,
      [cleanVal]
    );
    if (result.rows.length > 0) {
      return res.json({ found: true, results: result.rows });
    }
    res.json({ found: false, message: 'No records found for the provided value.' });
  } catch (err) {
    console.error('Error querying recebimentos:', err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

const DEFAULT_MODELS_SEED = [
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

// App Version Check for Auto-Update
app.get('/api/version', (req, res) => {
  res.json({ version: 'v1.5.0' });
});

// GET all models from Postgres
app.get('/api/modelos', async (req, res) => {
  try {
    const result = await pool.query('SELECT data FROM modelos ORDER BY name ASC');
    if (result.rows.length === 0) {
      for (const m of DEFAULT_MODELS_SEED) {
        await pool.query(
          'INSERT INTO modelos(name, data, updated_at) VALUES($1, $2, NOW()) ON CONFLICT(name) DO NOTHING',
          [m.name, JSON.stringify(m)]
        );
      }
      return res.json(DEFAULT_MODELS_SEED);
    }
    const list = result.rows.map(r => r.data);
    res.json(list);
  } catch (err) {
    console.error('Error fetching modelos:', err);
    res.status(500).json({ error: 'Failed to fetch modelos' });
  }
});

// POST save/sync models list to Postgres (Admin only in UI)
app.post('/api/modelos', async (req, res) => {
  const { models } = req.body;
  if (!Array.isArray(models)) return res.status(400).json({ error: 'Invalid models array' });
  try {
    for (const m of models) {
      const name = typeof m === 'object' ? m.name : m;
      const obj = typeof m === 'object' ? m : { name: m, fields: 3, rules: {} };
      await pool.query(
        `INSERT INTO modelos(name, data, updated_at) VALUES($1, $2, NOW())
         ON CONFLICT(name) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [name, JSON.stringify(obj)]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Error saving modelos:', err);
    res.status(500).json({ error: 'Failed to save modelos' });
  }
});

// User management routes

// Get all users
app.get('/api/usuarios', async (req, res) => {
  try {
    const result = await pool.query('SELECT username, level, criado_em FROM usuarios ORDER BY username ASC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error fetching users.' });
  }
});

// Create/Update user
app.post('/api/usuarios', async (req, res) => {
  const { username, password, level } = req.body;
  if (!username || !password || !level) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    await pool.query(
      `INSERT INTO usuarios(username, password, level, criado_em)
       VALUES($1, $2, $3, NOW())
       ON CONFLICT (username) DO UPDATE SET
         password = EXCLUDED.password,
         level = EXCLUDED.level`,
      [username.trim().toUpperCase(), password, level]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error saving user.' });
  }
});

// Delete user
app.delete('/api/usuarios/:username', async (req, res) => {
  const { username } = req.params;
  if (username.toUpperCase() === 'RODRIGO.BARRETO') {
    return res.status(400).json({ error: 'Cannot delete default admin' });
  }
  try {
    await pool.query('DELETE FROM usuarios WHERE username = $1', [username.toUpperCase()]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error deleting user.' });
  }
});

// User login authentication
app.post('/api/usuarios/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  try {
    const result = await pool.query(
      'SELECT username, level, password FROM usuarios WHERE username = $1',
      [username.toUpperCase()]
    );
    if (result.rows.length > 0 && result.rows[0].password === password) {
      return res.json({
        username: result.rows[0].username,
        level: result.rows[0].level
      });
    }
    res.status(401).json({ error: 'Invalid credentials' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error during login.' });
  }
});

// ============================================================
// Expedição Pintura Routes
// ============================================================

async function generateNextPalletCode(clientOrPool) {
  const res = await clientOrPool.query("SELECT nextval('seq_pallet_pintura') AS num");
  const num = parseInt(res.rows[0].num, 10);
  return 'PP' + String(num).padStart(8, '0');
}

// Get active open pallet (or creates initial one)
app.get('/api/expedicao-pintura/active', async (req, res) => {
  try {
    const palletRes = await pool.query(
      "SELECT * FROM pallets_pintura WHERE status = 'ABERTO' ORDER BY data_criacao DESC LIMIT 1"
    );
    if (palletRes.rows.length === 0) {
      const codigo = await generateNextPalletCode(pool);
      const newPallet = await pool.query(
        "INSERT INTO pallets_pintura(codigo_pallet, status, usuario_criacao, total_unidades, data_criacao) VALUES($1, 'ABERTO', 'SISTEMA', 0, NOW()) RETURNING *",
        [codigo]
      );
      return res.json({ pallet: newPallet.rows[0], items: [] });
    }
    const pallet = palletRes.rows[0];
    const itemsRes = await pool.query(
      "SELECT * FROM pallet_pintura_itens WHERE UPPER(codigo_pallet) = UPPER($1) ORDER BY id DESC",
      [pallet.codigo_pallet]
    );
    res.json({ pallet, items: itemsRes.rows });
  } catch (err) {
    console.error('Error fetching active pallet:', err);
    res.status(500).json({ error: 'Database error fetching active pallet.' });
  }
});

// Create new pallet
app.post('/api/expedicao-pintura/novo-pallet', async (req, res) => {
  try {
    const { usuario } = req.body;
    const codigo = await generateNextPalletCode(pool);
    const newPallet = await pool.query(
      "INSERT INTO pallets_pintura(codigo_pallet, status, usuario_criacao, total_unidades, data_criacao) VALUES($1, 'ABERTO', $2, 0, NOW()) RETURNING *",
      [codigo, usuario || 'OPERADOR']
    );
    res.json({ success: true, pallet: newPallet.rows[0], items: [] });
  } catch (err) {
    console.error('Error creating new pallet:', err);
    res.status(500).json({ error: 'Database error creating new pallet.' });
  }
});

// Get specific pallet
app.get('/api/expedicao-pintura/pallet/:codigo', async (req, res) => {
  try {
    const codigo = req.params.codigo.trim().toUpperCase();
    const palletRes = await pool.query("SELECT * FROM pallets_pintura WHERE UPPER(codigo_pallet) = $1", [codigo]);
    if (palletRes.rows.length === 0) return res.status(404).json({ error: 'Pallet não encontrado.' });
    const pallet = palletRes.rows[0];
    const itemsRes = await pool.query("SELECT * FROM pallet_pintura_itens WHERE UPPER(codigo_pallet) = $1 ORDER BY id DESC", [codigo]);
    res.json({ pallet, items: itemsRes.rows });
  } catch (err) {
    console.error('Error loading pallet:', err);
    res.status(500).json({ error: 'Database error loading pallet.' });
  }
});

// Get list of open pallets
app.get('/api/expedicao-pintura/pallets-abertos', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM pallets_pintura WHERE status = 'ABERTO' ORDER BY data_criacao DESC");
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching open pallets:', err);
    res.status(500).json({ error: 'Database error fetching open pallets.' });
  }
});

// Scan/Add unit to pallet
app.post('/api/expedicao-pintura/bipar', async (req, res) => {
  try {
    const { codigo_pallet, serial, pon, mac, usuario } = req.body;
    if (!codigo_pallet || (!serial && !pon && !mac)) {
      return res.status(400).json({ error: 'Informe ao menos um campo da unidade (Serial, PON ou MAC).' });
    }
    const cleanSerial = serial ? serial.trim().toUpperCase() : '';
    const cleanPon = pon ? pon.trim().toUpperCase() : '';
    const cleanMac = mac ? mac.trim().toUpperCase() : '';
    const codPallet = codigo_pallet.trim().toUpperCase();

    // 1. Check if pallet exists and is ABERTO
    const palletRes = await pool.query('SELECT * FROM pallets_pintura WHERE UPPER(codigo_pallet) = $1', [codPallet]);
    if (palletRes.rows.length === 0) {
      return res.status(404).json({ error: 'Pallet não encontrado.' });
    }
    const pallet = palletRes.rows[0];
    if (pallet.status !== 'ABERTO') {
      return res.status(400).json({ error: 'Este pallet já está fechado.' });
    }

    // 2. Query recebimentos to check if unit was received
    const searchTerms = [cleanSerial, cleanPon, cleanMac].filter(Boolean);
    const recRes = await pool.query(`
      SELECT * FROM recebimentos 
      WHERE (serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = ANY($1))
         OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = ANY($1))
         OR (mac IS NOT NULL AND mac != '' AND UPPER(TRIM(mac)) = ANY($1))
      ORDER BY id DESC LIMIT 1
    `, [searchTerms]);

    if (recRes.rows.length === 0) {
      return res.status(400).json({
        success: false,
        code: 'UNIDADE_NAO_RECEBIDA',
        error: 'Unidade não recebida'
      });
    }

    const unitReceived = recRes.rows[0];
    const unitSerial = unitReceived.serial_number || cleanSerial;
    const unitPon = unitReceived.gpon_id || cleanPon;
    const unitMac = unitReceived.mac || cleanMac;
    const unitModelo = unitReceived.modelo || 'NÃO INFORMADO';
    const unitFabricante = unitReceived.fabricante || 'NÃO INFORMADO';

    // 3. Check if unit is already in any pallet
    const unitIdentifiers = [unitSerial, unitPon, unitMac].filter(Boolean);
    const checkItem = await pool.query(`
      SELECT * FROM pallet_pintura_itens
      WHERE (serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = ANY($1))
         OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = ANY($1))
         OR (mac IS NOT NULL AND mac != '' AND UPPER(TRIM(mac)) = ANY($1))
      LIMIT 1
    `, [unitIdentifiers]);

    if (checkItem.rows.length > 0) {
      const existing = checkItem.rows[0];
      return res.status(400).json({
        success: false,
        code: 'JA_BIPADO',
        error: `Unidade já bipada no pallet ${existing.codigo_pallet}`
      });
    }

    // 4. Insert into pallet_pintura_itens
    const insertRes = await pool.query(`
      INSERT INTO pallet_pintura_itens (pallet_id, codigo_pallet, serial_number, gpon_id, mac, modelo, fabricante, data_bipagem, usuario, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, 'Em pallet')
      RETURNING *
    `, [pallet.id, codPallet, unitSerial, unitPon, unitMac, unitModelo, unitFabricante, usuario || 'OPERADOR']);

    // 5. Update unit status in recebimentos to 'Em pallet'
    await pool.query(`
      UPDATE recebimentos
      SET status = 'Em pallet'
      WHERE (serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = ANY($1))
         OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = ANY($1))
         OR (mac IS NOT NULL AND mac != '' AND UPPER(TRIM(mac)) = ANY($1))
    `, [unitIdentifiers]);

    // 6. Update total_unidades
    await pool.query(`
      UPDATE pallets_pintura 
      SET total_unidades = (SELECT COUNT(*)::int FROM pallet_pintura_itens WHERE UPPER(codigo_pallet) = $1)
      WHERE UPPER(codigo_pallet) = $1
    `, [codPallet]);

    const itemsRes = await pool.query(
      "SELECT * FROM pallet_pintura_itens WHERE UPPER(codigo_pallet) = $1 ORDER BY id DESC",
      [codPallet]
    );

    res.json({
      success: true,
      item: insertRes.rows[0],
      total_unidades: itemsRes.rows.length,
      items: itemsRes.rows
    });
  } catch (err) {
    console.error('Error scanning unit to pallet:', err);
    res.status(500).json({ error: 'Database error during scan.' });
  }
});

// Close pallet
app.post('/api/expedicao-pintura/fechar-pallet', async (req, res) => {
  try {
    const { codigo_pallet } = req.body;
    const codPallet = codigo_pallet.trim().toUpperCase();

    // 1. Update status of units in recebimentos to "Aguardando retorno de pintura"
    const updateRecebimentosQuery = `
      UPDATE recebimentos
      SET status = 'Aguardando retorno de pintura'
      WHERE id IN (
        SELECT r.id FROM recebimentos r
        JOIN pallet_pintura_itens ppi ON (
          (r.serial_number IS NOT NULL AND r.serial_number != '' AND UPPER(TRIM(r.serial_number)) = UPPER(TRIM(ppi.serial_number)))
          OR (r.gpon_id IS NOT NULL AND r.gpon_id != '' AND UPPER(TRIM(r.gpon_id)) = UPPER(TRIM(ppi.gpon_id)))
          OR (r.mac IS NOT NULL AND r.mac != '' AND UPPER(TRIM(r.mac)) = UPPER(TRIM(ppi.mac)))
        )
        WHERE UPPER(ppi.codigo_pallet) = $1
      )
    `;
    const updateRecRes = await pool.query(updateRecebimentosQuery, [codPallet]);

    // 2. Update status of items in pallet_pintura_itens
    await pool.query(`
      UPDATE pallet_pintura_itens
      SET status = 'Aguardando retorno de pintura'
      WHERE UPPER(codigo_pallet) = $1
    `, [codPallet]);

    // 3. Close the pallet
    await pool.query(`
      UPDATE pallets_pintura 
      SET status = 'FECHADO', data_fechamento = NOW() 
      WHERE UPPER(codigo_pallet) = $1
    `, [codPallet]);

    console.log(`Pallet ${codPallet} fechado. ${updateRecRes.rowCount} unidades com status atualizado para 'Aguardando retorno de pintura'.`);
    res.json({
      success: true,
      message: `Pallet ${codPallet} fechado com sucesso. ${updateRecRes.rowCount} unidades atualizadas para 'Aguardando retorno de pintura'.`,
      unidadesAtualizadas: updateRecRes.rowCount
    });
  } catch (err) {
    console.error('Error closing pallet:', err);
    res.status(500).json({ error: 'Database error closing pallet.' });
  }
});

// Get all pallets (open and closed)
app.get('/api/expedicao-pintura/pallets-todos', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM pallets_pintura ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching all pallets:', err);
    res.status(500).json({ error: 'Database error fetching pallets.' });
  }
});

// Get report data for expedicao pintura
app.get('/api/expedicao-pintura/report', async (req, res) => {
  const { start, end, modelo } = req.query;
  try {
    let query = `
      SELECT ppi.*, p.data_criacao, p.data_fechamento, p.status as pallet_status 
      FROM pallet_pintura_itens ppi
      JOIN pallets_pintura p ON ppi.pallet_id = p.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (start) {
      query += ` AND ppi.data_bipagem >= $${paramIndex}`;
      params.push(`${start} 00:00:00`);
      paramIndex++;
    }
    if (end) {
      query += ` AND ppi.data_bipagem <= $${paramIndex}`;
      params.push(`${end} 23:59:59`);
      paramIndex++;
    }
    if (modelo) {
      query += ` AND ppi.modelo = $${paramIndex}`;
      params.push(modelo);
      paramIndex++;
    }

    query += ' ORDER BY ppi.id ASC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching expedicao pintura report:', err);
    res.status(500).json({ error: 'Failed to fetch report data.' });
  }
});

// Reopen a closed pallet
app.post('/api/expedicao-pintura/reabrir-pallet', async (req, res) => {
  try {
    const { codigo_pallet } = req.body;
    const codPallet = codigo_pallet.trim().toUpperCase();

    // 1. Reopen pallet
    await pool.query(`
      UPDATE pallets_pintura 
      SET status = 'ABERTO', data_fechamento = NULL 
      WHERE UPPER(codigo_pallet) = $1
    `, [codPallet]);

    // 2. Update status of units in recebimentos to 'Em pallet'
    const updateRecebimentosQuery = `
      UPDATE recebimentos
      SET status = 'Em pallet'
      WHERE id IN (
        SELECT r.id FROM recebimentos r
        JOIN pallet_pintura_itens ppi ON (
          (r.serial_number IS NOT NULL AND r.serial_number != '' AND UPPER(TRIM(r.serial_number)) = UPPER(TRIM(ppi.serial_number)))
          OR (r.gpon_id IS NOT NULL AND r.gpon_id != '' AND UPPER(TRIM(r.gpon_id)) = UPPER(TRIM(ppi.gpon_id)))
          OR (r.mac IS NOT NULL AND r.mac != '' AND UPPER(TRIM(r.mac)) = UPPER(TRIM(ppi.mac)))
        )
        WHERE UPPER(ppi.codigo_pallet) = $1
      )
    `;
    const recRes = await pool.query(updateRecebimentosQuery, [codPallet]);

    // 3. Update status of items in pallet_pintura_itens
    await pool.query(`
      UPDATE pallet_pintura_itens
      SET status = 'Em pallet'
      WHERE UPPER(codigo_pallet) = $1
    `, [codPallet]);

    console.log(`Pallet ${codPallet} reaberto. ${recRes.rowCount} unidades atualizadas para 'Em pallet'.`);
    res.json({
      success: true,
      message: `Pallet ${codPallet} reaberto com sucesso. Status das unidades alterado para 'Em pallet'.`,
      unidadesAtualizadas: recRes.rowCount
    });
  } catch (err) {
    console.error('Error reopening pallet:', err);
    res.status(500).json({ error: 'Database error reopening pallet.' });
  }
});

// Remove item from pallet (and revert unit status in recebimentos back to 'Recebida')
app.delete('/api/expedicao-pintura/item/:id', async (req, res) => {
  try {
    const itemId = req.params.id;
    const itemRes = await pool.query('SELECT * FROM pallet_pintura_itens WHERE id = $1', [itemId]);
    if (itemRes.rows.length === 0) return res.status(404).json({ error: 'Item não encontrado.' });
    const item = itemRes.rows[0];

    // 1. Delete item from pallet
    await pool.query('DELETE FROM pallet_pintura_itens WHERE id = $1', [itemId]);

    // 2. Revert unit status in recebimentos to 'Recebida'
    const identifiers = [item.serial_number, item.gpon_id, item.mac].filter(Boolean);
    if (identifiers.length > 0) {
      await pool.query(`
        UPDATE recebimentos
        SET status = 'Recebida'
        WHERE (serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = ANY($1))
           OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = ANY($1))
           OR (mac IS NOT NULL AND mac != '' AND UPPER(TRIM(mac)) = ANY($1))
      `, [identifiers]);
    }

    // 3. Recalculate total_unidades on pallet
    await pool.query(`
      UPDATE pallets_pintura 
      SET total_unidades = (SELECT COUNT(*)::int FROM pallet_pintura_itens WHERE UPPER(codigo_pallet) = UPPER($1))
      WHERE UPPER(codigo_pallet) = UPPER($1)
    `, [item.codigo_pallet]);

    console.log(`Item ${item.serial_number} removido do pallet ${item.codigo_pallet}. Status revertido para 'Recebida'.`);
    res.json({ success: true, codigo_pallet: item.codigo_pallet, serial: item.serial_number });
  } catch (err) {
    console.error('Error removing item:', err);
    res.status(500).json({ error: 'Database error removing item.' });
  }
});

// ============================================================
// Retorno de Pintura Routes
// ============================================================

// Scan/Register unit into Retorno de Pintura
app.post('/api/retorno-pintura/bipar', async (req, res) => {
  try {
    const { codigo, usuario } = req.body;
    if (!codigo || !codigo.trim()) {
      return res.status(400).json({ error: 'Informe o Serial, GPON ID ou MAC da unidade.' });
    }
    const cleanCode = codigo.trim().toUpperCase();

    // 1. Check if unit exists in recebimentos by Serial, GPON ID or MAC
    const recRes = await pool.query(`
      SELECT * FROM recebimentos 
      WHERE (serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = $1)
         OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = $1)
         OR (mac IS NOT NULL AND mac != '' AND UPPER(TRIM(mac)) = $1)
      ORDER BY id DESC LIMIT 1
    `, [cleanCode]);

    if (recRes.rows.length === 0) {
      return res.status(404).json({
        success: false,
        code: 'UNIDADE_NAO_ENCONTRADA',
        error: `Unidade "${cleanCode}" não encontrada na base de Recebimento.`
      });
    }

    const unit = recRes.rows[0];
    const identifiers = [unit.serial_number, unit.gpon_id, unit.mac].filter(Boolean);

    // 2. Update status in recebimentos to "Retorno de Pintura"
    await pool.query(`
      UPDATE recebimentos
      SET status = 'Retorno de Pintura'
      WHERE id = $1 
         OR (serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = ANY($2))
         OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = ANY($2))
         OR (mac IS NOT NULL AND mac != '' AND UPPER(TRIM(mac)) = ANY($2))
    `, [unit.id, identifiers]);

    // 4. Update status in pallet_pintura_itens if it exists
    if (identifiers.length > 0) {
      await pool.query(`
        UPDATE pallet_pintura_itens
        SET status = 'Retorno de Pintura'
        WHERE (serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = ANY($1))
           OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = ANY($1))
           OR (mac IS NOT NULL AND mac != '' AND UPPER(TRIM(mac)) = ANY($1))
      `, [identifiers]);
    }

    // 5. Insert into retorno_pintura_itens
    const insertRes = await pool.query(`
      INSERT INTO retorno_pintura_itens (recebimento_id, serial_number, gpon_id, mac, modelo, fabricante, data_retorno, usuario, status)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, 'Retorno de Pintura')
      RETURNING *
    `, [
      unit.id,
      unit.serial_number || cleanCode,
      unit.gpon_id || '',
      unit.mac || '',
      unit.modelo || 'NÃO INFORMADO',
      unit.fabricante || 'NÃO INFORMADO',
      usuario || 'OPERADOR'
    ]);

    // 6. Get updated recent items and stats
    const recentRes = await pool.query('SELECT * FROM retorno_pintura_itens ORDER BY id DESC LIMIT 50');
    const statsRes = await pool.query(`
      SELECT 
        COUNT(*)::int as total,
        COUNT(CASE WHEN data_retorno >= CURRENT_DATE THEN 1 END)::int as total_hoje
      FROM retorno_pintura_itens
    `);

    res.json({
      success: true,
      item: insertRes.rows[0],
      message: `Unidade ${insertRes.rows[0].serial_number} registrada com sucesso no Retorno de Pintura!`,
      recentItems: recentRes.rows,
      stats: statsRes.rows[0]
    });
  } catch (err) {
    console.error('Error in retorno-pintura bipar:', err);
    res.status(500).json({ error: 'Erro no banco de dados ao registrar retorno de pintura.' });
  }
});

// Get recent retorno de pintura items
app.get('/api/retorno-pintura/recentes', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM retorno_pintura_itens ORDER BY id DESC LIMIT 50');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching recent retorno-pintura items:', err);
    res.status(500).json({ error: 'Database error fetching recent items.' });
  }
});

// Get retorno de pintura stats
app.get('/api/retorno-pintura/stats', async (req, res) => {
  try {
    const statsRes = await pool.query(`
      SELECT 
        COUNT(*)::int as total,
        COUNT(CASE WHEN data_retorno >= CURRENT_DATE THEN 1 END)::int as total_hoje
      FROM retorno_pintura_itens
    `);
    res.json(statsRes.rows[0] || { total: 0, total_hoje: 0 });
  } catch (err) {
    console.error('Error fetching retorno-pintura stats:', err);
    res.status(500).json({ error: 'Database error fetching stats.' });
  }
});

// Get report data for retorno pintura
app.get('/api/retorno-pintura/report', async (req, res) => {
  const { start, end, modelo } = req.query;
  try {
    let query = 'SELECT * FROM retorno_pintura_itens WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (start) {
      query += ` AND data_retorno >= $${paramIndex}`;
      params.push(`${start} 00:00:00`);
      paramIndex++;
    }
    if (end) {
      query += ` AND data_retorno <= $${paramIndex}`;
      params.push(`${end} 23:59:59`);
      paramIndex++;
    }
    if (modelo) {
      query += ` AND modelo = $${paramIndex}`;
      params.push(modelo);
      paramIndex++;
    }

    query += ' ORDER BY id DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching retorno pintura report:', err);
    res.status(500).json({ error: 'Failed to fetch report data.' });
  }
});

// ============================================================
// Endpoint de Consulta Completa e Histórico da Unidade
// ============================================================
app.get('/api/consulta-unidade/:query', async (req, res) => {
  const rawQuery = (req.params.query || '').trim();
  if (!rawQuery) {
    return res.status(400).json({ error: 'Termo de consulta não informado.' });
  }

  const cleanQuery = rawQuery.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const searchTerms = Array.from(new Set([rawQuery.toUpperCase(), cleanQuery])).filter(Boolean);

  try {
    // 1. Buscar em recebimentos
    const recRes = await pool.query(
      `SELECT * FROM recebimentos 
       WHERE (serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = ANY($1))
          OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = ANY($1))
          OR (mac IS NOT NULL AND mac != '' AND UPPER(REPLACE(mac, ':', '')) = ANY($1))
          OR (mac IS NOT NULL AND mac != '' AND UPPER(TRIM(mac)) = ANY($1))
       ORDER BY id DESC`,
      [searchTerms]
    );

    const recebimento = recRes.rows[0] || null;

    // Coleta todos os identificadores conhecidos
    const allIdentifiers = new Set(searchTerms);
    if (recebimento) {
      if (recebimento.serial_number) allIdentifiers.add(recebimento.serial_number.trim().toUpperCase());
      if (recebimento.gpon_id) allIdentifiers.add(recebimento.gpon_id.trim().toUpperCase());
      if (recebimento.mac) {
        allIdentifiers.add(recebimento.mac.trim().toUpperCase());
        allIdentifiers.add(recebimento.mac.replace(/[^a-zA-Z0-9]/g, '').toUpperCase());
      }
    }

    const idList = Array.from(allIdentifiers).filter(Boolean);

    // 2. Buscar em pre_alertas
    const preRes = await pool.query(
      `SELECT * FROM pre_alertas 
       WHERE UPPER(TRIM(serial)) = ANY($1)
          OR UPPER(REPLACE(serial, ':', '')) = ANY($1)`,
      [idList]
    );
    const preAlerta = preRes.rows[0] || null;

    // 3. Buscar em pallet_pintura_itens com dados do pallet
    const palletRes = await pool.query(
      `SELECT ppi.*, p.status as status_pallet, p.data_criacao as pallet_data_criacao, p.data_fechamento as pallet_data_fechamento, p.usuario_criacao as pallet_usuario_criacao
       FROM pallet_pintura_itens ppi
       LEFT JOIN pallets_pintura p ON p.id = ppi.pallet_id
       WHERE (ppi.serial_number IS NOT NULL AND ppi.serial_number != '' AND UPPER(TRIM(ppi.serial_number)) = ANY($1))
          OR (ppi.gpon_id IS NOT NULL AND ppi.gpon_id != '' AND UPPER(TRIM(ppi.gpon_id)) = ANY($1))
          OR (ppi.mac IS NOT NULL AND ppi.mac != '' AND UPPER(REPLACE(ppi.mac, ':', '')) = ANY($1))
          OR (ppi.mac IS NOT NULL AND ppi.mac != '' AND UPPER(TRIM(ppi.mac)) = ANY($1))
       ORDER BY ppi.id DESC`,
      [idList]
    );

    // 4. Buscar em retorno_pintura_itens
    const retornoRes = await pool.query(
      `SELECT * FROM retorno_pintura_itens 
       WHERE (serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = ANY($1))
          OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = ANY($1))
          OR (mac IS NOT NULL AND mac != '' AND UPPER(REPLACE(mac, ':', '')) = ANY($1))
          OR (mac IS NOT NULL AND mac != '' AND UPPER(TRIM(mac)) = ANY($1))
       ORDER BY id DESC`,
      [idList]
    );

    // Se não encontrou em nenhuma tabela
    if (!recebimento && !preAlerta && palletRes.rows.length === 0 && retornoRes.rows.length === 0) {
      return res.json({ found: false, message: 'Unidade não encontrada no sistema.' });
    }

    // Consolidar dados da unidade
    const unit = {
      serial_number: recebimento?.serial_number || palletRes.rows[0]?.serial_number || retornoRes.rows[0]?.serial_number || preAlerta?.serial || rawQuery,
      gpon_id: recebimento?.gpon_id || palletRes.rows[0]?.gpon_id || retornoRes.rows[0]?.gpon_id || null,
      mac: recebimento?.mac || palletRes.rows[0]?.mac || retornoRes.rows[0]?.mac || null,
      modelo: recebimento?.modelo || palletRes.rows[0]?.modelo || retornoRes.rows[0]?.modelo || 'Não identificado',
      fabricante: recebimento?.fabricante || palletRes.rows[0]?.fabricante || retornoRes.rows[0]?.fabricante || preAlerta?.fabricante || 'Não identificado',
      codigo: recebimento?.codigo || preAlerta?.codigo || '---',
      descricao: recebimento?.descricao || preAlerta?.descricao || '---',
      no_pre_alerta: !!(preAlerta || recebimento?.no_pre_alerta),
      status_atual: 'Desconhecido'
    };

    // Montar Linha do Tempo / Histórico
    const history = [];

    // Etapa Pré-Alerta
    if (preAlerta) {
      history.push({
        etapa: 'Pré-Alerta',
        titulo: 'Presente na Base de Pré-Alerta',
        descricao: `Código: ${preAlerta.codigo || '---'} | Descrição: ${preAlerta.descricao || '---'} | Fabricante: ${preAlerta.fabricante || '---'}`,
        data_hora: null,
        usuario: 'Sistema / Importação',
        status: 'Cadastrada no Pré-Alerta',
        tipo: 'pre-alerta',
        icone: 'database'
      });
    }

    // Etapa Recebimento
    if (recebimento) {
      history.push({
        etapa: 'Recebimento',
        titulo: 'Unidade Recebida no Sistema',
        descricao: `Modelo: ${recebimento.modelo || '---'} | Serial: ${recebimento.serial_number || '---'} | PON: ${recebimento.gpon_id || '---'} | MAC: ${recebimento.mac || '---'} (${recebimento.no_pre_alerta ? 'No Pré-Alerta' : 'Fora do Pré-Alerta'})`,
        data_hora: recebimento.data_hora,
        usuario: recebimento.usuario || 'Não registrado',
        status: recebimento.status || 'Recebida',
        tipo: 'recebimento',
        icone: 'inbox'
      });
    }

    // Etapa Pallet / Expedição Pintura
    palletRes.rows.forEach(palletItem => {
      history.push({
        etapa: 'Expedição Pintura',
        titulo: `Bipada no Pallet ${palletItem.codigo_pallet}`,
        descricao: `Pallet: ${palletItem.codigo_pallet} (Status do Pallet: ${palletItem.status_pallet || 'ABERTO'}) | Status do Item: ${palletItem.status || 'Em Pallet'}`,
        data_hora: palletItem.data_bipagem,
        usuario: palletItem.usuario || 'Não registrado',
        status: palletItem.status || 'Em Pallet',
        tipo: 'pallet',
        icone: 'package',
        codigo_pallet: palletItem.codigo_pallet
      });
    });

    // Etapa Retorno de Pintura
    retornoRes.rows.forEach(retornoItem => {
      history.push({
        etapa: 'Retorno de Pintura',
        titulo: 'Retornada da Pintura',
        descricao: `Modelo: ${retornoItem.modelo || '---'} | Serial: ${retornoItem.serial_number || '---'}`,
        data_hora: retornoItem.data_retorno,
        usuario: retornoItem.usuario || 'Não registrado',
        status: retornoItem.status || 'Retorno de Pintura',
        tipo: 'retorno',
        icone: 'repeat'
      });
    });

    // Definir Status Atual
    if (retornoRes.rows.length > 0) {
      unit.status_atual = 'Retorno de Pintura';
    } else if (palletRes.rows.length > 0 && palletRes.rows[0].status === 'Em Pallet') {
      unit.status_atual = `Em Pallet (${palletRes.rows[0].codigo_pallet})`;
    } else if (recebimento) {
      unit.status_atual = recebimento.status || 'Recebida';
    } else if (preAlerta) {
      unit.status_atual = 'No Pré-Alerta (Aguardando Recebimento)';
    }

    res.json({
      found: true,
      unit,
      history,
      detalhes: {
        recebimento,
        pre_alerta: preAlerta,
        pallets: palletRes.rows,
        retornos: retornoRes.rows
      }
    });
  } catch (err) {
    console.error('Erro ao consultar unidade:', err);
    res.status(500).json({ error: 'Erro interno ao consultar unidade.' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Unified server listening on port ${PORT}`));

