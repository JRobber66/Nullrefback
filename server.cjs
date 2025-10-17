const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_PATH = path.join(DATA_DIR, 'data.json');

app.use(cors());
app.use(express.json());

function gen15Digit() {
  let s = '';
  while (s.length < 15) s += String(Math.floor(Math.random() * 10));
  return s.slice(0, 15);
}
const STARTUP_SECONDARY = gen15Digit();
console.log('SECONDARY_CODE:', STARTUP_SECONDARY);

function bootstrapData() {
  if (fs.existsSync(DATA_PATH)) return;
  const raw = [
    { name: 'Daniel', pin: '0623' },
    { name: 'David', pin: '0305' },
    { name: 'Arnoldo', pin: '0716' },
    { name: 'Callen', pin: '0621' },
    { name: 'William', pin: '0115' }
  ];
  const members = raw.map(m => ({ name: m.name, pinHash: bcrypt.hashSync(String(m.pin), 10) }));
  const initial = { members, candidates: [] };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(initial, null, 2));
}
function load() { bootstrapData(); return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); }
function save(d) { fs.writeFileSync(DATA_PATH, JSON.stringify(d, null, 2)); }
const makeId = () => crypto.randomBytes(6).toString('base64url').slice(0, 9);

function memberNames(d) { return d.members.map(m => m.name); }
function countYes(v = {}) { return Object.values(v).filter(x => x === true).length; }
function countNo(v = {}) { return Object.values(v).filter(x => x === false).length; }

function recomputeStatus(c, membersArr) {
  const names = membersArr.map(m => m.name);
  const votes = c.votes || {};
  const total = names.length;
  const votedCount = Object.keys(votes).length;
  const allYes = total > 0 && names.every(n => votes[n] === true);
  const allNo = total > 0 && votedCount === total && names.every(n => votes[n] === false);
  if (allYes) { c.status = 'banned'; c.ratified = true; }
  else if (allNo) { c.status = 'allowed'; c.ratified = false; }
  else { c.status = 'pending'; c.ratified = false; }
  c.totalMembers = total;
}
function recomputeAll(d) { d.candidates.forEach(c => recomputeStatus(c, d.members)); }

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many requests', note: 'get fucked william' })
});
app.use('/auth', authLimiter);
app.use('/auth/2', authLimiter);

const FAILED = {};
const MAX_FAIL = 5;
const LOCKOUT_MS = 30 * 60 * 1000;

function registerFail(name) {
  const now = Date.now();
  if (!FAILED[name]) FAILED[name] = { count: 0, firstTs: now, lockedUntil: 0 };
  const rec = FAILED[name];
  if (rec.lockedUntil && now < rec.lockedUntil) return;
  rec.count += 1;
  if (rec.count >= MAX_FAIL) rec.lockedUntil = now + LOCKOUT_MS;
}
function clearFails(name) { delete FAILED[name]; }
function isLocked(name) {
  const rec = FAILED[name];
  if (!rec) return false;
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) return true;
  if (Date.now() - rec.firstTs > 60 * 60 * 1000) { delete FAILED[name]; return false; }
  return false;
}

app.get('/', (_req, res) => res.send('Ratify backend running'));

app.post('/auth', (req, res) => {
  const { memberName, pin } = req.body || {};
  if (!memberName || !pin) return res.status(400).json({ error: 'memberName and pin required' });
  if (isLocked(memberName)) return res.status(429).json({ error: 'locked', note: 'get fucked william' });
  const d = load();
  const m = d.members.find(x => x.name === memberName);
  if (!m) return res.status(404).json({ error: 'member not found' });
  const ok = bcrypt.compareSync(String(pin), m.pinHash);
  if (!ok) { registerFail(memberName); return res.status(401).json({ error: 'invalid pin' }); }
  clearFails(memberName);
  if (memberName === 'Daniel') return res.json({ need2fa: true });
  return res.json({ ok: true, memberName });
});

app.post('/auth/2', (req, res) => {
  const { memberName, secondary } = req.body || {};
  if (!memberName || !secondary) return res.status(400).json({ error: 'memberName and secondary required' });
  if (memberName !== 'Daniel') return res.status(400).json({ error: 'not applicable' });
  if (isLocked(memberName)) return res.status(429).json({ error: 'locked', note: 'get fucked william' });
  if (String(secondary) !== STARTUP_SECONDARY) { registerFail(memberName); return res.status(401).json({ error: 'invalid secondary' }); }
  clearFails(memberName);
  return res.json({ ok: true, memberName });
});

