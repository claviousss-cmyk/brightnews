const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// Simple Database JSON Loader/Writer
const DB_PATH = path.join(__dirname, 'data', 'db.json');
function getDB() {
    if (!fs.existsSync(DB_PATH)) {
        return { predictions: [], news: [], kits: [] };
    }
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function saveDB(data) {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// 1. Admin Login Endpoint (Aman dari Inspect Element)
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
        res.json({ success: true, message: 'Authenticated successfully' });
    } else {
        res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
});

// 2. API Proxy untuk Football-Data.org (Menyembunyikan Key dari Client)
app.get('/api/proxy/football-data', async (req, res) => {
    try {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch('https://api.football-data.org/v4/matches', {
            headers: { 'X-Auth-Token': process.env.FOOTBALL_DATA_API_KEY }
        });
        const data = await response.json();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Endpoint CRUD Dinamis untuk Admin (Predictions, News, Kits)
app.get('/api/content', (req, res) => {
    res.json(getDB());
});

app.post('/api/content', (req, res) => {
    // Contoh penambahan data oleh Admin
    const { type, item } = req.body; // type: 'predictions' / 'news' / 'kits'
    const db = getDB();
    if(db[type]) {
        db[type].push(item);
        saveDB(db);
        res.json({ success: true, data: db[type] });
    } else {
        res.status(400).json({ success: false, message: 'Invalid content type' });
    }
});

app.listen(PORT, () => {
    console.log(`BRIGHTNEWS Server running on http://localhost:${PORT}`);
});