/*
 * Backend API for the tenant management system.
 *
 * This server uses Express to handle HTTP requests and mysql2 to connect to a
 * MySQL database. The database is created on startup if it does not already
 * exist, along with the necessary tables for tenants, scanned packages and
 * reports.
 *
 * The API provides endpoints to create, read, update and delete tenants,
 * associate scanned packages with tenants, and generate a simple summary
 * report.  Connection pooling is used to improve performance.
 */

const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const cron = require('node-cron');
const config = require('./config');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const { Client } = require('ssh2');

const app = express();
const server = http.createServer(app);

// WebSocket Server
const wss = new WebSocket.Server({ server });

// Track WebSocket clients
const clients = new Set();

// In-memory log storage for OCR activities
const ocrLogs = [];
const MAX_LOGS = 500;
const SYSTEM_LOG_CACHE_MS = 8000;
const systemLogCache = {
  updatedAt: 0,
  logs: [],
};

function addOCRLog(message) {
  const logEntry = {
    time: new Date().toISOString(),
    message: message
  };
  ocrLogs.push(logEntry);
  
  // Keep only recent logs
  if (ocrLogs.length > MAX_LOGS) {
    ocrLogs.shift();
  }
  
  console.log(`[OCR] ${message}`);
}

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('[WebSocket] Client connected. Total:', clients.size);
  
  ws.on('close', () => {
    clients.delete(ws);
    console.log('[WebSocket] Client disconnected. Total:', clients.size);
  });
});

// Broadcast to all connected clients
function broadcast(type, data) {
  const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Use configuration from config.js
const { server: serverConfig, database, corsConfig = {} } = config;
const port = serverConfig.port;

// Setup CORS with config
app.use(cors(config.cors));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve static files for uploaded images
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));

// Create connection pool using database config
const pool = mysql.createPool(database);

async function initializeDatabase() {
  const connection = await pool.getConnection();
  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS tenant_management_db DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await connection.query(`USE tenant_management_db`);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        address VARCHAR(255) NOT NULL,
        room VARCHAR(50) NOT NULL,
        phone VARCHAR(50) NOT NULL,
        tag VARCHAR(100) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);
    // Add tag column if not exists
    await connection.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tag VARCHAR(100) DEFAULT NULL AFTER phone`).catch(() => {});
    await connection.query(`
      CREATE TABLE IF NOT EXISTS scanned_packages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        recipient_name VARCHAR(255),
        address VARCHAR(255),
        phone VARCHAR(50),
        image_path VARCHAR(500),
        raw_text TEXT,
        tenant_id INT DEFAULT NULL,
        scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
      ) ENGINE=InnoDB;
    `);
    // Add new columns if they don't exist (for existing databases)
    await connection.query(`
      ALTER TABLE scanned_packages 
      ADD COLUMN IF NOT EXISTS phone VARCHAR(50) AFTER address,
      ADD COLUMN IF NOT EXISTS image_path VARCHAR(500) AFTER phone,
      ADD COLUMN IF NOT EXISTS raw_text TEXT AFTER image_path,
      ADD COLUMN IF NOT EXISTS scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP AFTER tenant_id
    `).catch(() => {});
    await connection.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id INT AUTO_INCREMENT PRIMARY KEY,
        type VARCHAR(100),
        date DATE,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB;
    `);
    console.log('Database and tables ready');
  } catch (err) {
    console.error('Error initializing database:', err);
  } finally {
    connection.release();
  }
}

initializeDatabase().catch((err) => {
  console.error('Initialization failed:', err);
});

// Tenant endpoints
app.get('/api/tenants', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tenants');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve tenants' });
  }
});

app.get('/api/tenants/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tenants WHERE id = ?', [req.params.id]);
    if (rows.length > 0) {
      res.json(rows[0]);
    } else {
      res.status(404).json({ error: 'Tenant not found' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve tenant' });
  }
});

app.post('/api/tenants', async (req, res) => {
  const { name, address, room, phone, tag } = req.body;
  if (!name || !address || !room || !phone) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const [result] = await pool.query(
      'INSERT INTO tenants (name, address, room, phone, tag) VALUES (?, ?, ?, ?, ?)',
      [name, address, room, phone, tag || null]
    );
    const [rows] = await pool.query('SELECT * FROM tenants WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create tenant' });
  }
});

app.put('/api/tenants/:id', async (req, res) => {
  const { name, address, room, phone, tag } = req.body;
  try {
    await pool.query(
      'UPDATE tenants SET name = ?, address = ?, room = ?, phone = ?, tag = ? WHERE id = ?',
      [name, address, room, phone, tag || null, req.params.id]
    );
    const [rows] = await pool.query('SELECT * FROM tenants WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update tenant' });
  }
});

app.delete('/api/tenants/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM tenants WHERE id = ?', [req.params.id]);
    res.json({ message: 'Tenant deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete tenant' });
  }
});

