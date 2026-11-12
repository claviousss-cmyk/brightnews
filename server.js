const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const crypto = require('crypto');
const tokens = new Set();
const app = express();
app.use(express.json({ limit: '6mb' }));
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
    try { const out = await fn(req); if (req.method === 'GET') res.set('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120'); res.json(out); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
};
const iso = (offset) => {
    const d = new Date(Date.now() + offset * 86400000);
    return d.toISOString().slice(0, 10);
};

// ---------- Daftar pertandingan (kemarin-2 hari s/d 3 hari ke depan) ----------
app.get('/api/matches', wrap(async () => {
    const d = await fd(`/matches?dateFrom=${iso(-2)}&dateTo=${iso(4)}`, 60000);
    const live = (d.matches || []).filter(m => ['IN_PLAY', 'PAUSED'].includes(m.status));
    if (!live.length || !process.env.API_FOOTBALL_KEY) return d;
    let fx = [];
    try { const l = await af('/fixtures?live=all', 180000); if (!afErr(l)) fx = l.response || []; } catch (e) {}
    return { ...d, matches: d.matches.map(m => { const f = live.includes(m) ? fx.find(x => same(x.teams.home.name, m.homeTeam.name) && same(x.teams.away.name, m.awayTeam.name)) : null; return f ? { ...m, liveMinute: f.fixture.status.elapsed } : m; }) };
}));

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
const CODES = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL', 'ELC', 'DED', 'PPL', 'BSA'];
app.get('/api/standings/:code', wrap((req) => {
    if (!CODES.includes(req.params.code)) throw Object.assign(new Error('Liga tidak didukung'), { status: 400 });
    return fd(`/competitions/${req.params.code}/standings`, 300000);
}));

