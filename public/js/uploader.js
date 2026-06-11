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

const fileInput = document.getElementById('fileInput');
const uploadWrapper = document.getElementById('uploadWrapper');
const status = document.getElementById('status');
const linkContainer = document.getElementById('linkContainer');
const linkDiv = document.getElementById('link');
const copyBtn = document.getElementById('copyBtn');
const resetBtn = document.getElementById('resetBtn');
const restoreBanner = document.getElementById('restoreBanner');
const restoreMsg = document.getElementById('restoreMsg');
const discardBtn = document.getElementById('discardBtn');
const controlPanel = document.getElementById('controlPanel');
const pausePlayBtn = document.getElementById('pausePlayBtn');
const cancelTransferBtn = document.getElementById('cancelTransferBtn');
const streamAnimation = document.getElementById('streamAnimation');
const instructionText = document.getElementById('instructionText');

let selectedFile = null;
let isPaused = false;
let activeSlug = null;
let activeConnections = new Set();

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

const iceServers = [];
if (window.config && window.config.stunServer) iceServers.push({ urls: window.config.stunServer });
if (window.config && window.config.turnServer) {
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

peer.on('disconnected', () => {
    console.log('Disconnected from signaling server. Reconnecting...');
    peer.reconnect();
});

peer.on('open', (id) => {
    status.innerText = 'Ready. Select a file.';
    console.log('My peer ID is: ' + id);
    checkRestoreSession();

    // Fade out page loader once PeerJS is open
    const loader = document.getElementById('pageLoader');
    if (loader) {
        loader.classList.add('fade-out');
        setTimeout(() => loader.remove(), 500);
    }
});

function checkRestoreSession() {
    const saved = localStorage.getItem('active_share');
    if (saved) {
        try {
            const data = JSON.parse(saved);
            activeSlug = data.slug;
            restoreMsg.innerHTML = `⚠️ <strong>Resuming Link</strong><br>You have an active sharing link for <strong>${data.name}</strong>. Please select this file again to resume hosting.`;
            restoreBanner.style.display = 'block';
            instructionText.style.display = 'none';
        } catch (e) {
            localStorage.removeItem('active_share');
        }
    }
}

discardBtn.addEventListener('click', () => {
    localStorage.removeItem('active_share');
    activeSlug = null;
    restoreBanner.style.display = 'none';
    instructionText.style.display = 'block';
    instructionText.innerHTML = 'Select a file to start sharing. Senders must keep this tab open to allow peers to fetch files.';
    fileInput.value = '';
    fileInput.disabled = false;
    status.innerText = 'Ready. Select a file.';
    setStatusDot('red');
    linkContainer.style.display = 'none';
    linkDiv.innerHTML = '';
    controlPanel.style.display = 'none';
    uploadWrapper.style.display = 'block';
});

copyBtn.addEventListener('click', () => {
    if (!activeSlug) return;
    const shareLink = `${window.location.origin}/download/${activeSlug}`;
    navigator.clipboard.writeText(shareLink).then(() => {
        copyBtn.innerHTML = `
            <svg style="width: 20px; height: 20px; color: #10b981;" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
            </svg>
        `;
        setTimeout(() => {
            copyBtn.innerHTML = `
                <svg style="width: 20px; height: 20px;" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path>
                </svg>
            `;
        }, 2000);
    });
});

resetBtn.addEventListener('click', async () => {
    activeConnections.forEach(conn => {
        try {
            conn.send({ type: 'SESSION_TERMINATED' });
        } catch (e) {}
        conn.close();
    });
    activeConnections.clear();

    if (activeSlug) {
        try {
            await fetch('/api/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ slug: activeSlug })
            });
        } catch (e) {
            console.error("Failed to delete room slug:", e);
        }
    }

    localStorage.removeItem('active_share');
    activeSlug = null;
    selectedFile = null;
    isPaused = false;

    fileInput.value = '';
    fileInput.disabled = false;
    status.innerText = 'Ready. Select a file.';
    setStatusDot('red');
    linkContainer.style.display = 'none';
    linkDiv.innerHTML = '';
    controlPanel.style.display = 'none';
    restoreBanner.style.display = 'none';
    instructionText.style.display = 'block';
    instructionText.innerHTML = 'Select a file to start sharing. Senders must keep this tab open to allow peers to fetch files.';
    uploadWrapper.style.display = 'block';
});

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    fileInput.disabled = true;
    selectedFile = file;

    status.innerText = 'Registering link...';
    
    const slug = activeSlug || Math.random().toString(36).substring(2, 10);
    
    const res = await fetch('/api/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: peer.id, slug })
    });

    if (res.ok) {
        activeSlug = slug;
        localStorage.setItem('active_share', JSON.stringify({ slug, name: selectedFile.name }));
        const shareLink = `${window.location.origin}/download/${slug}`;
        linkContainer.style.display = 'flex';
        linkDiv.innerHTML = `Share link: <a href="${shareLink}" target="_blank">${shareLink}</a>`;
        status.innerText = 'Link activated. Waiting for connections...';
        restoreBanner.style.display = 'none';
        instructionText.style.display = 'block';
        instructionText.innerHTML = `Currently hosting: <strong>${selectedFile.name}</strong>`;
        controlPanel.style.display = 'block';
        uploadWrapper.style.display = 'none';

        activeConnections.forEach(conn => {
            conn.send({
                type: 'INFO',
                name: selectedFile.name,
                size: selectedFile.size,
                fileType: selectedFile.type
            });
        });
    } else {
        status.innerText = 'Error registering link.';
        setStatusDot('red');
        fileInput.disabled = false;
        selectedFile = null;
    }
});

