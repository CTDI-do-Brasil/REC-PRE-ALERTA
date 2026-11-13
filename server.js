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
const MINIO_BUCKET = process.env.MINIO_BUCKET_PRE_ALERTA || (process.env.MINIO_BUCKET === 'expedicao-tim' ? 'rec-pre-alerta' : (process.env.MINIO_BUCKET || 'rec-pre-alerta'));
const MINIO_EXPEDICAO_BUCKET = process.env.MINIO_EXPEDICAO_BUCKET || process.env.MINIO_BUCKET_EXPEDICAO || 'expedicao-tim';
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
      descricao TEXT,
      super_user TEXT
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

    // Create indexes for fast lookup during unit scans
    await client.query(`CREATE INDEX IF NOT EXISTS idx_recebimentos_serial_number ON recebimentos (serial_number)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_recebimentos_gpon_id ON recebimentos (gpon_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_recebimentos_mac ON recebimentos (mac)`);

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
    await client.query(`CREATE SEQUENCE IF NOT EXISTS seq_pallet_garantia START WITH 1`);
    await client.query(`CREATE TABLE IF NOT EXISTS pallets_pintura (
      id SERIAL PRIMARY KEY,
      codigo_pallet TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'ABERTO',
      data_criacao TIMESTAMP DEFAULT NOW(),
      data_fechamento TIMESTAMP,
      usuario_criacao TEXT,
      total_unidades INTEGER DEFAULT 0
    )`);
    await client.query(`ALTER TABLE pallets_pintura ADD COLUMN IF NOT EXISTS tipo TEXT DEFAULT 'NORMAL'`);
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
    await client.query(`ALTER TABLE pallet_pintura_itens ADD COLUMN IF NOT EXISTS tipo TEXT DEFAULT 'NORMAL'`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pallet_itens_serial ON pallet_pintura_itens(serial_number)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pallet_itens_codigo ON pallet_pintura_itens(codigo_pallet)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pallet_tipo ON pallets_pintura(tipo)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pallet_itens_tipo ON pallet_pintura_itens(tipo)`);

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

    // Ensure super_user column in recebimentos
    await client.query(`ALTER TABLE recebimentos ADD COLUMN IF NOT EXISTS super_user TEXT`);
    await client.query(`ALTER TABLE recebimentos ADD COLUMN IF NOT EXISTS lote_expedicao TEXT`);
    await client.query(`ALTER TABLE recebimentos ADD COLUMN IF NOT EXISTS data_expedicao TIMESTAMP`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_recebimentos_serial ON recebimentos(serial_number)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_recebimentos_status ON recebimentos(status)`);

    // Ensure Expedição TIM tables
    await client.query(`CREATE TABLE IF NOT EXISTS expedicao_tim_relatorio (
      id SERIAL PRIMARY KEY,
      report_data JSONB NOT NULL DEFAULT '[]'::jsonb,
      raw_data JSONB NOT NULL DEFAULT '[]'::jsonb,
      raw_headers JSONB NOT NULL DEFAULT '[]'::jsonb,
      column_map JSONB NOT NULL DEFAULT '{}'::jsonb,
      total_linhas INTEGER DEFAULT 0,
      usuario TEXT,
      importacao_id TEXT,
      nome_arquivo TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    await client.query(`ALTER TABLE expedicao_tim_relatorio ADD COLUMN IF NOT EXISTS importacao_id TEXT`);
    await client.query(`ALTER TABLE expedicao_tim_relatorio ADD COLUMN IF NOT EXISTS nome_arquivo TEXT`);

    // Tabela histórica de importações de relatórios da Expedição TIM
    await client.query(`CREATE TABLE IF NOT EXISTS expedicao_tim_importacoes (
      id TEXT PRIMARY KEY,
      nome_arquivo TEXT NOT NULL,
      total_linhas INTEGER DEFAULT 0,
      total_pallets INTEGER DEFAULT 0,
      usuario TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      column_map JSONB NOT NULL DEFAULT '{}'::jsonb,
      raw_headers JSONB NOT NULL DEFAULT '[]'::jsonb,
      report_data JSONB NOT NULL DEFAULT '[]'::jsonb,
      raw_data JSONB NOT NULL DEFAULT '[]'::jsonb
    )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_expedicao_importacoes_created ON expedicao_tim_importacoes(created_at DESC)`);

    await client.query(`CREATE TABLE IF NOT EXISTS expedicao_tim_lotes (
      id TEXT PRIMARY KEY,
      number INTEGER,
      dest TEXT,
      obs TEXT,
      status TEXT DEFAULT 'aberto',
      created_at TEXT,
      groups JSONB NOT NULL DEFAULT '[]'::jsonb,
      expedition_data JSONB,
      usuario TEXT,
      importacao_id TEXT,
      importacao_arquivo TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    await client.query(`ALTER TABLE expedicao_tim_lotes ADD COLUMN IF NOT EXISTS importacao_id TEXT`);
    await client.query(`ALTER TABLE expedicao_tim_lotes ADD COLUMN IF NOT EXISTS importacao_arquivo TEXT`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_expedicao_lotes_importacao ON expedicao_tim_lotes(importacao_id)`);

    await client.query(`CREATE TABLE IF NOT EXISTS expedicao_tim_config (
      key TEXT PRIMARY KEY,
      value JSONB,
      updated_at TIMESTAMP DEFAULT NOW()
    )`);

    console.log('Postgres tables verified/created successfully.');
  } catch (err) {
    console.error('Error establishing database tables:', err);
  } finally {
    client.release();
  }

  // 2. Ensure MinIO buckets exist (Pre-Alerta & Expedição TIM)
  try {
    if (MINIO_ACCESS_KEY && MINIO_SECRET_KEY) {
      const exists = await minioClient.bucketExists(MINIO_BUCKET);
      if (!exists) {
        await minioClient.makeBucket(MINIO_BUCKET);
        console.log(`MinIO bucket "${MINIO_BUCKET}" created successfully.`);
      } else {
        console.log(`MinIO bucket "${MINIO_BUCKET}" already exists.`);
      }

      if (MINIO_EXPEDICAO_BUCKET && MINIO_EXPEDICAO_BUCKET !== MINIO_BUCKET) {
        const existsExp = await minioClient.bucketExists(MINIO_EXPEDICAO_BUCKET);
        if (!existsExp) {
          await minioClient.makeBucket(MINIO_EXPEDICAO_BUCKET);
          console.log(`MinIO bucket da Expedição "${MINIO_EXPEDICAO_BUCKET}" criado com sucesso.`);
        } else {
          console.log(`MinIO bucket da Expedição "${MINIO_EXPEDICAO_BUCKET}" já existe.`);
        }
      }
    } else {
      console.warn('MinIO credentials missing. Skipping bucket auto-creation.');
    }
  } catch (err) {
    console.error('Error ensuring MinIO bucket exists:', err.message);
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

// Helper functions for special character restriction (trava contra caracteres especiais)
function hasSpecialChars(val) {
  if (!val || typeof val !== 'string') return false;
  return /[^A-Za-z0-9]/.test(val.trim());
}

function sanitizeDataCode(val) {
  if (!val || typeof val !== 'string') return '';
  return val.trim().replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function hasValidPassword(pwd) {
  if (!pwd || typeof pwd !== 'string') return false;
  const trimmed = pwd.trim();
  if (!trimmed) return false;
  const upper = trimmed.toUpperCase();
  const invalidValues = ['N/A', 'NA', 'NONE', 'NULL', 'SEM SENHA', 'SEM_SENHA', 'SEM-SENHA', 'PADRAO', 'PADRÃO', 'DEFAULT', '0', '-'];
  return !invalidValues.includes(upper);
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
      const cleanSerial = sanitizeDataCode(item.serial);
      if (!cleanSerial) continue;
      const cleanCodigo = item.codigo ? String(item.codigo).trim().replace(/[^A-Za-z0-9\s-]/g, '').toUpperCase() : '';
      await client.query(
        `INSERT INTO pre_alertas(serial, codigo, descricao, fabricante)
         VALUES($1, $2, $3, $4)
         ON CONFLICT (serial) DO UPDATE SET
           codigo = EXCLUDED.codigo,
           descricao = EXCLUDED.descricao,
           fabricante = EXCLUDED.fabricante`,
        [cleanSerial, cleanCodigo, item.descricao || '', item.fabricante || '']
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
  const rawVal = String(value).trim();
  if (hasSpecialChars(rawVal)) {
    return res.json({ found: false });
  }
  const cleanVal = sanitizeDataCode(rawVal);

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
  const rawS = String(serial || '').trim();
  const rawP = String(pon || '').trim();
  const rawM = String(mac || '').trim();

  if (hasSpecialChars(rawS) || (rawP && hasSpecialChars(rawP)) || hasSpecialChars(rawM)) {
    return res.status(400).json({ error: 'Caracteres especiais não são permitidos nos dados da unidade.' });
  }

  const s = sanitizeDataCode(rawS);
  const p = sanitizeDataCode(rawP);
  const m = sanitizeDataCode(rawM);

  try {
    // 1. Check existing records in Postgres (ordered by most recent first)
    const dupResult = await pool.query(
      `SELECT * FROM recebimentos 
       WHERE (serial_number IS NOT NULL AND serial_number = $1)
          OR (gpon_id IS NOT NULL AND gpon_id = $2)
          OR (mac IS NOT NULL AND mac = $3)
       ORDER BY data_hora DESC, id DESC
       LIMIT 1`,
      [s || null, p || null, m || null]
    );

    let isDuplicate = false;
    let duplicateData = null;
    let isReentry = false;
    let previousReception = null;
    let isSucata = false;

    if (dupResult.rows.length > 0) {
      const latestRec = dupResult.rows[0];
      const statusUpper = String(latestRec.status || '').trim().toUpperCase();

      if (statusUpper.includes('SUCATA')) {
        // Unidade com status de Sucata NUNCA pode ser recebida novamente no recebimento normal
        isDuplicate = true;
        isSucata = true;
        duplicateData = latestRec;
      } else if (statusUpper === 'EXPEDIDA') {
        // A unidade foi expedida no ciclo anterior. Ela já saiu da fábrica!
        // Portanto, NÃO é duplicidade: permitimos um novo recebimento (reentrada / logística reversa).
        isDuplicate = false;
        isReentry = true;
        previousReception = latestRec;
      } else {
        // A unidade ainda está dentro da fábrica em algum processo (Recebida, Em Pallet, Pintura, etc.)
        isDuplicate = true;
        duplicateData = latestRec;
      }
    }

    if (isDuplicate) {
      return res.json({ 
        duplicate: true, 
        isSucata,
        duplicateData 
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
      reentry: isReentry,
      previousReception,
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

  const rawSerial = String(body.serial || body.serial_number || '').trim();
  const rawPon = String(body.pon || body.gpon_id || '').trim();
  const rawMac = String(body.mac || '').trim();

  if (hasSpecialChars(rawSerial) || (rawPon && hasSpecialChars(rawPon)) || hasSpecialChars(rawMac)) {
    return res.status(400).json({ error: 'Caracteres especiais não são permitidos nos dados da unidade.' });
  }

  let cleanSerial = sanitizeDataCode(rawSerial);
  let cleanPon = sanitizeDataCode(rawPon);
  let cleanMac = sanitizeDataCode(rawMac);

  const isF6600P = body.modelo && body.modelo.trim().toUpperCase().includes('F6600P');
  const isNP7287 = body.modelo && body.modelo.trim().toUpperCase().includes('NP7287');
  const isHG8145 = body.modelo && (body.modelo.trim().toUpperCase().includes('HG8145') || body.modelo.trim().toUpperCase().includes('8145X6'));
  const hasPasswordCheck = isF6600P || isNP7287 || isHG8145;
  let superUserStatus = null;
  let destinoMsg = null;
  let destinoTipo = null;

  try {
    if (hasPasswordCheck) {
      if (secondPool && (cleanPon || cleanSerial)) {
        try {
          let ponAlt = '';
          if (cleanPon) {
            if (cleanPon.startsWith('HWTC')) {
              ponAlt = '48575443' + cleanPon.slice(4);
            } else if (cleanPon.startsWith('48575443')) {
              ponAlt = 'HWTC' + cleanPon.slice(8);
            }
          }

          let checkRes;
          // 1. Busca estrita pelo GPON primeiro
          if (cleanPon || ponAlt) {
            const checkQuery = `
              SELECT gpon_sn, cpe_sn, mac, fabricante, modelo, password_router
              FROM etiquetas_scan_onu
              WHERE UPPER(TRIM(gpon_sn)) = UPPER(TRIM($1))
                 OR ( $2 != '' AND UPPER(TRIM(gpon_sn)) = UPPER(TRIM($2)) )
              ORDER BY (CASE WHEN cpe_sn IS NOT NULL AND cpe_sn != '' AND UPPER(cpe_sn) != 'N/A' THEN 1 ELSE 0 END) DESC,
                       (CASE WHEN mac IS NOT NULL AND mac != '' AND UPPER(mac) != 'N/A' THEN 1 ELSE 0 END) DESC
              LIMIT 1
            `;
            checkRes = await secondPool.query(checkQuery, [cleanPon || '', ponAlt || '']);
          }

          // 2. Fallback por Serial somente se não encontrou nada pelo GPON
          if ((!checkRes || checkRes.rows.length === 0) && cleanSerial) {
            const serialQuery = `
              SELECT gpon_sn, cpe_sn, mac, fabricante, modelo, password_router
              FROM etiquetas_scan_onu
              WHERE UPPER(TRIM(cpe_sn)) = UPPER(TRIM($1))
              ORDER BY (CASE WHEN mac IS NOT NULL AND mac != '' AND UPPER(mac) != 'N/A' THEN 1 ELSE 0 END) DESC
              LIMIT 1
            `;
            checkRes = await secondPool.query(serialQuery, [cleanSerial]);
          }

          if (checkRes && checkRes.rows.length > 0) {
            const etiqueta = checkRes.rows[0];
            const hasPassword = hasValidPassword(etiqueta.password_router);

            if (hasPassword) {
              superUserStatus = 'Sim';
              if (body.noPreAlerta) {
                destinoMsg = 'Enviar essa unidade para o laboratório';
                destinoTipo = 'laboratorio';
              }
            } else {
              superUserStatus = 'Não';
              if (body.noPreAlerta) {
                destinoMsg = 'Separe essa unidade para a engenharia';
                destinoTipo = 'engenharia';
              }
            }
            // Atualiza cpe_sn e mac no segundo banco com o que foi bipado no recebimento
            try {
              const targetGpon = cleanPon || etiqueta.gpon_sn;
              if (targetGpon && (cleanSerial || cleanMac)) {
                await secondPool.query(`
                  UPDATE etiquetas_scan_onu
                  SET cpe_sn = COALESCE($1, cpe_sn),
                      mac = COALESCE($2, mac)
                  WHERE UPPER(TRIM(gpon_sn)) = UPPER(TRIM($3))
                `, [cleanSerial || null, cleanMac || null, targetGpon]);
              }
            } catch (updSecErr) {
              console.error('Erro ao atualizar cpe_sn/mac em etiquetas_scan_onu no recebimento:', updSecErr.message);
            }
          } else {
            superUserStatus = 'Não';
            if (body.noPreAlerta) {
              destinoMsg = 'Separe essa unidade para a engenharia';
              destinoTipo = 'engenharia';
            }
          }
        } catch (secDbErr) {
          console.error('Error querying second DB for F6600P/NP7287/HG8145 gpon_sn:', secDbErr);
          superUserStatus = 'Não';
          if (body.noPreAlerta) {
            destinoMsg = 'Separe essa unidade para a engenharia';
            destinoTipo = 'engenharia';
          }
        }
      } else {
        superUserStatus = 'Não';
        if (body.noPreAlerta) {
          destinoMsg = 'Separe essa unidade para a engenharia';
          destinoTipo = 'engenharia';
        }
      }
    }

    // Prevent duplicate or Sucata unit from being inserted again in normal or sucata receiving
    const existingCheck = await pool.query(
      `SELECT * FROM recebimentos 
       WHERE (serial_number IS NOT NULL AND serial_number = $1)
          OR (gpon_id IS NOT NULL AND gpon_id = $2)
          OR (mac IS NOT NULL AND mac = $3)
       ORDER BY data_hora DESC, id DESC
       LIMIT 1`,
      [cleanSerial || null, cleanPon || null, cleanMac || null]
    );
    if (existingCheck.rows.length > 0) {
      const latestExisting = existingCheck.rows[0];
      const existingStatusUpper = String(latestExisting.status || '').trim().toUpperCase();
      if (existingStatusUpper.includes('SUCATA')) {
        return res.status(400).json({
          error: 'Esta unidade possui status de SUCATA e não pode ser recebida novamente.',
          code: 'JA_SUCATA',
          duplicateData: latestExisting
        });
      }
      if (existingStatusUpper !== 'EXPEDIDA') {
        return res.status(400).json({
          error: 'Esta unidade já foi recebida no sistema.',
          code: 'DUPLICADO',
          duplicateData: latestExisting
        });
      }
    }

    const isSucataRequest = body.status && String(body.status).trim().toUpperCase() === 'SUCATA';
    const finalStatus = isSucataRequest ? 'Sucata' : 'Recebida';

    const query = `INSERT INTO recebimentos(fabricante, modelo, serial_number, gpon_id, mac, usuario, data_hora, no_pre_alerta, matched_value, codigo, descricao, status, super_user)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`;
    const params = [
      body.fabricante || null,
      body.modelo,
      cleanSerial,
      cleanPon || null,
      cleanMac,
      body.usuario || null,
      body.dataHora ? new Date(body.dataHora) : new Date(),
      body.noPreAlerta || false,
      body.matchedValue || null,
      body.codigo || null,
      body.descricao || null,
      finalStatus,
      superUserStatus
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

    res.json({
      ok: true,
      super_user: superUserStatus,
      Super_User: superUserStatus,
      destinoMsg,
      destinoTipo
    });
  } catch (err) {
    console.error('Error saving recebimento:', err);
    res.status(500).json({ error: 'DB error' });
  }
});

// Convert an already-received unit to Sucata status (ADMIN ONLY)
app.post('/api/recebimentos/converter-sucata', async (req, res) => {
  const { id, serial, pon, mac, usuario } = req.body || {};
  const uName = String(usuario || '').trim().toUpperCase();

  if (!uName) {
    return res.status(401).json({ ok: false, code: 'NAO_AUTENTICADO', error: 'Usuário não identificado.' });
  }

  try {
    const userRes = await pool.query(
      'SELECT level FROM usuarios WHERE UPPER(TRIM(username)) = $1',
      [uName]
    );
    const isAdmin = (userRes.rows.length > 0 && userRes.rows[0].level === 'admin') || uName === 'RODRIGO.BARRETO';

    if (!isAdmin) {
      return res.status(403).json({
        ok: false,
        code: 'APENAS_ADMIN',
        error: 'Apenas Administradores podem converter uma unidade já recebida para o status Sucata.'
      });
    }

    const cleanS = sanitizeDataCode(String(serial || ''));
    const cleanP = sanitizeDataCode(String(pon || ''));
    const cleanM = sanitizeDataCode(String(mac || ''));

    let targetRes;
    if (id) {
      targetRes = await pool.query('SELECT * FROM recebimentos WHERE id = $1', [id]);
    }
    if (!targetRes || targetRes.rows.length === 0) {
      targetRes = await pool.query(
        `SELECT * FROM recebimentos 
         WHERE (serial_number IS NOT NULL AND serial_number = $1)
            OR (gpon_id IS NOT NULL AND gpon_id = $2)
            OR (mac IS NOT NULL AND mac = $3)
         ORDER BY data_hora DESC, id DESC
         LIMIT 1`,
        [cleanS || null, cleanP || null, cleanM || null]
      );
    }

    if (!targetRes || targetRes.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Unidade não encontrada na base de recebimentos.' });
    }

    const targetUnit = targetRes.rows[0];
    if (String(targetUnit.status || '').trim().toUpperCase() === 'SUCATA') {
      return res.status(400).json({ ok: false, code: 'JA_SUCATA', error: 'Esta unidade já possui o status Sucata.' });
    }

    const updateRes = await pool.query(
      `UPDATE recebimentos
       SET status = 'Sucata',
           usuario = COALESCE($2, usuario),
           data_hora = NOW()
       WHERE id = $1
       RETURNING *`,
      [targetUnit.id, uName]
    );

    const updatedUnit = updateRes.rows[0];

    // Se a unidade estava em algum pallet aberto, remove do pallet e recalcula total
    const identifiers = [updatedUnit.serial_number, updatedUnit.gpon_id, updatedUnit.mac].filter(Boolean);
    if (identifiers.length > 0) {
      const palletItems = await pool.query(
        `DELETE FROM pallet_pintura_itens
         WHERE (serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = ANY($1))
            OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = ANY($1))
            OR (mac IS NOT NULL AND mac != '' AND UPPER(TRIM(mac)) = ANY($1))
         RETURNING codigo_pallet`,
        [identifiers]
      );
      for (const row of palletItems.rows) {
        await pool.query(
          `UPDATE pallets_pintura
           SET total_unidades = (SELECT COUNT(*)::int FROM pallet_pintura_itens WHERE UPPER(codigo_pallet) = UPPER($1))
           WHERE UPPER(codigo_pallet) = UPPER($1)`,
          [row.codigo_pallet]
        );
      }
    }

    res.json({
      ok: true,
      converted: true,
      unit: updatedUnit
    });
  } catch (err) {
    console.error('Error converting unit to Sucata:', err);
    res.status(500).json({ ok: false, error: 'Erro no banco de dados ao converter unidade para Sucata.' });
  }
});

// Summary of Sucata units (stats for today + recent Sucata units)
app.get('/api/recebimentos/sucata/summary', async (req, res) => {
  try {
    const statsRes = await pool.query(`
      SELECT
        COUNT(CASE WHEN data_hora >= CURRENT_DATE AND no_pre_alerta = true THEN 1 END)::int AS pre_alerta_hoje,
        COUNT(CASE WHEN data_hora >= CURRENT_DATE AND no_pre_alerta = false THEN 1 END)::int AS fora_hoje,
        COUNT(CASE WHEN data_hora >= CURRENT_DATE THEN 1 END)::int AS total_hoje,
        COUNT(*)::int AS total_geral
      FROM recebimentos
      WHERE UPPER(TRIM(status)) = 'SUCATA'
    `);
    const recentRes = await pool.query(`
      SELECT *
      FROM recebimentos
      WHERE UPPER(TRIM(status)) = 'SUCATA'
      ORDER BY data_hora DESC, id DESC
      LIMIT 10
    `);
    res.json({
      stats: statsRes.rows[0] || { pre_alerta_hoje: 0, fora_hoje: 0, total_hoje: 0, total_geral: 0 },
      recent: recentRes.rows
    });
  } catch (err) {
    console.error('Error fetching sucata summary:', err);
    res.status(500).json({ error: 'Failed to fetch sucata summary.' });
  }
});

// Fetch recebimentos report data from Postgres
app.get('/api/recebimentos/report', async (req, res) => {
  const { start, end, noPreAlerta, modelo, status } = req.query;
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
    if (status) {
      query += ` AND UPPER(TRIM(status)) = UPPER(TRIM($${paramIndex}))`;
      params.push(status);
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

// Lookup unit by GPON in second DB (etiquetas_scan_onu) for autocomplete
app.get('/api/etiquetas/lookup', async (req, res) => {
  if (!secondPool) {
    return res.status(400).json({ error: 'Second database connection is not configured.' });
  }

  const { gpon } = req.query;
  if (!gpon) {
    return res.status(400).json({ error: 'Missing gpon parameter.' });
  }

  const cleanPon = sanitizeDataCode(String(gpon));
  try {
    const query = `
      SELECT gpon_sn, cpe_sn, mac, fabricante, modelo, password_router
      FROM etiquetas_scan_onu
      WHERE UPPER(TRIM(gpon_sn)) = UPPER(TRIM($1)) OR UPPER(TRIM(cpe_sn)) = UPPER(TRIM($1))
      ORDER BY (CASE WHEN cpe_sn IS NOT NULL AND cpe_sn != '' AND UPPER(cpe_sn) != 'N/A' THEN 1 ELSE 0 END) DESC,
               (CASE WHEN mac IS NOT NULL AND mac != '' AND UPPER(mac) != 'N/A' THEN 1 ELSE 0 END) DESC
      LIMIT 1
    `;
    const result = await secondPool.query(query, [cleanPon]);
    if (result.rows.length > 0) {
      const row = result.rows[0];
      const cleanSerial = (row.cpe_sn && row.cpe_sn.trim().toUpperCase() !== 'N/A') ? row.cpe_sn.trim() : null;
      const cleanMac = (row.mac && row.mac.trim().toUpperCase() !== 'N/A') ? row.mac.trim() : null;
      return res.json({
        found: true,
        data: {
          gpon_sn: row.gpon_sn ? row.gpon_sn.trim() : cleanPon,
          cpe_sn: cleanSerial,
          mac: cleanMac,
          fabricante: row.fabricante,
          modelo: row.modelo,
          has_password: hasValidPassword(row.password_router)
        }
      });
    }
    res.json({ found: false });
  } catch (err) {
    console.error('Error looking up etiquetas_scan_onu:', err);
    res.status(500).json({ error: 'Database query error.' });
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

// Helper functions for batch operations in F6600P synchronization

async function updateBatchRecebimentos(items, clientOrPool) {
  if (!items || items.length === 0) return 0;
  let totalUpdated = 0;
  const chunkSize = 200;
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const valueClauses = [];
    const params = [];
    let pIdx = 1;
    for (const item of chunk) {
      valueClauses.push(`($${pIdx}::int, $${pIdx+1}::text, $${pIdx+2}::text, $${pIdx+3}::text, $${pIdx+4}::text)`);
      params.push(
        item.id,
        item.serial_number || null,
        item.gpon_id || null,
        item.mac || null,
        item.super_user
      );
      pIdx += 5;
    }
    const query = `
      UPDATE recebimentos AS r
      SET 
        serial_number = COALESCE(v.serial_number, r.serial_number),
        gpon_id = COALESCE(v.gpon_id, r.gpon_id),
        mac = COALESCE(v.mac, r.mac),
        super_user = v.super_user
      FROM (VALUES ${valueClauses.join(', ')}) AS v(id, serial_number, gpon_id, mac, super_user)
      WHERE r.id = v.id
    `;
    const res = await clientOrPool.query(query, params);
    totalUpdated += (res.rowCount || 0);
  }
  return totalUpdated;
}

async function updateBatchEtiquetas(items, clientOrPool) {
  if (!items || items.length === 0) return 0;
  let totalUpdated = 0;
  const chunkSize = 200;
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const valueClauses = [];
    const params = [];
    let pIdx = 1;
    for (const item of chunk) {
      valueClauses.push(`($${pIdx}::varchar, $${pIdx+1}::varchar, $${pIdx+2}::varchar)`);
      params.push(item.gpon_sn, item.cpe_sn || null, item.mac || null);
      pIdx += 3;
    }
    const query = `
      UPDATE etiquetas_scan_onu AS e
      SET 
        cpe_sn = COALESCE(v.cpe_sn, e.cpe_sn),
        mac = COALESCE(v.mac, e.mac)
      FROM (VALUES ${valueClauses.join(', ')}) AS v(gpon_sn, cpe_sn, mac)
      WHERE UPPER(TRIM(e.gpon_sn)) = UPPER(TRIM(v.gpon_sn))
    `;
    const res = await clientOrPool.query(query, params);
    totalUpdated += (res.rowCount || 0);
  }
  return totalUpdated;
}

// Retroactive sync and completion endpoint for ZTE F6600P and NP7287
async function handleSyncUnits(req, res, forcedModelo) {
  if (!secondPool) {
    return res.status(400).json({ error: 'Second database connection is not configured.' });
  }

  const { limit, last_id, modelo } = req.query;
  const limitNum = limit ? parseInt(limit, 10) : null;
  const lastIdNum = last_id ? parseInt(last_id, 10) : 0;
  const targetModelo = forcedModelo || (
    modelo && (modelo.toUpperCase().includes('HG8145') || modelo.toUpperCase().includes('8145X6')) ? 'HG8145X6-10' :
    modelo && modelo.toUpperCase().includes('NP7287') ? 'NP7287' : 'F6600P'
  );

  try {
    // 1. Get units in recebimentos
    let selectQuery = `
      SELECT id, modelo, fabricante, serial_number, gpon_id, mac, usuario, super_user, no_pre_alerta
      FROM recebimentos
      WHERE UPPER(modelo) LIKE $1
        AND id > $2
      ORDER BY id ASC
    `;
    const modelLikePattern = targetModelo.toUpperCase().includes('HG8145') ? '%8145%' : `%${targetModelo}%`;
    const queryParams = [modelLikePattern, lastIdNum];
    if (limitNum) {
      selectQuery += ` LIMIT $3`;
      queryParams.push(limitNum);
    }

    const { rows } = await pool.query(selectQuery, queryParams);
    if (rows.length === 0) {
      return res.json({
        success: true,
        message: `Nenhuma unidade ${targetModelo} restante para sincronizar.`,
        totalProcessed: 0,
        lastId: lastIdNum,
        simCount: 0,
        naoCount: 0,
        totalUpdatedMainDb: 0,
        completedSerialsCount: 0,
        completedMacsCount: 0,
        totalInsertedSecondDb: 0
      });
    }

    // 2. Collect all GPON identifiers
    const gponSet = new Set();
    for (const r of rows) {
      const gponVal = r.gpon_id ? r.gpon_id.trim().toUpperCase() : '';
      if (gponVal) {
        gponSet.add(gponVal);
        if (gponVal.startsWith('HWTC')) {
          gponSet.add('48575443' + gponVal.slice(4));
        } else if (gponVal.startsWith('48575443')) {
          gponSet.add('HWTC' + gponVal.slice(8));
        }
      } else if (r.serial_number) {
        const serVal = r.serial_number.trim().toUpperCase();
        if (serVal.startsWith('ZTE3') || serVal.startsWith('ZTEG') || serVal.startsWith('TLCT') || serVal.startsWith('HWTC') || serVal.startsWith('48575443')) {
          gponSet.add(serVal);
          if (serVal.startsWith('HWTC')) {
            gponSet.add('48575443' + serVal.slice(4));
          } else if (serVal.startsWith('48575443')) {
            gponSet.add('HWTC' + serVal.slice(8));
          }
        }
      }
    }

    const gponArray = Array.from(gponSet);
    const etiquetasMap = new Map();

    const chunkSize = 500;
    for (let i = 0; i < gponArray.length; i += chunkSize) {
      const chunk = gponArray.slice(i, i + chunkSize);
      const secondCheckQuery = `
        SELECT UPPER(TRIM(gpon_sn)) AS gpon_sn, cpe_sn, mac, fabricante, modelo, password_router
        FROM etiquetas_scan_onu
        WHERE UPPER(TRIM(gpon_sn)) = ANY($1)
      `;
      const chunkRes = await secondPool.query(secondCheckQuery, [chunk]);
      chunkRes.rows.forEach(r => {
        etiquetasMap.set(r.gpon_sn, {
          cpe_sn: r.cpe_sn ? r.cpe_sn.trim() : null,
          mac: r.mac ? r.mac.trim() : null,
          fabricante: r.fabricante,
          modelo: r.modelo,
          password_router: r.password_router ? r.password_router.trim() : null
        });
      });
    }

    // 3. Process units and prepare updates
    let simCount = 0;
    let naoCount = 0;
    let completedSerialsCount = 0;
    let completedMacsCount = 0;
    let completedGponsCount = 0;
    const unitsToUpdateMainDb = [];
    const toUpdateSecondDb = [];
    const sampleResults = [];

    for (const r of rows) {
      let cleanPon = r.gpon_id ? r.gpon_id.trim().toUpperCase() : '';
      let cleanSerial = r.serial_number ? r.serial_number.trim().toUpperCase() : '';
      let cleanMac = r.mac ? r.mac.trim().toUpperCase() : '';

      // If gpon_id was empty but serial contains the GPON
      if (!cleanPon && cleanSerial && (cleanSerial.startsWith('ZTE3') || cleanSerial.startsWith('ZTEG') || cleanSerial.startsWith('TLCT') || cleanSerial.startsWith('HWTC') || cleanSerial.startsWith('48575443'))) {
        cleanPon = cleanSerial;
      }

      let etiqueta = cleanPon ? etiquetasMap.get(cleanPon) : null;
      if (!etiqueta && cleanPon) {
        if (cleanPon.startsWith('HWTC')) {
          etiqueta = etiquetasMap.get('48575443' + cleanPon.slice(4));
        } else if (cleanPon.startsWith('48575443')) {
          etiqueta = etiquetasMap.get('HWTC' + cleanPon.slice(8));
        }
      }
      const hasPassword = etiqueta && hasValidPassword(etiqueta.password_router);
      const newSuperUser = hasPassword ? 'Sim' : 'Não';

      if (hasPassword) {
        simCount++;
      } else {
        naoCount++;
      }

      let needsMainUpdate = false;
      let newSerial = cleanSerial;
      let newPon = cleanPon;
      let newMac = cleanMac;

      if (etiqueta) {
        // Complete serial if missing or N/A
        if ((!newSerial || newSerial === '' || newSerial === 'N/A') && etiqueta.cpe_sn) {
          newSerial = sanitizeDataCode(etiqueta.cpe_sn);
          completedSerialsCount++;
          needsMainUpdate = true;
        }

        // Complete mac if missing or N/A
        if ((!newMac || newMac === '' || newMac === 'N/A') && etiqueta.mac) {
          newMac = sanitizeDataCode(etiqueta.mac);
          completedMacsCount++;
          needsMainUpdate = true;
        }

        // If gpon_id in recebimentos was empty
        if ((!r.gpon_id || r.gpon_id.trim() === '') && cleanPon) {
          newPon = cleanPon;
          completedGponsCount++;
          needsMainUpdate = true;
        }

        // Atualiza cpe_sn e mac no segundo banco com o que foi bipado no recebimento
        if (newSerial || newMac) {
          toUpdateSecondDb.push({
            gpon_sn: cleanPon,
            cpe_sn: newSerial || null,
            mac: newMac || null
          });
        }
      }

      if (r.super_user !== newSuperUser) {
        needsMainUpdate = true;
      }

      if (needsMainUpdate) {
        unitsToUpdateMainDb.push({
          id: r.id,
          serial_number: newSerial || null,
          gpon_id: newPon || null,
          mac: newMac || null,
          super_user: newSuperUser
        });
      }

      if (sampleResults.length < 50) {
        sampleResults.push({
          id: r.id,
          serial: newSerial,
          gpon: cleanPon,
          mac: newMac,
          no_pre_alerta: r.no_pre_alerta,
          super_user: newSuperUser,
          encontrado_segundo_banco: !!etiqueta
        });
      }
    }

    // 4. Batch update recebimentos in main database
    const totalUpdatedMainDb = await updateBatchRecebimentos(unitsToUpdateMainDb, pool);

    // 5. Update missing fields in second DB if needed (only for units that exist in second DB)
    const totalUpdatedSecondDb = await updateBatchEtiquetas(toUpdateSecondDb, secondPool);

    const lastId = rows.length > 0 ? rows[rows.length - 1].id : lastIdNum;

    res.json({
      success: true,
      message: `Sincronização de unidades ${targetModelo} concluída com sucesso!`,
      totalProcessed: rows.length,
      lastId,
      simCount,
      naoCount,
      totalUpdatedMainDb,
      completedSerialsCount,
      completedMacsCount,
      completedGponsCount,
      totalUpdatedSecondDb,
      sampleResults
    });
  } catch (err) {
    console.error(`Error during ${targetModelo} sync:`, err);
    res.status(500).json({ error: `${targetModelo} sync database error.`, details: err.message });
  }
}

app.get('/api/admin/sync-f6600p', (req, res) => handleSyncUnits(req, res, req.query.modelo ? null : 'F6600P'));
app.get('/api/admin/sync-np7287', (req, res) => handleSyncUnits(req, res, 'NP7287'));
app.get('/api/admin/sync-hg8145', (req, res) => handleSyncUnits(req, res, 'HG8145X6-10'));

// Endpoint de análise, simulação e reversão do F6600P
app.get('/api/admin/revert-f6600p', async (req, res) => {
  if (!secondPool) {
    return res.status(400).json({ error: 'Second database connection is not configured.' });
  }

  const { apply, scenario } = req.query;
  const isApply = apply === 'true' || apply === '1';

  try {
    // 1. Busca todas as unidades F6600P no banco principal (recebimentos)
    const { rows: recebidos } = await pool.query(`
      SELECT id, serial_number, gpon_id, mac, no_pre_alerta, super_user, data_hora
      FROM recebimentos
      WHERE UPPER(modelo) LIKE '%F6600P%'
      ORDER BY id ASC
    `);

    // Coleta todos os GPONs
    const gponMap = new Map();
    for (const r of recebidos) {
      let gpon = r.gpon_id ? r.gpon_id.trim().toUpperCase() : '';
      if (!gpon && r.serial_number) {
        const s = r.serial_number.trim().toUpperCase();
        if (s.startsWith('ZTE3') || s.startsWith('ZTEG')) gpon = s;
      }
      if (gpon) gponMap.set(gpon, r);
    }
    const allGpons = Array.from(gponMap.keys());

    // 2. Busca todos os registros correspondentes no 2o banco (etiquetas_scan_onu)
    const chunkSize = 500;
    const etiquetas = [];
    for (let i = 0; i < allGpons.length; i += chunkSize) {
      const chunk = allGpons.slice(i, i + chunkSize);
      const chunkRes = await secondPool.query(`
        SELECT 
          UPPER(TRIM(gpon_sn)) AS gpon_sn,
          cpe_sn,
          mac,
          fabricante,
          modelo,
          usuario,
          password_router,
          web_key,
          wifi_key,
          data_leitura
        FROM etiquetas_scan_onu
        WHERE UPPER(TRIM(gpon_sn)) = ANY($1)
      `, [chunk]);
      etiquetas.push(...chunkRes.rows);
    }

    const etiquetasMap = new Map();
    etiquetas.forEach(e => etiquetasMap.set(e.gpon_sn, e));

    // 3. Simula os diferentes cenários para as unidades NO PRÉ-ALERTA (onde havia 1.972 Sim e 1.636 Não)
    const preUnits = recebidos.filter(r => r.no_pre_alerta === true);

    function testCriteria(fn) {
      let sim = 0;
      let nao = 0;
      const simIds = [];
      const naoIds = [];
      for (const r of preUnits) {
        let gpon = r.gpon_id ? r.gpon_id.trim().toUpperCase() : '';
        if (!gpon && r.serial_number) {
          const s = r.serial_number.trim().toUpperCase();
          if (s.startsWith('ZTE3') || s.startsWith('ZTEG')) gpon = s;
        }
        const e = gpon ? etiquetasMap.get(gpon) : null;
        if (e && fn(e, r)) {
          sim++;
          simIds.push(r.id);
        } else {
          nao++;
          naoIds.push(r.id);
        }
      }
      return {
        total: preUnits.length,
        sim,
        nao,
        percentualSim: `${((sim / preUnits.length) * 100).toFixed(1)}%`,
        percentualNao: `${((nao / preUnits.length) * 100).toFixed(1)}%`,
        simIds,
        naoIds
      };
    }

    // Cenário 1: Presença em etiquetas antes do dia 23/09 (ex: data_leitura < '2026-09-23T00:00:00.000Z')
    const cenario_data_antiga = testCriteria(e => {
      if (!e.data_leitura) return false;
      const dt = new Date(e.data_leitura);
      return dt < new Date('2026-09-23T00:00:00.000Z');
    });

    // Cenário 2: Presença em etiquetas antes das 12:00 do dia 23/09 (antes da carga de 173 mil)
    const cenario_data_23_manha = testCriteria(e => {
      if (!e.data_leitura) return false;
      const dt = new Date(e.data_leitura);
      return dt < new Date('2026-09-23T12:00:00.000Z');
    });

    // Cenário 3: Tem senha real no password_router (diferente de NULL, vazio e diferente de 'N/A')
    const cenario_senha_real = testCriteria(e => {
      const pwd = e.password_router ? e.password_router.trim() : '';
      return pwd !== '' && pwd.toUpperCase() !== 'N/A';
    });

    // Cenário 4: Tem web_key ou wifi_key real
    const cenario_web_ou_wifi = testCriteria(e => {
      const w = e.web_key ? e.web_key.trim() : '';
      const wf = e.wifi_key ? e.wifi_key.trim() : '';
      return (w !== '' && w.toUpperCase() !== 'N/A') || (wf !== '' && wf.toUpperCase() !== 'N/A');
    });

    // Cenário 5: Tem cpe_sn e mac preenchidos e não N/A originalmente
    const cenario_sn_e_mac_validos = testCriteria(e => {
      const s = e.cpe_sn ? e.cpe_sn.trim() : '';
      const m = e.mac ? e.mac.trim() : '';
      return s !== '' && s.toUpperCase() !== 'N/A' && m !== '' && m.toUpperCase() !== 'N/A';
    });

    // Cenário Atual: Qualquer existência no 2o banco (que deu 100%)
    const cenario_qualquer_existencia = testCriteria(e => !!e);

    // Se apply=true, aplica o cenário escolhido (ou o que mais se aproxima de 1.972 / 1.636)
    let appliedScenario = null;
    let totalUpdatedMainDb = 0;

    if (isApply) {
      let chosen = null;
      if (scenario === 'data_antiga') {
        chosen = cenario_data_antiga;
        appliedScenario = 'data_antiga (antes de 23/09)';
      } else if (scenario === 'data_23_manha') {
        chosen = cenario_data_23_manha;
        appliedScenario = 'data_23_manha (antes de 23/09 12h)';
      } else if (scenario === 'senha_real') {
        chosen = cenario_senha_real;
        appliedScenario = 'senha_real (password_router != N/A)';
      } else {
        // Encontra automaticamente qual cenário deu o número mais próximo de 1.972
        const scenarios = [
          { name: 'data_antiga', data: cenario_data_antiga },
          { name: 'data_23_manha', data: cenario_data_23_manha },
          { name: 'senha_real', data: cenario_senha_real },
          { name: 'web_ou_wifi', data: cenario_web_ou_wifi },
          { name: 'sn_e_mac_validos', data: cenario_sn_e_mac_validos }
        ];
        scenarios.sort((a, b) => Math.abs(a.data.sim - 1972) - Math.abs(b.data.sim - 1972));
        chosen = scenarios[0].data;
        appliedScenario = scenarios[0].name;
      }

      if (chosen.simIds.length > 0) {
        const resSim = await pool.query(`UPDATE recebimentos SET super_user = 'Sim' WHERE id = ANY($1)`, [chosen.simIds]);
        totalUpdatedMainDb += (resSim.rowCount || 0);
      }
      if (chosen.naoIds.length > 0) {
        const resNao = await pool.query(`UPDATE recebimentos SET super_user = 'Não' WHERE id = ANY($1)`, [chosen.naoIds]);
        totalUpdatedMainDb += (resNao.rowCount || 0);
      }
    }

    res.json({
      success: true,
      meta_esperada: {
        total: '~3618',
        sim_esperado: 1972,
        nao_esperado: 1636,
        percentualSimEsperado: '54.6%',
        percentualNaoEsperado: '45.4%'
      },
      simulacao_cenarios_pre_alerta: {
        cenario_1_data_antes_23_set: {
          descricao: 'Registros com data de leitura antes de 23/09',
          resultado: { total: cenario_data_antiga.total, sim: cenario_data_antiga.sim, nao: cenario_data_antiga.nao, percentualSim: cenario_data_antiga.percentualSim, percentualNao: cenario_data_antiga.percentualNao }
        },
        cenario_2_data_antes_23_set_12h: {
          descricao: 'Registros com data de leitura antes de 23/09 12:00 (antes da carga da tarde)',
          resultado: { total: cenario_data_23_manha.total, sim: cenario_data_23_manha.sim, nao: cenario_data_23_manha.nao, percentualSim: cenario_data_23_manha.percentualSim, percentualNao: cenario_data_23_manha.percentualNao }
        },
        cenario_3_senha_router_real: {
          descricao: 'password_router preenchido com senha real (diferente de N/A ou vazio)',
          resultado: { total: cenario_senha_real.total, sim: cenario_senha_real.sim, nao: cenario_senha_real.nao, percentualSim: cenario_senha_real.percentualSim, percentualNao: cenario_senha_real.percentualNao }
        },
        cenario_4_web_ou_wifi_real: {
          descricao: 'web_key ou wifi_key preenchido com senha real (diferente de N/A ou vazio)',
          resultado: { total: cenario_web_ou_wifi.total, sim: cenario_web_ou_wifi.sim, nao: cenario_web_ou_wifi.nao, percentualSim: cenario_web_ou_wifi.percentualSim, percentualNao: cenario_web_ou_wifi.percentualNao }
        },
        cenario_5_qualquer_existencia_segundo_banco: {
          descricao: 'Qualquer registro existente no 2o banco (cenário que deu 100%)',
          resultado: { total: cenario_qualquer_existencia.total, sim: cenario_qualquer_existencia.sim, nao: cenario_qualquer_existencia.nao, percentualSim: cenario_qualquer_existencia.percentualSim, percentualNao: cenario_qualquer_existencia.percentualNao }
        }
      },
      status_execucao: isApply
        ? `APLICADO com sucesso! Cenário: ${appliedScenario}. Total atualizados: ${totalUpdatedMainDb}`
        : 'MODO SIMULAÇÃO (nenhum dado foi alterado no banco principal). Para aplicar a reversão do cenário ideal, chame com ?apply=true'
    });
  } catch (err) {
    console.error('Error during revert-f6600p simulation:', err);
    res.status(500).json({ error: 'Revert simulation error', details: err.message });
  }
});

// Detailed debug diagnostic for F6600P
app.get('/api/admin/debug-f6600p', async (req, res) => {
  if (!secondPool) {
    return res.status(400).json({ error: 'Second database connection is not configured.' });
  }

  try {
    // 1. Unidades F6600P no recebimentos
    const recebidosRes = await pool.query(`
      SELECT id, serial_number, gpon_id, mac, no_pre_alerta, super_user, data_hora
      FROM recebimentos
      WHERE UPPER(modelo) LIKE '%F6600P%'
      ORDER BY id ASC
    `);
    const recebidos = recebidosRes.rows;

    const gponsPre = [];
    const gponsFora = [];
    const gponToRecMap = new Map();

    for (const r of recebidos) {
      let gpon = r.gpon_id ? r.gpon_id.trim().toUpperCase() : '';
      if (!gpon && r.serial_number) {
        const s = r.serial_number.trim().toUpperCase();
        if (s.startsWith('ZTE3') || s.startsWith('ZTEG')) gpon = s;
      }
      if (gpon) {
        gponToRecMap.set(gpon, r);
        if (r.no_pre_alerta) gponsPre.push(gpon);
        else gponsFora.push(gpon);
      }
    }

    // 2. Busca todas as correspondências no segundo banco em lotes de 500
    const allGpons = Array.from(gponToRecMap.keys());
    const chunkSize = 500;
    const etiquetasEncontradas = [];

    for (let i = 0; i < allGpons.length; i += chunkSize) {
      const chunk = allGpons.slice(i, i + chunkSize);
      const chkRes = await secondPool.query(`
        SELECT 
          UPPER(TRIM(gpon_sn)) AS gpon_sn,
          cpe_sn,
          mac,
          fabricante,
          modelo,
          usuario,
          password_router,
          web_key,
          wifi_key,
          data_leitura
        FROM etiquetas_scan_onu
        WHERE UPPER(TRIM(gpon_sn)) = ANY($1)
      `, [chunk]);
      etiquetasEncontradas.push(...chkRes.rows);
    }

    const etiquetaMap = new Map();
    etiquetasEncontradas.forEach(e => etiquetaMap.set(e.gpon_sn, e));

    // 3. Análise detalhada dos dados das unidades NO PRÉ-ALERTA
    let preTotal = gponsPre.length;
    let preEncontrados = 0;
    let preNaoEncontrados = 0;

    let preComWebKeyReal = 0;
    let preComPasswordRouterReal = 0;
    let preComWifiKeyReal = 0;
    let preComCpeSnReal = 0;
    let preComMacReal = 0;

    const prePorDataLeitura = {};
    const prePorUsuario = {};
    const prePorModelo = {};

    const amostraPreComValores = [];
    const amostraPreSemValores = [];

    for (const gpon of gponsPre) {
      const e = etiquetaMap.get(gpon);
      if (e) {
        preEncontrados++;
        const dt = e.data_leitura ? new Date(e.data_leitura).toISOString().split('T')[0] : 'SEM_DATA';
        prePorDataLeitura[dt] = (prePorDataLeitura[dt] || 0) + 1;

        const usr = e.usuario || 'NULL';
        prePorUsuario[usr] = (prePorUsuario[usr] || 0) + 1;

        const mod = e.modelo || 'NULL';
        prePorModelo[mod] = (prePorModelo[mod] || 0) + 1;

        const hasWebKey = e.web_key && e.web_key.trim() !== '' && e.web_key.trim().toUpperCase() !== 'N/A';
        const hasPwd = e.password_router && e.password_router.trim() !== '' && e.password_router.trim().toUpperCase() !== 'N/A';
        const hasWifi = e.wifi_key && e.wifi_key.trim() !== '' && e.wifi_key.trim().toUpperCase() !== 'N/A';
        const hasCpe = e.cpe_sn && e.cpe_sn.trim() !== '' && e.cpe_sn.trim().toUpperCase() !== 'N/A';
        const hasMac = e.mac && e.mac.trim() !== '' && e.mac.trim().toUpperCase() !== 'N/A';

        if (hasWebKey) preComWebKeyReal++;
        if (hasPwd) preComPasswordRouterReal++;
        if (hasWifi) preComWifiKeyReal++;
        if (hasCpe) preComCpeSnReal++;
        if (hasMac) preComMacReal++;

        if (hasWebKey || hasPwd || hasWifi) {
          if (amostraPreComValores.length < 5) {
            amostraPreComValores.push({ gpon, web_key: e.web_key, password_router: e.password_router, wifi_key: e.wifi_key, cpe_sn: e.cpe_sn, mac: e.mac, data: e.data_leitura, usuario: e.usuario });
          }
        } else {
          if (amostraPreSemValores.length < 5) {
            amostraPreSemValores.push({ gpon, web_key: e.web_key, password_router: e.password_router, wifi_key: e.wifi_key, cpe_sn: e.cpe_sn, mac: e.mac, data: e.data_leitura, usuario: e.usuario });
          }
        }
      } else {
        preNaoEncontrados++;
      }
    }

    // 4. Análise de recebimentos por data de bipagem
    const recPorDataBipagem = {};
    for (const r of recebidos) {
      const dt = r.data_hora ? new Date(r.data_hora).toISOString().split('T')[0] : 'SEM_DATA';
      recPorDataBipagem[dt] = (recPorDataBipagem[dt] || 0) + 1;
    }

    res.json({
      success: true,
      recebimentos_por_data_bipagem: recPorDataBipagem,
      pre_alerta_f6600p: {
        total: preTotal,
        encontradosNoSegundoBanco: preEncontrados,
        naoEncontradosNoSegundoBanco: preNaoEncontrados,
        etiquetas_por_data_leitura: prePorDataLeitura,
        etiquetas_por_usuario: prePorUsuario,
        etiquetas_por_modelo: prePorModelo,
        campos_reais: {
          com_web_key_real: preComWebKeyReal,
          com_password_router_real: preComPasswordRouterReal,
          com_wifi_key_real: preComWifiKeyReal,
          com_cpe_sn_real: preComCpeSnReal,
          com_mac_real: preComMacReal
        },
        amostra_com_senhas: amostraPreComValores,
        amostra_sem_senhas: amostraPreSemValores
      },
      fora_pre_alerta_f6600p: {
        total: gponsFora.length,
        encontradosNoSegundoBanco: gponsFora.filter(g => etiquetaMap.has(g)).length
      }
    });
  } catch (err) {
    console.error('Debug error:', err);
    res.status(500).json({ error: 'Debug error', details: err.message });
  }
});

// Detailed audit endpoint for F6600P comparing recebimentos and etiquetas_scan_onu
app.get('/api/admin/audit-f6600p', async (req, res) => {
  if (!secondPool) {
    return res.status(400).json({ error: 'Second database connection is not configured.' });
  }

  try {
    const { rows: recebidos } = await pool.query(`
      SELECT id, serial_number, gpon_id, mac, modelo, super_user
      FROM recebimentos
      WHERE UPPER(modelo) LIKE '%F6600P%'
      ORDER BY id ASC
    `);

    const gponSet = new Set(recebidos.map(r => (r.gpon_id ? r.gpon_id.trim().toUpperCase() : '')).filter(Boolean));
    const gponArray = Array.from(gponSet);
    const etiquetasMap = new Map();

    const chunkSize = 500;
    for (let i = 0; i < gponArray.length; i += chunkSize) {
      const chunk = gponArray.slice(i, i + chunkSize);
      const chunkRes = await secondPool.query(`
        SELECT UPPER(TRIM(gpon_sn)) AS gpon_sn, cpe_sn, mac, fabricante, modelo
        FROM etiquetas_scan_onu
        WHERE UPPER(TRIM(gpon_sn)) = ANY($1)
      `, [chunk]);
      chunkRes.rows.forEach(r => {
        etiquetasMap.set(r.gpon_sn, {
          cpe_sn: r.cpe_sn ? r.cpe_sn.trim() : null,
          mac: r.mac ? r.mac.trim() : null,
          fabricante: r.fabricante,
          modelo: r.modelo
        });
      });
    }

    let totalRecebidos = recebidos.length;
    let encontradosSegundoBanco = 0;
    let naoEncontrados = 0;
    let serialBate = 0;
    let serialDiferente = 0;
    let serialVazioRecebimento = 0;
    let serialVazioSegundoBanco = 0;
    let macBate = 0;
    let macDiferente = 0;
    let macVazioRecebimento = 0;
    let macVazioSegundoBanco = 0;

    const amostraCorrespondencias = [];

    for (const r of recebidos) {
      const cleanPon = r.gpon_id ? r.gpon_id.trim().toUpperCase() : '';
      const rSerial = r.serial_number ? r.serial_number.trim().toUpperCase() : '';
      const rMac = r.mac ? r.mac.trim().toUpperCase() : '';

      if (!rSerial) serialVazioRecebimento++;
      if (!rMac) macVazioRecebimento++;

      const etiqueta = cleanPon ? etiquetasMap.get(cleanPon) : null;
      if (etiqueta) {
        encontradosSegundoBanco++;
        const eSerial = etiqueta.cpe_sn ? etiqueta.cpe_sn.trim().toUpperCase() : '';
        const eMac = etiqueta.mac ? etiqueta.mac.trim().toUpperCase() : '';

        if (!eSerial || eSerial === 'N/A') serialVazioSegundoBanco++;
        if (!eMac || eMac === 'N/A') macVazioSegundoBanco++;

        if (rSerial && eSerial && rSerial === eSerial) serialBate++;
        else if (rSerial && eSerial && rSerial !== eSerial) serialDiferente++;

        if (rMac && eMac && rMac === eMac) macBate++;
        else if (rMac && eMac && rMac !== eMac) macDiferente++;

        if (amostraCorrespondencias.length < 10) {
          amostraCorrespondencias.push({
            gpon: cleanPon,
            recebimentos: { serial: rSerial, mac: rMac, super_user: r.super_user },
            segundo_banco_etiquetas: { cpe_sn: eSerial, mac: eMac }
          });
        }
      } else {
        naoEncontrados++;
      }
    }

    return res.json({
      success: true,
      totalRecebidos,
      encontradosSegundoBanco,
      naoEncontrados,
      seriais: {
        iguaisEmAmbos: serialBate,
        diferentes: serialDiferente,
        vazioEmRecebimentos: serialVazioRecebimento,
        vazioEmSegundoBanco: serialVazioSegundoBanco
      },
      macs: {
        iguaisEmAmbos: macBate,
        diferentes: macDiferente,
        vazioEmRecebimentos: macVazioRecebimento,
        vazioEmSegundoBanco: macVazioSegundoBanco
      },
      amostra: amostraCorrespondencias
    });
  } catch (err) {
    console.error('Error auditing F6600P:', err);
    res.status(500).json({ error: 'Audit error', details: err.message });
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
      `SELECT id, fabricante, modelo, serial_number, gpon_id, mac, usuario, data_hora, no_pre_alerta, matched_value, codigo, descricao, super_user
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
  { name: "HG8145X6-10", fields: 3, rules: { serial: "2102315", pon: "HWTC, 48575443" } },
  { name: "NP7287", fields: 3, rules: { serial: "T25", pon: "TLCTA, TLCT" } }
];

// App Version Check for Auto-Update
app.get('/api/version', (req, res) => {
  res.json({ version: 'v1.6.0' });
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
      if (!name || /[^A-Za-z0-9\s-]/.test(name)) {
        return res.status(400).json({ error: 'Nome do modelo contém caracteres especiais inválidos.' });
      }
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
      "SELECT * FROM pallets_pintura WHERE status = 'ABERTO' AND (tipo IS NULL OR tipo = 'NORMAL') ORDER BY data_criacao DESC LIMIT 1"
    );
    if (palletRes.rows.length === 0) {
      const codigo = await generateNextPalletCode(pool);
      const newPallet = await pool.query(
        "INSERT INTO pallets_pintura(codigo_pallet, status, usuario_criacao, total_unidades, data_criacao, tipo) VALUES($1, 'ABERTO', 'SISTEMA', 0, NOW(), 'NORMAL') RETURNING *",
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
      "INSERT INTO pallets_pintura(codigo_pallet, status, usuario_criacao, total_unidades, data_criacao, tipo) VALUES($1, 'ABERTO', $2, 0, NOW(), 'NORMAL') RETURNING *",
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
    const palletRes = await pool.query("SELECT * FROM pallets_pintura WHERE UPPER(codigo_pallet) = $1 AND (tipo IS NULL OR tipo = 'NORMAL')", [codigo]);
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
    const result = await pool.query("SELECT * FROM pallets_pintura WHERE status = 'ABERTO' AND (tipo IS NULL OR tipo = 'NORMAL') ORDER BY data_criacao DESC");
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching open pallets:', err);
    res.status(500).json({ error: 'Database error fetching open pallets.' });
  }
});

// Scan/Add unit to pallet
app.post('/api/expedicao-pintura/bipar', async (req, res) => {
  try {
    const { codigo_pallet, serial, scan, pon, mac, usuario } = req.body;
    const targetScan = String(serial || scan || '').trim();
    if (!codigo_pallet || (!targetScan && !pon && !mac)) {
      return res.status(400).json({ error: 'Informe ao menos um campo da unidade (Serial, PON ou MAC).' });
    }

    if (hasSpecialChars(targetScan) || (pon && hasSpecialChars(pon)) || (mac && hasSpecialChars(mac))) {
      return res.status(400).json({ success: false, error: 'Caracteres especiais não são permitidos no código da unidade.' });
    }

    const cleanSerial = sanitizeDataCode(targetScan);
    const cleanPon = sanitizeDataCode(pon);
    const cleanMac = sanitizeDataCode(mac);
    const codPallet = sanitizeDataCode(codigo_pallet);

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
    if (cleanSerial && cleanSerial.length === 12 && /^[0-9A-F]{12}$/i.test(cleanSerial)) {
      searchTerms.push(cleanSerial.match(/.{1,2}/g).join(':'));
    }
    const recRes = await pool.query(`
      SELECT * FROM recebimentos 
      WHERE (serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = ANY($1))
         OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = ANY($1))
         OR (mac IS NOT NULL AND mac != '' AND (
              UPPER(TRIM(mac)) = ANY($1)
              OR UPPER(REPLACE(REPLACE(mac, ':', ''), '-', '')) = ANY($1)
            ))
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
    if (String(unitReceived.status || '').trim().toUpperCase() === 'SUCATA') {
      return res.status(400).json({
        success: false,
        code: 'UNIDADE_SUCATA',
        error: `A unidade "${unitReceived.serial_number || cleanSerial}" consta com status SUCATA e não pode ser adicionada ao pallet.`
      });
    }
    const unitSerial = unitReceived.serial_number || cleanSerial;
    const unitPon = unitReceived.gpon_id || cleanPon;
    const unitMac = unitReceived.mac || cleanMac;
    const unitModelo = unitReceived.modelo || 'NÃO INFORMADO';
    const unitFabricante = unitReceived.fabricante || 'NÃO INFORMADO';

    // 3. Check if unit is already in any pallet
    const unitIdentifiers = new Set();
    if (unitReceived.serial_number) unitIdentifiers.add(unitReceived.serial_number.trim().toUpperCase());
    if (unitReceived.gpon_id) unitIdentifiers.add(unitReceived.gpon_id.trim().toUpperCase());
    if (unitReceived.mac) {
      unitIdentifiers.add(unitReceived.mac.trim().toUpperCase());
      unitIdentifiers.add(unitReceived.mac.replace(/[^A-Za-z0-9]/g, '').toUpperCase());
    }
    if (cleanSerial) {
      unitIdentifiers.add(cleanSerial);
      if (cleanSerial.length === 12 && /^[0-9A-F]{12}$/i.test(cleanSerial)) {
        unitIdentifiers.add(cleanSerial.match(/.{1,2}/g).join(':'));
      }
    }
    const unitIdList = Array.from(unitIdentifiers).filter(Boolean);

    const checkItem = await pool.query(`
      SELECT * FROM pallet_pintura_itens
      WHERE (serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = ANY($1))
         OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = ANY($1))
         OR (mac IS NOT NULL AND mac != '' AND (
              UPPER(TRIM(mac)) = ANY($1)
              OR UPPER(REPLACE(REPLACE(mac, ':', ''), '-', '')) = ANY($1)
            ))
      LIMIT 1
    `, [unitIdList]);

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
      WHERE id = $1
         OR (serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = ANY($2))
         OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = ANY($2))
         OR (mac IS NOT NULL AND mac != '' AND (
              UPPER(TRIM(mac)) = ANY($2)
              OR UPPER(REPLACE(REPLACE(mac, ':', ''), '-', '')) = ANY($2)
            ))
    `, [unitReceived.id, unitIdList]);

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
    const result = await pool.query("SELECT * FROM pallets_pintura WHERE (tipo IS NULL OR tipo = 'NORMAL') ORDER BY id DESC");
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
      WHERE (p.tipo IS NULL OR p.tipo = 'NORMAL')
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
// Expedição Pintura - Garantia Routes
// ============================================================

async function generateNextPalletGarantiaCode(clientOrPool) {
  const res = await clientOrPool.query("SELECT nextval('seq_pallet_garantia') AS num");
  const num = parseInt(res.rows[0].num, 10);
  return 'PG' + String(num).padStart(8, '0');
}

// Get active open pallet for Garantia (or creates initial one)
app.get('/api/expedicao-garantia/active', async (req, res) => {
  try {
    const palletRes = await pool.query(
      "SELECT * FROM pallets_pintura WHERE status = 'ABERTO' AND tipo = 'GARANTIA' ORDER BY data_criacao DESC LIMIT 1"
    );
    if (palletRes.rows.length === 0) {
      const codigo = await generateNextPalletGarantiaCode(pool);
      const newPallet = await pool.query(
        "INSERT INTO pallets_pintura(codigo_pallet, status, usuario_criacao, total_unidades, data_criacao, tipo) VALUES($1, 'ABERTO', 'SISTEMA', 0, NOW(), 'GARANTIA') RETURNING *",
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
    console.error('Error fetching active garantia pallet:', err);
    res.status(500).json({ error: 'Database error fetching active garantia pallet.' });
  }
});

// Create new garantia pallet
app.post('/api/expedicao-garantia/novo-pallet', async (req, res) => {
  try {
    const { usuario } = req.body;
    const codigo = await generateNextPalletGarantiaCode(pool);
    const newPallet = await pool.query(
      "INSERT INTO pallets_pintura(codigo_pallet, status, usuario_criacao, total_unidades, data_criacao, tipo) VALUES($1, 'ABERTO', $2, 0, NOW(), 'GARANTIA') RETURNING *",
      [codigo, usuario || 'OPERADOR']
    );
    res.json({ success: true, pallet: newPallet.rows[0], items: [] });
  } catch (err) {
    console.error('Error creating new garantia pallet:', err);
    res.status(500).json({ error: 'Database error creating new garantia pallet.' });
  }
});

// Get specific garantia pallet
app.get('/api/expedicao-garantia/pallet/:codigo', async (req, res) => {
  try {
    const codigo = req.params.codigo.trim().toUpperCase();
    const palletRes = await pool.query("SELECT * FROM pallets_pintura WHERE UPPER(codigo_pallet) = $1 AND tipo = 'GARANTIA'", [codigo]);
    if (palletRes.rows.length === 0) return res.status(404).json({ error: 'Pallet de garantia não encontrado.' });
    const pallet = palletRes.rows[0];
    const itemsRes = await pool.query("SELECT * FROM pallet_pintura_itens WHERE UPPER(codigo_pallet) = $1 ORDER BY id DESC", [codigo]);
    res.json({ pallet, items: itemsRes.rows });
  } catch (err) {
    console.error('Error loading garantia pallet:', err);
    res.status(500).json({ error: 'Database error loading garantia pallet.' });
  }
});

// Get list of open garantia pallets
app.get('/api/expedicao-garantia/pallets-abertos', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM pallets_pintura WHERE status = 'ABERTO' AND tipo = 'GARANTIA' ORDER BY data_criacao DESC");
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching open garantia pallets:', err);
    res.status(500).json({ error: 'Database error fetching open garantia pallets.' });
  }
});

// Get all garantia pallets (open and closed)
app.get('/api/expedicao-garantia/pallets-todos', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM pallets_pintura WHERE tipo = 'GARANTIA' ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching all garantia pallets:', err);
    res.status(500).json({ error: 'Database error fetching garantia pallets.' });
  }
});

// Scan/Add unit to garantia pallet
app.post('/api/expedicao-garantia/bipar', async (req, res) => {
  try {
    const { codigo_pallet, serial, scan, pon, mac, usuario } = req.body;
    const targetScan = String(serial || scan || '').trim();
    if (!codigo_pallet || (!targetScan && !pon && !mac)) {
      return res.status(400).json({ error: 'Informe ao menos um campo da unidade (Serial, PON ou MAC).' });
    }

    if (hasSpecialChars(targetScan) || (pon && hasSpecialChars(pon)) || (mac && hasSpecialChars(mac))) {
      return res.status(400).json({ success: false, error: 'Caracteres especiais não são permitidos no código da unidade.' });
    }

    const cleanSerial = sanitizeDataCode(targetScan);
    const cleanPon = sanitizeDataCode(pon);
    const cleanMac = sanitizeDataCode(mac);
    const codPallet = sanitizeDataCode(codigo_pallet);

    // 1. Check if pallet exists, is GARANTIA and is ABERTO
    const palletRes = await pool.query("SELECT * FROM pallets_pintura WHERE UPPER(codigo_pallet) = $1 AND tipo = 'GARANTIA'", [codPallet]);
    if (palletRes.rows.length === 0) {
      return res.status(404).json({ error: 'Pallet de garantia não encontrado.' });
    }
    const pallet = palletRes.rows[0];
    if (pallet.status !== 'ABERTO') {
      return res.status(400).json({ error: 'Este pallet de garantia já está fechado.' });
    }

    // 2. Query recebimentos to check if unit exists
    const searchTerms = [cleanSerial, cleanPon, cleanMac].filter(Boolean);
    if (cleanSerial && cleanSerial.length === 12 && /^[0-9A-F]{12}$/i.test(cleanSerial)) {
      searchTerms.push(cleanSerial.match(/.{1,2}/g).join(':'));
    }
    const recRes = await pool.query(`
      SELECT * FROM recebimentos 
      WHERE (serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = ANY($1))
         OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = ANY($1))
         OR (mac IS NOT NULL AND mac != '' AND (
              UPPER(TRIM(mac)) = ANY($1)
              OR UPPER(REPLACE(REPLACE(mac, ':', ''), '-', '')) = ANY($1)
            ))
      ORDER BY id DESC LIMIT 1
    `, [searchTerms]);

    if (recRes.rows.length === 0) {
      return res.status(400).json({
        success: false,
        code: 'UNIDADE_NAO_RECEBIDA',
        error: 'Unidade não encontrada na base de recebimento'
      });
    }

    const unitReceived = recRes.rows[0];
    if (String(unitReceived.status || '').trim().toUpperCase() === 'SUCATA') {
      return res.status(400).json({
        success: false,
        code: 'UNIDADE_SUCATA',
        error: `A unidade "${unitReceived.serial_number || cleanSerial}" consta com status SUCATA e não pode ser adicionada ao pallet.`
      });
    }
    const unitSerial = unitReceived.serial_number || cleanSerial;
    const unitPon = unitReceived.gpon_id || cleanPon;
    const unitMac = unitReceived.mac || cleanMac;
    const unitModelo = unitReceived.modelo || 'NÃO INFORMADO';
    const unitFabricante = unitReceived.fabricante || 'NÃO INFORMADO';

    const unitIdentifiers = new Set();
    if (unitReceived.serial_number) unitIdentifiers.add(unitReceived.serial_number.trim().toUpperCase());
    if (unitReceived.gpon_id) unitIdentifiers.add(unitReceived.gpon_id.trim().toUpperCase());
    if (unitReceived.mac) {
      unitIdentifiers.add(unitReceived.mac.trim().toUpperCase());
      unitIdentifiers.add(unitReceived.mac.replace(/[^A-Za-z0-9]/g, '').toUpperCase());
    }
    if (cleanSerial) {
      unitIdentifiers.add(cleanSerial);
      if (cleanSerial.length === 12 && /^[0-9A-F]{12}$/i.test(cleanSerial)) {
        unitIdentifiers.add(cleanSerial.match(/.{1,2}/g).join(':'));
      }
    }
    const unitIdList = Array.from(unitIdentifiers).filter(Boolean);

    // 3. MANDATORY RULE: Check if unit passed through "Retorno de Pintura"
    const retornoCheck = await pool.query(`
      SELECT * FROM retorno_pintura_itens
      WHERE (serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = ANY($1))
         OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = ANY($1))
         OR (mac IS NOT NULL AND mac != '' AND (
              UPPER(TRIM(mac)) = ANY($1)
              OR UPPER(REPLACE(REPLACE(mac, ':', ''), '-', '')) = ANY($1)
            ))
      LIMIT 1
    `, [unitIdList]);

    const isRetornoStatus = unitReceived.status === 'Retorno de Pintura';
    const hasRetornoRecord = retornoCheck.rows.length > 0;

    if (!isRetornoStatus && !hasRetornoRecord) {
      return res.status(400).json({
        success: false,
        code: 'NAO_PASSOU_RETORNO',
        error: `A unidade "${unitSerial}" não passou por "Retorno de Pintura" (status atual: "${unitReceived.status || 'Recebida'}"). Apenas unidades que retornaram da pintura podem ser expedidas em Garantia.`
      });
    }

    // 4. Check if unit is currently in an open or pending warranty pallet
    if (unitReceived.status === 'Em Pallet (Garantia)') {
      return res.status(400).json({
        success: false,
        code: 'JA_BIPADO_GARANTIA',
        error: `Unidade já está em um pallet de garantia aberto.`
      });
    }

    if (unitReceived.status === 'Aguardando retorno de pintura (Garantia)') {
      return res.status(400).json({
        success: false,
        code: 'JA_BIPADO_GARANTIA',
        error: `Unidade já foi expedida em garantia e está aguardando retorno de pintura.`
      });
    }

    if (unitReceived.status === 'Em pallet') {
      return res.status(400).json({
        success: false,
        code: 'JA_EM_PALLET',
        error: `Unidade está em um pallet de expedição normal aberto. Remova-a do pallet normal antes se for enviar como garantia.`
      });
    }

    // Check if already in this specific pallet
    const checkItemInThisPallet = await pool.query(`
      SELECT * FROM pallet_pintura_itens
      WHERE UPPER(codigo_pallet) = $1
        AND ((serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = ANY($2))
         OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = ANY($2))
         OR (mac IS NOT NULL AND mac != '' AND (
              UPPER(TRIM(mac)) = ANY($2)
              OR UPPER(REPLACE(REPLACE(mac, ':', ''), '-', '')) = ANY($2)
            )))
      LIMIT 1
    `, [codPallet, unitIdList]);

    if (checkItemInThisPallet.rows.length > 0) {
      return res.status(400).json({
        success: false,
        code: 'JA_BIPADO',
        error: `Unidade já bipada neste pallet de garantia (${codPallet})`
      });
    }

    // 5. Insert into pallet_pintura_itens
    const insertRes = await pool.query(`
      INSERT INTO pallet_pintura_itens (pallet_id, codigo_pallet, serial_number, gpon_id, mac, modelo, fabricante, data_bipagem, usuario, status, tipo)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, 'Em Pallet (Garantia)', 'GARANTIA')
      RETURNING *
    `, [pallet.id, codPallet, unitSerial, unitPon, unitMac, unitModelo, unitFabricante, usuario || 'OPERADOR']);

    // 6. Update unit status in recebimentos to 'Em Pallet (Garantia)'
    await pool.query(`
      UPDATE recebimentos
      SET status = 'Em Pallet (Garantia)'
      WHERE id = $1
         OR (serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = ANY($2))
         OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = ANY($2))
         OR (mac IS NOT NULL AND mac != '' AND (
              UPPER(TRIM(mac)) = ANY($2)
              OR UPPER(REPLACE(REPLACE(mac, ':', ''), '-', '')) = ANY($2)
            ))
    `, [unitReceived.id, unitIdList]);

    // 7. Update total_unidades
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
    console.error('Error scanning unit to garantia pallet:', err);
    res.status(500).json({ error: 'Database error during scan.' });
  }
});

// Close garantia pallet
app.post('/api/expedicao-garantia/fechar-pallet', async (req, res) => {
  try {
    const { codigo_pallet } = req.body;
    const codPallet = codigo_pallet.trim().toUpperCase();

    // 1. Update status of units in recebimentos to "Aguardando retorno de pintura (Garantia)"
    const updateRecebimentosQuery = `
      UPDATE recebimentos
      SET status = 'Aguardando retorno de pintura (Garantia)'
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
      SET status = 'Aguardando retorno de pintura (Garantia)'
      WHERE UPPER(codigo_pallet) = $1
    `, [codPallet]);

    // 3. Close the pallet
    await pool.query(`
      UPDATE pallets_pintura 
      SET status = 'FECHADO', data_fechamento = NOW() 
      WHERE UPPER(codigo_pallet) = $1 AND tipo = 'GARANTIA'
    `, [codPallet]);

    console.log(`Pallet Garantia ${codPallet} fechado. ${updateRecRes.rowCount} unidades com status atualizado para 'Aguardando retorno de pintura (Garantia)'.`);
    res.json({
      success: true,
      message: `Pallet Garantia ${codPallet} fechado com sucesso. ${updateRecRes.rowCount} unidades atualizadas para 'Aguardando retorno de pintura (Garantia)'.`,
      unidadesAtualizadas: updateRecRes.rowCount
    });
  } catch (err) {
    console.error('Error closing garantia pallet:', err);
    res.status(500).json({ error: 'Database error closing garantia pallet.' });
  }
});

