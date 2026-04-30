const express = require('express');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'US2026!';
const SESSION_SECRET = process.env.SESSION_SECRET || 'upsearch-secret-2026';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// Support both DATA_DIR and legacy DB_PATH variable
let DATA_DIR = process.env.DATA_DIR;
if (!DATA_DIR && process.env.DB_PATH) {
  DATA_DIR = path.dirname(process.env.DB_PATH); // /data/crm.db → /data
}
if (!DATA_DIR) DATA_DIR = './data';
console.log('📁 DATA_DIR:', DATA_DIR);

const genId = () => crypto.randomBytes(8).toString('hex');

// ── Helpers JSON ──────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch(e) { return def; }
}
function writeJSON(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}

// ── Init users ────────────────────────────────────────
let users = readJSON('users.json', []);
const adminExists = users.find(u => u.username === 'jeremy');
if (!adminExists) {
  users.push({ id: genId(), username: 'jeremy', password_hash: bcrypt.hashSync(ADMIN_PASSWORD, 10), display_name: 'Jérémy', role: 'admin', created_at: new Date().toISOString() });
  writeJSON('users.json', users);
  console.log('✅ Admin créé : jeremy / ' + ADMIN_PASSWORD);
} else {
  // Toujours resynchroniser le mot de passe avec la variable d'environnement
  users = users.map(u => u.username === 'jeremy' ? { ...u, password_hash: bcrypt.hashSync(ADMIN_PASSWORD, 10) } : u);
  writeJSON('users.json', users);
  console.log('🔄 Mot de passe admin synchronisé');
}

// ── Init collections ──────────────────────────────────
['candidats','clients','contacts','commandes','relances','refs'].forEach(k => {
  const p = path.join(DATA_DIR, k + '.json');
  if (!fs.existsSync(p)) writeJSON(k + '.json', k === 'refs' ? {} : []);
});

// ── Middleware ────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } }));

const auth  = (req, res, next) => { if (!req.session.userId) return res.status(401).json({ error: 'Non authentifié' }); next(); };
const admin = (req, res, next) => { if (!req.session.userId || req.session.role !== 'admin') return res.status(403).json({ error: 'Accès refusé' }); next(); };

// ── Auth ──────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Champs manquants' });
  users = readJSON('users.json', []);
  const user = users.find(u => u.username === username.toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
  req.session.userId = user.id; req.session.role = user.role;
  res.json({ id: user.id, username: user.username, display_name: user.display_name, role: user.role });
});
app.post('/api/auth/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
app.get('/api/auth/me', auth, (req, res) => {
  users = readJSON('users.json', []);
  const user = users.find(u => u.id === req.session.userId);
  if (!user) return res.status(401).json({ error: 'Session invalide' });
  res.json({ id: user.id, username: user.username, display_name: user.display_name, role: user.role });
});

// ── Data ──────────────────────────────────────────────
app.get('/api/data/:key', auth, (req, res) => res.json(readJSON(req.params.key + '.json', [])));
app.put('/api/data/:key', auth, (req, res) => { writeJSON(req.params.key + '.json', req.body); res.json({ ok: true }); });

// ── CV Parsing (Claude API) ───────────────────────────
app.post('/api/parse-cv', auth, async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.json({ error: 'Clé API non configurée. Ajoutez ANTHROPIC_API_KEY dans Railway.', parsed: null });
  const { data, type, name } = req.body;
  if (!data) return res.status(400).json({ error: 'Fichier manquant', parsed: null });
  const isPDF = type === 'application/pdf' || (name || '').toLowerCase().endsWith('.pdf');
  if (!isPDF) return res.json({ error: 'Parsing automatique disponible pour les PDF uniquement', parsed: null });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-5', max_tokens: 300,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
          { type: 'text', text: 'Extrais ces informations du CV. Réponds UNIQUEMENT en JSON sans texte avant/après : {"nom":"...","prenom":"...","tel":"...","email":"..."}. Mets null si introuvable.' }
        ]}]
      })
    });
    if (!response.ok) return res.json({ error: 'Extraction impossible — erreur API', parsed: null });
    const result = await response.json();
    const text = result.content?.[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return res.json({ error: 'Réponse inattendue de l\'API', parsed: null });
    const raw = JSON.parse(m[0]);
    const clean = {
      nom: raw.nom && raw.nom !== 'null' ? String(raw.nom).trim() : null,
      prenom: raw.prenom && raw.prenom !== 'null' ? String(raw.prenom).trim() : null,
      tel: raw.tel && raw.tel !== 'null' ? String(raw.tel).trim() : null,
      email: raw.email && raw.email !== 'null' ? String(raw.email).trim() : null,
    };
    res.json({ parsed: clean });
  } catch(e) {
    console.error('Parse CV error:', e);
    res.json({ error: 'Erreur lors de l\'extraction', parsed: null });
  }
});

