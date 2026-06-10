const express = require('express');
const { ExpressPeerServer } = require('peer');
const path = require('path');
const Redis = require('ioredis');
require('dotenv').config();

const app = express();
const http = require('http');
const server = http.createServer(app);

const port = process.env.PORT || 3001;

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(redisUrl);  

redis.on('connect', () => console.log('Successfully connected to Redis.'));
redis.on('error', (err) => console.error('Redis Connection error:', err));

// Signaling server (PeerServer)
const peerServer = ExpressPeerServer(server, {
    debug: true
});

app.use('/peerjs', peerServer);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/', (req, res) => {
    res.render('index', {
        stunServer: process.env.STUN_SERVER,
        turnServer: process.env.TURN_SERVER,
        turnUser: process.env.TURN_USERNAME,
        turnPass: process.env.TURN_PASSWORD
    });
});

app.post('/api/create', async (req, res) => {
    const { peerId, slug } = req.body;
    if (!peerId || !slug) return res.status(400).json({ error: 'PeerID and Slug required' });

    try {
        // Store key link with 1-hour expiration window
        await redis.set(`slug:${slug}`, peerId, 'EX', 3600);
        res.json({ success: true, slug });
    } catch (err) {
        res.status(500).json({ error: 'Database write error' });
    }
});

app.get('/download/:slug', async (req, res) => {
    const slug = req.params.slug;
    
    try {
        const peerId = await redis.get(`slug:${slug}`);
        if (!peerId) return res.status(404).send('Link expired or invalid');
        
        res.render('download', {
            uploaderPeerId: peerId,
            stunServer: process.env.STUN_SERVER,
            turnServer: process.env.TURN_SERVER,    
            turnUser: process.env.TURN_USERNAME,
            turnPass: process.env.TURN_PASSWORD
        });
    } catch (err) {
        res.status(500).send('Database read error');
    }
});

server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});