// Reopen a closed garantia pallet
app.post('/api/expedicao-garantia/reabrir-pallet', async (req, res) => {
  try {
    const { codigo_pallet } = req.body;
    const codPallet = codigo_pallet.trim().toUpperCase();

    // 1. Reopen pallet
    await pool.query(`
      UPDATE pallets_pintura 
      SET status = 'ABERTO', data_fechamento = NULL 
      WHERE UPPER(codigo_pallet) = $1 AND tipo = 'GARANTIA'
    `, [codPallet]);

    // 2. Update status of units in recebimentos to 'Em Pallet (Garantia)'
    const updateRecebimentosQuery = `
      UPDATE recebimentos
      SET status = 'Em Pallet (Garantia)'
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
      SET status = 'Em Pallet (Garantia)'
      WHERE UPPER(codigo_pallet) = $1
    `, [codPallet]);

    console.log(`Pallet Garantia ${codPallet} reaberto. ${recRes.rowCount} unidades atualizadas para 'Em Pallet (Garantia)'.`);
    res.json({
      success: true,
      message: `Pallet Garantia ${codPallet} reaberto com sucesso. Status das unidades alterado para 'Em Pallet (Garantia)'.`,
      unidadesAtualizadas: recRes.rowCount
    });
  } catch (err) {
    console.error('Error reopening garantia pallet:', err);
    res.status(500).json({ error: 'Database error reopening garantia pallet.' });
  }
});