// ---------- Analisis otomatis (bukan prediksi resmi) ----------
async function analyze(id) {
    const m = await fd(`/matches/${id}`, 30000);
    const H = m.homeTeam.id, A = m.awayTeam.id;
    const [std, fh, fa, h2h] = await Promise.all([
        fd(`/competitions/${m.competition.code}/standings`, 300000).catch(() => null),
        fd(`/teams/${H}/matches?status=FINISHED&limit=5`, 600000).catch(() => null),
        fd(`/teams/${A}/matches?status=FINISHED&limit=5`, 600000).catch(() => null),
        fd(`/matches/${id}/head2head?limit=5`, 600000).catch(() => null)
    ]);
    const rows = std ? (std.standings || []).filter(x => x.type === 'TOTAL').flatMap(x => x.table) : [];
    const stat = (tid, f) => {
        const r = rows.find(x => x.team.id === tid);
        const s = r && r.playedGames ? { ppg: r.points / r.playedGames, gf: r.goalsFor / r.playedGames, ga: r.goalsAgainst / r.playedGames } : null;
        let pts = 0, gf = 0, ga = 0, n = 0;
        ((f && f.matches) || []).forEach(x => {
            const hs = x.score.fullTime.home, as = x.score.fullTime.away;
            if (hs == null) return;
            const home = x.homeTeam.id === tid, me = home ? hs : as, op = home ? as : hs;
            gf += me; ga += op; n++; pts += me > op ? 3 : me === op ? 1 : 0;
        });
        const fo = n ? { ppg: pts / n, gf: gf / n, ga: ga / n } : null;
        if (!s && !fo) return null;
        const mix = (k) => (s && fo ? s[k] * 0.55 + fo[k] * 0.45 : (s || fo)[k]);
        return { ppg: mix('ppg'), gf: mix('gf'), ga: mix('ga') };
    };
    const th = stat(H, fh), ta = stat(A, fa);
    if (!th || !ta) return { available: false };

    const ag = h2h && h2h.aggregates;
    let hh = 0, h2hText = 'Head to head: no data';
    if (ag && ag.numberOfMatches) {
        const hw = ag.homeTeam.id === H ? ag.homeTeam : ag.awayTeam, aw = hw === ag.homeTeam ? ag.awayTeam : ag.homeTeam;
        hh = (hw.wins - aw.wins) / ag.numberOfMatches;
        h2hText = `Head to head (last ${ag.numberOfMatches}): ${hw.wins}W ${hw.draws}D ${aw.wins}L for the home side`;
    }
    const diff = (th.ppg - ta.ppg) + 0.35 + ((th.gf - th.ga) - (ta.gf - ta.ga)) * 0.25 + hh * 0.3;
    const pD = 0.28 - Math.min(0.12, Math.abs(diff) * 0.06);
    const ph0 = 1 / (1 + Math.exp(-1.1 * diff));
    let home = Math.round((1 - pD) * ph0 * 100), draw = Math.round(pD * 100), away = 100 - home - draw;
    const sources = ['football-data.org'];
    let afAdvice = null;
    try {
        const fx = await afFind(m.utcDate.slice(0, 10), m.homeTeam.name, m.awayTeam.name);
        if (fx) {
            const pr = await af('/predictions?fixture=' + fx.fixture.id, 21600000);
            const p = pr.response && pr.response[0] && pr.response[0].predictions;
            const pc = p && p.percent, n = (v) => parseInt(v, 10) || 0;
            if (pc && n(pc.home) + n(pc.draw) + n(pc.away) > 0) {
                home = Math.round(home * 0.6 + n(pc.home) * 0.4); draw = Math.round(draw * 0.6 + n(pc.draw) * 0.4); away = 100 - home - draw;
                sources.push('API-Football'); afAdvice = p.advice || null;
            }
        }
    } catch (e) {}
    const ranked = [['H', home], ['D', draw], ['A', away]].sort((x, y) => y[1] - x[1]);
    const gap = ranked[0][1] - ranked[1][1];
    const hn = m.homeTeam.shortName || m.homeTeam.name, an = m.awayTeam.shortName || m.awayTeam.name;
    const pick = ranked[0][0] === 'H' ? `${hn} to win` : ranked[0][0] === 'A' ? `${an} to win` : 'Draw';
    const tot = (th.gf + ta.ga) / 2 + (ta.gf + th.ga) / 2;
    const goals = tot >= 2.75 ? 'Over 2.5 goals' : tot <= 2.25 ? 'Under 2.5 goals' : 'Too close to call (around 2.5)';
    const btts = (th.gf >= 1.1 && ta.gf >= 1.1 && th.ga >= 1 && ta.ga >= 1) ? 'Yes' : (th.gf < 0.9 || ta.gf < 0.9) ? 'No' : 'Uncertain';
    const f1 = (x) => x.toFixed(1);
    return {
        available: true, home, draw, away, pick, goals, btts, xg: f1(tot), sources, afAdvice, matchId: m.id, kickoff: m.utcDate, mstatus: m.status, label: hn + ' vs ' + an, pk: ranked[0][0], ou: tot >= 2.75 ? 'O' : tot <= 2.25 ? 'U' : '-',
        confidence: gap >= 20 ? 'High' : gap >= 10 ? 'Medium' : 'Low',
        basis: [
            `Points per game (season blended with last 5): ${f1(th.ppg)} vs ${f1(ta.ppg)}`,
            `Goals scored per game: ${f1(th.gf)} vs ${f1(ta.gf)}`,
            `Goals conceded per game: ${f1(th.ga)} vs ${f1(ta.ga)}`,
            h2hText,
            'A fixed home advantage is applied to the host team',
            sources.length > 1 ? 'API-Football prediction model blended in (40% weight)' : 'API-Football had no data for this match, so only football-data is used'
        ]
    };
}
async function snap(r) {
    if (!r || !r.available || !['TIMED', 'SCHEDULED'].includes(r.mstatus) || Date.parse(r.kickoff) < Date.now()) return;
    if (await store.get('asnap', r.matchId)) return;
    await store.put('asnap', r.matchId, { label: r.label, kickoff: r.kickoff, pk: r.pk, ou: r.ou, btts: r.btts, conf: r.confidence, home: r.home, draw: r.draw, away: r.away, st: 'pending' });
}
app.get('/api/suggest/:id', wrap(async (req) => {
    if (!/^\d+$/.test(req.params.id)) throw Object.assign(new Error('ID salah'), { status: 400 });
    const r = await analyze(req.params.id);
    try { await snap(r); } catch (e) {}
    return r;
}));
app.get('/api/team/:id', wrap((req) => {
    if (!/^\d+$/.test(req.params.id)) throw Object.assign(new Error('ID salah'), { status: 400 });
    return fd(`/teams/${req.params.id}`, 3600000);
}));
app.get('/api/team/:id/next', wrap((req) => {
    if (!/^\d+$/.test(req.params.id)) throw Object.assign(new Error('ID salah'), { status: 400 });
    return fd(`/teams/${req.params.id}/matches?status=SCHEDULED,TIMED&limit=5`, 600000);
}));

