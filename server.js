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

    await client.query(`CREATE TABLE IF NOT EXISTS recebimentos (
      ordem SERIAL,
      id TEXT PRIMARY KEY,
      modelo TEXT,
      serial TEXT,
      pon TEXT,
      mac TEXT,
      datahora TIMESTAMP,
      usuario TEXT,
      no_pre_alerta BOOLEAN,
      matched_value TEXT,
      codigo TEXT,
      descricao TEXT,
      fabricante TEXT
    )`);

    // Ensure the auto-increment 'ordem' column exists for existing tables
    await client.query(`ALTER TABLE recebimentos ADD COLUMN IF NOT EXISTS ordem SERIAL`);

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

// Check duplicity of scans in Postgres
app.get('/api/recebimentos/check', async (req, res) => {
  const { serial, pon, mac } = req.query;
  try {
    const result = await pool.query(
      `SELECT * FROM recebimentos 
       WHERE (serial IS NOT NULL AND serial = $1)
          OR (pon IS NOT NULL AND pon = $2)
          OR (mac IS NOT NULL AND mac = $3)
       LIMIT 1`,
      [serial || null, pon || null, mac || null]
    );
    if (result.rows.length > 0) {
      return res.json({ duplicate: true, data: result.rows[0] });
    }
    res.json({ duplicate: false });
  } catch (err) {
    console.error('Error checking duplicity:', err);
    res.status(500).json({ error: 'DB check error' });
  }
});

// Save scan results
app.post('/api/recebimentos', async (req, res) => {
  const body = req.body;
  if (!body || !body.id) return res.status(400).json({ error: 'Invalid payload' });
  try {
    const query = `INSERT INTO recebimentos(id, modelo, serial, pon, mac, datahora, usuario, no_pre_alerta, matched_value, codigo, descricao, fabricante)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (id) DO UPDATE SET modelo = EXCLUDED.modelo`;
    const params = [
      body.id,
      body.modelo,
      body.serial,
      body.pon || null,
      body.mac,
      body.dataHora ? new Date(body.dataHora) : new Date(),
      body.usuario || null,
      body.noPreAlerta || false,
      body.matchedValue || null,
      body.codigo || null,
      body.descricao || null,
      body.fabricante || null
    ];
    await pool.query(query, params);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error saving recebimento:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// Fetch recebimentos report data from Postgres
app.get('/api/recebimentos/report', async (req, res) => {
  const { start, end, noPreAlerta } = req.query;
  try {
    let query = 'SELECT * FROM recebimentos WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (start) {
      query += ` AND datahora >= $${paramIndex}`;
      params.push(new Date(start + 'T00:00:00'));
      paramIndex++;
    }
    if (end) {
      query += ` AND datahora <= $${paramIndex}`;
      params.push(new Date(end + 'T23:59:59'));
      paramIndex++;
    }
    if (noPreAlerta !== undefined) {
      query += ` AND no_pre_alerta = $${paramIndex}`;
      params.push(noPreAlerta === 'true');
      paramIndex++;
    }

    query += ' ORDER BY datahora DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching report data:', err);
    res.status(500).json({ error: 'Failed to fetch report data.' });
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