// Remove item from garantia pallet (and revert unit status back to 'Retorno de Pintura')
app.delete('/api/expedicao-garantia/item/:id', async (req, res) => {
  try {
    const itemId = req.params.id;
    const itemRes = await pool.query('SELECT * FROM pallet_pintura_itens WHERE id = $1', [itemId]);
    if (itemRes.rows.length === 0) return res.status(404).json({ error: 'Item não encontrado.' });
    const item = itemRes.rows[0];

    // 1. Delete item from pallet
    await pool.query('DELETE FROM pallet_pintura_itens WHERE id = $1', [itemId]);

    // 2. Revert unit status in recebimentos back to 'Retorno de Pintura'
    const identifiers = [item.serial_number, item.gpon_id, item.mac].filter(Boolean);
    if (identifiers.length > 0) {
      await pool.query(`
        UPDATE recebimentos
        SET status = 'Retorno de Pintura'
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

    console.log(`Item ${item.serial_number} removido do pallet de garantia ${item.codigo_pallet}. Status revertido para 'Retorno de Pintura'.`);
    res.json({ success: true, codigo_pallet: item.codigo_pallet, serial: item.serial_number });
  } catch (err) {
    console.error('Error removing item from garantia pallet:', err);
    res.status(500).json({ error: 'Database error removing item.' });
  }
});

// Get report data for expedicao garantia
app.get('/api/expedicao-garantia/report', async (req, res) => {
  const { start, end, modelo } = req.query;
  try {
    let query = `
      SELECT ppi.*, p.data_criacao, p.data_fechamento, p.status as pallet_status 
      FROM pallet_pintura_itens ppi
      JOIN pallets_pintura p ON ppi.pallet_id = p.id
      WHERE p.tipo = 'GARANTIA'
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
    console.error('Error fetching expedicao garantia report:', err);
    res.status(500).json({ error: 'Failed to fetch report data.' });
  }
});

// ============================================================
// Retorno de Pintura Routes
// ============================================================

// Scan/Register unit into Retorno de Pintura (ou Sucata de Retorno)
app.post('/api/retorno-pintura/bipar', async (req, res) => {
  try {
    const { codigo, usuario, isSucata } = req.body;
    if (!codigo || !String(codigo).trim()) {
      return res.status(400).json({ error: 'Informe o Serial, GPON ID ou MAC da unidade.' });
    }
    const rawCodigo = String(codigo).trim();
    if (hasSpecialChars(rawCodigo)) {
      return res.status(400).json({ success: false, error: 'Caracteres especiais não são permitidos no código da unidade.' });
    }
    const cleanCode = sanitizeDataCode(rawCodigo);
    const isSucataRetorno = !!isSucata;

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
    const unitStatusUpper = String(unit.status || '').trim().toUpperCase();

    // 1.1 Se já é Sucata, não pode bipar novamente
    if (unitStatusUpper.includes('SUCATA')) {
      return res.status(400).json({
        success: false,
        code: 'UNIDADE_SUCATA',
        error: `Unidade "${unit.serial_number || cleanCode}" consta com status ${unit.status} e não pode ser bipada novamente.`
      });
    }

    const identifiers = [unit.serial_number, unit.gpon_id, unit.mac].filter(Boolean);

    // 1.2 REGRA OBRIGATÓRIA: A unidade precisa estar como ENVIADA para a pintura!
    // Ou seja: estar em pallet_pintura_itens OU status indicar que está/foi para pintura
    const checkPallet = await pool.query(`
      SELECT * FROM pallet_pintura_itens
      WHERE (serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = ANY($1))
         OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = ANY($1))
         OR (mac IS NOT NULL AND mac != '' AND UPPER(TRIM(mac)) = ANY($1))
      ORDER BY id DESC LIMIT 1
    `, [identifiers]);

    const statusPinturaValido = 
      unitStatusUpper.includes('PALLET') ||
      unitStatusUpper.includes('AGUARDANDO RETORNO') ||
      checkPallet.rows.length > 0;

    if (!statusPinturaValido) {
      return res.status(400).json({
        success: false,
        code: 'NAO_ENVIADA_PINTURA',
        error: `A unidade "${unit.serial_number || cleanCode}" não foi enviada para a pintura (status atual: "${unit.status || 'Recebida'}"). Para registrar retorno ou sucata de retorno, a unidade precisa ter sido adicionada a um pallet de pintura.`
      });
    }

    // 2. Check if unit was already scanned into Retorno de Pintura (Allow if returning from Garantia)
    const isReturningFromGarantia = (unit.status === 'Aguardando retorno de pintura (Garantia)' || unit.status === 'Em Pallet (Garantia)');

    const checkDup = await pool.query(`
      SELECT * FROM retorno_pintura_itens
      WHERE (serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = ANY($1))
         OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = ANY($1))
         OR (mac IS NOT NULL AND mac != '' AND UPPER(TRIM(mac)) = ANY($1))
      ORDER BY id DESC LIMIT 1
    `, [identifiers]);

    if (checkDup.rows.length > 0 && !isReturningFromGarantia) {
      const dup = checkDup.rows[0];
      const dataHoraStr = dup.data_retorno ? new Date(dup.data_retorno).toLocaleString('pt-BR') : '';
      return res.status(400).json({
        success: false,
        code: 'JA_BIPADO',
        error: `Unidade "${unit.serial_number || cleanCode}" já foi bipada no Retorno de Pintura${dataHoraStr ? ` em ${dataHoraStr}` : ''} por ${dup.usuario || 'Operador'} (Status: ${dup.status || 'Retorno de Pintura'}).`,
        item: dup
      });
    }

    const novoStatus = isSucataRetorno ? 'Sucata de Retorno de Pintura' : 'Retorno de Pintura';

    // 3. Update status in recebimentos
    await pool.query(`
      UPDATE recebimentos
      SET status = $1
      WHERE id = $2 
         OR (serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = ANY($3))
         OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = ANY($3))
         OR (mac IS NOT NULL AND mac != '' AND UPPER(TRIM(mac)) = ANY($3))
    `, [novoStatus, unit.id, identifiers]);

    // 4. Update status in pallet_pintura_itens if it exists
    if (identifiers.length > 0) {
      await pool.query(`
        UPDATE pallet_pintura_itens
        SET status = $1
        WHERE (serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = ANY($2))
           OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = ANY($2))
           OR (mac IS NOT NULL AND mac != '' AND UPPER(TRIM(mac)) = ANY($2))
      `, [novoStatus, identifiers]);
    }

    // 5. Insert into retorno_pintura_itens
    const insertRes = await pool.query(`
      INSERT INTO retorno_pintura_itens (recebimento_id, serial_number, gpon_id, mac, modelo, fabricante, data_retorno, usuario, status)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8)
      RETURNING *
    `, [
      unit.id,
      unit.serial_number || cleanCode,
      unit.gpon_id || '',
      unit.mac || '',
      unit.modelo || 'NÃO INFORMADO',
      unit.fabricante || 'NÃO INFORMADO',
      usuario || 'OPERADOR',
      novoStatus
    ]);

    // 6. Get updated recent items and stats
    const recentRes = await pool.query('SELECT * FROM retorno_pintura_itens ORDER BY id DESC LIMIT 50');
    const statsRes = await pool.query(`
      SELECT 
        COUNT(*)::int as total,
        COUNT(CASE WHEN data_retorno >= CURRENT_DATE THEN 1 END)::int as total_hoje,
        COUNT(CASE WHEN data_retorno >= CURRENT_DATE AND (UPPER(status) LIKE '%SUCATA%') THEN 1 END)::int as sucata_hoje
      FROM retorno_pintura_itens
    `);

    res.json({
      success: true,
      item: insertRes.rows[0],
      isSucata: isSucataRetorno,
      message: isSucataRetorno 
        ? `Unidade ${insertRes.rows[0].serial_number} registrada com SUCATA DE RETORNO DE PINTURA!`
        : `Unidade ${insertRes.rows[0].serial_number} registrada com sucesso no Retorno de Pintura!`,
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
        COUNT(CASE WHEN data_retorno >= CURRENT_DATE THEN 1 END)::int as total_hoje,
        COUNT(CASE WHEN data_retorno >= CURRENT_DATE AND (UPPER(status) LIKE '%SUCATA%') THEN 1 END)::int as sucata_hoje
      FROM retorno_pintura_itens
    `);
    res.json(statsRes.rows[0] || { total: 0, total_hoje: 0, sucata_hoje: 0 });
  } catch (err) {
    console.error('Error fetching retorno-pintura stats:', err);
    res.status(500).json({ error: 'Database error fetching stats.' });
  }
});

// Get report data for retorno pintura
app.get('/api/retorno-pintura/report', async (req, res) => {
  const { start, end, modelo, apenasSucata } = req.query;
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
    if (apenasSucata === 'true') {
      query += ` AND UPPER(status) LIKE '%SUCATA%'`;
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

  if (hasSpecialChars(rawQuery)) {
    return res.status(400).json({ found: false, error: 'Caracteres especiais não são permitidos na consulta.' });
  }

  const cleanQuery = sanitizeDataCode(rawQuery);
  const searchTerms = [cleanQuery];

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
    let unitModelo = recebimento?.modelo || palletRes.rows[0]?.modelo || retornoRes.rows[0]?.modelo || 'Não identificado';
    let unitGpon = recebimento?.gpon_id || palletRes.rows[0]?.gpon_id || retornoRes.rows[0]?.gpon_id || null;

    // Se o modelo não foi identificado, tenta inferir pela descrição do pré-alerta
    if (unitModelo === 'Não identificado' && preAlerta?.descricao) {
      const descUpper = preAlerta.descricao.toUpperCase();
      for (const m of DEFAULT_MODELS_SEED) {
        if (descUpper.includes(m.name.toUpperCase())) {
          unitModelo = m.name;
          break;
        }
      }
    }

    // Identificar GPON para busca no banco de etiquetas (direto ou a partir do serial cadastrado)
    let searchPon = unitGpon ? unitGpon.trim().toUpperCase() : '';
    if (!searchPon) {
      const candidates = [
        recebimento?.serial_number,
        preAlerta?.serial,
        rawQuery,
        cleanQuery
      ];
      for (const cand of candidates) {
        if (cand) {
          const c = String(cand).trim().toUpperCase();
          if (c.startsWith('ZTE3') || c.startsWith('ZTEG') || c.startsWith('TLCT') || c.startsWith('HWTC') || c.startsWith('48575443')) {
            searchPon = c;
            break;
          }
        }
      }
    }

    if (!unitGpon && searchPon && (searchPon.startsWith('ZTE3') || searchPon.startsWith('ZTEG') || searchPon.startsWith('TLCT') || searchPon.startsWith('HWTC') || searchPon.startsWith('48575443'))) {
      unitGpon = searchPon;
    }

    let searchSerial = recebimento?.serial_number || preAlerta?.serial || '';
    if (!searchSerial && (cleanQuery.startsWith('2102315') || rawQuery.startsWith('2102315') || cleanQuery.startsWith('T25') || rawQuery.startsWith('T25'))) {
      searchSerial = cleanQuery;
    }

    const isF6600P = (unitModelo || '').toUpperCase().includes('F6600P') ||
                     (preAlerta?.descricao || '').toUpperCase().includes('F6600P') ||
                     (searchPon && (searchPon.startsWith('ZTE3') || searchPon.startsWith('ZTEG')));

    const isNP7287 = (unitModelo || '').toUpperCase().includes('NP7287') ||
                     (preAlerta?.descricao || '').toUpperCase().includes('NP7287') ||
                     (searchPon && searchPon.startsWith('TLCT')) ||
                     (searchSerial && searchSerial.startsWith('T25'));

    const isHG8145 = (unitModelo || '').toUpperCase().includes('HG8145') ||
                     (unitModelo || '').toUpperCase().includes('8145X6') ||
                     (preAlerta?.descricao || '').toUpperCase().includes('HG8145') ||
                     (preAlerta?.descricao || '').toUpperCase().includes('8145X6') ||
                     (searchPon && (searchPon.startsWith('HWTC') || searchPon.startsWith('48575443'))) ||
                     (searchSerial && searchSerial.startsWith('2102315'));

    const shouldCheckPassword = (isF6600P || isNP7287 || isHG8145);

    // Status da senha: se a unidade já tiver sido recebida, usa o gravado inicialmente
    let superUserVal = recebimento?.super_user || null;

    // Consulta de senha no 2º banco para F6600P, NP7287 e HG8145 (tanto para recebidas quanto para aguardando recebimento)
    if (shouldCheckPassword && secondPool && (searchPon || searchSerial)) {
      try {
        let ponAlt = '';
        if (searchPon) {
          if (searchPon.startsWith('HWTC')) {
            ponAlt = '48575443' + searchPon.slice(4);
          } else if (searchPon.startsWith('48575443')) {
            ponAlt = 'HWTC' + searchPon.slice(8);
          }
        }

        // 1. Busca estrita pelo GPON primeiro
        let chk;
        if (searchPon || ponAlt) {
          chk = await secondPool.query(
            `SELECT password_router, modelo, fabricante, cpe_sn, mac 
             FROM etiquetas_scan_onu 
             WHERE UPPER(TRIM(gpon_sn)) = UPPER(TRIM($1))
                OR ( $2 != '' AND UPPER(TRIM(gpon_sn)) = UPPER(TRIM($2)) )
             ORDER BY (CASE WHEN cpe_sn IS NOT NULL AND cpe_sn != '' AND UPPER(cpe_sn) != 'N/A' THEN 1 ELSE 0 END) DESC,
                      (CASE WHEN mac IS NOT NULL AND mac != '' AND UPPER(mac) != 'N/A' THEN 1 ELSE 0 END) DESC
             LIMIT 1`,
            [searchPon || '', ponAlt || '']
          );
        }

        // 2. Fallback por Serial somente se não encontrou nada pelo GPON
        if ((!chk || chk.rows.length === 0) && searchSerial) {
          chk = await secondPool.query(
            `SELECT password_router, modelo, fabricante, cpe_sn, mac 
             FROM etiquetas_scan_onu 
             WHERE UPPER(TRIM(cpe_sn)) = UPPER(TRIM($1))
             ORDER BY (CASE WHEN mac IS NOT NULL AND mac != '' AND UPPER(mac) != 'N/A' THEN 1 ELSE 0 END) DESC
             LIMIT 1`,
            [searchSerial]
          );
        }

        if (chk && chk.rows.length > 0) {
          const etiq = chk.rows[0];
          const hasPassword = hasValidPassword(etiq.password_router);
          superUserVal = hasPassword ? 'Sim' : 'Não';

          if (unitModelo === 'Não identificado') {
            if (isNP7287) {
              unitModelo = 'NP7287';
            } else if (isHG8145) {
              unitModelo = 'HG8145X6-10';
            } else if (etiq.modelo) {
              unitModelo = etiq.modelo.toUpperCase().includes('F6600') ? 'ZXHN F6600P' : etiq.modelo;
            }
          }
        } else {
          superUserVal = 'Não';
        }

        // Se a unidade já está recebida e o valor em recebimentos divergir da regra real, corrige no banco principal
        if (recebimento && recebimento.id && recebimento.super_user !== superUserVal) {
          await pool.query('UPDATE recebimentos SET super_user = $1 WHERE id = $2', [superUserVal, recebimento.id])
            .catch(e => console.warn('Erro ao atualizar super_user no recebimento:', e.message));
          recebimento.super_user = superUserVal;
        }
      } catch (e) {
        console.warn('Erro ao consultar segundo banco na consulta da unidade:', e.message);
        if (recebimento) {
          superUserVal = recebimento.super_user || null;
        }
      }
    }

    const unit = {
      serial_number: recebimento?.serial_number || palletRes.rows[0]?.serial_number || retornoRes.rows[0]?.serial_number || preAlerta?.serial || rawQuery,
      gpon_id: unitGpon,
      mac: recebimento?.mac || palletRes.rows[0]?.mac || retornoRes.rows[0]?.mac || null,
      modelo: unitModelo,
      fabricante: recebimento?.fabricante || palletRes.rows[0]?.fabricante || retornoRes.rows[0]?.fabricante || preAlerta?.fabricante || 'Não identificado',
      codigo: recebimento?.codigo || preAlerta?.codigo || '---',
      descricao: recebimento?.descricao || preAlerta?.descricao || '---',
      no_pre_alerta: !!(preAlerta || recebimento?.no_pre_alerta),
      status_atual: 'Desconhecido',
      super_user: superUserVal
    };

    // Identificar qual identificador deu entrada no Pré-Alerta (SN, GPON ID ou MAC)
    const valPre = (preAlerta?.serial || recebimento?.matched_value || '').trim();
    const valPreUpper = valPre.toUpperCase();
    const valPreClean = valPreUpper.replace(/[^A-Z0-9]/g, '');

    const sVal = (unit.serial_number || '').trim();
    const sClean = sVal.toUpperCase().replace(/[^A-Z0-9]/g, '');

    const gVal = (unit.gpon_id || '').trim();
    const gClean = gVal.toUpperCase().replace(/[^A-Z0-9]/g, '');

    const mVal = (unit.mac || '').trim();
    const mClean = mVal.toUpperCase().replace(/[^A-Z0-9]/g, '');

    let preAlertaOrigem = null;

    if (unit.no_pre_alerta) {
      if (valPreClean) {
        if (sClean && (valPreClean === sClean || valPreUpper === sVal.toUpperCase())) {
          preAlertaOrigem = {
            tipo: 'Serial Number',
            sigla: 'SN',
            campo: 'serial',
            valor: sVal || valPre
          };
        } else if (gClean && (valPreClean === gClean || valPreClean === gVal.toUpperCase().replace(/[^A-Z0-9]/g, ''))) {
          preAlertaOrigem = {
            tipo: 'GPON ID',
            sigla: 'GPON ID',
            campo: 'gpon',
            valor: gVal || valPre
          };
        } else if (mClean && (valPreClean === mClean || valPreClean === mVal.toUpperCase().replace(/[^A-Z0-9]/g, ''))) {
          preAlertaOrigem = {
            tipo: 'MAC',
            sigla: 'MAC',
            campo: 'mac',
            valor: mVal || valPre
          };
        } else {
          // Se não coincidiu diretamente com os dados salvos ou a unidade está apenas no pré-alerta
          let inferido = 'Identificador Pré-Alerta';
          let inferidoSigla = 'Pré-Alerta';
          let inferidoCampo = 'geral';

          if (valPreClean.length === 12 && /^[0-9A-F]{12}$/i.test(valPreClean)) {
            inferido = 'MAC';
            inferidoSigla = 'MAC';
            inferidoCampo = 'mac';
          } else if (/^[A-Z]{4}[0-9A-F]{8}$/i.test(valPreClean) || /^GPON/i.test(valPreClean)) {
            inferido = 'GPON ID';
            inferidoSigla = 'GPON ID';
            inferidoCampo = 'gpon';
          } else {
            inferido = 'Serial Number';
            inferidoSigla = 'SN';
            inferidoCampo = 'serial';
          }

          preAlertaOrigem = {
            tipo: inferido,
            sigla: inferidoSigla,
            campo: inferidoCampo,
            valor: valPre
          };
        }
      } else {
        preAlertaOrigem = {
          tipo: 'Pré-Alerta',
          sigla: 'Pré-Alerta',
          campo: 'geral',
          valor: 'Confirmado no Recebimento'
        };
      }
    }

    unit.pre_alerta_origem = preAlertaOrigem;

    // Montar Linha do Tempo / Histórico
    const history = [];

    // Etapa Pré-Alerta
    if (preAlerta) {
      let extraOrigem = '';
      if (preAlertaOrigem && preAlertaOrigem.valor) {
        extraOrigem = ` | Entrada via: ${preAlertaOrigem.tipo} (${preAlertaOrigem.valor})`;
      } else if (preAlerta.serial) {
        extraOrigem = ` | Identificador cadastrado: ${preAlerta.serial}`;
      }

      const senhaPreInfo = !recebimento && superUserVal ? (superUserVal === 'Sim' ? ' | Senha: Com senha' : ' | Senha: Sem senha') : '';

      history.push({
        etapa: 'Pré-Alerta',
        titulo: 'Presente na Base de Pré-Alerta',
        descricao: `Código: ${preAlerta.codigo || '---'} | Descrição: ${preAlerta.descricao || '---'} | Fabricante: ${preAlerta.fabricante || '---'}${extraOrigem}${senhaPreInfo}`,
        data_hora: null,
        usuario: 'Sistema / Importação',
        status: 'Cadastrada no Pré-Alerta',
        tipo: 'pre-alerta',
        icone: 'database'
      });
    }

    // Etapas de Recebimento e Expedição (Ciclos de Vida da Unidade)
    const sortedRecs = [...recRes.rows].sort((a, b) => new Date(a.data_hora || 0) - new Date(b.data_hora || 0));
    sortedRecs.forEach((r, idx) => {
      const isReentrada = sortedRecs.length > 1 && idx > 0;
      const isSucataRec = String(r.status || '').trim().toUpperCase() === 'SUCATA';
      const senhaInfo = r.super_user === 'Sim' ? ' | Senha: Com senha' : r.super_user === 'Não' ? ' | Senha: Sem senha' : '';
      let preAlertaStatusDesc = r.no_pre_alerta ? 'No Pré-Alerta' : 'Fora do Pré-Alerta';

      history.push({
        etapa: isSucataRec ? 'Sucata' : 'Recebimento',
        titulo: isSucataRec
          ? 'Unidade Recebida / Classificada como SUCATA'
          : (isReentrada ? `Reentrada #${idx + 1} no Sistema (Logística Reversa)` : 'Unidade Recebida no Sistema'),
        descricao: `Modelo: ${r.modelo || '---'} | Serial: ${r.serial_number || '---'} | PON: ${r.gpon_id || '---'} | MAC: ${r.mac || '---'} (${preAlertaStatusDesc}${senhaInfo})`,
        data_hora: r.data_hora,
        usuario: r.usuario || 'Não registrado',
        status: r.status || 'Recebida',
        tipo: isSucataRec ? 'sucata' : 'recebimento',
        icone: 'inbox'
      });

      // Se esse ciclo de recebimento foi expedido
      if (r.status === 'Expedida' || r.lote_expedicao) {
        history.push({
          etapa: 'Expedição',
          titulo: `Expedida no Lote ${r.lote_expedicao || 'TIM'}`,
          descricao: `Lote: ${r.lote_expedicao || '---'} | Status: Expedida${r.data_expedicao ? ' | Data: ' + new Date(r.data_expedicao).toLocaleString('pt-BR') : ''}`,
          data_hora: r.data_expedicao || r.data_hora,
          usuario: 'Expedição TIM',
          status: 'Expedida',
          tipo: 'expedicao',
          icone: 'truck'
        });
      }
    });

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

    // Etapa Expedição TIM (relatório e lotes)
    try {
      const repRes = await pool.query(`SELECT report_data FROM expedicao_tim_relatorio ORDER BY id DESC LIMIT 1`);
      if (repRes.rows.length > 0 && Array.isArray(repRes.rows[0].report_data)) {
        const matchingItems = repRes.rows[0].report_data.filter(r => {
          if (!r.serial) return false;
          const sUpper = String(r.serial).trim().toUpperCase();
          return idList.some(id => id.toUpperCase() === sUpper);
        });

        if (matchingItems.length > 0) {
          const matchedPallets = new Set(matchingItems.map(m => String(m.palletId || '').trim().toUpperCase()).filter(Boolean));
          const lotsRes = await pool.query(`SELECT id, number, dest, status, expedition_data, groups FROM expedicao_tim_lotes ORDER BY number ASC`);
          for (const lot of (lotsRes.rows || [])) {
            const groups = lot.groups || [];
            const hasPallet = groups.some(g => (g.palletIds || []).some(pid => matchedPallets.has(String(pid).trim().toUpperCase())));
            if (hasPallet) {
              const exp = lot.expedition_data || {};
              const isExp = lot.status === 'expedido';
              history.push({
                etapa: 'Expedição TIM',
                titulo: `Lote #${lot.number} (${lot.dest || 'Sem destino'}) · ${isExp ? 'Expedido' : 'Em Preparação'}`,
                descricao: `Pallet: ${Array.from(matchedPallets).join('/')} | Lote: ${exp.loteIdent || lot.number} | NF: ${exp.nf || '---'} | Destino: ${exp.destino || lot.dest || '---'} | Status: ${isExp ? 'Expedida' : 'Em Lote'}`,
                data_hora: exp.expedidoEm || exp.dataHora || null,
                usuario: exp.responsavel || lot.usuario || 'Expedição TIM',
                status: isExp ? 'Expedida' : 'Em Lote',
                tipo: 'expedicao',
                icone: 'truck'
              });
            }
          }
        }
      }
    } catch (expTimErr) {
      console.warn('Aviso ao consultar histórico de Expedição TIM:', expTimErr.message);
    }

    // Definir Status Atual considerando o ciclo mais recente
    const latestRec = recRes.rows[0] || null;
    if (latestRec && String(latestRec.status || '').trim().toUpperCase() === 'SUCATA') {
      unit.status_atual = 'Sucata';
    } else if (latestRec && String(latestRec.status || '').toUpperCase() === 'EXPEDIDA') {
      unit.status_atual = 'Expedida' + (latestRec.lote_expedicao ? ` (${latestRec.lote_expedicao})` : '');
    } else if (retornoRes.rows.length > 0) {
      unit.status_atual = 'Retorno de Pintura';
    } else if (palletRes.rows.length > 0 && palletRes.rows[0].status === 'Em Pallet') {
      unit.status_atual = `Em Pallet (${palletRes.rows[0].codigo_pallet})`;
    } else if (latestRec) {
      unit.status_atual = latestRec.status || 'Recebida';
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

// ============================================================
// Endpoint para Edição das Séries da Unidade
// ============================================================
async function handleEditarSeries(req, res) {
  try {
    const {
      recebimento_id,
      old_serial,
      old_gpon,
      old_mac,
      new_serial,
      new_gpon,
      new_mac,
      new_modelo,
      motivo,
      usuario
    } = req.body;

    const rawNewSerial = (new_serial || '').trim();
    const rawNewGpon = (new_gpon || '').trim();
    const rawNewMac = (new_mac || '').trim();

    if (!rawNewSerial) {
      return res.status(400).json({ success: false, error: 'O Serial Number é obrigatório.' });
    }
    if (!rawNewMac) {
      return res.status(400).json({ success: false, error: 'O Endereço MAC é obrigatório.' });
    }

    if (hasSpecialChars(rawNewSerial) || (rawNewGpon && hasSpecialChars(rawNewGpon)) || hasSpecialChars(rawNewMac)) {
      return res.status(400).json({ success: false, error: 'Caracteres especiais não são permitidos nas séries.' });
    }

    const cleanNewSerial = sanitizeDataCode(rawNewSerial);
    const cleanNewGpon = sanitizeDataCode(rawNewGpon);
    const cleanNewMac = sanitizeDataCode(rawNewMac);
    const cleanModelo = (new_modelo || '').trim().toUpperCase();

    const cleanOldSerial = sanitizeDataCode(old_serial || '');
    const cleanOldGpon = sanitizeDataCode(old_gpon || '');
    const cleanOldMac = sanitizeDataCode(old_mac || '');

    // Identificadores antigos
    const oldIdentifiers = [cleanOldSerial, cleanOldGpon, cleanOldMac].filter(Boolean);

    // 1. Verificar duplicidade em recebimentos (outro registro com o novo serial/gpon/mac)
    let dupQuery = `
      SELECT id, serial_number, gpon_id, mac 
      FROM recebimentos
      WHERE (UPPER(TRIM(serial_number)) = $1 OR UPPER(TRIM(mac)) = $2 ${cleanNewGpon ? 'OR UPPER(TRIM(gpon_id)) = $3' : ''})
    `;
    const dupParams = cleanNewGpon ? [cleanNewSerial, cleanNewMac, cleanNewGpon] : [cleanNewSerial, cleanNewMac];
    if (recebimento_id) {
      dupQuery += ` AND id != $${dupParams.length + 1}`;
      dupParams.push(recebimento_id);
    } else if (oldIdentifiers.length > 0) {
      dupQuery += ` AND NOT (
        (serial_number IS NOT NULL AND UPPER(TRIM(serial_number)) = ANY($${dupParams.length + 1})) 
        OR (mac IS NOT NULL AND UPPER(TRIM(mac)) = ANY($${dupParams.length + 1}))
      )`;
      dupParams.push(oldIdentifiers);
    }
    dupQuery += ' LIMIT 1';

    const checkDup = await pool.query(dupQuery, dupParams);
    if (checkDup.rows.length > 0) {
      const dup = checkDup.rows[0];
      return res.status(400).json({
        success: false,
        error: `Já existe outra unidade registrada com esta série (ID: ${dup.id}, Serial: ${dup.serial_number}, MAC: ${dup.mac}).`
      });
    }

    // 2. Verificar correspondência com Pre-Alerta para a nova série
    const searchTerms = [cleanNewSerial, cleanNewGpon, cleanNewMac].filter(Boolean);
    const preMatchRes = await pool.query(
      `SELECT * FROM pre_alertas 
       WHERE UPPER(TRIM(serial)) = ANY($1) 
          OR UPPER(REPLACE(serial, ':', '')) = ANY($1) 
       LIMIT 1`,
      [searchTerms]
    );
    const preMatch = preMatchRes.rows[0] || null;
    const isNoPreAlerta = !!preMatch;
    const matchedValue = preMatch ? preMatch.serial : null;

    let superUserEdit = null;
    const isF6600PEdit = cleanModelo && cleanModelo.toUpperCase().includes('F6600P');
    const isNP7287Edit = cleanModelo && cleanModelo.toUpperCase().includes('NP7287');
    const isHG8145Edit = cleanModelo && (cleanModelo.toUpperCase().includes('HG8145') || cleanModelo.toUpperCase().includes('8145X6'));
    if (isF6600PEdit || isNP7287Edit || isHG8145Edit) {
      if (secondPool && (cleanNewGpon || cleanNewSerial)) {
        try {
          let editPonAlt = '';
          if (cleanNewGpon) {
            if (cleanNewGpon.startsWith('HWTC')) {
              editPonAlt = '48575443' + cleanNewGpon.slice(4);
            } else if (cleanNewGpon.startsWith('48575443')) {
              editPonAlt = 'HWTC' + cleanNewGpon.slice(8);
            }
          }

          let chk;
          if (cleanNewGpon || editPonAlt) {
            chk = await secondPool.query(`
              SELECT password_router FROM etiquetas_scan_onu 
              WHERE UPPER(TRIM(gpon_sn)) = UPPER(TRIM($1))
                 OR ( $2 != '' AND UPPER(TRIM(gpon_sn)) = UPPER(TRIM($2)) )
              LIMIT 1
            `, [cleanNewGpon || '', editPonAlt || '']);
          }

          if ((!chk || chk.rows.length === 0) && cleanNewSerial) {
            chk = await secondPool.query(`
              SELECT password_router FROM etiquetas_scan_onu 
              WHERE UPPER(TRIM(cpe_sn)) = UPPER(TRIM($1))
              LIMIT 1
            `, [cleanNewSerial]);
          }

          if (chk && chk.rows.length > 0) {
            superUserEdit = hasValidPassword(chk.rows[0].password_router) ? 'Sim' : 'Não';
          } else {
            superUserEdit = 'Não';
          }
        } catch (e) {
          superUserEdit = 'Não';
        }
      } else {
        superUserEdit = 'Não';
      }
    }

    // 3. Atualizar tabela recebimentos
    let recUpdated = false;
    if (recebimento_id) {
      const updateRecRes = await pool.query(
        `UPDATE recebimentos 
         SET serial_number = $1,
             gpon_id = $2,
             mac = $3,
             modelo = COALESCE(NULLIF($4, ''), modelo),
             no_pre_alerta = $5,
             matched_value = $6,
             codigo = COALESCE($7, codigo),
             descricao = COALESCE($8, descricao),
             fabricante = COALESCE($9, fabricante),
             super_user = COALESCE($11, super_user)
         WHERE id = $10
         RETURNING *`,
        [
          cleanNewSerial,
          cleanNewGpon || null,
          cleanNewMac,
          cleanModelo,
          isNoPreAlerta,
          matchedValue,
          preMatch ? preMatch.codigo : null,
          preMatch ? preMatch.descricao : null,
          preMatch ? preMatch.fabricante : null,
          recebimento_id,
          superUserEdit
        ]
      );
      recUpdated = updateRecRes.rowCount > 0;
    } else if (oldIdentifiers.length > 0) {
      const updateRecRes = await pool.query(
        `UPDATE recebimentos 
         SET serial_number = $1,
             gpon_id = $2,
             mac = $3,
             modelo = COALESCE(NULLIF($4, ''), modelo),
             no_pre_alerta = $5,
             matched_value = $6,
             codigo = COALESCE($7, codigo),
             descricao = COALESCE($8, descricao),
             fabricante = COALESCE($9, fabricante),
             super_user = COALESCE($11, super_user)
         WHERE (serial_number IS NOT NULL AND UPPER(TRIM(serial_number)) = ANY($10))
            OR (gpon_id IS NOT NULL AND UPPER(TRIM(gpon_id)) = ANY($10))
            OR (mac IS NOT NULL AND UPPER(TRIM(mac)) = ANY($10))
         RETURNING *`,
        [
          cleanNewSerial,
          cleanNewGpon || null,
          cleanNewMac,
          cleanModelo,
          isNoPreAlerta,
          matchedValue,
          preMatch ? preMatch.codigo : null,
          preMatch ? preMatch.descricao : null,
          preMatch ? preMatch.fabricante : null,
          oldIdentifiers,
          superUserEdit
        ]
      );
      recUpdated = updateRecRes.rowCount > 0;
    }

    // 4. Atualizar pallet_pintura_itens se houver itens associados
    if (oldIdentifiers.length > 0) {
      await pool.query(
        `UPDATE pallet_pintura_itens
         SET serial_number = $1,
             gpon_id = $2,
             mac = $3,
             modelo = COALESCE(NULLIF($4, ''), modelo)
         WHERE (serial_number IS NOT NULL AND UPPER(TRIM(serial_number)) = ANY($5))
            OR (gpon_id IS NOT NULL AND UPPER(TRIM(gpon_id)) = ANY($5))
            OR (mac IS NOT NULL AND UPPER(TRIM(mac)) = ANY($5))`,
        [cleanNewSerial, cleanNewGpon || null, cleanNewMac, cleanModelo, oldIdentifiers]
      );
    }

    // 5. Atualizar retorno_pintura_itens se houver
    if (oldIdentifiers.length > 0 || recebimento_id) {
      await pool.query(
        `UPDATE retorno_pintura_itens
         SET serial_number = $1,
             gpon_id = $2,
             mac = $3,
             modelo = COALESCE(NULLIF($4, ''), modelo)
         WHERE ($5::int IS NOT NULL AND recebimento_id = $5)
            OR (serial_number IS NOT NULL AND UPPER(TRIM(serial_number)) = ANY($6))
            OR (gpon_id IS NOT NULL AND UPPER(TRIM(gpon_id)) = ANY($6))
            OR (mac IS NOT NULL AND UPPER(TRIM(mac)) = ANY($6))`,
        [cleanNewSerial, cleanNewGpon || null, cleanNewMac, cleanModelo, recebimento_id || null, oldIdentifiers]
      );
    }

    // 6. Atualizar pre_alertas se a unidade foi cadastrada apenas em pre_alertas
    if (!recUpdated && cleanOldSerial) {
      await pool.query(
        `UPDATE pre_alertas
         SET serial = $1
         WHERE UPPER(TRIM(serial)) = UPPER($2)`,
        [cleanNewSerial, cleanOldSerial]
      );
    }

    // 7. Segundo banco (PG2447)
    if (secondPool && cleanModelo === 'PG2447' && cleanNewSerial.startsWith('GPO') && cleanNewMac) {
      try {
        await secondPool.query(
          `UPDATE etiquetas_scan_onu SET cpe_sn = $1 WHERE UPPER(mac) = UPPER($2)`,
          [cleanNewSerial, cleanNewMac]
        );
      } catch (secErr) {
        console.warn('Erro ao atualizar segundo banco na edição de série:', secErr.message);
      }
    }

    console.log(`Séries atualizadas com sucesso: ${cleanOldSerial || '(novo)'} -> ${cleanNewSerial} por ${usuario || 'USUÁRIO'}`);

    res.json({
      success: true,
      message: 'Séries da unidade atualizadas com sucesso!',
      updated: {
        serial_number: cleanNewSerial,
        gpon_id: cleanNewGpon,
        mac: cleanNewMac,
        modelo: cleanModelo,
        no_pre_alerta: isNoPreAlerta,
        super_user: superUserEdit
      }
    });
  } catch (err) {
    console.error('Erro ao editar séries da unidade:', err);
    res.status(500).json({ success: false, error: 'Erro interno no banco de dados ao salvar edição de séries.' });
  }
}

app.post('/api/unidades/editar-series', handleEditarSeries);
app.put('/api/unidades/editar-series', handleEditarSeries);

// ============================================================
// Expedição TIM - Routes & Armazenamento MinIO / PostgreSQL
// ============================================================

// Memória de contingência para Expedição TIM caso banco esteja reiniciando ou offline
const expedicaoTimMemoryStore = {
  importacoes: [],
  relatorio: null,
  lotes: [],
  config: {}
};

// Helpers de integração com MinIO para Expedição TIM (Bucket: expedicao-tim)
async function saveExpedicaoMinio(objectName, data) {
  try {
    if (!MINIO_ACCESS_KEY || !MINIO_SECRET_KEY) return false;
    const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);
    const buffer = Buffer.from(jsonStr, 'utf8');
    await minioClient.putObject(MINIO_EXPEDICAO_BUCKET, objectName, buffer, buffer.length, {
      'Content-Type': 'application/json'
    });
    return true;
  } catch (err) {
    console.warn(`[MinIO Expedição] Erro ao salvar "${objectName}":`, err.message);
    return false;
  }
}

async function getExpedicaoMinio(objectName) {
  try {
    if (!MINIO_ACCESS_KEY || !MINIO_SECRET_KEY) return null;
    const stream = await minioClient.getObject(MINIO_EXPEDICAO_BUCKET, objectName);
    return new Promise((resolve) => {
      let data = '';
      stream.on('data', chunk => { data += chunk; });
      stream.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
      stream.on('error', (err) => {
        if (err.code !== 'NoSuchKey') {
          console.warn(`[MinIO Expedição] Erro no stream do objeto "${objectName}":`, err.message);
        }
        resolve(null);
      });
    });
  } catch (err) {
    if (err.code !== 'NoSuchKey') {
      console.warn(`[MinIO Expedição] Objeto "${objectName}" não encontrado ou inacessível:`, err.message);
    }
    return null;
  }
}

async function deleteExpedicaoMinio(objectName) {
  try {
    if (!MINIO_ACCESS_KEY || !MINIO_SECRET_KEY) return false;
    await minioClient.removeObject(MINIO_EXPEDICAO_BUCKET, objectName);
    return true;
  } catch (err) {
    console.warn(`[MinIO Expedição] Erro ao excluir "${objectName}":`, err.message);
    return false;
  }
}

async function listExpedicaoMinio(prefix = '') {
  return new Promise((resolve) => {
    if (!MINIO_ACCESS_KEY || !MINIO_SECRET_KEY) return resolve([]);
    try {
      const stream = minioClient.listObjectsV2(MINIO_EXPEDICAO_BUCKET, prefix, true);
      const objects = [];
      stream.on('data', obj => objects.push(obj));
      stream.on('error', err => {
        console.warn(`[MinIO Expedição] Erro ao listar prefixo "${prefix}":`, err.message);
        resolve([]);
      });
      stream.on('end', () => resolve(objects));
    } catch (e) {
      console.warn(`[MinIO Expedição] Falha ao iniciar listObjects:`, e.message);
      resolve([]);
    }
  });
}

// 1. Obter estado completo (Relatório, Lotes, Configurações, Histórico de Importações)
app.get('/api/expedicao-tim/state', async (req, res) => {
  let reportRow = {};
  let lots = [];
  let config = {};
  let importacoes = [];
  let fromDb = false;

  try {
    const repRes = await pool.query(
      `SELECT report_data, raw_data, raw_headers, column_map, importacao_id, nome_arquivo, updated_at 
       FROM expedicao_tim_relatorio ORDER BY id DESC LIMIT 1`
    );
    reportRow = repRes.rows[0] || {};

    const lotsRes = await pool.query(
      `SELECT id, number, dest, obs, status, created_at, groups, expedition_data, importacao_id, importacao_arquivo 
       FROM expedicao_tim_lotes ORDER BY number ASC`
    );
    lots = (lotsRes.rows || []).map(r => ({
      id: r.id,
      number: r.number,
      dest: r.dest,
      obs: r.obs,
      status: r.status,
      createdAt: r.created_at,
      groups: r.groups || [],
      expeditionData: r.expedition_data || null,
      importacaoId: r.importacao_id || null,
      importacaoArquivo: r.importacao_arquivo || null
    }));

    const cfgRes = await pool.query(`SELECT key, value FROM expedicao_tim_config`);
    (cfgRes.rows || []).forEach(r => { config[r.key] = r.value; });

    const impRes = await pool.query(
      `SELECT i.id, i.nome_arquivo, i.total_linhas, i.total_pallets, i.usuario, i.created_at, i.column_map,
              COALESCE(
                (SELECT json_agg(json_build_object(
                  'id', l.id,
                  'number', l.number,
                  'status', l.status,
                  'dest', l.dest,
                  'createdAt', l.created_at,
                  'totalPallets', (SELECT jsonb_array_length(l.groups))
                ))
                 FROM expedicao_tim_lotes l WHERE l.importacao_id = i.id),
                '[]'::json
              ) AS lotes
       FROM expedicao_tim_importacoes i
       ORDER BY i.created_at DESC`
    );
    importacoes = impRes.rows || [];
    fromDb = true;
  } catch (err) {
    console.warn('PostgreSQL indisponível ao consultar estado de Expedição TIM (buscando no MinIO):', err.message);
  }

  // Backup / Fallback / Complemento via MinIO
  let minioState = null;
  try {
    minioState = await getExpedicaoMinio('state.json');
  } catch (mErr) {
    console.warn('[MinIO] Erro ao ler state.json:', mErr.message);
  }

  // Se o banco estiver vazio ou offline, recupera do MinIO
  if ((!lots || lots.length === 0) && minioState && Array.isArray(minioState.lots)) {
    lots = minioState.lots;
    console.log(`[MinIO Expedição] ${lots.length} lotes recuperados do MinIO.`);
  } else if (minioState && Array.isArray(minioState.lots) && minioState.lots.length > 0) {
    // Mesclar lotes que possam existir no MinIO e ainda não no DB
    const existingIds = new Set(lots.map(l => l.id));
    minioState.lots.forEach(ml => {
      if (ml && ml.id && !existingIds.has(ml.id)) {
        lots.push(ml);
      }
    });
  }

  if ((!reportRow.report_data || reportRow.report_data.length === 0) && minioState && minioState.reportData) {
    reportRow = {
      report_data: minioState.reportData,
      raw_data: minioState.rawData || [],
      raw_headers: minioState.rawHeaders || [],
      column_map: minioState.columnMap || {},
      importacao_id: minioState.currentImportId || null,
      nome_arquivo: minioState.currentImportFilename || null
    };
  }

  if (importacoes.length === 0) {
    const minioIndex = await getExpedicaoMinio('importacoes/index.json');
    if (Array.isArray(minioIndex) && minioIndex.length > 0) {
      importacoes = minioIndex;
    } else if (expedicaoTimMemoryStore.importacoes.length > 0) {
      importacoes = expedicaoTimMemoryStore.importacoes;
    }
  }

  // Se banco funcionou mas MinIO estava vazio, salvar snapshot no MinIO
  if (fromDb && (!minioState || !minioState.lots || minioState.lots.length === 0) && lots.length > 0) {
    saveExpedicaoMinio('state.json', {
      reportData: reportRow.report_data || [],
      rawData: reportRow.raw_data || [],
      rawHeaders: reportRow.raw_headers || [],
      columnMap: reportRow.column_map || {},
      lots: lots,
      lastResponsavel: config.last_responsavel || '',
      currentImportId: reportRow.importacao_id || null,
      currentImportFilename: reportRow.nome_arquivo || null,
      updatedAt: new Date().toISOString()
    }).catch(e => console.warn('Erro ao sincronizar MinIO state em background:', e.message));
  }

  res.json({
    success: true,
    reportData: reportRow.report_data || (expedicaoTimMemoryStore.relatorio ? expedicaoTimMemoryStore.relatorio.reportData : []),
    rawData: reportRow.raw_data || (expedicaoTimMemoryStore.relatorio ? expedicaoTimMemoryStore.relatorio.rawData : []),
    rawHeaders: reportRow.raw_headers || (expedicaoTimMemoryStore.relatorio ? expedicaoTimMemoryStore.relatorio.rawHeaders : []),
    columnMap: reportRow.column_map || (expedicaoTimMemoryStore.relatorio ? expedicaoTimMemoryStore.relatorio.columnMap : {}),
    currentImportId: reportRow.importacao_id || (expedicaoTimMemoryStore.relatorio ? expedicaoTimMemoryStore.relatorio.importacaoId : null),
    currentImportFilename: reportRow.nome_arquivo || (expedicaoTimMemoryStore.relatorio ? expedicaoTimMemoryStore.relatorio.nomeArquivo : null),
    lots: lots.length > 0 ? lots : (expedicaoTimMemoryStore.lotes || []),
    importacoes: importacoes,
    lastResponsavel: config.last_responsavel || expedicaoTimMemoryStore.config.last_responsavel || ''
  });
});

// 2. Salvar relatório importado
app.post('/api/expedicao-tim/report', async (req, res) => {
  const { reportData, rawData, rawHeaders, columnMap, usuario, importId, nomeArquivo } = req.body;
  const total = Array.isArray(reportData) ? reportData.length : 0;

  const relRecord = {
    reportData: reportData || [],
    rawData: rawData || [],
    rawHeaders: rawHeaders || [],
    columnMap: columnMap || {},
    importacaoId: importId || null,
    nomeArquivo: nomeArquivo || null,
    updatedAt: new Date().toISOString()
  };
  expedicaoTimMemoryStore.relatorio = relRecord;

  // Salvar no MinIO
  saveExpedicaoMinio('relatorio-ativo.json', relRecord).catch(e => console.warn('[MinIO] Erro ao salvar relatorio-ativo:', e.message));

  try {
    await pool.query(`DELETE FROM expedicao_tim_relatorio`);
    await pool.query(
      `INSERT INTO expedicao_tim_relatorio (report_data, raw_data, raw_headers, column_map, total_linhas, usuario, importacao_id, nome_arquivo, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        JSON.stringify(reportData || []),
        JSON.stringify(rawData || []),
        JSON.stringify(rawHeaders || []),
        JSON.stringify(columnMap || {}),
        total,
        usuario || 'ADMIN',
        importId || null,
        nomeArquivo || null
      ]
    );

    res.json({ success: true, message: 'Relatório salvo com sucesso no banco de dados e MinIO!' });
  } catch (err) {
    console.warn('Banco offline ao salvar relatório (salvo no MinIO e contingência):', err.message);
    res.json({ success: true, message: 'Relatório salvo no MinIO e contingência!', offline: true });
  }
});

// 2.1 Histórico de Importações: Listar todas as importações e lotes vinculados
app.get('/api/expedicao-tim/importacoes', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT i.id, i.nome_arquivo, i.total_linhas, i.total_pallets, i.usuario, i.created_at, i.column_map,
              COALESCE(
                (SELECT json_agg(json_build_object(
                  'id', l.id,
                  'number', l.number,
                  'status', l.status,
                  'dest', l.dest,
                  'createdAt', l.created_at,
                  'totalPallets', (SELECT jsonb_array_length(l.groups))
                ))
                 FROM expedicao_tim_lotes l WHERE l.importacao_id = i.id),
                '[]'::json
              ) AS lotes
       FROM expedicao_tim_importacoes i
       ORDER BY i.created_at DESC`
    );
    if (result.rows && result.rows.length > 0) {
      return res.json({ success: true, importacoes: result.rows });
    }
  } catch (err) {
    console.warn('PostgreSQL offline ao buscar importações (consultando MinIO):', err.message);
  }

  // Fallback para MinIO index
  const minioIndex = await getExpedicaoMinio('importacoes/index.json');
  if (Array.isArray(minioIndex) && minioIndex.length > 0) {
    return res.json({ success: true, importacoes: minioIndex });
  }

  res.json({ success: true, importacoes: expedicaoTimMemoryStore.importacoes || [] });
});

// 2.2 Histórico de Importações: Obter detalhes e dados de uma importação específica
app.get('/api/expedicao-tim/importacoes/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT i.*,
              COALESCE(
                (SELECT json_agg(json_build_object(
                  'id', l.id,
                  'number', l.number,
                  'status', l.status,
                  'dest', l.dest,
                  'createdAt', l.created_at,
                  'groups', l.groups,
                  'expeditionData', l.expedition_data
                ))
                 FROM expedicao_tim_lotes l WHERE l.importacao_id = i.id),
                '[]'::json
              ) AS lotes
       FROM expedicao_tim_importacoes i
       WHERE i.id = $1`,
      [id]
    );

    if (result.rows.length > 0) {
      return res.json({ success: true, importacao: result.rows[0] });
    }
  } catch (err) {
    console.warn('PostgreSQL offline ao buscar detalhes da importação (consultando MinIO):', err.message);
  }

  // Buscar do MinIO
  const minioImp = await getExpedicaoMinio(`importacoes/${id}.json`);
  if (minioImp) {
    return res.json({ success: true, importacao: minioImp });
  }

  const mem = (expedicaoTimMemoryStore.importacoes || []).find(x => x.id === id);
  if (mem) return res.json({ success: true, importacao: mem });
  res.status(404).json({ error: 'Importação não encontrada.' });
});

// 2.3 Histórico de Importações: Salvar nova importação no histórico permanente (MinIO + DB)
app.post('/api/expedicao-tim/importacoes', async (req, res) => {
  const { id, nomeArquivo, reportData, rawData, rawHeaders, columnMap, totalLinhas, totalPallets, usuario } = req.body;
  const importId = id || ('IMP-' + Date.now());
  const totalLines = totalLinhas !== undefined ? totalLinhas : (Array.isArray(reportData) ? reportData.length : 0);
  const fileName = nomeArquivo || 'relatorio.xlsx';

  // Salvar em memória de contingência
  const memRecord = {
    id: importId,
    nome_arquivo: fileName,
    total_linhas: totalLines,
    total_pallets: totalPallets || 0,
    usuario: usuario || 'ADMIN',
    created_at: new Date().toISOString(),
    column_map: columnMap || {},
    raw_headers: rawHeaders || [],
    report_data: reportData || [],
    rawData: rawData || [],
    lotes: []
  };
  expedicaoTimMemoryStore.importacoes.unshift(memRecord);
  expedicaoTimMemoryStore.relatorio = {
    reportData: reportData || [],
    rawData: rawData || [],
    rawHeaders: rawHeaders || [],
    columnMap: columnMap || {},
    importacaoId: importId,
    nomeArquivo: fileName
  };

  // 1. Gravar no MinIO como arquivo JSON completo e imutável
  await saveExpedicaoMinio(`importacoes/${importId}.json`, memRecord);
  await saveExpedicaoMinio('relatorio-ativo.json', expedicaoTimMemoryStore.relatorio);

  // 2. Atualizar índice de importações no MinIO
  try {
    let indexData = await getExpedicaoMinio('importacoes/index.json');
    if (!Array.isArray(indexData)) indexData = [];
    indexData = indexData.filter(x => x.id !== importId);
    indexData.unshift({
      id: importId,
      nome_arquivo: fileName,
      total_linhas: totalLines,
      total_pallets: totalPallets || 0,
      usuario: usuario || 'ADMIN',
      created_at: memRecord.created_at,
      column_map: columnMap || {},
      lotes: []
    });
    await saveExpedicaoMinio('importacoes/index.json', indexData);
  } catch (idxErr) {
    console.warn('[MinIO Expedição] Erro ao atualizar índice de importações:', idxErr.message);
  }

  try {
    // 3. Gravar no PostgreSQL
    await pool.query(
      `INSERT INTO expedicao_tim_importacoes (id, nome_arquivo, total_linhas, total_pallets, usuario, created_at, column_map, raw_headers, report_data, raw_data)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         nome_arquivo = EXCLUDED.nome_arquivo,
         total_linhas = EXCLUDED.total_linhas,
         total_pallets = EXCLUDED.total_pallets,
         usuario = EXCLUDED.usuario,
         column_map = EXCLUDED.column_map,
         raw_headers = EXCLUDED.raw_headers,
         report_data = EXCLUDED.report_data,
         raw_data = EXCLUDED.raw_data`,
      [
        importId,
        fileName,
        totalLines,
        totalPallets || 0,
        usuario || 'ADMIN',
        JSON.stringify(columnMap || {}),
        JSON.stringify(rawHeaders || []),
        JSON.stringify(reportData || []),
        JSON.stringify(rawData || [])
      ]
    );

    // 4. Atualizar também expedicao_tim_relatorio como a planilha ativa no momento
    await pool.query(`DELETE FROM expedicao_tim_relatorio`);
    await pool.query(
      `INSERT INTO expedicao_tim_relatorio (report_data, raw_data, raw_headers, column_map, total_linhas, usuario, importacao_id, nome_arquivo, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        JSON.stringify(reportData || []),
        JSON.stringify(rawData || []),
        JSON.stringify(rawHeaders || []),
        JSON.stringify(columnMap || {}),
        totalLines,
        usuario || 'ADMIN',
        importId,
        fileName
      ]
    );

    res.json({ success: true, message: 'Importação salva no MinIO e PostgreSQL com sucesso!', importId });
  } catch (err) {
    console.warn('PostgreSQL offline ao salvar importação (salvo no MinIO):', err.message);
    res.json({ success: true, message: 'Importação salva no MinIO com sucesso!', importId, offline: true });
  }
});