// ---------- Form tim (5 laga terakhir) ----------
app.get('/api/form/:id', wrap((req) => {
    if (!/^\d+$/.test(req.params.id)) throw Object.assign(new Error('ID salah'), { status: 400 });
    return fd(`/teams/${req.params.id}/matches?status=FINISHED&limit=5`, 600000);
}));

// ---------- API-Football (stats pertandingan) ----------
const afDay = { d: '', n: 0 };
async function af(p, ttl) {
    const hit = cache.get('af' + p);
    if (hit && Date.now() - hit.t < ttl) return hit.d;
    const day = new Date().toISOString().slice(0, 10);
    if (afDay.d !== day) { afDay.d = day; afDay.n = 0; }
    if (afDay.n >= 95) throw new Error('API-Football daily limit reached (95/100 used)');
    afDay.n++;
    const r = await fetch('https://v3.football.api-sports.io' + p, { headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY } });
    const d = await r.json();
    cache.set('af' + p, { d, t: Date.now() });
    return d;
}
const afErr = (d) => { const e = d && d.errors; if (!e) return null; const v = Array.isArray(e) ? e : Object.values(e); return v.length ? v.join(' | ') : null; };
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\b(fc|cf|ac|as|sc|afc|ssc|us|rc|ud|cd|1907|1899)\b/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const same = (a, b) => { a = norm(a); b = norm(b); if (!a || !b) return false; return a.includes(b) || b.includes(a) || a.split(' ')[0] === b.split(' ')[0]; };

let afWin = null;
const today = () => new Date().toISOString().slice(0, 10);
const afOut = (d) => !!(afWin && afWin.day === today() && (d < afWin.from || d > afWin.to));
const setWin = (e) => { const mm = /from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/.exec(e); if (mm) afWin = { day: today(), from: mm[1], to: mm[2] }; };
async function afFind(date, home, away) {
    if (afOut(date)) return null;
    const list = await af('/fixtures?date=' + date, 3600000);
    const e0 = afErr(list);
    if (e0) { setWin(e0); return null; }
    return (list.response || []).find(f => same(f.teams.home.name, home) && same(f.teams.away.name, away)) || null;
}
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
        if (afOut(date)) return res.json({ available: false, reason: 'API-Football free plan only covers ' + afWin.from + ' to ' + afWin.to });
        const list = await af('/fixtures?date=' + date, 3600000);
        const e1 = afErr(list);
        if (e1) { setWin(e1); return res.json({ available: false, reason: e1 }); }
        const fx = (list.response || []).find(f => same(f.teams.home.name, home) && same(f.teams.away.name, away));
        if (!fx) return res.json({ available: false, reason: 'Pertandingan ini tidak ditemukan di API-Football' });
        const live = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE'].includes(fx.fixture.status.short);
        const ttl = live ? 60000 : 1800000;
        const [st, ev, lu] = await Promise.all([af('/fixtures/statistics?fixture=' + fx.fixture.id, ttl), af('/fixtures/events?fixture=' + fx.fixture.id, ttl), af('/fixtures/lineups?fixture=' + fx.fixture.id, ttl)]);
        res.json({ available: true, homeId: fx.teams.home.id, minute: fx.fixture.status.elapsed, statistics: st.response || [], events: ev.response || [], lineups: lu.response || [] });
    } catch (e) { res.json({ available: false, reason: e.message }); }
});