peer.on('connection', (conn) => {
    console.log('Connected to peer: ' + conn.peer);
    activeConnections.add(conn);
    status.innerText = `Connected peers: ${activeConnections.size}`;
    setStatusDot('green');

    conn.on('data', (data) => {
        if (data.type === 'REQUEST_INFO') {
            if (!selectedFile) {
                console.log('Peer requested info, but file is not selected yet.');
                return;
            }
            conn.send({
                type: 'INFO',
                name: selectedFile.name,
                size: selectedFile.size,
                fileType: selectedFile.type
            });
        } else if (data.type === 'START_DOWNLOAD') {
            if (!selectedFile) return;
            sendFile(conn, data.offset || 0);
        } else if (data.type === 'PAUSE_TRANSFER') {
            conn.isTransferPaused = true;
        } else if (data.type === 'CANCEL_TRANSFER') {
            conn.isTransferPaused = true;
            status.innerText = `Transfer cancelled by peer. Connected peers: ${activeConnections.size}`;
            setStatusDot('red');
        } else if (data.type === 'PING') {
            conn.send({ type: 'PONG' });
        }
    });

    conn.on('close', () => {
        activeConnections.delete(conn);
        if (activeConnections.size === 0) {
            status.innerText = 'Waiting for connections...';
            setStatusDot('red');
        } else {
            status.innerText = `Connected peers: ${activeConnections.size}`;
            setStatusDot('green');
        }
    });

    conn.on('error', (err) => {
        console.error('Connection error:', err);
        activeConnections.delete(conn);
        if (activeConnections.size === 0) {
            status.innerText = 'Waiting for connections...';
            setStatusDot('red');
        } else {
            status.innerText = `Connected peers: ${activeConnections.size}`;
            setStatusDot('green');
        }
    });
});

pausePlayBtn.addEventListener('click', () => {
    isPaused = !isPaused;
    if (isPaused) {
        pausePlayBtn.innerText = 'Resume Upload';
        pausePlayBtn.classList.add('paused');
        status.innerText = 'Upload paused.';
        setStatusDot('yellow');
        if (streamAnimation) streamAnimation.style.display = 'none';
        activeConnections.forEach(conn => {
            conn.send({ type: 'HOST_PAUSE' });
        });
    } else {
        pausePlayBtn.innerText = 'Pause Upload';
        pausePlayBtn.classList.remove('paused');
        status.innerText = `Connected peers: ${activeConnections.size}`;
        setStatusDot('green');
        if (streamAnimation && activeConnections.size > 0 && selectedFile) streamAnimation.style.display = 'flex';
        activeConnections.forEach(conn => {
            conn.send({ type: 'HOST_RESUME' });
        });
    }
});

cancelTransferBtn.addEventListener('click', () => {
    // Cancel any active stream send reader on all connections
    activeConnections.forEach(conn => {
        conn.isTransferPaused = true;
        try {
            conn.send({ type: 'TRANSFER_CANCELLED' });
        } catch (e) {}
    });

    selectedFile = null;
    isPaused = false;
    fileInput.value = '';
    fileInput.disabled = false;
    
    // Update uploader UI
    status.innerText = 'Transfer cancelled. Select a file to share.';
    setStatusDot('red');
    if (streamAnimation) streamAnimation.style.display = 'none';
    instructionText.innerHTML = 'Select a file to start sharing. Senders must keep this tab open to allow peers to fetch files.';
    controlPanel.style.display = 'none';
    uploadWrapper.style.display = 'block';
    pausePlayBtn.innerText = 'Pause Upload';
    pausePlayBtn.classList.remove('paused');

    // Keep session slug in localStorage, but clear file name info
    if (activeSlug) {
        localStorage.setItem('active_share', JSON.stringify({ slug: activeSlug, name: '' }));
    }
});

async function sendFile(conn, startOffset = 0) {
    try {
        conn.isTransferPaused = false;
        setStatusDot('green');
        if (streamAnimation) streamAnimation.style.display = 'flex';
        const fileSlice = selectedFile.slice(startOffset);
        const reader = fileSlice.stream().getReader();
        let offset = startOffset;

        while (true) {
            if (isPaused || conn.isTransferPaused) {
                setStatusDot('yellow');
                if (streamAnimation) streamAnimation.style.display = 'none';
                reader.cancel();
                break;
            }

            const { done, value } = await reader.read();
            if (done) {
                conn.send({ type: 'CHUNK', done: true });
                status.innerText = 'Transfer complete!';
                setStatusDot('red');
                if (streamAnimation) streamAnimation.style.display = 'none';
                break;
            }

            // Segment chunk into safe 64KB slices for WebRTC Data Channel
            let valueOffset = 0;
            while (valueOffset < value.length) {
                if (isPaused || conn.isTransferPaused) {
                    break;
                }

                // WebRTC Backpressure: Check if channel queue is saturated
                if (conn.dataChannel && conn.dataChannel.bufferedAmount > 256 * 1024) {
                    await new Promise(resolve => {
                        const dc = conn.dataChannel;
                        dc.bufferedAmountLowThreshold = 64 * 1024;
                        const onLow = () => {
                            dc.removeEventListener('bufferedamountlow', onLow);
                            resolve();
                        };
                        dc.addEventListener('bufferedamountlow', onLow);
                    });
                }

                const chunkLength = Math.min(64 * 1024, value.length - valueOffset);
                const subArray = value.subarray(valueOffset, valueOffset + chunkLength);

                conn.send({
                    type: 'CHUNK',
                    buffer: subArray,
                    done: false,
                    offset: offset
                });
                offset += chunkLength;
                valueOffset += chunkLength;
            }
        }
    } catch (error) {
        console.error('Error sending file stream:', error);
        setStatusDot('red');
        if (streamAnimation) streamAnimation.style.display = 'none';
    }
}