// Scanned packages endpoints
app.get('/api/scanned-packages', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT sp.id, sp.recipient_name, sp.address, sp.phone, sp.image_path, sp.raw_text, 
              sp.tenant_id, t.name AS tenant_name, t.room AS tenant_room, t.tag AS tenant_tag, t.address AS tenant_address, sp.scanned_at, sp.created_at
       FROM scanned_packages sp
       LEFT JOIN tenants t ON sp.tenant_id = t.id
       ORDER BY sp.scanned_at DESC`
    );
    const packages = rows.map((row) => ({
      id: row.id,
      recipientName: row.recipient_name,
      address: row.address,
      phone: row.phone,
      imagePath: row.image_path,
      rawText: row.raw_text,
      tenant: row.tenant_id ? { id: row.tenant_id, name: row.tenant_name, room: row.tenant_room, tag: row.tenant_tag, address: row.tenant_address || null } : null,
      scannedAt: row.scanned_at,
      created_at: row.created_at,
    }));
    res.json(packages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve packages' });
  }
});

app.post('/api/scanned-packages', async (req, res) => {
  const { recipientName, address } = req.body;
  if (!recipientName || !address) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const [result] = await pool.query(
      'INSERT INTO scanned_packages (recipient_name, address) VALUES (?, ?)',
      [recipientName, address]
    );
    const [rows] = await pool.query('SELECT * FROM scanned_packages WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create scanned package' });
  }
});

// NEW: Match OCR text to tenant using LIKE search
app.post('/api/ocr/match-tenant', async (req, res) => {
  const { rawText } = req.body;
  if (!rawText) {
    return res.status(400).json({ error: 'Missing rawText field' });
  }

  const connection = await pool.getConnection();
  try {
    // ค้นหา tenant ที่ชื่อมี text บ้าง หรือ text ประกอบด้วย name
    const [tenants] = await connection.query(
      `SELECT id, name, room, phone, tag FROM tenants 
       WHERE name LIKE ? OR ? LIKE CONCAT('%', name, '%')
       LIMIT 1`,
      [`%${rawText}%`, rawText]
    );

    if (tenants.length > 0) {
      const tenant = tenants[0];
      addOCRLog(`✅ Found tenant: ${tenant.name} (room: ${tenant.room})`);
      res.json({
        found: true,
        name: tenant.name,
        room: tenant.room,
        phone: tenant.phone,
        tag: tenant.tag || null,
        tenantId: tenant.id
      });
    } else {
      addOCRLog(`⚠️ No tenant found for text: ${rawText.substring(0, 50)}...`);
      res.json({
        found: false,
        name: null,
        room: null,
        phone: null,
        tag: null,
        tenantId: null
      });
    }
  } catch (err) {
    console.error('[OCR Match] Error:', err);
    res.status(500).json({ error: 'Database query failed' });
  } finally {
    connection.release();
  }
});

// NEW: OCR Package endpoint - receives data from Raspberry Pi
app.post('/api/ocr-package', async (req, res) => {
  const { recipientName, address, phone, rawText, imageBase64 } = req.body;
  
  if (!recipientName && !rawText) {
    return res.status(400).json({ error: 'Missing required fields (recipientName or rawText)' });
  }
  
  addOCRLog(`📸 Scanning new package: ${recipientName || 'Unknown'}...`);

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    
    // Save image if provided
    let imagePath = null;
    if (imageBase64) {
      const timestamp = Date.now();
      const filename = `package_${timestamp}.jpg`;
      const fullPath = path.join(uploadsDir, filename);
      
      // Remove data URL prefix if present
      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(fullPath, Buffer.from(base64Data, 'base64'));
      imagePath = `/uploads/${filename}`;
    }
    
    // Try to find matching tenant by name using LIKE
    let tenantId = null;
    let matchedTenant = null;
    
    if (recipientName) {
      // Search for tenant with similar name
      const [tenants] = await connection.query(
        `SELECT * FROM tenants WHERE name LIKE ? OR ? LIKE CONCAT('%', name, '%') LIMIT 1`,
        [`%${recipientName}%`, recipientName]
      );
      
      if (tenants.length > 0) {
        tenantId = tenants[0].id;
        matchedTenant = tenants[0];
        console.log(`Matched tenant: ${matchedTenant.name} (ID: ${tenantId})`);
      } else {
        // ไม่สร้าง tenant ใหม่อัตโนมัติ - ให้เพิ่มผ่านหน้าจัดการเท่านั้น
        console.log(`No matching tenant found for: ${recipientName}. Package will be saved without tenant.`);
      }
    }
    
    // Insert scanned package
    const [packageResult] = await connection.query(
      `INSERT INTO scanned_packages 
       (recipient_name, address, phone, image_path, raw_text, tenant_id, scanned_at) 
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [recipientName || 'ไม่ระบุ', address || 'ไม่ระบุ', phone || null, imagePath, rawText || null, tenantId]
    );
    
    await connection.commit();
    
    // Fetch the created package
    const [packages] = await connection.query(
      `SELECT sp.*, t.name AS tenant_name, t.tag AS tenant_tag
       FROM scanned_packages sp 
       LEFT JOIN tenants t ON sp.tenant_id = t.id 
       WHERE sp.id = ?`,
      [packageResult.insertId]
    );
    
    const pkg = packages[0];
    
    // Add log entry
    if (tenantId && matchedTenant) {
      addOCRLog(`✅ Matched to: ${matchedTenant.name} (${matchedTenant.room})`);
    } else {
      addOCRLog(`⏳ Package saved - waiting for tenant match`);
    }
    
    // Broadcast to WebSocket clients
    broadcast('new_package', {
      id: pkg.id,
      recipientName: pkg.recipient_name,
      address: pkg.address,
      phone: pkg.phone,
      imagePath: pkg.image_path,
      tenant: tenantId ? { id: tenantId, name: matchedTenant.name, tag: matchedTenant.tag } : null,
      scannedAt: pkg.scanned_at,
    });
    
    res.status(201).json({
      success: true,
      message: matchedTenant ? `จับคู่กับผู้เช่า: ${matchedTenant.name}` : 'บันทึกข้อมูลสำเร็จ (ไม่พบผู้เช่าที่ตรงกัน)',
      package: {
        id: pkg.id,
        recipientName: pkg.recipient_name,
        address: pkg.address,
        phone: pkg.phone,
        imagePath: pkg.image_path,
        rawText: pkg.raw_text,
        tenant: tenantId ? { id: tenantId, name: matchedTenant.name, tag: matchedTenant.tag } : null,
        scannedAt: pkg.scanned_at,
      },
      isNewTenant: false,
    });
  } catch (err) {
    await connection.rollback();
    addOCRLog(`❌ Error: ${err.message}`);
    console.error('Error in /api/ocr-package:', err);
    res.status(500).json({ error: 'Failed to process OCR package', details: err.message });
  } finally {
    connection.release();
  }
});

app.put('/api/scanned-packages/:id/match/:tenantId', async (req, res) => {
  try {
    await pool.query('UPDATE scanned_packages SET tenant_id = ? WHERE id = ?', [req.params.tenantId, req.params.id]);
    const [rows] = await pool.query('SELECT * FROM scanned_packages WHERE id = ?', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to match package to tenant' });
  }
});

// Reports endpoint
app.get('/api/reports', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, type, date, description, created_at 
       FROM reports 
       ORDER BY date DESC, created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve reports' });
  }
});

app.get('/api/reports/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM reports WHERE id = ?', [req.params.id]);
    if (rows.length > 0) {
      res.json(rows[0]);
    } else {
      res.status(404).json({ error: 'Report not found' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve report' });
  }
});

app.post('/api/reports', async (req, res) => {
  const { type, date, description } = req.body;
  if (!type || !date || !description) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const [result] = await pool.query(
      'INSERT INTO reports (type, date, description) VALUES (?, ?, ?)',
      [type, date, description]
    );
    const [rows] = await pool.query('SELECT * FROM reports WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create report' });
  }
});

app.delete('/api/reports/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM reports WHERE id = ?', [req.params.id]);
    res.json({ message: 'Report deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete report' });
  }
});

// Auto-delete packages older than 1 month (runs daily at 2 AM)
cron.schedule('0 2 * * *', async () => {
  try {
    const connection = await pool.getConnection();
    const oneMonthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const result = await connection.query(
      'DELETE FROM scanned_packages WHERE scanned_time < ?',
      [oneMonthAgo]
    );
    connection.release();
    console.log(`[AUTO-DELETE] Deleted ${result[0].affectedRows} packages older than 1 month`);
  } catch (err) {
    console.error('[AUTO-DELETE] Error:', err);
  }
});

// ========== Pi Control API ==========
// Configuration for Raspberry Pi SSH connection
const PI_CONFIG = {
  host: process.env.PI_HOST || '192.168.1.132',
  port: parseInt(process.env.PI_SSH_PORT) || 22,
  username: process.env.PI_USER || 'admin',
  password: process.env.PI_PASSWORD || 'pipi123',
};