// ---------- Login admin ----------
const fails = new Map();
const SECRET = process.env.SESSION_SECRET || process.env.ADMIN_PASS || 'dev-secret';
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const signToken = () => { const exp = String(Date.now() + 12 * 3600e3); return exp + '.' + hmac(exp); };
const okToken = (tk) => { const [exp, sig] = String(tk || '').split('.'); const good = hmac(String(exp)); return !!sig && sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)) && Number(exp) > Date.now(); };
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
app.post('/api/admin/login', (req, res) => {
    const ip = String(req.headers['x-forwarded-for'] || req.ip).split(',')[0];
    const f = fails.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - f.t > 600000) { f.n = 0; f.t = Date.now(); }
    if (f.n >= 5) return res.status(429).json({ success: false, message: 'Too many attempts. Try again in 10 minutes.' });
    const { username, password } = req.body || {};
    const ok = crypto.timingSafeEqual(hash(username), hash(process.env.ADMIN_USER)) && crypto.timingSafeEqual(hash(password), hash(process.env.ADMIN_PASS));
    if (ok) { fails.delete(ip); return res.json({ success: true, token: signToken() }); }
    f.n++; fails.set(ip, f);
    res.status(401).json({ success: false });
});

// ---------- Konten (prediksi, berita, kits) ----------

// ---------- Top skor ----------
app.get('/api/scorers/:code', wrap((req) => {
    if (!CODES.includes(req.params.code)) throw Object.assign(new Error('Liga tidak didukung'), { status: 400 });
    return fd(`/competitions/${req.params.code}/scorers?limit=10`, 300000);
}));

// ---------- Konten admin (butuh login) ----------
const TYPES = ['predictions', 'news', 'kits', 'featured', 'takes', 'transfers', 'players', 'facts', 'hero', 'backdrops'];
const TURSO = !!(process.env.TURSO_URL && process.env.TURSO_TOKEN);
async function sql(q, args = []) {
    const base = process.env.TURSO_URL.replace(/^libsql:/, 'https:').replace(/\/$/, '');
    const r = await fetch(base + '/v2/pipeline', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.TURSO_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql: q, args: args.map(v => ({ type: typeof v === 'number' ? 'integer' : 'text', value: String(v) })) } }, { type: 'close' }] })
    });
    const j = await r.json().catch(() => ({}));
    const res = j.results && j.results[0];
    if (!r.ok || !res || res.type === 'error') throw new Error('Database error: ' + JSON.stringify((res && res.error) || j).slice(0, 200));
    return ((res.response.result && res.response.result.rows) || []).map(row => row.map(c => c.value));
}
let ready;
const init = () => ready || (ready = sql('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, type TEXT NOT NULL, data TEXT NOT NULL)'));
const fileDB = () => fs.existsSync(DB_PATH) ? JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) : { predictions: [], news: [], kits: [] };
const saveFile = (d) => { fs.mkdirSync(path.dirname(DB_PATH), { recursive: true }); fs.writeFileSync(DB_PATH, JSON.stringify(d, null, 2)); };
const store = {
    async all() {
        if (!TURSO) return fileDB();
        await init();
        const o = { predictions: [], news: [], kits: [] };
        (await sql("SELECT id, type, data FROM items WHERE type NOT IN ('fan', 'asnap') ORDER BY id")).forEach(([id, type, data]) => { (o[type] = o[type] || []).push({ ...JSON.parse(data), id: Number(id) }); });
        return o;
    },
    async add(type, item) {
        const id = Date.now();
        if (!TURSO) { const d = fileDB(); (d[type] = d[type] || []).push({ ...item, id }); return saveFile(d); }
        await init(); await sql('INSERT INTO items (id, type, data) VALUES (?, ?, ?)', [id, type, JSON.stringify(item)]);
    },
    async del(type, id) {
        if (!TURSO) { const d = fileDB(); d[type] = (d[type] || []).filter(x => String(x.id) !== String(id)); return saveFile(d); }
        await init(); await sql('DELETE FROM items WHERE id = ? AND type = ?', [Number(id), type]);
    },
    async patch(id, fn) {
        if (!TURSO) { const d = fileDB(); const p = (d.predictions || []).find(x => String(x.id) === String(id)); if (!p) return false; fn(p); saveFile(d); return true; }
        await init();
        const r = await sql("SELECT data FROM items WHERE id = ? AND type = 'predictions'", [Number(id)]);
        if (!r.length) return false;
        const p = JSON.parse(r[0][0]); fn(p);
        await sql('UPDATE items SET data = ? WHERE id = ?', [JSON.stringify(p), Number(id)]);
        return true;
    }
};
store.upd = async (type, id, item) => {
    if (!TURSO) { const d = fileDB(); const p = (d[type] || []).find(x => String(x.id) === String(id)); if (!p) return false; Object.assign(p, item); saveFile(d); return true; }
    await init();
    const r = await sql('SELECT data FROM items WHERE id = ? AND type = ?', [Number(id), type]);
    if (!r.length) return false;
    await sql('UPDATE items SET data = ? WHERE id = ?', [JSON.stringify({ ...JSON.parse(r[0][0]), ...item }), Number(id)]);
    return true;
};
store.get = async (type, id) => {
    if (!TURSO) return (fileDB()['_' + type] || {})[id] || null;
    await init();
    const r = await sql('SELECT data FROM items WHERE id = ? AND type = ?', [Number(id), type]);
    return r.length ? JSON.parse(r[0][0]) : null;
};
store.put = async (type, id, obj) => {
    if (!TURSO) { const d = fileDB(); d['_' + type] = d['_' + type] || {}; d['_' + type][id] = obj; return saveFile(d); }
    await init();
    await sql('INSERT INTO items (id, type, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', [Number(id), type, JSON.stringify(obj)]);
};
store.list = async (type) => {
    if (!TURSO) return Object.entries(fileDB()['_' + type] || {}).map(([id, v]) => ({ ...v, id: Number(id) }));
    await init();
    return (await sql('SELECT id, data FROM items WHERE type = ?', [type])).map(([id, data]) => ({ ...JSON.parse(data), id: Number(id) }));
};
const auth = (req, res, next) => okToken(req.headers['x-token']) ? next() : res.status(401).json({ error: 'Unauthorized' });
const clean = (o) => Object.fromEntries(Object.entries(o || {}).slice(0, 10).map(([k, v]) => [String(k).slice(0, 30), String(v).slice(0, 4000)]));
const guard = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(500).json({ error: e.message }); } };

