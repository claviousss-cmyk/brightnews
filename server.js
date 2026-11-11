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
const CODES = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL'];
app.get('/api/standings/:code', wrap((req) => {
    if (!CODES.includes(req.params.code)) throw Object.assign(new Error('Liga tidak didukung'), { status: 400 });
    return fd(`/competitions/${req.params.code}/standings`, 300000);
}));

// ---------- Analisis otomatis (bukan prediksi resmi) ----------
app.get('/api/suggest/:id', wrap(async (req) => {
    const id = req.params.id;
    if (!/^\d+$/.test(id)) throw Object.assign(new Error('ID salah'), { status: 400 });
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
        available: true, home, draw, away, pick, goals, btts, xg: f1(tot), sources, afAdvice,
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

async function afFind(date, home, away) {
    const list = await af('/fixtures?date=' + date, 3600000);
    if (afErr(list)) return null;
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
const TYPES = ['predictions', 'news', 'kits', 'featured', 'takes', 'transfers', 'players', 'facts'];
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
        (await sql('SELECT id, type, data FROM items ORDER BY id')).forEach(([id, type, data]) => { (o[type] = o[type] || []).push({ ...JSON.parse(data), id: Number(id) }); });
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
const auth = (req, res, next) => okToken(req.headers['x-token']) ? next() : res.status(401).json({ error: 'Unauthorized' });
const clean = (o) => Object.fromEntries(Object.entries(o || {}).slice(0, 10).map(([k, v]) => [String(k).slice(0, 30), String(v).slice(0, 4000)]));
const guard = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(500).json({ error: e.message }); } };

app.get('/api/content', guard(async (req, res) => {
    const d = await store.all();
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
