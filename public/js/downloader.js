// Theme Toggle Support
const themeToggleBtn = document.getElementById('themeToggleBtn');
if (themeToggleBtn) {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'light' || (!savedTheme && window.matchMedia('(prefers-color-scheme: light)').matches)) {
        document.body.classList.add('light-theme');
    }
    themeToggleBtn.addEventListener('click', () => {
        document.body.classList.toggle('light-theme');
        const isLight = document.body.classList.contains('light-theme');
        localStorage.setItem('theme', isLight ? 'light' : 'dark');
    });
}

const status = document.getElementById('status');
const fileInfo = document.getElementById('fileInfo');
const fileNameSpan = document.getElementById('fileName');
const fileSizeSpan = document.getElementById('fileSize');
const downloadBtn = document.getElementById('downloadBtn');
const downloadControls = document.getElementById('downloadControls');
const pausePlayBtn = document.getElementById('pausePlayBtn');
const cancelBtn = document.getElementById('cancelBtn');
const streamAnimation = document.getElementById('streamAnimation');
const progressBar = document.getElementById('progressBar');

const slug = window.config.slug;
let uploaderPeerId = window.config.uploaderPeerId;
const iceServers = [];
if (window.config.stunServer) iceServers.push({ urls: window.config.stunServer });
if (window.config.turnServer) {
    iceServers.push({
        urls: window.config.turnServer,
        username: window.config.turnUser,
        credential: window.config.turnPass
    });
}

const peer = new Peer({
    host: window.location.hostname,
    port: window.location.port || (window.location.protocol === 'https:' ? 443 : 80),
    path: '/peerjs',
    config: { iceServers }
});

let conn = null;
let fileMetadata = null;
let receivedSize = 0;
let isDownloading = false;
let isPaused = false;
let reconnectTimeout = null;
let lastActiveTime = Date.now();
let heartbeatInterval = null;
let pendingWrites = [];

const dbName = 'P2PFileShareDB';
const storeName = 'file_chunks';
let db = null;

function setStatusDot(color) {
    status.classList.remove('status-green', 'status-yellow', 'status-red');
    if (color) {
        status.classList.add(`status-${color}`);
    }
    const h1 = document.querySelector('h1');
    if (h1) {
        h1.classList.remove('status-green', 'status-yellow', 'status-red');
        if (color) {
            h1.classList.add(`status-${color}`);
        }
    }
}

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = (e) => {
            const database = e.target.result;
            if (!database.objectStoreNames.contains(storeName)) {
                const store = database.createObjectStore(storeName, { keyPath: 'slug_offset' });
                store.createIndex('slug', 'slug', { unique: false });
            }
        };
        request.onsuccess = (e) => {
            db = e.target.result;
            resolve(db);
        };
        request.onerror = (e) => reject(e.target.error);
    });
}

function storeChunk(slug, offset, buffer) {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error("DB not initialized"));
        const transaction = db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.put({
            slug_offset: `${slug}:${offset}`,
            slug: slug,
            offset: offset,
            data: buffer
        });
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
    });
}

function getStoredProgress(slug) {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error("DB not initialized"));
        const transaction = db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const index = store.index('slug');
        const request = index.getAll(slug);
        request.onsuccess = (e) => {
            const records = e.target.result;
            records.sort((a, b) => a.offset - b.offset);
            resolve(records);
        };
        request.onerror = (e) => reject(e.target.error);
    });
}

function storeMetadata(slug, meta) {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error("DB not initialized"));
        const transaction = db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.put({
            slug_offset: `metadata:${slug}`,
            slug: slug,
            meta: meta
        });
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
    });
}

function getStoredMetadata(slug) {
    return new Promise((resolve, reject) => {
        if (!db) return reject(new Error("DB not initialized"));
        const transaction = db.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.get(`metadata:${slug}`);
        request.onsuccess = (e) => {
            resolve(e.target.result ? e.target.result.meta : null);
        };
        request.onerror = (e) => reject(e.target.error);
    });
}