app.post('/api/parse-prequalif', auth, async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.json({ error: 'Clé API non configurée.', parsed: null });
  const { data, type, name } = req.body;
  if (!data) return res.status(400).json({ error: 'Fichier manquant', parsed: null });
  const isPDF = type === 'application/pdf' || (name || '').toLowerCase().endsWith('.pdf');
  if (!isPDF) return res.json({ error: 'PDF uniquement supporté', parsed: null });
  try {
    const prompt = `Tu analyses une trame de préqualification de recrutement déjà remplie. Extrais les informations saisies par le recruteur et retourne UNIQUEMENT un objet JSON valide, sans texte avant ou après, avec exactement ces clés (valeur "" si non trouvée ou vide) :
{
  "en_poste": false,
  "preavis": "",
  "disponible": false,
  "raisons_dispo": "",
  "raisons_ecoute": "",
  "type_poste": "",
  "rem_actuelle": "",
  "rem_souhaitee": "",
  "refus_secteurs": "",
  "souhaits": "",
  "processus_en_cours": "",
  "motivation_note": 0,
  "motivation_comment": "",
  "exp1_entreprise": "", "exp1_poste": "", "exp1_duree": "", "exp1_depart": "", "exp1_missions": "",
  "exp2_entreprise": "", "exp2_poste": "", "exp2_duree": "", "exp2_depart": "", "exp2_missions": "",
  "exp3_entreprise": "", "exp3_poste": "", "exp3_duree": "", "exp3_depart": "", "exp3_missions": "",
  "logiciels": "",
  "dispo_format": "",
  "dispo_date": "",
  "dispo_heure": "",
  "ressenti": ""
}
Pour en_poste et disponible: utilise true/false. Pour motivation_note: utilise un entier entre 0 et 5. Retourne UNIQUEMENT le JSON.`;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-5', max_tokens: 2000,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
          { type: 'text', text: prompt }
        ]}]
      })
    });
    if (!response.ok) {
      const err = await response.text();
      return res.json({ error: 'Erreur API: ' + response.status, parsed: null });
    }
    const result = await response.json();
    const text = result.content?.[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return res.json({ error: 'Réponse inattendue', parsed: null });
    const parsed = JSON.parse(m[0]);
    res.json({ parsed });
  } catch(e) {
    console.error('Parse prequalif error:', e);
    res.json({ error: 'Erreur: ' + e.message, parsed: null });
  }
});

// ── Users (admin) ─────────────────────────────────────
app.get('/api/users', admin, (req, res) => res.json(readJSON('users.json', []).map(u => ({ id: u.id, username: u.username, display_name: u.display_name, role: u.role, photo: u.photo||null, created_at: u.created_at }))));
app.post('/api/users', admin, (req, res) => {
  const { username, password, display_name, role, photo } = req.body;
  if (!username || !password || !display_name) return res.status(400).json({ error: 'Champs manquants' });
  users = readJSON('users.json', []);
  if (users.find(u => u.username === username.toLowerCase().trim())) return res.status(400).json({ error: 'Identifiant déjà utilisé' });
  users.push({ id: genId(), username: username.toLowerCase().trim(), password_hash: bcrypt.hashSync(password, 10), display_name, role: role || 'user', photo: photo||null, created_at: new Date().toISOString() });
  writeJSON('users.json', users); res.json({ ok: true });
});
app.put('/api/users/:id', admin, (req, res) => {
  const { display_name, role, password, photo } = req.body;
  users = readJSON('users.json', []).map(u => {
    if (u.id !== req.params.id) return u;
    const up = { ...u, display_name, role };
    if (photo !== undefined) up.photo = photo;
    if (password && password.length >= 4) up.password_hash = bcrypt.hashSync(password, 10);
    return up;
  });
  writeJSON('users.json', users); res.json({ ok: true });
});
app.delete('/api/users/:id', admin, (req, res) => {
  if (req.params.id === req.session.userId) return res.status(400).json({ error: 'Impossible de supprimer son propre compte' });
  writeJSON('users.json', readJSON('users.json', []).filter(u => u.id !== req.params.id));
  res.json({ ok: true });
});

app.post('/api/parse-brief', auth, async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.json({ error: 'Clé API non configurée.', parsed: null });
  const { data, type, name } = req.body;
  if (!data) return res.status(400).json({ error: 'Fichier manquant', parsed: null });
  const isPDF = type === 'application/pdf' || (name || '').toLowerCase().endsWith('.pdf');
  if (!isPDF) return res.json({ error: 'PDF uniquement supporté', parsed: null });
  try {
    const prompt = `Tu analyses un brief de poste de recrutement déjà rempli. Extrais les informations saisies et retourne UNIQUEMENT un objet JSON valide, sans texte avant ou après, avec exactement ces clés (valeur "" si non trouvée) :
{"interlocuteur":"","coords_interlo":"","activite_ent":"","effectif_ent":"","concurrents":"","habitudes_recru":"","ouvert_depuis":"","contexte":"","intitule_poste":"","rattachement":"","urgence_date":"","passation":"","qui_travaille":"","process_recru":"","no_approche":"","recru_echoue":"","missions_princ":"","missions_sec":"","journee_type":"","defis":"","objectifs":"","diplomes":"","compe_tech":"","savoir_etre":"","logiciels":"","localisation":"","deplacements":"","horaires":"","teletravail":"","equipe":"","contrat":"","statut_contrat":"","remuneration":"","avantages":"","must_have":"","should_have":"","nice_have":"","commentaires":""}
Retourne UNIQUEMENT le JSON.`;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-5', max_tokens: 3000,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
          { type: 'text', text: prompt }
        ]}]
      })
    });
    if (!response.ok) return res.json({ error: 'Erreur API: ' + response.status, parsed: null });
    const result = await response.json();
    const text = result.content?.[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return res.json({ error: 'Réponse inattendue', parsed: null });
    res.json({ parsed: JSON.parse(m[0]) });
  } catch(e) {
    console.error('Parse brief error:', e);
    res.json({ error: 'Erreur: ' + e.message, parsed: null });
  }
});

app.listen(PORT, () => console.log(`🚀 UpSearch CRM démarré sur le port ${PORT}`));