// Execute SSH command on Raspberry Pi using ssh2 client
async function executeSSHCommand(command, timeoutMs = 20000) {
  const { host, port, username, password } = PI_CONFIG;

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = '';
    let errorOutput = '';
    let settled = false;

    const finalize = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      conn.end();
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    const timeoutId = setTimeout(() => {
      finalize(new Error('SSH command timeout'));
    }, timeoutMs);

    conn
      .on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            finalize(err);
            return;
          }

          stream
            .on('close', (code) => {
              finalize(null, {
                code: typeof code === 'number' ? code : 0,
                output,
                errorOutput,
              });
            })
            .on('data', (data) => {
              output += data.toString();
            });

          stream.stderr.on('data', (data) => {
            errorOutput += data.toString();
          });
        });
      })
      .on('error', (err) => {
        finalize(err);
      })
      .connect({
        host,
        port,
        username,
        password,
        readyTimeout: 5000,
      });
  });
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function extractSystemErrorLogs(journalOutput) {
  const lines = (journalOutput || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const errorPatterns = [
    /unauthenticated/i,
    /account_state_invalid/i,
    /traceback/i,
    /exception/i,
    /error:/i,
    /grpc\._channel/i,
    /google\.api_core\.exceptions/i,
    /vision\.googleapis\.com/i,
  ];

  const extracted = [];
  for (const line of lines) {
    if (!errorPatterns.some((pattern) => pattern.test(line))) {
      continue;
    }

    const match = line.match(/^([A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2})\s+[^\s]+\s+[^:]+:\s*(.*)$/);
    if (match) {
      extracted.push({
        time: match[1],
        message: `[SYSTEM] ${match[2]}`,
        source: 'system',
      });
    } else {
      extracted.push({
        time: new Date().toISOString(),
        message: `[SYSTEM] ${line}`,
        source: 'system',
      });
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const log of extracted) {
    const key = `${log.time}|${log.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(log);
  }

  return deduped.slice(-120);
}

async function getPiSystemErrorLogs() {
  const now = Date.now();
  if (now - systemLogCache.updatedAt < SYSTEM_LOG_CACHE_MS) {
    return systemLogCache.logs;
  }

  const journalResult = await executeSSHCommand('journalctl -u ocr.service --no-pager -n 220 2>/dev/null || true');
  const logs = extractSystemErrorLogs(journalResult.output || '');

  systemLogCache.updatedAt = now;
  systemLogCache.logs = logs;
  return logs;
}

// Speak on Pi via TTS
app.post('/api/pi/speak', async (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'Missing text parameter' });
  }
  try {
    // Create Python script to speak the text using gTTS (run in background)
    const escapedText = text.replace(/'/g, "\\'").replace(/"/g, '\\"');
    const command = `nohup python3 -c "
from gtts import gTTS
import subprocess
import os
tts = gTTS(text='${escapedText}', lang='th')
tts.save('/tmp/speak_remote.mp3')
env = os.environ.copy()
env['XDG_RUNTIME_DIR'] = '/run/user/1000'
volume = 80
try:
  import json
  with open('/home/admin/percel/volume_config.json', 'r', encoding='utf-8') as f:
    volume = int(json.load(f).get('volume', 80))
except Exception:
  volume = 80
volume = max(0, min(100, volume))
subprocess.run(['mpv', '--no-video', '--speed=1.5', '--ao=alsa', f'--volume={volume}', '/tmp/speak_remote.mp3'], env=env)
" > /dev/null 2>&1 &
echo "Speak started"`;
    const result = await executeSSHCommand(command);
    res.json({ success: true, message: 'Speak command sent' });
  } catch (err) {
    console.error('Error speaking on Pi:', err);
    res.status(500).json({ error: 'Failed to speak on Pi', details: err.message });
  }
});

// Send a Telegram test message using Pi OCR service credentials
app.post('/api/pi/telegram/test', async (req, res) => {
  const { message } = req.body || {};
  const textToSend = (message && String(message).trim()) || `🧪 Telegram test from Tenant Manager (${new Date().toLocaleString('th-TH')})`;

  try {
    const safeMessage = shellSingleQuote(textToSend);
    const command = [
      "token=$(systemctl show ocr.service --property=Environment --value 2>/dev/null | tr ' ' '\\n' | grep '^TELEGRAM_BOT_TOKEN=' | head -1 | cut -d= -f2-)",
      "chat=$(systemctl show ocr.service --property=Environment --value 2>/dev/null | tr ' ' '\\n' | grep '^TELEGRAM_CHAT_ID=' | head -1 | cut -d= -f2-)",
      "if [ -z \"$token\" ]; then token=$(grep -oP '^Environment=TELEGRAM_BOT_TOKEN=\\K.*' /etc/systemd/system/ocr.service 2>/dev/null | tail -1); fi",
      "if [ -z \"$chat\" ]; then chat=$(grep -oP '^Environment=TELEGRAM_CHAT_ID=\\K.*' /etc/systemd/system/ocr.service 2>/dev/null | tail -1); fi",
      `msg=${safeMessage}`,
      "if [ -z \"$token\" ] || [ -z \"$chat\" ]; then echo '{\"ok\":false,\"description\":\"Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in ocr.service\"}'; exit 0; fi",
      "resp=$(curl -sS -X POST \"https://api.telegram.org/bot${token}/sendMessage\" --data-urlencode \"chat_id=${chat}\" --data-urlencode \"text=${msg}\" 2>/dev/null || echo '{\"ok\":false,\"description\":\"Failed to call Telegram API\"}')",
      "echo \"$resp\"",
    ].join(' ; ');

    const result = await executeSSHCommand(command);
    const lines = (result.output || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1] || '{}';

    let telegramResult;
    try {
      telegramResult = JSON.parse(lastLine);
    } catch {
      telegramResult = { ok: false, description: `Unexpected Telegram response: ${lastLine}` };
    }

    if (!telegramResult.ok) {
      addOCRLog(`❌ Telegram test failed: ${telegramResult.description || 'Unknown error'}`);
      return res.status(500).json({
        success: false,
        error: telegramResult.description || 'Telegram send failed',
        telegram: telegramResult,
      });
    }

    addOCRLog('📨 Telegram test message sent successfully');
    return res.json({
      success: true,
      message: 'Telegram test sent successfully',
      telegram: telegramResult,
    });
  } catch (err) {
    addOCRLog(`❌ Telegram test failed: ${err.message}`);
    console.error('Error sending Telegram test:', err);
    return res.status(500).json({ error: 'Failed to send Telegram test', details: err.message });
  }
});

// Capture image -> run Google OCR -> send OCR text to Telegram
app.post('/api/pi/capture-telegram', async (req, res) => {
  try {
    const statusResult = await executeSSHCommand('systemctl is-active ocr.service 2>/dev/null || true');
    const serviceStatus = (statusResult.output || '').trim();
    if (serviceStatus !== 'active') {
      addOCRLog('❌ Capture failed: OCR service is not active');
      return res.status(500).json({
        success: false,
        error: 'OCR service ไม่ทำงาน กรุณากดถ่ายใหม่',
        shouldRetry: true,
      });
    }

    const envResult = await executeSSHCommand([
      "token=$(systemctl show ocr.service --property=Environment --value 2>/dev/null | tr ' ' '\\n' | grep '^TELEGRAM_BOT_TOKEN=' | head -1 | cut -d= -f2-)",
      "chat=$(systemctl show ocr.service --property=Environment --value 2>/dev/null | tr ' ' '\\n' | grep '^TELEGRAM_CHAT_ID=' | head -1 | cut -d= -f2-)",
      "if [ -z \"$token\" ]; then token=$(grep -oP '^Environment=TELEGRAM_BOT_TOKEN=\\K.*' /etc/systemd/system/ocr.service 2>/dev/null | tail -1); fi",
      "if [ -z \"$chat\" ]; then chat=$(grep -oP '^Environment=TELEGRAM_CHAT_ID=\\K.*' /etc/systemd/system/ocr.service 2>/dev/null | tail -1); fi",
      "echo \"$token\"",
      "echo \"$chat\"",
    ].join(' ; '));

    const envLines = (envResult.output || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const token = envLines[0] || '';
    const chatId = envLines[1] || '';
    if (!token || !chatId) {
      addOCRLog('❌ Capture failed: missing Telegram token/chat id');
      return res.status(500).json({
        success: false,
        error: 'ไม่พบค่า Telegram ในระบบ กรุณากดถ่ายใหม่',
        shouldRetry: true,
      });
    }

    const capturePath = '/tmp/manual_capture.jpg';
    const captureCommand = [
      `rm -f ${capturePath}`,
      `if command -v libcamera-still >/dev/null 2>&1; then libcamera-still -n -t 1200 --width 1280 --height 720 -o ${capturePath} >/dev/null 2>&1; ` +
        `elif command -v raspistill >/dev/null 2>&1; then raspistill -n -t 1200 -o ${capturePath} >/dev/null 2>&1; ` +
        `elif command -v fswebcam >/dev/null 2>&1; then fswebcam -q --no-banner ${capturePath} >/dev/null 2>&1; ` +
        `else echo NO_CAMERA_TOOL; fi`,
      `[ -s ${capturePath} ] && echo CAPTURE_OK || echo CAPTURE_FAIL`,
    ].join(' ; ');
    const captureResult = await executeSSHCommand(captureCommand, 45000);
    if (!(captureResult.output || '').includes('CAPTURE_OK')) {
      addOCRLog('❌ Capture failed: cannot capture image from camera');
      return res.status(500).json({
        success: false,
        error: 'ถ่ายภาพไม่สำเร็จ กรุณากดถ่ายใหม่',
        shouldRetry: true,
      });
    }

    const ocrAndTelegramCommand = [
      `IMAGE_PATH=${shellSingleQuote(capturePath)} TELEGRAM_TOKEN=${shellSingleQuote(token)} TELEGRAM_CHAT_ID=${shellSingleQuote(chatId)} /home/admin/percel/venv/bin/python - <<'PY'`,
      'import json, os, urllib.request, urllib.parse',
      'from google.cloud import vision',
      '',
      'def fail(code, message):',
      '    print(json.dumps({"success": False, "code": code, "message": message}, ensure_ascii=False))',
      '    raise SystemExit(1)',
      '',
      'image_path = os.environ.get("IMAGE_PATH", "")',
      'token = os.environ.get("TELEGRAM_TOKEN", "")',
      'chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")',
      'if not image_path or not token or not chat_id:',
      '    fail("MISSING_ENV", "Missing image/token/chat")',
      '',
      'try:',
      '    client = vision.ImageAnnotatorClient()',
      '    with open(image_path, "rb") as f:',
      '        content = f.read()',
      '    response = client.text_detection(image=vision.Image(content=content))',
      '    if response.error and response.error.message:',
      '        fail("OCR_API_ERROR", response.error.message)',
      '',
      '    text = ""',
      '    if response.text_annotations and len(response.text_annotations) > 0:',
      '        text = (response.text_annotations[0].description or "").strip()',
      '    if not text:',
      '        fail("OCR_EMPTY", "OCR ไม่พบข้อความจากภาพ")',
      '',
      '    message = "📸 ผล OCR จากปุ่มถ่าย\\n\\n" + text[:3500]',
      '    data = urllib.parse.urlencode({"chat_id": chat_id, "text": message}).encode("utf-8")',
      '    req = urllib.request.Request(',
      '        f"https://api.telegram.org/bot{token}/sendMessage",',
      '        data=data,',
      '        headers={"Content-Type": "application/x-www-form-urlencoded"},',
      '        method="POST",',
      '    )',
      '    with urllib.request.urlopen(req, timeout=20) as resp:',
      '        tg = json.loads((resp.read() or b"{}").decode("utf-8", "ignore"))',
      '    if not tg.get("ok"):',
      '        fail("TELEGRAM_ERROR", str(tg.get("description") or "Telegram send failed"))',
      '',
      '    print(json.dumps({',
      '        "success": True,',
      '        "ocrText": text,',
      '        "textPreview": text[:160],',
      '        "telegram": tg,',
      '    }, ensure_ascii=False))',
      'except Exception as e:',
      '    fail("OCR_RUNTIME", str(e))',
      'PY',
    ].join('\n');

    const ocrResult = await executeSSHCommand(ocrAndTelegramCommand, 70000);
    const outLines = (ocrResult.output || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const jsonLine = outLines[outLines.length - 1] || '{}';

    let parsed;
    try {
      parsed = JSON.parse(jsonLine);
    } catch {
      parsed = {
        success: false,
        code: 'INVALID_RESPONSE',
        message: `Unexpected OCR response: ${jsonLine}`,
      };
    }

    if (!parsed.success) {
      addOCRLog(`❌ Capture/OCR failed: ${parsed.message || parsed.code || 'Unknown error'}`);
      return res.status(500).json({
        success: false,
        error: `OCR ไม่สำเร็จ กรุณากดถ่ายใหม่ (${parsed.message || parsed.code || 'Unknown error'})`,
        shouldRetry: true,
        details: parsed,
      });
    }

    addOCRLog('📸 Capture + OCR + Telegram sent successfully');
    return res.json({
      success: true,
      message: 'ถ่ายภาพและส่ง OCR ไป Telegram สำเร็จ',
      ocrText: parsed.ocrText,
      textPreview: parsed.textPreview,
      telegram: parsed.telegram,
    });
  } catch (err) {
    addOCRLog(`❌ Capture/OCR exception: ${err.message}`);
    console.error('Error capture+OCR+Telegram:', err);
    return res.status(500).json({
      success: false,
      error: `OCR ไม่สำเร็จ กรุณากดถ่ายใหม่ (${err.message})`,
      shouldRetry: true,
      details: err.message,
    });
  }
});

// ─── Telegram Chat Preview ────────────────────────────────────────
// In-memory cache for telegram messages to avoid hitting API too often
let telegramMsgCache = { messages: [], updatedAt: 0, offset: 0 };
const TELEGRAM_CACHE_MS = 3000; // cache getUpdates results for 3s

// Helper: read bot token & chat id from ocr.service env on Pi
async function getTelegramCreds() {
  const command = [
    "token=$(systemctl show ocr.service --property=Environment --value 2>/dev/null | tr ' ' '\\n' | grep '^TELEGRAM_BOT_TOKEN=' | head -1 | cut -d= -f2-)",
    "chat=$(systemctl show ocr.service --property=Environment --value 2>/dev/null | tr ' ' '\\n' | grep '^TELEGRAM_CHAT_ID=' | head -1 | cut -d= -f2-)",
    "if [ -z \"$token\" ]; then token=$(grep -oP '^Environment=TELEGRAM_BOT_TOKEN=\\K.*' /etc/systemd/system/ocr.service 2>/dev/null | tail -1); fi",
    "if [ -z \"$chat\" ]; then chat=$(grep -oP '^Environment=TELEGRAM_CHAT_ID=\\K.*' /etc/systemd/system/ocr.service 2>/dev/null | tail -1); fi",
    "echo \"$token\"",
    "echo \"$chat\"",
  ].join(' ; ');

  const result = await executeSSHCommand(command);
  const lines = (result.output || '').split('\n').map(l => l.trim()).filter(Boolean);
  return { token: lines[0] || '', chatId: lines[1] || '' };
}

// GET /api/pi/telegram/messages — fetch recent chat from Telegram group
app.get('/api/pi/telegram/messages', async (req, res) => {
  try {
    const now = Date.now();
    const forceRefresh = String(req.query.force || '') === '1';
    // Return cached results if still fresh
    if (!forceRefresh && now - telegramMsgCache.updatedAt < TELEGRAM_CACHE_MS && telegramMsgCache.messages.length > 0) {
      return res.json({
        success: true,
        messages: telegramMsgCache.messages,
        fromCache: true,
        fetchedAt: telegramMsgCache.updatedAt,
      });
    }

    const { token, chatId } = await getTelegramCreds();
    if (!token || !chatId) {
      return res.status(500).json({ success: false, error: 'ไม่พบ Telegram credentials ใน ocr.service' });
    }

    // Use getUpdates to fetch recent messages — limited to last 100
    const curlCmd = `curl -sS "https://api.telegram.org/bot${token}/getUpdates?offset=${telegramMsgCache.offset}&limit=100&allowed_updates=%5B%22message%22%5D&timeout=0" 2>/dev/null`;
    const result = await executeSSHCommand(curlCmd, 15000);
    const raw = (result.output || '').trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(500).json({ success: false, error: 'ไม่สามารถอ่านข้อมูลจาก Telegram API' });
    }

    if (!parsed.ok) {
      return res.status(500).json({ success: false, error: parsed.description || 'Telegram API error' });
    }

    const targetChatId = String(chatId);
    const newMessages = [];

    for (const update of (parsed.result || [])) {
      const msg = update.message || update.channel_post;
      if (!msg) continue;

      // Filter only messages from our target group
      if (String(msg.chat?.id) !== targetChatId) continue;

      newMessages.push({
        id: msg.message_id,
        updateId: update.update_id,
        from: msg.from ? {
          id: msg.from.id,
          name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' '),
          username: msg.from.username || '',
          isBot: msg.from.is_bot || false,
        } : { id: 0, name: msg.chat?.title || 'Unknown', username: '', isBot: false },
        text: msg.text || msg.caption || '',
        date: msg.date,
        hasPhoto: !!(msg.photo && msg.photo.length > 0),
        hasDocument: !!msg.document,
        replyTo: msg.reply_to_message ? msg.reply_to_message.message_id : null,
      });

      // Update offset to acknowledge processed messages
      if (update.update_id >= telegramMsgCache.offset) {
        telegramMsgCache.offset = update.update_id + 1;
      }
    }

    // Append new messages and keep last 100
    if (newMessages.length > 0) {
      telegramMsgCache.messages.push(...newMessages);
      if (telegramMsgCache.messages.length > 100) {
        telegramMsgCache.messages = telegramMsgCache.messages.slice(-100);
      }
    }

    telegramMsgCache.updatedAt = now;
    return res.json({
      success: true,
      messages: telegramMsgCache.messages,
      fromCache: false,
      fetchedAt: telegramMsgCache.updatedAt,
      newCount: newMessages.length,
    });
  } catch (err) {
    console.error('Error fetching Telegram messages:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/pi/telegram/send — send a message to the group
app.post('/api/pi/telegram/send', async (req, res) => {
  const { message: msgText } = req.body || {};
  if (!msgText || !String(msgText).trim()) {
    return res.status(400).json({ success: false, error: 'ข้อความว่างเปล่า' });
  }

  try {
    const { token, chatId } = await getTelegramCreds();
    if (!token || !chatId) {
      return res.status(500).json({ success: false, error: 'ไม่พบ Telegram credentials' });
    }

    const safeMsg = shellSingleQuote(String(msgText).trim());
    const curlCmd = `msg=${safeMsg}; curl -sS -X POST "https://api.telegram.org/bot${token}/sendMessage" --data-urlencode "chat_id=${chatId}" --data-urlencode "text=$msg" 2>/dev/null`;
    const result = await executeSSHCommand(curlCmd, 15000);
    const raw = (result.output || '').split('\n').map(l => l.trim()).filter(Boolean);
    const lastLine = raw[raw.length - 1] || '{}';

    let tg;
    try {
      tg = JSON.parse(lastLine);
    } catch {
      tg = { ok: false, description: 'Unexpected response' };
    }

    if (!tg.ok) {
      return res.status(500).json({ success: false, error: tg.description || 'Send failed' });
    }

    // Also add the sent message to our cache immediately
    const sentMsg = tg.result;
    if (sentMsg) {
      telegramMsgCache.messages.push({
        id: sentMsg.message_id,
        updateId: 0,
        from: sentMsg.from ? {
          id: sentMsg.from.id,
          name: [sentMsg.from.first_name, sentMsg.from.last_name].filter(Boolean).join(' '),
          username: sentMsg.from.username || '',
          isBot: sentMsg.from.is_bot || false,
        } : { id: 0, name: 'Bot', username: '', isBot: true },
        text: sentMsg.text || '',
        date: sentMsg.date,
        hasPhoto: false,
        hasDocument: false,
        replyTo: null,
      });
      if (telegramMsgCache.messages.length > 100) {
        telegramMsgCache.messages = telegramMsgCache.messages.slice(-100);
      }
    }

    return res.json({ success: true, telegram: tg });
  } catch (err) {
    console.error('Error sending Telegram message:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Get Pi volume setting
app.get('/api/pi/volume', async (req, res) => {
  try {
    const volumeFile = '/home/admin/percel/volume_config.json';
    const command = `cat ${volumeFile} 2>/dev/null || echo '{"volume": 80}'`;
    const result = await executeSSHCommand(command);
    const config = JSON.parse(result.output.trim());
    res.json({ success: true, volume: config.volume ?? 80 });
  } catch (err) {
    console.error('Error getting Pi volume:', err);
    res.json({ success: true, volume: 80 }); // Default volume
  }
});

// Set Pi volume setting
app.post('/api/pi/volume', async (req, res) => {
  const { volume } = req.body;
  const parsedVolume = Number.parseInt(volume, 10);
  if (!Number.isFinite(parsedVolume) || parsedVolume < 0 || parsedVolume > 100) {
    return res.status(400).json({ error: 'Volume must be between 0 and 100' });
  }
  try {
    const volumeFile = '/home/admin/percel/volume_config.json';
    const config = JSON.stringify({ volume: parsedVolume });
    const command = [
      `echo '${config}' > ${volumeFile}`,
      `chmod 644 ${volumeFile}`,
      `echo 1234 | sudo -S amixer -q sset Master ${parsedVolume}% unmute 2>/dev/null || true`,
      `echo 1234 | sudo -S amixer -q sset Speaker ${parsedVolume}% unmute 2>/dev/null || true`,
      `echo 1234 | sudo -S amixer -q sset PCM ${parsedVolume}% unmute 2>/dev/null || true`,
      `XDG_RUNTIME_DIR=/run/user/1000 pactl set-sink-volume @DEFAULT_SINK@ ${parsedVolume}% 2>/dev/null || true`,
    ].join(' ; ');
    await executeSSHCommand(command);
    addOCRLog(`🔊 Volume set to ${parsedVolume}%`);
    res.json({ success: true, volume: parsedVolume });
  } catch (err) {
    console.error('Error setting Pi volume:', err);
    res.status(500).json({ error: 'Failed to set Pi volume', details: err.message });
  }
});

// Get current Pi Wi-Fi status
app.get('/api/pi/wifi', async (req, res) => {
  try {
    const statusResult = await executeSSHCommand('nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status');
    const lines = (statusResult.output || '').split('\n').map(line => line.trim()).filter(Boolean);

    const parsed = lines
      .map((line) => {
        const match = line.match(/^([^:]+):([^:]+):([^:]+):(.*)$/);
        if (!match) return null;
        return {
          device: match[1],
          type: match[2],
          state: match[3],
          connection: match[4] || '',
        };
      })
      .filter(Boolean);

    const wifi = parsed.find((item) => item.type === 'wifi' && item.state === 'connected');
    const lan = parsed.find((item) => item.type === 'ethernet' && item.state === 'connected');

    const routeResult = await executeSSHCommand("ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i==\"dev\"){print $(i+1); exit}}'");
    const activeInterface = (routeResult.output || '').trim();

    let connectionType = 'none';
    let interfaceName = null;
    let connectionName = '';
    if (activeInterface && wifi && activeInterface === wifi.device) {
      connectionType = 'wifi';
      interfaceName = wifi.device;
      connectionName = wifi.connection;
    } else if (activeInterface && lan && activeInterface === lan.device) {
      connectionType = 'lan';
      interfaceName = lan.device;
      connectionName = lan.connection;
    } else if (wifi) {
      connectionType = 'wifi';
      interfaceName = wifi.device;
      connectionName = wifi.connection;
    } else if (lan) {
      connectionType = 'lan';
      interfaceName = lan.device;
      connectionName = lan.connection;
    }

    const ssid = wifi ? wifi.connection : '';

    res.json({
      success: true,
      ssid,
      connected: connectionType !== 'none',
      wifiConnected: Boolean(wifi),
      lanConnected: Boolean(lan),
      connectionType,
      activeInterface: activeInterface || interfaceName,
      interface: interfaceName,
      connectionName,
      wifiInterface: wifi ? wifi.device : null,
      wifiName: wifi ? wifi.connection : '',
      lanInterface: lan ? lan.device : null,
      lanName: lan ? lan.connection : '',
    });
  } catch (err) {
    console.error('Error getting Pi Wi-Fi status:', err);
    res.status(500).json({ error: 'Failed to get Pi Wi-Fi status', details: err.message });
  }
});

// Update Pi Wi-Fi configuration (SSID / password)
app.post('/api/pi/wifi', async (req, res) => {
  const { ssid, password } = req.body;

  if (!ssid || !password) {
    return res.status(400).json({ error: 'Missing ssid or password' });
  }

  try {
    const safeSsid = shellSingleQuote(ssid);
    const safePassword = shellSingleQuote(password);

    const connectCommand = [
      'echo 1234 | sudo -S nmcli dev wifi rescan ifname wlan0',
      `echo 1234 | sudo -S nmcli --wait 30 dev wifi connect ${safeSsid} password ${safePassword} ifname wlan0`,
    ].join(' && ');

    const connectResult = await executeSSHCommand(connectCommand);

    if (connectResult.code !== 0) {
      return res.status(500).json({
        error: 'Failed to update Pi Wi-Fi',
        details: (connectResult.errorOutput || connectResult.output || 'Unknown error').trim(),
      });
    }

    // wait a bit before checking active status
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const verifyResult = await executeSSHCommand('nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status');
    const lines = (verifyResult.output || '').split('\n').map(line => line.trim()).filter(Boolean);
    const wifi = lines
      .map((line) => {
        const match = line.match(/^([^:]+):([^:]+):([^:]+):(.*)$/);
        if (!match) return null;
        return {
          device: match[1],
          type: match[2],
          state: match[3],
          connection: match[4] || '',
        };
      })
      .filter(Boolean)
      .find((item) => item.type === 'wifi' && item.state === 'connected');

    if (!wifi) {
      return res.status(500).json({
        error: 'Wi-Fi command sent but not connected',
        details: 'Raspberry Pi ยังไม่เชื่อม Wi-Fi สำเร็จ (ตรวจสอบรหัสผ่าน/สัญญาณ hotspot)',
      });
    }

    // best effort: keep profile auto-connect; do not fail whole request if this step errors
    await executeSSHCommand(`echo 1234 | sudo -S nmcli connection modify ${shellSingleQuote(wifi.connection)} connection.autoconnect yes`).catch(() => {});

    addOCRLog(`📶 Wi-Fi updated to SSID: ${ssid}`);
    res.json({
      success: true,
      message: 'Wi-Fi updated successfully',
      ssid: wifi.connection || ssid,
      connected: true,
    });
  } catch (err) {
    console.error('Error updating Pi Wi-Fi:', err);
    res.status(500).json({ error: 'Failed to update Pi Wi-Fi', details: err.message });
  }
});

// Switch preferred active path between Wi-Fi and LAN when both are connected
app.post('/api/pi/network/prefer', async (req, res) => {
  const { target } = req.body;
  if (!target || !['wifi', 'lan'].includes(target)) {
    return res.status(400).json({ error: 'Invalid target. Use wifi or lan' });
  }

  try {
    const statusResult = await executeSSHCommand('nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status');
    const lines = (statusResult.output || '').split('\n').map(line => line.trim()).filter(Boolean);
    const parsed = lines
      .map((line) => {
        const match = line.match(/^([^:]+):([^:]+):([^:]+):(.*)$/);
        if (!match) return null;
        return {
          device: match[1],
          type: match[2],
          state: match[3],
          connection: match[4] || '',
        };
      })
      .filter(Boolean);

    const wifi = parsed.find((item) => item.type === 'wifi' && item.state === 'connected');
    const lan = parsed.find((item) => item.type === 'ethernet' && item.state === 'connected');

    // Fallback: if target path is not currently connected, try known saved connections
    const savedConnectionsResult = await executeSSHCommand('nmcli -t -f NAME,TYPE connection show');
    const savedLines = (savedConnectionsResult.output || '').split('\n').map((line) => line.trim()).filter(Boolean);

    function splitNmcliEscaped(line) {
      const parts = [];
      let current = '';
      for (let index = 0; index < line.length; index++) {
        if (line[index] === '\\' && index + 1 < line.length && line[index + 1] === ':') {
          current += ':';
          index++;
        } else if (line[index] === ':') {
          parts.push(current);
          current = '';
        } else {
          current += line[index];
        }
      }
      parts.push(current);
      return parts;
    }

    const savedConnections = savedLines
      .map((line) => {
        const fields = splitNmcliEscaped(line);
        if (fields.length < 2) return null;
        return {
          name: fields[0],
          type: fields[1],
        };
      })
      .filter(Boolean);

    const fallbackWifi = savedConnections.find((item) => item.type === '802-11-wireless');
    const fallbackLan = savedConnections.find((item) => item.type === '802-3-ethernet');

    let preferred = target === 'wifi' ? wifi : lan;
    let secondary = target === 'wifi' ? lan : wifi;

    if (!preferred) {
      if (target === 'wifi' && fallbackWifi) {
        preferred = { device: null, connection: fallbackWifi.name };
      } else if (target === 'lan' && fallbackLan) {
        preferred = { device: null, connection: fallbackLan.name };
      }
    }

    if (!secondary) {
      if (target === 'wifi' && fallbackLan) {
        secondary = { device: null, connection: fallbackLan.name };
      } else if (target === 'lan' && fallbackWifi) {
        secondary = { device: null, connection: fallbackWifi.name };
      }
    }

    if (!preferred || !preferred.connection) {
      return res.status(400).json({
        error: target === 'wifi' ? 'Wi-Fi connection profile not found' : 'LAN connection profile not found',
      });
    }

    const commands = [
      `echo 1234 | sudo -S nmcli connection modify ${shellSingleQuote(preferred.connection)} ipv4.route-metric 50 ipv6.route-metric 50`,
      `echo 1234 | sudo -S nmcli connection up ${shellSingleQuote(preferred.connection)}`,
    ];
    if (secondary) {
      commands.push(`echo 1234 | sudo -S nmcli connection modify ${shellSingleQuote(secondary.connection)} ipv4.route-metric 300 ipv6.route-metric 300`);
      commands.push(`echo 1234 | sudo -S nmcli connection up ${shellSingleQuote(secondary.connection)}`);
    }

    const switchResult = await executeSSHCommand(commands.join(' && '));
    if (switchResult.code !== 0) {
      return res.status(500).json({
        error: 'Failed to switch preferred network',
        details: (switchResult.errorOutput || switchResult.output || 'Unknown error').trim(),
      });
    }

    addOCRLog(`🌐 Preferred network switched to ${target.toUpperCase()}`);
    res.json({
      success: true,
      target,
      message: `Preferred network switched to ${target}`,
      preferredInterface: preferred.device || null,
      preferredConnection: preferred.connection,
    });
  } catch (err) {
    console.error('Error switching preferred network:', err);
    res.status(500).json({ error: 'Failed to switch preferred network', details: err.message });
  }
});

// Scan available Wi-Fi networks
app.get('/api/pi/wifi/scan', async (req, res) => {
  try {
    // Trigger a fresh rescan first, then list
    await executeSSHCommand('echo 1234 | sudo -S nmcli dev wifi rescan ifname wlan0 2>/dev/null || true');
    // Small delay to allow scan results to populate
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const result = await executeSSHCommand(
      'nmcli -t -f SSID,SIGNAL,SECURITY,FREQ,BSSID,IN-USE dev wifi list ifname wlan0'
    );

    if (result.code !== 0) {
      return res.status(500).json({
        error: 'Failed to scan Wi-Fi',
        details: (result.errorOutput || result.output || 'Unknown error').trim(),
      });
    }

    const lines = (result.output || '').split('\n').map((l) => l.trim()).filter(Boolean);

    // Parse nmcli colon-separated output.
    // nmcli escapes literal colons inside values as \:
    // We split on un-escaped colons only.
    function splitNmcliLine(line) {
      const parts = [];
      let cur = '';
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '\\' && i + 1 < line.length && line[i + 1] === ':') {
          cur += ':';
          i++; // skip next char
        } else if (line[i] === ':') {
          parts.push(cur);
          cur = '';
        } else {
          cur += line[i];
        }
      }
      parts.push(cur);
      return parts;
    }

    const seen = new Set();
    const networks = [];

    for (const line of lines) {
      const parts = splitNmcliLine(line);
      if (parts.length < 6) continue;

      const ssid = parts[0].trim();
      if (!ssid || ssid === '--') continue; // skip hidden/empty SSIDs

      const signal = parseInt(parts[1], 10) || 0;
      const security = parts[2].trim() || 'Open';
      const freq = parts[3].trim();
      const bssid = parts[4].trim();
      const inUse = parts[5].trim() === '*';

      // De-duplicate by SSID (keep strongest signal)
      if (seen.has(ssid)) {
        const existing = networks.find((n) => n.ssid === ssid);
        if (existing && signal > existing.signal) {
          existing.signal = signal;
          existing.security = security;
          existing.freq = freq;
          existing.bssid = bssid;
          existing.inUse = existing.inUse || inUse;
        }
        continue;
      }

      seen.add(ssid);
      networks.push({ ssid, signal, security, freq, bssid, inUse });
    }

    // Sort: in-use first, then by signal descending
    networks.sort((a, b) => {
      if (a.inUse !== b.inUse) return a.inUse ? -1 : 1;
      return b.signal - a.signal;
    });

    res.json({ success: true, networks });
  } catch (err) {
    console.error('Error scanning Wi-Fi:', err);
    res.status(500).json({ error: 'Failed to scan Wi-Fi', details: err.message });
  }
});

// Get Pi OCR service status
app.get('/api/pi/status', async (req, res) => {
  try {
    const result = await executeSSHCommand('systemctl is-active ocr.service');
    // Remove SSH warnings (lines that start with "Warning:")
    const lines = result.output.split('\n').filter(line => !line.startsWith('Warning:'));
    const status = lines.join('\n').trim();
    res.json({ 
      success: true, 
      status: status,
      isRunning: status === 'active'
    });
  } catch (err) {
    console.error('Error getting Pi status:', err);
    res.status(500).json({ error: 'Failed to get Pi status', details: err.message });
  }
});

// Control Pi OCR service (start/stop/restart)
app.post('/api/pi/control', async (req, res) => {
  const { action } = req.body;
  const validActions = ['start', 'stop', 'restart'];
  
  if (!action || !validActions.includes(action)) {
    return res.status(400).json({ error: 'Invalid action. Use: start, stop, or restart' });
  }

  try {
    // First speak the action (run in background with nohup)
    const speakText = {
      start: 'กำลังเริ่มระบบ',
      stop: 'กำลังหยุดระบบ',
      restart: 'กำลังรีสตาร์ทระบบ',
    };
    
    const escapedSpeak = speakText[action];
    // Use nohup to run speak in background so it doesn't block
    const speakCmd = `nohup python3 -c "
from gtts import gTTS
import subprocess
import os
tts = gTTS(text='${escapedSpeak}', lang='th')
tts.save('/tmp/speak_remote.mp3')
env = os.environ.copy()
env['XDG_RUNTIME_DIR'] = '/run/user/1000'
volume = 80
try:
  import json
  with open('/home/admin/percel/volume_config.json', 'r', encoding='utf-8') as f:
    volume = int(json.load(f).get('volume', 80))
except Exception:
  volume = 80
volume = max(0, min(100, volume))
subprocess.run(['mpv', '--no-video', '--speed=1.5', '--ao=alsa', f'--volume={volume}', '/tmp/speak_remote.mp3'], env=env)
" > /dev/null 2>&1 &`;
    
    // Speak in background (don't wait)
    executeSSHCommand(speakCmd).catch(() => {});
    
    // Wait a moment for speech to start
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Clear old images in inbox before restart
    if (action === 'restart' || action === 'start') {
      await executeSSHCommand('rm -f /var/lib/motion/inbox/*.jpg').catch(() => {});
    }
    
    // Then perform action (use echo password | sudo -S for non-interactive sudo)
    const result = await executeSSHCommand(`echo 1234 | sudo -S systemctl ${action} ocr.service 2>/dev/null`);
    
    // Wait a moment for service to change state
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Get updated status
    const statusResult = await executeSSHCommand('systemctl is-active ocr.service');
    const status = statusResult.output.trim();
    
    // Log the action
    const actionEmojis = {
      start: '▶️ Started',
      stop: '⏹️ Stopped',
      restart: '🔄 Restarted'
    };
    addOCRLog(`${actionEmojis[action]} OCR service: ${status}`);
    
    res.json({ 
      success: true, 
      action: action,
      message: `OCR service ${action} command sent`,
      status: status,
      isRunning: status === 'active'
    });
  } catch (err) {
    addOCRLog(`❌ Failed to ${action}: ${err.message}`);
    console.error(`Error ${action} Pi OCR service:`, err);
    res.status(500).json({ error: `Failed to ${action} Pi OCR service`, details: err.message });
  }
});

// Reboot Raspberry Pi
app.post('/api/pi/reboot', async (req, res) => {
  try {
    // Speak in background
    const speakCmd = `nohup python3 -c "
from gtts import gTTS
import subprocess
import os
tts = gTTS(text='กำลังรีบูทระบบ', lang='th')
tts.save('/tmp/speak_remote.mp3')
env = os.environ.copy()
env['XDG_RUNTIME_DIR'] = '/run/user/1000'
volume = 80
try:
  import json
  with open('/home/admin/percel/volume_config.json', 'r', encoding='utf-8') as f:
    volume = int(json.load(f).get('volume', 80))
except Exception:
  volume = 80
volume = max(0, min(100, volume))
subprocess.run(['mpv', '--no-video', '--speed=1.5', '--ao=alsa', f'--volume={volume}', '/tmp/speak_remote.mp3'], env=env)
" > /dev/null 2>&1 &`;
    
    executeSSHCommand(speakCmd).catch(() => {});
    
    // Wait a bit for audio to start
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Then reboot
    await executeSSHCommand('echo 1234 | sudo -S reboot 2>/dev/null').catch(() => {});
    
    addOCRLog(`⚡ Rebooting Raspberry Pi...`);
    
    res.json({ 
      success: true, 
      message: 'Reboot command sent. Pi will restart shortly.'
    });
  } catch (err) {
    addOCRLog(`❌ Failed to reboot: ${err.message}`);
    console.error('Error rebooting Pi:', err);
    res.status(500).json({ error: 'Failed to reboot Pi', details: err.message });
  }
});

// Get OCR logs in realtime
app.get('/api/pi/logs', async (req, res) => {
  try {
    const systemLogs = await getPiSystemErrorLogs().catch(() => []);
    const mergedLogs = [...ocrLogs, ...systemLogs];

    res.json({
      success: true,
      logs: mergedLogs,
      appLogCount: ocrLogs.length,
      systemLogCount: systemLogs.length,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error getting Pi logs:', err);
    res.status(500).json({ error: 'Failed to get Pi logs', details: err.message });
  }
});

// Clear OCR logs
// Execute arbitrary SSH command on Pi (for debugging/admin)
app.post('/api/pi/ssh', async (req, res) => {
  const { command } = req.body;
  if (!command) {
    return res.status(400).json({ error: 'Missing command parameter' });
  }
  try {
    const result = await executeSSHCommand(command);
    res.json({ success: true, output: result.output });
  } catch (err) {
    console.error('SSH command error:', err);
    res.status(500).json({ error: 'SSH command failed', details: err.message });
  }
});

// Get GCP credential status from Pi (includes API validity test)
app.get('/api/pi/credential', async (req, res) => {
  try {
    const result = await executeSSHCommand(
      'stat -c "%s %Y" /home/admin/percel/pi-ocr-key.json 2>/dev/null && ' +
      'cat /home/admin/percel/pi-ocr-key.json | grep -oP \'"client_email":\\s*"\\K[^"]+\' && ' +
      'cat /home/admin/percel/pi-ocr-key.json | grep -oP \'"project_id":\\s*"\\K[^"]+\' && ' +
      'cat /home/admin/percel/pi-ocr-key.json | grep -oP \'"private_key_id":\\s*"\\K[^"]+\' || echo NOT_FOUND'
    );
    const lines = (result.output || '').trim().split('\n');
    if (lines[0] === 'NOT_FOUND' || lines.length < 4) {
      return res.json({ exists: false, apiValid: false });
    }
    const [sizeAndTime, clientEmail, projectId, keyId] = lines;
    const [size, mtime] = sizeAndTime.split(' ');

    // Test if the credential actually works by calling Vision API
    let apiValid = false;
    let apiError = '';
    try {
      const testResult = await executeSSHCommand(
        `cd /home/admin/percel && GOOGLE_APPLICATION_CREDENTIALS=pi-ocr-key.json ` +
        `/home/admin/percel/venv/bin/python -c "` +
        `from google.cloud import vision; import base64; ` +
        `c = vision.ImageAnnotatorClient(); ` +
        `png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='); ` +
        `img = vision.Image(content=png); ` +
        `r = c.text_detection(image=img); ` +
        `print('API_OK')" 2>&1`
      );
      const output = (testResult.output || '').trim();
      apiValid = output.endsWith('API_OK');
      if (!apiValid) {
        // Extract the key error line (prefer Unauthenticated/401 lines over generic Traceback)
        const lines = output.split('\n');
        const errorLine = lines.find(l => l.includes('Unauthenticated') || l.includes('ACCOUNT_STATE'))
          || lines.find(l => l.includes('401'))
          || lines.find(l => l.includes('PermissionDenied') || l.includes('Forbidden'))
          || lines[lines.length - 1]
          || output.substring(0, 200);
        apiError = errorLine.trim().substring(0, 300);
      }
    } catch (testErr) {
      apiError = testErr.message;
    }

    res.json({
      exists: true,
      clientEmail,
      projectId,
      keyId: keyId ? keyId.substring(0, 8) + '...' : 'N/A',
      fileSize: parseInt(size, 10),
      lastModified: new Date(parseInt(mtime, 10) * 1000).toISOString(),
      apiValid,
      apiError,
    });
  } catch (err) {
    console.error('Error checking credential:', err);
    res.status(500).json({ error: 'Failed to check credential', details: err.message });
  }
});

// Upload new GCP credential JSON to Pi
app.post('/api/pi/credential', async (req, res) => {
  const { credential } = req.body;
  if (!credential) {
    return res.status(400).json({ error: 'Missing credential JSON' });
  }
  try {
    // Validate it's proper JSON with required fields
    let parsed;
    try {
      parsed = typeof credential === 'string' ? JSON.parse(credential) : credential;
    } catch {
      return res.status(400).json({ error: 'Invalid JSON format' });
    }
    if (!parsed.type || !parsed.client_email || !parsed.private_key) {
      return res.status(400).json({ error: 'Invalid service account key: missing required fields (type, client_email, private_key)' });
    }

    // Base64 encode to avoid shell escaping issues
    const jsonStr = JSON.stringify(parsed, null, 2);
    const b64 = Buffer.from(jsonStr).toString('base64');

    // Backup old key and write new one
    await executeSSHCommand(
      `cp /home/admin/percel/pi-ocr-key.json /home/admin/percel/pi-ocr-key.json.bak 2>/dev/null || true && ` +
      `echo '${b64}' | base64 -d > /home/admin/percel/pi-ocr-key.json`
    );

    // Restart OCR service to pick up new credentials
    await executeSSHCommand('echo 1234 | sudo -S systemctl restart ocr.service 2>/dev/null');
    await new Promise(resolve => setTimeout(resolve, 2000));
    const statusResult = await executeSSHCommand('systemctl is-active ocr.service');
    const status = statusResult.output.trim();

    addOCRLog(`🔑 GCP credential updated (${parsed.client_email}), service: ${status}`);
    systemLogCache.updatedAt = 0; // invalidate system log cache

    res.json({
      success: true,
      message: 'Credential updated and service restarted',
      clientEmail: parsed.client_email,
      projectId: parsed.project_id,
      serviceStatus: status,
      isRunning: status === 'active',
    });
  } catch (err) {
    addOCRLog(`❌ Failed to update credential: ${err.message}`);
    console.error('Error uploading credential:', err);
    res.status(500).json({ error: 'Failed to upload credential', details: err.message });
  }
});

// Clear old images from motion inbox
app.post('/api/pi/inbox/clear', async (req, res) => {
  try {
    const countResult = await executeSSHCommand('ls /var/lib/motion/inbox/ 2>/dev/null | wc -l');
    const count = parseInt((countResult.output || '0').trim(), 10);
    await executeSSHCommand('rm -f /var/lib/motion/inbox/*.jpg');
    addOCRLog(`🗑️ Cleared ${count} images from inbox`);
    res.json({ success: true, cleared: count });
  } catch (err) {
    console.error('Error clearing inbox:', err);
    res.status(500).json({ error: 'Failed to clear inbox', details: err.message });
  }
});

app.delete('/api/pi/logs', async (req, res) => {
  try {
    const clearedCount = ocrLogs.length;
    ocrLogs.length = 0; // Clear the array
    addOCRLog(`🗑️ Logs cleared (${clearedCount} entries)`);
    res.json({
      success: true,
      message: `Cleared ${clearedCount} log entries`
    });
  } catch (err) {
    console.error('Error clearing Pi logs:', err);
    res.status(500).json({ error: 'Failed to clear Pi logs', details: err.message });
  }
});

// Helper: fetch Pi info (used by API and WebSocket broadcaster)
async function fetchPiInfo() {
  // Use simpler, faster commands to avoid timeout
  const uptimeResult = await executeSSHCommand('uptime -p 2>/dev/null || uptime');
  const uptimeSecResult = await executeSSHCommand('cat /proc/uptime');
  const cpuTempResult = await executeSSHCommand("vcgencmd measure_temp 2>/dev/null || echo \"temp=N/A\"");
  const memResult = await executeSSHCommand('cat /proc/meminfo | grep MemAvailable');
  const statusResult = await executeSSHCommand('systemctl is-active ocr.service');

  // Remove SSH warnings
  const cleanOutput = (output) => output.split('\n').filter(line => !line.startsWith('Warning:')).join('\n').trim();

  // Parse memory (kB) and format into kB / MB / GB, choose best display unit
  const memClean = cleanOutput(memResult.output) || '';
  let memoryFormatted = { kb: null, mb: null, gb: null };
  let memoryDisplay = 'N/A';
  if (memClean) {
    const m = memClean.match(/MemAvailable:\s*(\d+)\s*kB/i);
    if (m) {
      const kb = parseInt(m[1], 10);
      memoryFormatted.kb = `${kb} kB`;
      memoryFormatted.mb = `${(kb / 1024).toFixed(2)} MB`;
      memoryFormatted.gb = `${(kb / (1024 * 1024)).toFixed(2)} GB`;

      if (kb < 1024) {
        memoryDisplay = `${kb} kB`;
      } else if (kb < 1024 * 1024) {
        memoryDisplay = `${(kb / 1024).toFixed(2)} MB`;
      } else {
        memoryDisplay = `${(kb / (1024 * 1024)).toFixed(2)} GB`;
      }
    } else {
      memoryFormatted.kb = memClean;
      memoryDisplay = memClean;
    }
  }

  // Parse uptime seconds and create Thai localized string
  let uptimeSeconds = null;
  let uptimeThai = null;
  try {
    const upClean = cleanOutput(uptimeSecResult.output || '');
    const first = upClean.split(' ')[0];
    const secs = parseFloat(first);
    if (!Number.isNaN(secs)) {
      uptimeSeconds = Math.floor(secs);
      const h = Math.floor(uptimeSeconds / 3600);
      const m = Math.floor((uptimeSeconds % 3600) / 60);
      const s = uptimeSeconds % 60;
      const parts = [];
      if (h) parts.push(`${h} ชั่วโมง`);
      if (m) parts.push(`${m} นาที`);
      if (s || parts.length === 0) parts.push(`${s} วินาที`);
      uptimeThai = parts.join(' ');
    }
  } catch (e) {
    // ignore parse errors
  }

  const statusClean = cleanOutput(statusResult.output || 'unknown');

  // DEBUG: log uptime parsing results
  console.log('[fetchPiInfo] uptimeSeconds=', uptimeSeconds, 'uptimeThai=', uptimeThai);

  return {
    success: true,
    uptime: cleanOutput(uptimeResult.output).replace('up ', ''),
    uptimeSeconds: uptimeSeconds || 0,
    uptimeThai: uptimeThai || '',
    cpuTemp: cleanOutput(cpuTempResult.output).replace('temp=', '').replace("'C", '°C'),
    memoryUsageRaw: memClean || 'N/A',
    memoryUsage: memoryFormatted,
    memoryDisplay,
    status: statusClean,
    isRunning: statusClean === 'active'
  };
} 

// Get Pi system info
app.get('/api/pi/info', async (req, res) => {
  try {
    const info = await fetchPiInfo();
    console.log('[route] /api/pi/info ->', info);
    res.json(info);
  } catch (err) {
    console.error('Error getting Pi info:', err);
    res.status(500).json({ error: 'Failed to get Pi info', details: err.message });
  }
});

// Periodically broadcast Pi info to WebSocket clients
setInterval(async () => {
  try {
    const info = await fetchPiInfo();
    broadcast('pi-info', info);
  } catch (err) {
    console.error('Error broadcasting Pi info:', err);
    // Inform clients of error state
    broadcast('pi-info', { success: false, error: err.message });
  }
}, 3000); // every 3 seconds

console.log('[server-start] server.js file:', __filename);
server.listen(port, () => {
  const host = process.env.HOST;
  console.log('[server-start] Backend server listening at', `http://${host}:${port}`);
  console.log('[server-start] WebSocket server listening at', `ws://${host}:${port}`);
});