function clearStoredChunks(slug) {
    return new Promise((resolve, reject) => {
        if (!db) return resolve();
        const transaction = db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const index = store.index('slug');
        const request = index.openCursor(slug);
        request.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
                store.delete(cursor.primaryKey);
                cursor.continue();
            } else {
                resolve();
            }
        };
        request.onerror = (e) => reject(e.target.error);
    });
}

peer.on('disconnected', () => {
    console.log('Disconnected from signaling server. Reconnecting...');
    peer.reconnect();
});

peer.on('open', async (id) => {
    console.log('My peer ID is: ' + id);
    try {
        await initDB();
        const cachedMeta = await getStoredMetadata(slug);
        const records = await getStoredProgress(slug);
        const chunks = records.filter(r => r.offset !== undefined);
        let size = 0;
        for (const r of chunks) {
            const len = r.data.byteLength !== undefined ? r.data.byteLength : (r.data.length || 0);
            if (r.offset === size) {
                size += len;
            } else {
                break;
            }
        }
        receivedSize = size;
        
        if (receivedSize > 0 && cachedMeta) {
            progressBar.style.display = 'block';
            status.innerText = `Found partial download progress for ${cachedMeta.name}. Ready to resume at ${(receivedSize / (1024 * 1024)).toFixed(2)} MB.`;
        }
    } catch (err) {
        console.error("IndexedDB initialization error:", err);
    }
    connectToUploader();

    // Fade out page loader overlay
    const loader = document.getElementById('pageLoader');
    if (loader) {
        loader.classList.add('fade-out');
        setTimeout(() => loader.remove(), 500);
    }
});

peer.on('error', (err) => {
    console.error('PeerJS error:', err);
    if (err.type === 'peer-unavailable') {
        status.innerText = 'Uploader is offline. Retrying...';
        handleDisconnect();
    }
});

function startHeartbeat() {
    stopHeartbeat();
    lastActiveTime = Date.now();
    heartbeatInterval = setInterval(() => {
        if (!isPaused && isDownloading) {
            if (Date.now() - lastActiveTime > 30000) {
                console.log("Heartbeat timeout. Assuming connection dead.");
                handleDisconnect();
            } else {
                if (conn && conn.open) {
                    conn.send({ type: 'PING' });
                }
            }
        }
    }, 5000);
}

function stopHeartbeat() {
    clearInterval(heartbeatInterval);
}