// 2.4 Histórico de Importações: Reativar uma importação anterior como relatório ativo
app.post('/api/expedicao-tim/importacoes/:id/reativar', async (req, res) => {
  const { id } = req.params;
  let imp = null;

  try {
    const impRes = await pool.query(`SELECT * FROM expedicao_tim_importacoes WHERE id = $1`, [id]);
    if (impRes.rows.length > 0) imp = impRes.rows[0];
  } catch (dbErr) {
    console.warn('PostgreSQL offline ao buscar importação para reativação:', dbErr.message);
  }

  if (!imp) {
    imp = await getExpedicaoMinio(`importacoes/${id}.json`);
  }

  if (!imp) {
    imp = (expedicaoTimMemoryStore.importacoes || []).find(x => x.id === id);
  }

  if (!imp) {
    return res.status(404).json({ error: 'Importação não encontrada.' });
  }

  const reportData = imp.report_data || imp.reportData || [];
  const rawData = imp.raw_data || imp.rawData || [];
  const rawHeaders = imp.raw_headers || imp.rawHeaders || [];
  const columnMap = imp.column_map || imp.columnMap || {};
  const nomeArquivo = imp.nome_arquivo || imp.nomeArquivo || '';
  const totalLinhas = imp.total_linhas || imp.totalLinhas || reportData.length;

  expedicaoTimMemoryStore.relatorio = {
    reportData,
    rawData,
    rawHeaders,
    columnMap,
    importacaoId: imp.id,
    nomeArquivo
  };

  // Salvar no MinIO como relatório ativo
  saveExpedicaoMinio('relatorio-ativo.json', expedicaoTimMemoryStore.relatorio).catch(e => console.warn('[MinIO] Erro ao atualizar relatorio-ativo:', e.message));

  try {
    await pool.query(`DELETE FROM expedicao_tim_relatorio`);
    await pool.query(
      `INSERT INTO expedicao_tim_relatorio (report_data, raw_data, raw_headers, column_map, total_linhas, usuario, importacao_id, nome_arquivo, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        JSON.stringify(reportData),
        JSON.stringify(rawData),
        JSON.stringify(rawHeaders),
        JSON.stringify(columnMap),
        totalLinhas,
        imp.usuario || 'ADMIN',
        imp.id,
        nomeArquivo
      ]
    );
  } catch (pErr) {
    console.warn('PostgreSQL offline ao reativar (reativado no MinIO e memória):', pErr.message);
  }

  res.json({
    success: true,
    message: `Planilha "${nomeArquivo}" reativada com sucesso!`,
    reportData,
    rawData,
    rawHeaders,
    columnMap,
    nomeArquivo,
    importId: imp.id
  });
});

// 2.5 Histórico de Importações: Excluir um registro histórico
app.delete('/api/expedicao-tim/importacoes/:id', async (req, res) => {
  const { id } = req.params;
  const memIdx = (expedicaoTimMemoryStore.importacoes || []).findIndex(x => x.id === id);
  if (memIdx >= 0) expedicaoTimMemoryStore.importacoes.splice(memIdx, 1);

  // Deletar do MinIO
  deleteExpedicaoMinio(`importacoes/${id}.json`).catch(e => console.warn('[MinIO] Erro ao deletar importacao:', e.message));
  getExpedicaoMinio('importacoes/index.json').then(idx => {
    if (Array.isArray(idx)) {
      const filtered = idx.filter(x => x.id !== id);
      saveExpedicaoMinio('importacoes/index.json', filtered);
    }
  }).catch(() => {});

  try {
    await pool.query(`UPDATE expedicao_tim_lotes SET importacao_id = NULL WHERE importacao_id = $1`, [id]);
    await pool.query(`DELETE FROM expedicao_tim_importacoes WHERE id = $1`, [id]);
    res.json({ success: true, message: 'Registro de importação excluído com sucesso.' });
  } catch (err) {
    console.warn('PostgreSQL offline ao excluir importação (excluído do MinIO e memória):', err.message);
    res.json({ success: true, message: 'Registro de importação excluído do MinIO e memória.', offline: true });
  }
});

// 3. Limpar relatório importado
app.delete('/api/expedicao-tim/report', async (req, res) => {
  expedicaoTimMemoryStore.relatorio = null;
  deleteExpedicaoMinio('relatorio-ativo.json').catch(e => console.warn('[MinIO] Erro ao limpar relatorio-ativo:', e.message));
  try {
    await pool.query(`DELETE FROM expedicao_tim_relatorio`);
    res.json({ success: true, message: 'Relatório ativo removido com sucesso.' });
  } catch (err) {
    console.error('Error clearing expedicao-tim report:', err);
    res.json({ success: true, message: 'Relatório ativo removido do MinIO e memória.', offline: true });
  }
});

// 4. Salvar ou atualizar um Lote (com vínculo e persistência no MinIO)
app.post('/api/expedicao-tim/lote', async (req, res) => {
  const { id, number, dest, obs, status, createdAt, groups, expeditionData, usuario, importacaoId, importacaoArquivo } = req.body;
  if (!id) return res.status(400).json({ error: 'ID do lote é obrigatório.' });

  const lotObj = {
    id,
    number: number || 1,
    dest: dest || '',
    obs: obs || '',
    status: status || 'aberto',
    createdAt: createdAt || new Date().toLocaleString('pt-BR'),
    groups: groups || [],
    expeditionData: expeditionData || null,
    usuario: usuario || 'ADMIN',
    importacaoId: importacaoId || null,
    importacaoArquivo: importacaoArquivo || null,
    updatedAt: new Date().toISOString()
  };

  const memIdx = (expedicaoTimMemoryStore.lotes || []).findIndex(l => l.id === id);
  if (memIdx >= 0) {
    expedicaoTimMemoryStore.lotes[memIdx] = lotObj;
  } else {
    expedicaoTimMemoryStore.lotes.push(lotObj);
  }

  // 1. Salvar no MinIO como arquivo individual do lote
  await saveExpedicaoMinio(`lotes/${id}.json`, lotObj);

  // 2. Salvar no PostgreSQL
  try {
    await pool.query(
      `INSERT INTO expedicao_tim_lotes (id, number, dest, obs, status, created_at, groups, expedition_data, usuario, importacao_id, importacao_arquivo, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       ON CONFLICT (id) DO UPDATE SET
         number = EXCLUDED.number,
         dest = EXCLUDED.dest,
         obs = EXCLUDED.obs,
         status = EXCLUDED.status,
         created_at = EXCLUDED.created_at,
         groups = EXCLUDED.groups,
         expedition_data = EXCLUDED.expedition_data,
         usuario = EXCLUDED.usuario,
         importacao_id = COALESCE(EXCLUDED.importacao_id, expedicao_tim_lotes.importacao_id),
         importacao_arquivo = COALESCE(EXCLUDED.importacao_arquivo, expedicao_tim_lotes.importacao_arquivo),
         updated_at = NOW()`,
      [
        id,
        number || 1,
        dest || '',
        obs || '',
        status || 'aberto',
        createdAt || new Date().toLocaleString('pt-BR'),
        JSON.stringify(groups || []),
        expeditionData ? JSON.stringify(expeditionData) : null,
        usuario || 'ADMIN',
        importacaoId || null,
        importacaoArquivo || null
      ]
    );

    res.json({ success: true, message: 'Lote salvo com sucesso no MinIO e banco de dados!' });
  } catch (err) {
    console.warn('PostgreSQL offline ao salvar lote (salvo no MinIO):', err.message);
    res.json({ success: true, message: 'Lote salvo no MinIO com sucesso!', offline: true });
  }
});

// 4.1 Expedir Lote e Atualizar Status das Unidades para 'Expedida' (MinIO + PostgreSQL)
app.post('/api/expedicao-tim/lote/:id/expedir', async (req, res) => {
  try {
    const { id } = req.params;
    const { expeditionData, serials, pallets } = req.body;
    if (!id) return res.status(400).json({ error: 'ID do lote é obrigatório.' });

    // 1. Atualizar no MinIO
    let lot = await getExpedicaoMinio(`lotes/${id}.json`);
    if (!lot) {
      lot = (expedicaoTimMemoryStore.lotes || []).find(l => l.id === id);
    }
    if (lot) {
      lot.status = 'expedido';
      lot.expeditionData = expeditionData || null;
      lot.updatedAt = new Date().toISOString();
      await saveExpedicaoMinio(`lotes/${id}.json`, lot);
    }

    // Atualizar memória
    const memL = (expedicaoTimMemoryStore.lotes || []).find(l => l.id === id);
    if (memL) {
      memL.status = 'expedido';
      memL.expeditionData = expeditionData || null;
    }

    // 2. Atualizar status do lote para expedido no PostgreSQL
    try {
      await pool.query(
        `UPDATE expedicao_tim_lotes
         SET status = 'expedido',
             expedition_data = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [expeditionData ? JSON.stringify(expeditionData) : null, id]
      );
    } catch (pgErr) {
      console.warn('PostgreSQL offline ao atualizar status do lote (salvo no MinIO):', pgErr.message);
    }

    // 3. Coletar seriais para atualizar em recebimentos
    let targetSerials = Array.isArray(serials) ? serials.map(s => String(s).trim().toUpperCase()).filter(Boolean) : [];

    // Se seriais não foram enviados no body, tenta buscar do report_data associado aos pallets do lote
    if (targetSerials.length === 0 && Array.isArray(pallets) && pallets.length > 0) {
      try {
        const repRes = await pool.query(`SELECT report_data FROM expedicao_tim_relatorio ORDER BY id DESC LIMIT 1`);
        if (repRes.rows.length > 0 && Array.isArray(repRes.rows[0].report_data)) {
          const pSet = new Set(pallets.map(p => String(p).trim().toUpperCase()));
          repRes.rows[0].report_data.forEach(r => {
            if (r.palletId && pSet.has(String(r.palletId).trim().toUpperCase()) && r.serial) {
              targetSerials.push(String(r.serial).trim().toUpperCase());
            }
          });
        }
      } catch (repErr) {}
    }

    const loteIdent = (expeditionData && expeditionData.loteIdent) ? expeditionData.loteIdent : id;
    const dataExp = (expeditionData && expeditionData.expedidoEm) ? new Date(expeditionData.expedidoEm) : new Date();

    let updatedCount = 0;
    if (targetSerials.length > 0) {
      try {
        const updRes = await pool.query(
          `UPDATE recebimentos
           SET status = 'Expedida',
               lote_expedicao = $1,
               data_expedicao = $2
           WHERE (
             (serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = ANY($3))
             OR (mac IS NOT NULL AND mac != '' AND UPPER(TRIM(mac)) = ANY($3))
             OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = ANY($3))
           )
           AND status != 'Expedida'`,
          [loteIdent, dataExp, targetSerials]
        );
        updatedCount = updRes.rowCount;
      } catch (recErr) {
        console.warn('Erro ao atualizar status em recebimentos:', recErr.message);
      }
    }

    res.json({
      success: true,
      message: `Lote expedido com sucesso no MinIO e banco! ${updatedCount} unidades atualizadas para status 'Expedida'.`,
      updatedUnits: updatedCount
    });
  } catch (err) {
    console.error('Erro ao expedir lote na Expedição TIM:', err);
    res.status(500).json({ error: 'Erro ao expedir lote.' });
  }
});