app.get('/api/content', guard(async (req, res) => {
    const d = await store.all(); Object.keys(d).forEach(k => (k === 'fan' || k[0] === '_') && delete d[k]);
    if (!okToken(req.headers['x-token'])) d.predictions = (d.predictions || []).filter(p => p.published !== 'false');
    res.json(d);
}));
app.post('/api/content', auth, guard(async (req, res) => {
    const { type, item } = req.body;
    if (!TYPES.includes(type)) return res.status(400).json({ error: 'Invalid type' });
    await store.add(type, { ...clean(item), date: new Date().toISOString() });
    res.json({ success: true });
}));
app.delete('/api/content/:type/:id', auth, guard(async (req, res) => {
    if (!TYPES.includes(req.params.type)) return res.status(400).json({ error: 'Invalid type' });
    await store.del(req.params.type, req.params.id);
    res.json({ success: true });
}));
app.patch('/api/content/predictions/:id', auth, guard(async (req, res) => {
    const { result, published } = req.body;
    if (result !== undefined && !['won', 'lost', 'void', 'pending'].includes(result)) return res.status(400).json({ error: 'Invalid' });
    const ok = await store.patch(req.params.id, (p) => { if (result !== undefined) p.result = result; if (published !== undefined) p.published = String(published); });
    res.status(ok ? 200 : 404).json({ success: ok });
}));

app.put('/api/content/:type/:id', auth, guard(async (req, res) => {
    if (!TYPES.includes(req.params.type)) return res.status(400).json({ error: 'Invalid type' });
    const ok = await store.upd(req.params.type, req.params.id, clean(req.body && req.body.item));
    res.status(ok ? 200 : 404).json({ success: ok });
}));

// Fan Prediction (vote publik, 1 vote per IP per pertandingan)
const votes = new Map();
app.get('/api/fan/:id', guard(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid' });
    res.json((await store.get('fan', req.params.id)) || { home: 0, draw: 0, away: 0 });
}));
app.post('/api/fan/:id', guard(async (req, res) => {
    const id = req.params.id, c = req.body && req.body.choice;
    if (!/^\d+$/.test(id) || !['home', 'draw', 'away'].includes(c)) return res.status(400).json({ error: 'Invalid' });
    const k = String(req.headers['x-forwarded-for'] || req.ip).split(',')[0] + ':' + id;
    if (votes.has(k)) return res.status(429).json({ error: 'Already voted' });
    votes.set(k, 1);
    const cur = (await store.get('fan', id)) || { home: 0, draw: 0, away: 0 };
    cur[c]++;
    await store.put('fan', id, cur);
    res.json(cur);
}));