async function connectToUploader() {
    if (conn) {
        conn.close();
    }
    stopHeartbeat();

    status.innerText = 'Resolving uploader address...';
    try {
        const res = await fetch(`/api/peer/${slug}`);
        if (res.status === 404) {
            status.innerText = '⚠️ The sharing session has been terminated by the uploader.';
            setStatusDot('red');
            isDownloading = false;
            progressBar.style.display = 'none';
            fileInfo.style.display = 'none';
            stopHeartbeat();
            clearTimeout(reconnectTimeout);
            return;
        }
        if (res.ok) {
            const data = await res.json();
            if (data.peerId) {
                uploaderPeerId = data.peerId;
            }
        }
    } catch (e) {
        console.error("Could not resolve latest peer ID:", e);
    }
    
    status.innerText = 'Connecting to uploader...';
    conn = peer.connect(uploaderPeerId, { reliable: true });

    conn.on('open', () => {
        clearTimeout(reconnectTimeout);
        if (isDownloading) {
            status.innerText = 'Reconnected! Resuming download...';
            setStatusDot('green');
            if (streamAnimation) streamAnimation.style.display = 'flex';
            startHeartbeat();
            if (!isPaused) {
                conn.send({ type: 'START_DOWNLOAD', offset: receivedSize });
            }
        } else {
            if (receivedSize > 0) {
                status.innerText = `Connected! Ready to resume download at ${(receivedSize / (1024 * 1024)).toFixed(2)} MB.`;
            } else {
                status.innerText = 'Connected! Requesting file info...';
            }
            conn.send({ type: 'REQUEST_INFO' });
        }
    });

    conn.on('data', async (data) => {
        lastActiveTime = Date.now();
        if (data.type === 'INFO') {
            let fileChanged = false;
            try {
                const cachedMeta = await getStoredMetadata(slug);
                if (cachedMeta && (cachedMeta.name !== data.name || cachedMeta.size !== data.size)) {
                    console.log("Cached file metadata mismatch. Resetting local cache.");
                    await clearStoredChunks(slug);
                    receivedSize = 0;
                    progressBar.value = 0;
                    downloadBtn.innerText = 'Download';
                    isDownloading = false;
                    fileChanged = true;
                }
                await storeMetadata(slug, { name: data.name, size: data.size });
            } catch (err) {
                console.error("Failed to verify metadata:", err);
            }

            fileMetadata = data;
            fileNameSpan.innerText = data.name;
            fileSizeSpan.innerText = (data.size / (1024 * 1024)).toFixed(2) + ' MB';
            fileInfo.style.display = 'block';
            
            // Configure progress bar limits natively
            progressBar.max = fileMetadata.size;
            progressBar.value = receivedSize;
            
            // Only reset UI controls if the file actually changed or if we are not actively downloading
            if (fileChanged || !isDownloading) {
                downloadBtn.style.display = 'inline-flex';
                downloadControls.style.display = 'none';
                pausePlayBtn.innerText = 'Pause Download';
                pausePlayBtn.classList.remove('paused');
                isPaused = false;

                if (receivedSize > 0) {
                    downloadBtn.innerText = 'Resume Download';
                    status.innerText = `Connected! Ready to resume download at ${(receivedSize / (1024 * 1024)).toFixed(2)} MB.`;
                    setStatusDot('red');
                } else {
                    downloadBtn.innerText = 'Download';
                    status.innerText = 'Connected! Ready to download.';
                    setStatusDot('red');
                }
            }
        } else if (data.type === 'CHUNK') {
            handleChunk(data);
        } else if (data.type === 'TRANSFER_CANCELLED') {
            status.innerText = '⚠️ Transfer was cancelled by the uploader.';
            setStatusDot('red');
            if (streamAnimation) streamAnimation.style.display = 'none';
            isDownloading = false;
            try {
                await clearStoredChunks(slug);
            } catch (e) {}
            receivedSize = 0;
            progressBar.value = 0;
            downloadBtn.innerText = 'Download';
            downloadBtn.style.display = 'inline-flex';
            downloadControls.style.display = 'none';
            stopHeartbeat();
        } else if (data.type === 'HOST_PAUSE') {
            status.innerText = 'Upload paused by host.';
            setStatusDot('yellow');
            if (streamAnimation) streamAnimation.style.display = 'none';
        } else if (data.type === 'HOST_RESUME') {
            status.innerText = 'Downloading...';
            if (isDownloading && !isPaused) {
                setStatusDot('green');
                if (streamAnimation) streamAnimation.style.display = 'flex';
                conn.send({ type: 'START_DOWNLOAD', offset: receivedSize });
            }
        } else if (data.type === 'SESSION_TERMINATED') {
            status.innerText = '⚠️ The sharing session has been terminated by the uploader.';
            setStatusDot('red');
            if (streamAnimation) streamAnimation.style.display = 'none';
            isDownloading = false;
            progressBar.style.display = 'none';
            fileInfo.style.display = 'none';
            stopHeartbeat();
            clearTimeout(reconnectTimeout);
            if (conn) conn.close();
        }
    });

    conn.on('close', () => {
        handleDisconnect();
    });

    conn.on('error', (err) => {
        console.error('Data channel connection error:', err);
        handleDisconnect();
    });
}