app.get('/members', (req, res) => {
  const d = load();
  res.json({ members: memberNames(d) });
});

app.post('/members', (req, res) => {
  const { name, pin } = req.body || {};
  if (!name || !pin) return res.status(400).json({ error: 'name and pin required' });
  const d = load();
  if (d.members.find(m => m.name === name)) return res.status(409).json({ error: 'member exists' });
  d.members.push({ name, pinHash: bcrypt.hashSync(String(pin), 10) });
  recomputeAll(d);
  save(d);
  res.json({ message: 'member added', members: memberNames(d) });
});

app.get('/candidates', (req, res) => {
  const d = load();
  recomputeAll(d);
  res.json({ candidates: d.candidates });
});

app.post('/candidates', (req, res) => {
  const { firstName, lastInitial, notes } = req.body || {};
  if (!firstName || !lastInitial) return res.status(400).json({ error: 'firstName and lastInitial required' });
  const d = load();
  const dupe = d.candidates.find(c =>
    String(c.firstName).toLowerCase() === String(firstName).toLowerCase() &&
    String(c.lastInitial).toLowerCase() === String(lastInitial).slice(0,1).toLowerCase()
  );
  if (dupe) return res.status(409).json({ error: 'name already exists' });
  const candidate = {
    id: makeId(),
    firstName: String(firstName),
    lastInitial: String(lastInitial).slice(0,1).toUpperCase(),
    notes: notes || '',
    votes: {},
    status: 'pending',
    ratified: false,
    totalMembers: load().members.length,
    createdAt: new Date().toISOString()
  };
  d.candidates.push(candidate);
  recomputeAll(d);
  save(d);
  res.json({ message: 'candidate added', candidate });
});

app.post('/vote', (req, res) => {
  const { candidateId, memberName, vote } = req.body || {};
  if (!candidateId || !memberName || typeof vote !== 'boolean') {
    return res.status(400).json({ error: 'candidateId, memberName, vote(boolean) required' });
  }
  const d = load();
  const c = d.candidates.find(x => x.id === candidateId);
  if (!c) return res.status(404).json({ error: 'candidate not found' });
  if (!d.members.find(m => m.name === memberName)) return res.status(400).json({ error: 'member not recognized' });
  c.votes = c.votes || {};
  c.votes[memberName] = !!vote;
  recomputeStatus(c, d.members);
  save(d);
  res.json({ message: 'vote recorded', candidate: c });
});

app.patch('/candidates/:id', (req, res) => {
  const { id } = req.params;
  const { action, status } = req.body || {};
  const d = load();
  const idx = d.candidates.findIndex(c => c.id === id);
  if (idx < 0) return res.status(404).json({ error: 'candidate not found' });
  const c = d.candidates[idx];
  switch (action) {
    case 'reopen':
      c.votes = {};
      c.status = 'pending';
      c.ratified = false;
      break;
    case 'delete':
      d.candidates.splice(idx, 1);
      save(d);
      return res.json({ message: 'deleted', id });
    case 'setStatus':
      if (!['banned','allowed','pending'].includes(status)) return res.status(400).json({ error: 'invalid status' });
      c.status = status;
      c.ratified = status === 'banned';
      if (status === 'banned' || status === 'allowed') {
        const yes = status === 'banned';
        c.votes = {};
        memberNames(d).forEach(n => { c.votes[n] = yes; });
      } else {
        c.votes = {};
      }
      break;
    default:
      return res.status(400).json({ error: 'unknown action' });
  }
  recomputeStatus(c, d.members);
  save(d);
  res.json({ message: 'updated', candidate: c });
});

app.post('/admin/reset', (req, res) => {
  const hdr = req.headers['x-admin-secondary'];
  if (hdr !== STARTUP_SECONDARY) return res.status(401).json({ error: 'unauthorized' });
  try { fs.unlinkSync(DATA_PATH); } catch {}
  bootstrapData();
  res.json({ ok: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