// 4.2 Estornar Expedição do Lote e Reverter Status das Unidades para 'Recebida'
app.post('/api/expedicao-tim/lote/:id/estornar', async (req, res) => {
  try {
    const { id } = req.params;
    const { loteIdent, serials } = req.body;
    if (!id) return res.status(400).json({ error: 'ID do lote é obrigatório.' });

    // 1. Atualizar no MinIO
    let lot = await getExpedicaoMinio(`lotes/${id}.json`);
    if (!lot) {
      lot = (expedicaoTimMemoryStore.lotes || []).find(l => l.id === id);
    }
    if (lot) {
      lot.status = 'finalizado';
      lot.updatedAt = new Date().toISOString();
      await saveExpedicaoMinio(`lotes/${id}.json`, lot);
    }

    const memL = (expedicaoTimMemoryStore.lotes || []).find(l => l.id === id);
    if (memL) {
      memL.status = 'finalizado';
    }

    // 2. Atualizar status do lote de volta para finalizado no PostgreSQL
    try {
      await pool.query(
        `UPDATE expedicao_tim_lotes
         SET status = 'finalizado',
             updated_at = NOW()
         WHERE id = $1`,
        [id]
      );
    } catch (pgErr) {
      console.warn('PostgreSQL offline ao estornar lote (estornado no MinIO):', pgErr.message);
    }

    // 3. Reverter status das unidades em recebimentos de 'Expedida' de volta para 'Recebida'
    const targetIdent = loteIdent || id;
    let targetSerials = Array.isArray(serials) ? serials.map(s => String(s).trim().toUpperCase()).filter(Boolean) : [];

    let revertedCount = 0;
    try {
      let updRes;
      if (targetSerials.length > 0) {
        updRes = await pool.query(
          `UPDATE recebimentos
           SET status = 'Recebida',
               lote_expedicao = NULL,
               data_expedicao = NULL
           WHERE (lote_expedicao = $1 OR UPPER(TRIM(serial_number)) = ANY($2))
             AND status = 'Expedida'`,
          [targetIdent, targetSerials]
        );
      } else {
        updRes = await pool.query(
          `UPDATE recebimentos
           SET status = 'Recebida',
               lote_expedicao = NULL,
               data_expedicao = NULL
           WHERE lote_expedicao = $1 AND status = 'Expedida'`,
          [targetIdent]
        );
      }
      revertedCount = updRes.rowCount;
    } catch (recErr) {
      console.warn('Erro ao reverter status em recebimentos:', recErr.message);
    }

    res.json({
      success: true,
      message: `Expedição do lote estornada no MinIO e banco! ${revertedCount} unidades retornadas para status 'Recebida'.`,
      revertedUnits: revertedCount
    });
  } catch (err) {
    console.error('Erro ao estornar expedição do lote:', err);
    res.status(500).json({ error: 'Erro ao estornar lote.' });
  }
});