function handleDisconnect() {
    stopHeartbeat();
    setStatusDot('red');
    if (streamAnimation) streamAnimation.style.display = 'none';
    if (!isDownloading) {
        status.innerText = 'Connection to uploader lost.';
        return;
    }
    status.innerText = `Connection lost. Reconnecting... (Received: ${(receivedSize / (1024 * 1024)).toFixed(2)} MB)`;
    
    clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(() => {
        connectToUploader();
    }, 3000);
}

downloadBtn.addEventListener('click', () => {
    status.innerText = 'Downloading...';
    setStatusDot('green');
    if (streamAnimation) streamAnimation.style.display = 'flex';
    downloadBtn.style.display = 'none';
    downloadControls.style.display = 'flex';
    progressBar.style.display = 'block';
    isDownloading = true;
    startHeartbeat();
    conn.send({ type: 'START_DOWNLOAD', offset: receivedSize });
});

pausePlayBtn.addEventListener('click', () => {
    isPaused = !isPaused;
    if (isPaused) {
        pausePlayBtn.innerText = 'Resume Download';
        pausePlayBtn.classList.add('paused');
        status.innerText = 'Download paused.';
        setStatusDot('yellow');
        if (streamAnimation) streamAnimation.style.display = 'none';
        conn.send({ type: 'PAUSE_TRANSFER' });
        stopHeartbeat();
    } else {
        pausePlayBtn.innerText = 'Pause Download';
        pausePlayBtn.classList.remove('paused');
        status.innerText = 'Downloading...';
        setStatusDot('green');
        if (streamAnimation) streamAnimation.style.display = 'flex';
        startHeartbeat();
        conn.send({ type: 'START_DOWNLOAD', offset: receivedSize });
    }
});

cancelBtn.addEventListener('click', async () => {
    if (conn && conn.open) {
        conn.send({ type: 'CANCEL_TRANSFER' });
    }
    isDownloading = false;
    isPaused = false;
    stopHeartbeat();
    status.innerText = 'Download cancelled. Ready to download.';
    setStatusDot('red');
    if (streamAnimation) streamAnimation.style.display = 'none';
    
    try {
        await clearStoredChunks(slug);
    } catch (e) {}
    
    receivedSize = 0;
    progressBar.value = 0;
    
    downloadBtn.innerText = 'Download';
    downloadBtn.style.display = 'inline-flex';
    downloadControls.style.display = 'none';
    pausePlayBtn.innerText = 'Pause Download';
    pausePlayBtn.classList.remove('paused');
});

async function handleChunk(data) {
    if (data.done) {
        status.innerText = 'Download complete! Assembling...';
        stopHeartbeat();
        try {
            // Wait for all background database writes to finish before assembling
            await Promise.all(pendingWrites);
            pendingWrites = [];

            const records = await getStoredProgress(slug);
            const blob = new Blob(records.map(r => r.data), { type: fileMetadata.fileType });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileMetadata.name;
            a.click();
            URL.revokeObjectURL(url);
            status.innerText = 'File saved.';
            setStatusDot('red');
            await clearStoredChunks(slug);
        } catch (err) {
            console.error("Assembly or cleanup failed:", err);
            status.innerText = 'File assembly failed.';
            setStatusDot('red');
        }
        progressBar.style.display = 'none';
        downloadControls.style.display = 'none';
        if (streamAnimation) streamAnimation.style.display = 'none';
        isDownloading = false;
        return;
    }

    if (data.offset === receivedSize) {
        const chunkLength = data.buffer.byteLength !== undefined ? data.buffer.byteLength : (data.buffer.length || 0);
        // Start the DB write in the background without blocking the incoming chunks flow
        const writePromise = storeChunk(slug, data.offset, data.buffer).catch(err => {
            console.error("Failed to cache chunk:", err);
            throw err;
        });
        pendingWrites.push(writePromise);

        // Update receivedSize synchronously so the next incoming chunk (which arrives immediately)
        // matches the updated offset check
        receivedSize += chunkLength;
        progressBar.value = receivedSize; // Update progress bar natively
    }
}
