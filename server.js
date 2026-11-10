const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const crypto = require('crypto');
const tokens = new Set();
const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'db.json');

// ---------- Fungsi ambil data + simpan sementara (cache) ----------
const cache = new Map();
async function fd(apiPath, ttlMs) {
    const hit = cache.get(apiPath);
    if (hit && Date.now() - hit.t < ttlMs) return hit.d;
    const r = await fetch('https://api.football-data.org/v4' + apiPath, {
        headers: { 'X-Auth-Token': process.env.FOOTBALL_DATA_API_KEY }
    });
    if (!r.ok) {
        const e = new Error('API error ' + r.status);
        e.status = r.status;
        throw e;
    }
    const d = await r.json();
    cache.set(apiPath, { d, t: Date.now() });
    return d;
}
const wrap = (fn) => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
};
const iso = (offset) => {
    const d = new Date(Date.now() + offset * 86400000);
    return d.toISOString().slice(0, 10);
};

// ---------- Daftar pertandingan (kemarin-2 hari s/d 3 hari ke depan) ----------
app.get('/api/matches', wrap(() =>
    fd(`/matches?dateFrom=${iso(-2)}&dateTo=${iso(4)}`, 60000)));

// ---------- Detail 1 pertandingan ----------
app.get('/api/match/:id', wrap((req) => {
    if (!/^\d+$/.test(req.params.id)) throw Object.assign(new Error('ID salah'), { status: 400 });
    return fd(`/matches/${req.params.id}`, 30000);
}));

// ---------- Head to head ----------
app.get('/api/h2h/:id', wrap((req) => {
    if (!/^\d+$/.test(req.params.id)) throw Object.assign(new Error('ID salah'), { status: 400 });
    return fd(`/matches/${req.params.id}/head2head?limit=5`, 300000);
}));

// ---------- Klasemen ----------
const CODES = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL'];
app.get('/api/standings/:code', wrap((req) => {
    if (!CODES.includes(req.params.code)) throw Object.assign(new Error('Liga tidak didukung'), { status: 400 });
    return fd(`/competitions/${req.params.code}/standings`, 300000);
}));

// ---------- Form tim (5 laga terakhir) ----------
app.get('/api/form/:id', wrap((req) => {
    if (!/^\d+$/.test(req.params.id)) throw Object.assign(new Error('ID salah'), { status: 400 });
    return fd(`/teams/${req.params.id}/matches?status=FINISHED&limit=5`, 600000);
}));

// ---------- API-Football (stats pertandingan) ----------
async function af(p, ttl) {
    const hit = cache.get('af' + p);
    if (hit && Date.now() - hit.t < ttl) return hit.d;
    const r = await fetch('https://v3.football.api-sports.io' + p, { headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY } });
    const d = await r.json();
    cache.set('af' + p, { d, t: Date.now() });
    return d;
}
const afErr = (d) => { const e = d && d.errors; if (!e) return null; const v = Array.isArray(e) ? e : Object.values(e); return v.length ? v.join(' | ') : null; };
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\b(fc|cf|ac|as|sc|afc|ssc|us|rc|ud|cd|1907|1899)\b/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const same = (a, b) => { a = norm(a); b = norm(b); if (!a || !b) return false; return a.includes(b) || b.includes(a) || a.split(' ')[0] === b.split(' ')[0]; };

// Buka /api/af/status di browser untuk TES apakah API-Football lo jalan
app.get('/api/af/status', async (req, res) => {
    try {
        const d = await af('/status', 60000);
        res.json({ keyDiisi: !!process.env.API_FOOTBALL_KEY, error: afErr(d), akun: d.response && d.response.account, paket: d.response && d.response.subscription, request: d.response && d.response.requests });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/af/match', async (req, res) => {
    const { date, home, away } = req.query;
    try {
        if (!process.env.API_FOOTBALL_KEY) return res.json({ available: false, reason: 'API_FOOTBALL_KEY belum diisi' });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'date salah' });
        const list = await af('/fixtures?date=' + date, 3600000);
        const e1 = afErr(list);
        if (e1) return res.json({ available: false, reason: e1 });
        const fx = (list.response || []).find(f => same(f.teams.home.name, home) && same(f.teams.away.name, away));
        if (!fx) return res.json({ available: false, reason: 'Pertandingan ini tidak ditemukan di API-Football' });
        const live = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE'].includes(fx.fixture.status.short);
        const ttl = live ? 60000 : 1800000;
        const [st, ev] = await Promise.all([af('/fixtures/statistics?fixture=' + fx.fixture.id, ttl), af('/fixtures/events?fixture=' + fx.fixture.id, ttl)]);
        res.json({ available: true, homeId: fx.teams.home.id, minute: fx.fixture.status.elapsed, statistics: st.response || [], events: ev.response || [] });
    } catch (e) { res.json({ available: false, reason: e.message }); }
});

// ---------- Login admin ----------
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
        const token = crypto.randomBytes(24).toString('hex'); tokens.add(token); res.json({ success: true, token });
    } else {
        res.status(401).json({ success: false });
    }
});

// ---------- Konten (prediksi, berita, kits) ----------
app.get('/api/content', (req, res) => {
    if (!fs.existsSync(DB_PATH)) return res.json({ predictions: [], news: [], kits: [] });
    res.json(JSON.parse(fs.readFileSync(DB_PATH, 'utf8')));
});

// ---------- Top skor ----------
app.get('/api/scorers/:code', wrap((req) => {
    if (!CODES.includes(req.params.code)) throw Object.assign(new Error('Liga tidak didukung'), { status: 400 });
    return fd(`/competitions/${req.params.code}/scorers?limit=10`, 300000);
}));

// ---------- Konten admin (butuh login) ----------
const TYPES = ['predictions', 'news', 'kits'];
const readDB = () => fs.existsSync(DB_PATH) ? JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) : { predictions: [], news: [], kits: [] };
const writeDB = (d) => { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); fs.writeFileSync(DB_PATH, JSON.stringify(d, null, 2)); };
const auth = (req, res, next) => tokens.has(req.headers['x-token']) ? next() : res.status(401).json({ error: 'Unauthorized' });
const clean = (o) => Object.fromEntries(Object.entries(o || {}).slice(0, 10).map(([k, v]) => [String(k).slice(0, 30), String(v).slice(0, 1000)]));

app.post('/api/content', auth, (req, res) => {
    const { type, item } = req.body;
    if (!TYPES.includes(type)) return res.status(400).json({ error: 'Tipe salah' });
    const db = readDB(); db[type] = db[type] || [];
    db[type].push({ ...clean(item), id: Date.now(), date: new Date().toISOString() });
    writeDB(db); res.json({ success: true });
});
app.delete('/api/content/:type/:id', auth, (req, res) => {
    if (!TYPES.includes(req.params.type)) return res.status(400).json({ error: 'Tipe salah' });
    const db = readDB();
    db[req.params.type] = (db[req.params.type] || []).filter(x => String(x.id) !== req.params.id);
    writeDB(db); res.json({ success: true });
});
app.patch('/api/content/predictions/:id', auth, (req, res) => {
    const db = readDB();
    const p = (db.predictions || []).find(x => String(x.id) === req.params.id);
    if (!p || !['won', 'lost', 'pending'].includes(req.body.result)) return res.status(400).json({ error: 'Salah' });
    p.result = req.body.result; writeDB(db); res.json({ success: true });
});

app.listen(PORT, () => console.log(`BRIGHTNEWS jalan di http://localhost:${PORT}`));
