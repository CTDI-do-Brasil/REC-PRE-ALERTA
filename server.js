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
    const query = `INSERT INTO recebimentos(fabricante, modelo, serial_number, gpon_id, mac, usuario, data_hora, no_pre_alerta, matched_value, codigo, descricao)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;
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
      body.descricao || null
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
  res.json({ version: 'v1.4.9' });
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Unified server listening on port ${PORT}`));
