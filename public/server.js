const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || './crm.db';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'RA2026!';
const SESSION_SECRET = process.env.SESSION_SECRET || 'ra-crm-secret-key-2026';

const genId = () => crypto.randomBytes(8).toString('hex');

// ── Ensure DB directory exists ────────────────────────
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

// ── Database ──────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS app_data (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── Seed default admin ────────────────────────────────
const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('jeremy');
if (!adminExists) {
  db.prepare('INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)')
    .run(genId(), 'jeremy', bcrypt.hashSync(ADMIN_PASSWORD, 10), 'Jérémy', 'admin');
  console.log('✅ Admin créé : jeremy / ' + ADMIN_PASSWORD);
}

// ── Seed empty data collections ───────────────────────
const DATA_KEYS = ['candidats', 'clients', 'contacts', 'commandes', 'relances', 'refs'];
for (const key of DATA_KEYS) {
  const exists = db.prepare('SELECT key FROM app_data WHERE key = ?').get(key);
  if (!exists) {
    db.prepare('INSERT INTO app_data (key, value) VALUES (?, ?)').run(key, '[]');
  }
}

// ── Middleware ────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, secure: false }
}));

const requireAuth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Non authentifié' });
  next();
};
const requireAdmin = (req, res, next) => {
  if (!req.session.userId || req.session.role !== 'admin')
    return res.status(403).json({ error: 'Accès refusé — Admin requis' });
  next();
};

// ── Auth ──────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Champs manquants' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.displayName = user.display_name;
  res.json({ id: user.id, username: user.username, display_name: user.display_name, role: user.role });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, username, display_name, role FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Session invalide' });
  res.json(user);
});

// ── Data ──────────────────────────────────────────────
app.get('/api/data/:key', requireAuth, (req, res) => {
  const row = db.prepare('SELECT value FROM app_data WHERE key = ?').get(req.params.key);
  try {
    res.json(row ? JSON.parse(row.value) : []);
  } catch(e) {
    res.json([]);
  }
});

app.put('/api/data/:key', requireAuth, (req, res) => {
  const value = JSON.stringify(req.body);
  db.prepare('INSERT OR REPLACE INTO app_data (key, value, updated_at) VALUES (?, ?, datetime("now"))')
    .run(req.params.key, value);
  res.json({ ok: true });
});

// ── Users (admin) ─────────────────────────────────────
app.get('/api/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, display_name, role, created_at FROM users ORDER BY created_at').all();
  res.json(users);
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, display_name, role } = req.body;
  if (!username || !password || !display_name)
    return res.status(400).json({ error: 'Tous les champs sont requis' });
  try {
    db.prepare('INSERT INTO users (id, username, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)')
      .run(genId(), username.toLowerCase().trim(), bcrypt.hashSync(password, 10), display_name, role || 'user');
    res.json({ ok: true });
  } catch(e) {
    res.status(400).json({ error: 'Cet identifiant est déjà utilisé' });
  }
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  const { display_name, role, password } = req.body;
  if (password && password.length >= 4) {
    db.prepare('UPDATE users SET display_name = ?, role = ?, password_hash = ? WHERE id = ?')
      .run(display_name, role, bcrypt.hashSync(password, 10), req.params.id);
  } else {
    db.prepare('UPDATE users SET display_name = ?, role = ? WHERE id = ?')
      .run(display_name, role, req.params.id);
  }
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  if (req.params.id === req.session.userId)
    return res.status(400).json({ error: 'Impossible de supprimer son propre compte' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 RA CRM démarré sur le port ${PORT}`);
});