// ---------- Upload gambar (admin) ----------
let imgReady;
const initImg = () => imgReady || (imgReady = sql('CREATE TABLE IF NOT EXISTS images (id INTEGER PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL)'));
app.post('/api/upload', auth, guard(async (req, res) => {
    const s = String((req.body && req.body.dataUrl) || ''), mm = /^data:(image\/(?:jpeg|png|webp));base64,/.exec(s.slice(0, 40));
    const data = mm ? s.slice(mm[0].length) : '';
    if (!mm || !data || data.length > 4000000 || !/^[A-Za-z0-9+/=]+$/.test(data)) return res.status(400).json({ error: 'Invalid or too large image' });
    const id = Date.now();
    if (TURSO) { await initImg(); await sql('INSERT INTO images (id, mime, data) VALUES (?, ?, ?)', [id, mm[1], data]); }
    else { fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true }); fs.writeFileSync(path.join(__dirname, 'data', 'img-' + id + '.json'), JSON.stringify({ mime: mm[1], data })); }
    res.json({ url: '/api/img/' + id });
}));
app.get('/api/img/:id', guard(async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).end();
    let r = null;
    if (TURSO) { await initImg(); const q = await sql('SELECT mime, data FROM images WHERE id = ?', [Number(req.params.id)]); if (q.length) r = { mime: q[0][0], data: q[0][1] }; }
    else { const f = path.join(__dirname, 'data', 'img-' + req.params.id + '.json'); if (fs.existsSync(f)) r = JSON.parse(fs.readFileSync(f, 'utf8')); }
    if (!r) return res.status(404).end();
    res.set('Content-Type', r.mime).set('Cache-Control', 'public, max-age=31536000, immutable').send(Buffer.from(r.data, 'base64'));
}));

// ---------- Scorecard analisis otomatis ----------
app.get('/api/scorecard', guard(async (req, res) => {
    try {
        const d = await fd(`/matches?dateFrom=${iso(-2)}&dateTo=${iso(4)}`, 60000);
        const have = new Set((await store.list('asnap')).map(r => String(r.id)));
        const up = (d.matches || []).filter(m => ['TIMED', 'SCHEDULED'].includes(m.status) && !have.has(String(m.id)) && Date.parse(m.utcDate) > Date.now() && Date.parse(m.utcDate) - Date.now() < 36 * 3600e3).slice(0, 2);
        for (const m of up) { try { await snap(await analyze(m.id)); } catch (e) {} }
    } catch (e) {}
    const rows = await store.list('asnap');
    let budget = 4;
    for (const r of rows) {
        if (r.st !== 'pending' || budget <= 0 || Date.parse(r.kickoff) > Date.now() - 3 * 3600e3) continue;
        try {
            const m = await fd(`/matches/${r.id}`, 600000); budget--;
            if (m.status === 'FINISHED') {
                const h = m.score.fullTime.home, a = m.score.fullTime.away, act = h > a ? 'H' : h < a ? 'A' : 'D';
                Object.assign(r, { st: 'done', act, hs: h, as: a, okR: r.pk === act, okG: r.ou === '-' ? null : (r.ou === 'O') === (h + a > 2.5), okB: r.btts === 'Uncertain' ? null : (r.btts === 'Yes') === (h > 0 && a > 0) });
                const { id, ...rest } = r; await store.put('asnap', id, rest);
            }
        } catch (e) {}
    }
    const done = rows.filter(r => r.st === 'done'), ok = done.filter(r => r.okR).length, conf = {};
    ['High', 'Medium', 'Low'].forEach(c => { const x = done.filter(r => r.conf === c); conf[c] = { n: x.length, ok: x.filter(r => r.okR).length }; });
    const g = done.filter(r => r.okG === true || r.okG === false), b = done.filter(r => r.okB === true || r.okB === false);
    res.set('Cache-Control', 'public, s-maxage=300').json({ total: done.length, ok, pending: rows.length - done.length, conf, goals: { n: g.length, ok: g.filter(r => r.okG).length }, btts: { n: b.length, ok: b.filter(r => r.okB).length }, recent: done.sort((p, q) => q.id - p.id).slice(0, 10).map(r => ({ label: r.label, pk: r.pk, act: r.act, hs: r.hs, as: r.as, okR: r.okR })) });
}));