// 5. Excluir um Lote (MinIO + PostgreSQL)
app.delete('/api/expedicao-tim/lote/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const memIdx = (expedicaoTimMemoryStore.lotes || []).findIndex(l => l.id === id);
    if (memIdx >= 0) expedicaoTimMemoryStore.lotes.splice(memIdx, 1);

    // Excluir do MinIO
    deleteExpedicaoMinio(`lotes/${id}.json`).catch(e => console.warn('[MinIO] Erro ao excluir lote:', e.message));

    // Excluir do PostgreSQL
    try {
      await pool.query(`DELETE FROM expedicao_tim_lotes WHERE id = $1`, [id]);
    } catch (pgErr) {
      console.warn('PostgreSQL offline ao excluir lote (excluído do MinIO):', pgErr.message);
    }

    res.json({ success: true, message: 'Lote excluído com sucesso do MinIO e banco de dados.' });
  } catch (err) {
    console.error('Error deleting expedicao-tim lote:', err);
    res.status(500).json({ error: 'Erro ao excluir lote.' });
  }
});

// 6. Sincronização completa (sync-all no MinIO + PostgreSQL)
app.post('/api/expedicao-tim/sync-all', async (req, res) => {
  const { reportData, rawData, rawHeaders, columnMap, lots, lastResponsavel, usuario, currentImportId, currentImportFilename } = req.body;

  // Atualizar memória de contingência
  if (Array.isArray(lots)) expedicaoTimMemoryStore.lotes = lots;
  if (reportData !== undefined) {
    expedicaoTimMemoryStore.relatorio = {
      reportData: reportData || [],
      rawData: rawData || [],
      rawHeaders: rawHeaders || [],
      columnMap: columnMap || {},
      importacaoId: currentImportId || null,
      nomeArquivo: currentImportFilename || null
    };
  }
  if (lastResponsavel) expedicaoTimMemoryStore.config.last_responsavel = lastResponsavel;

  // 1. Gravar snapshot completo no MinIO (state.json e lotes individuais)
  saveExpedicaoMinio('state.json', {
    reportData: reportData || [],
    rawData: rawData || [],
    rawHeaders: rawHeaders || [],
    columnMap: columnMap || {},
    lots: lots || [],
    lastResponsavel: lastResponsavel || '',
    currentImportId: currentImportId || null,
    currentImportFilename: currentImportFilename || null,
    updatedAt: new Date().toISOString()
  }).catch(e => console.warn('[MinIO] Erro no sync-all ao salvar state.json:', e.message));

  if (Array.isArray(lots)) {
    lots.forEach(l => {
      if (l && l.id) {
        saveExpedicaoMinio(`lotes/${l.id}.json`, l).catch(e => console.warn(`[MinIO] Erro ao salvar lote ${l.id}:`, e.message));
      }
    });
  }

  // 2. Gravar no PostgreSQL
  let client;
  try {
    client = await pool.connect();
  } catch (connErr) {
    console.warn('PostgreSQL offline no sync-all (dados preservados com segurança no MinIO):', connErr.message);
    return res.json({ success: true, message: 'Dados salvos no MinIO com segurança!', offline: true });
  }

  try {
    await client.query('BEGIN');

    if (reportData !== undefined) {
      await client.query(`DELETE FROM expedicao_tim_relatorio`);
      await client.query(
        `INSERT INTO expedicao_tim_relatorio (report_data, raw_data, raw_headers, column_map, total_linhas, usuario, importacao_id, nome_arquivo, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          JSON.stringify(reportData || []),
          JSON.stringify(rawData || []),
          JSON.stringify(rawHeaders || []),
          JSON.stringify(columnMap || {}),
          Array.isArray(reportData) ? reportData.length : 0,
          usuario || 'ADMIN',
          currentImportId || null,
          currentImportFilename || null
        ]
      );
    }

    if (Array.isArray(lots)) {
      const lotIds = lots.map(l => l.id).filter(Boolean);
      if (lotIds.length > 0) {
        await client.query(`DELETE FROM expedicao_tim_lotes WHERE NOT (id = ANY($1))`, [lotIds]);
      } else {
        await client.query(`DELETE FROM expedicao_tim_lotes`);
      }

      for (const l of lots) {
        if (!l.id) continue;
        await client.query(
          `INSERT INTO expedicao_tim_lotes (id, number, dest, obs, status, created_at, groups, expedition_data, usuario, importacao_id, importacao_arquivo, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
           ON CONFLICT (id) DO UPDATE SET
             number = EXCLUDED.number,
             dest = EXCLUDED.dest,
             obs = EXCLUDED.obs,
             status = EXCLUDED.status,
             created_at = EXCLUDED.created_at,
             groups = EXCLUDED.groups,
             expedition_data = EXCLUDED.expedition_data,
             usuario = EXCLUDED.usuario,
             importacao_id = COALESCE(EXCLUDED.importacao_id, expedicao_tim_lotes.importacao_id),
             importacao_arquivo = COALESCE(EXCLUDED.importacao_arquivo, expedicao_tim_lotes.importacao_arquivo),
             updated_at = NOW()`,
          [
            l.id,
            l.number || 1,
            l.dest || '',
            l.obs || '',
            l.status || 'aberto',
            l.createdAt || new Date().toLocaleString('pt-BR'),
            JSON.stringify(l.groups || []),
            l.expeditionData ? JSON.stringify(l.expeditionData) : null,
            usuario || 'ADMIN',
            l.importacaoId || null,
            l.importacaoArquivo || null
          ]
        );
      }
    }

    if (lastResponsavel) {
      await client.query(
        `INSERT INTO expedicao_tim_config (key, value, updated_at)
         VALUES ('last_responsavel', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [JSON.stringify(lastResponsavel)]
      );
    }

    // Sincroniza status 'Expedida' em recebimentos para todos os lotes marcados como 'expedido'
    if (Array.isArray(lots) && Array.isArray(reportData) && reportData.length > 0) {
      const expedidoLots = lots.filter(l => l && l.status === 'expedido');
      if (expedidoLots.length > 0) {
        for (const expLot of expedidoLots) {
          const expPallets = new Set((expLot.groups || []).flatMap(g => (g.palletIds || []).map(p => String(p).trim().toUpperCase())));
          const expSerials = [];
          reportData.forEach(r => {
            if (r.palletId && expPallets.has(String(r.palletId).trim().toUpperCase()) && r.serial) {
              expSerials.push(String(r.serial).trim().toUpperCase());
            }
          });
          if (expSerials.length > 0) {
            const loteIdent = (expLot.expeditionData && expLot.expeditionData.loteIdent) ? expLot.expeditionData.loteIdent : (expLot.number ? `Lote #${expLot.number}` : expLot.id);
            const dataExp = (expLot.expeditionData && expLot.expeditionData.expedidoEm) ? new Date(expLot.expeditionData.expedidoEm) : new Date();
            await client.query(
              `UPDATE recebimentos
               SET status = 'Expedida',
                   lote_expedicao = COALESCE(lote_expedicao, $1),
                   data_expedicao = COALESCE(data_expedicao, $2)
               WHERE (
                 (serial_number IS NOT NULL AND serial_number != '' AND UPPER(TRIM(serial_number)) = ANY($3))
                 OR (mac IS NOT NULL AND mac != '' AND UPPER(TRIM(mac)) = ANY($3))
                 OR (gpon_id IS NOT NULL AND gpon_id != '' AND UPPER(TRIM(gpon_id)) = ANY($3))
               )
               AND status != 'Expedida'`,
              [loteIdent, dataExp, expSerials]
            );
          }
        }
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Dados da Expedição TIM sincronizados com sucesso no MinIO e banco de dados!' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error syncing all expedicao-tim data in Postgres:', err);
    res.status(500).json({ error: 'Erro ao sincronizar dados no banco de dados.' });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Unified server listening on port ${PORT}`));