// ---------- Link share dengan preview (WhatsApp, Instagram, X) ----------
app.get('/share/:type/:id', async (req, res) => {
    const { type, id } = req.params, base = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host || '');
    let title = 'BRIGHTNEWS - THE GAME, BEYOND THE SCORE', desc = 'Live scores, match analysis, predictions and football culture.', go = '/';
    try {
        if (type === 'match' && /^\d+$/.test(id)) {
            const m = await fd(`/matches/${id}`, 30000);
            title = `${m.homeTeam.name} vs ${m.awayTeam.name} - ${m.competition.name} | BRIGHTNEWS`;
            desc = m.status === 'FINISHED' ? `Final score ${m.score.fullTime.home}-${m.score.fullTime.away}. Stats, events and analysis on BRIGHTNEWS.` : `Kick-off ${m.utcDate.slice(0, 16).replace('T', ' ')} GMT. Form, head to head and automated analysis on BRIGHTNEWS.`;
            go = '/#/match/' + id;
        } else if (type === 'news' && /^\d+$/.test(id)) {
            const n = ((await store.all()).news || []).find(x => String(x.id) === id);
            if (n) { title = n.title + ' | BRIGHTNEWS'; desc = String(n.text || '').slice(0, 160); go = '/#/news/' + id; }
        } else if (type === 'team' && /^\d+$/.test(id)) {
            const tm = await fd(`/teams/${id}`, 3600000);
            title = `${tm.name} - fixtures, results and squad | BRIGHTNEWS`; desc = `Latest fixtures, form and squad for ${tm.name}.`; go = '/#/team/' + id;
        }
    } catch (e) {}
    const e = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    res.set('Content-Type', 'text/html; charset=utf-8').set('Cache-Control', 'public, s-maxage=300').send(`<!doctype html><html><head><meta charset="utf-8"><title>${e(title)}</title><meta name="description" content="${e(desc)}"><meta property="og:title" content="${e(title)}"><meta property="og:description" content="${e(desc)}"><meta property="og:type" content="website"><meta property="og:image" content="${base}/og.png"><meta name="twitter:card" content="summary_large_image"><meta http-equiv="refresh" content="0;url=${go}"></head><body><script>location.replace(${JSON.stringify(go)})</script></body></html>`);
});

// Cek kesehatan semua sumber data (hanya admin)
app.get('/api/health', auth, guard(async (req, res) => {
    const out = { database: TURSO ? 'Turso (permanent)' : 'db.json (temporary on most hosts)', footballData: {}, apiFootball: {} };
    try { const d = await fd('/competitions/PL', 60000); out.footballData = { ok: true, detail: d.name + ' reachable' }; } catch (e) { out.footballData = { ok: false, detail: e.message }; }
    try {
        const st = await af('/status', 60000), fx = await af('/fixtures?date=' + iso(0), 3600000), r = st.response || {};
        out.apiFootball = { ok: !afErr(st), plan: r.subscription && r.subscription.plan, used: r.requests && r.requests.current, limit: r.requests && r.requests.limit_day, todayData: afErr(fx) ? 'Blocked: ' + afErr(fx) : (fx.response || []).length + ' fixtures available today' };
    } catch (e) { out.apiFootball = { ok: false, detail: e.message }; }
    res.json(out);
}));

// Proxy logo klub (agar bisa dipakai di gambar yang dibagikan)
app.get('/api/crest', async (req, res) => {
    try {
        const u = new URL(String(req.query.u));
        if (u.protocol !== 'https:' || !['crests.football-data.org', 'upload.wikimedia.org', 'media.api-sports.io'].includes(u.hostname)) return res.status(400).end();
        const r = await fetch(u);
        if (!r.ok) return res.status(404).end();
        res.set('Content-Type', r.headers.get('content-type') || 'image/png').set('Cache-Control', 'public, max-age=604800').send(Buffer.from(await r.arrayBuffer()));
    } catch (e) { res.status(400).end(); }
});

if (require.main === module) app.listen(PORT, () => console.log(`BRIGHTNEWS running at http://localhost:${PORT}`));
module.exports = app;
