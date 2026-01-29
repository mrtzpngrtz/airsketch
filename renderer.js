// Patch for .nproj files (XML/Text) which cause syntax errors in Electron/Node environment
// The SDK tries to require them as modules, but they are static assets.
// We mock them as returning their own file path (as a URL) so fetch() can find them.
if (require.extensions) {
    require.extensions['.nproj'] = function (module, filename) {
        module.exports = filename;
    };
}

// Direct imports to bypass index.js which pulls in NoteServer (and potentially broken Firebase dep)
const PenHelper = require('web_pen_sdk/dist/PenCotroller/PenHelper').default;
const PenMessageType = require('web_pen_sdk/dist/API/PenMessageType').default;
const { ipcRenderer } = require('electron');

const connectBtn = document.getElementById('connectBtn');
const zoomInBtn = document.getElementById('zoomInBtn');
const zoomOutBtn = document.getElementById('zoomOutBtn');
const rotateBtn = document.getElementById('rotateBtn');
const lockBoundsBtn = document.getElementById('lockBoundsBtn');
const clearBtn = document.getElementById('clearBtn');
const statusSpan = document.getElementById('status');
const canvas = document.getElementById('penCanvas');
const ctx = canvas.getContext('2d');

let paperSize = { width: 0, height: 0, Xmin: 0, Ymin: 0 };
let lastPoint = null;
let isPenDown = false;
let rotation = 0; // 0, 90, 180, 270
let boundsLocked = false; // Lock paper bounds to prevent rescaling
let strokeHistory = []; // Array of {points: [{x, y}], color, width}
let currentStroke = null;
let canvasZoom = 1.0; // Canvas container zoom (1.0 = 100%)
let panX = 0; // Pan offset X
let panY = 0; // Pan offset Y
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartPanX = 0;
let dragStartPanY = 0;

// Resize canvas to fill container with correct resolution
function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * 2; // Retina/HighDPI
    canvas.height = rect.height * 2;
    // Note: Canvas content is cleared on resize, but that's OK
    // We redraw everything to fix scaling
    redrawAll();
}

function redrawAll() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (strokeHistory.length === 0 && !currentStroke) return;

    strokeHistory.forEach(stroke => {
        drawStroke(stroke);
    });

    if (currentStroke) {
        drawStroke(currentStroke);
    }
}

function drawStroke(stroke) {
    if (!stroke.points || stroke.points.length === 0) return;

    // Apply scaling - minimal padding for 100% screen fit
    const view = { width: canvas.width, height: canvas.height };
    const p = 0.01; // Reduced padding from 5% to 1% for near-100% screen fit
    const uw = view.width * (1 - 2 * p);
    const uh = view.height * (1 - 2 * p);

    // Safety for 0 width/height
    const pw = Math.max(paperSize.width, 1);
    const ph = Math.max(paperSize.height, 1);

    const scaleX = uw / pw;
    const scaleY = uh / ph;
    const scale = Math.min(scaleX, scaleY);

    const sw = pw * scale;
    const sh = ph * scale;
    const ox = (view.width - sw) / 2;
    const oy = (view.height - sh) / 2;

    ctx.lineWidth = 2 * (canvas.width / 1000); // Responsive line width
    ctx.strokeStyle = '#ffffff';
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    stroke.points.forEach((dot, index) => {
        const sx = (dot.x - paperSize.Xmin) * scale + ox;
        const sy = (dot.y - paperSize.Ymin) * scale + oy;

        if (index === 0) {
            ctx.moveTo(sx, sy);
        } else {
            ctx.lineTo(sx, sy);
        }
    });
    ctx.stroke();
}
window.addEventListener('resize', resizeCanvas);
// Call repeatedly to ensure layout settles
setTimeout(resizeCanvas, 100);
window.addEventListener('load', resizeCanvas);


connectBtn.addEventListener('click', async () => {
    console.log("Connect button clicked");

    if (!navigator.bluetooth) {
        console.error("Web Bluetooth is not available in this environment!");
        statusSpan.innerText = "Web Bluetooth Unavailable (Check DevTools)";
        return;
    }

    try {
        console.log("Calling PenHelper.scanPen()...");
        await PenHelper.scanPen();
        console.log("PenHelper.scanPen() called.");
    } catch (e) {
        console.error("Connection failed or cancelled:", e);
        statusSpan.innerText = "Connection Failed: " + e.message;
    }
});

// Apply zoom and pan to canvas container
function applyCanvasTransform() {
    const container = document.getElementById('canvas-container');
    container.style.transform = `translate(${panX}px, ${panY}px) scale(${canvasZoom}) rotate(${rotation}deg)`;
    container.style.transition = isDragging ? 'none' : 'transform 0.2s ease';
    
    // Update zoom info display
    const zoomInfo = document.getElementById('zoom-info');
    if (zoomInfo) {
        zoomInfo.innerText = `${Math.round(canvasZoom * 100)}%`;
    }
    
    console.log('Canvas zoom:', canvasZoom.toFixed(2), 'Pan:', panX.toFixed(0), panY.toFixed(0));
}

// Zoom In button handler
zoomInBtn.addEventListener('click', () => {
    canvasZoom = Math.min(canvasZoom * 1.2, 5.0); // Max 5x zoom
    applyCanvasTransform();
});

// Zoom Out button handler
zoomOutBtn.addEventListener('click', () => {
    canvasZoom = Math.max(canvasZoom / 1.2, 0.2); // Min 0.2x zoom
    applyCanvasTransform();
});

// Mouse wheel zoom
const canvasContainer = document.getElementById('canvas-container');
canvasContainer.addEventListener('wheel', (e) => {
    e.preventDefault();
    
    // Zoom direction: wheel down = zoom out, wheel up = zoom in
    if (e.deltaY < 0) {
        // Zoom in
        canvasZoom = Math.min(canvasZoom * 1.1, 5.0);
    } else {
        // Zoom out
        canvasZoom = Math.max(canvasZoom / 1.1, 0.2);
    }
    
    applyCanvasTransform();
});

// Mouse drag to pan
canvasContainer.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartPanX = panX;
    dragStartPanY = panY;
    canvasContainer.style.cursor = 'grabbing';
});

document.addEventListener('mousemove', (e) => {
    if (isDragging) {
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        panX = dragStartPanX + dx;
        panY = dragStartPanY + dy;
        applyCanvasTransform();
    }
});

document.addEventListener('mouseup', () => {
    if (isDragging) {
        isDragging = false;
        canvasContainer.style.cursor = 'grab';
    }
});

// Set initial cursor
canvasContainer.style.cursor = 'grab';

// Rotate button handler
rotateBtn.addEventListener('click', () => {
    rotation = (rotation + 90) % 360;
    applyCanvasTransform(); // Update transform with zoom, rotation, and pan
});

// Lock Bounds button handler
lockBoundsBtn.addEventListener('click', () => {
    boundsLocked = !boundsLocked;
    lockBoundsBtn.innerText = boundsLocked ? 'Unlock' : 'Lock';
    lockBoundsBtn.style.backgroundColor = boundsLocked ? '#ffffff' : '#000000';
    lockBoundsBtn.style.color = boundsLocked ? '#000000' : '#ffffff';
    console.log(`Bounds ${boundsLocked ? 'locked' : 'unlocked'} at:`, paperSize);
});

// Clear button handler
clearBtn.addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    paperSize = { width: 0, height: 0, Xmin: 0, Ymin: 0 };
    strokeHistory = [];
    currentStroke = null;
    boundsLocked = false;
    lockBoundsBtn.innerText = 'Lock';
    lockBoundsBtn.style.backgroundColor = '#000000';
    lockBoundsBtn.style.color = '#ffffff';
    console.log('Canvas cleared');
});

// Save last connected device
function saveLastDevice(mac) {
    localStorage.setItem('lastPenMac', mac);
    console.log('Saved last pen MAC:', mac);
}

// Get last connected device
function getLastDevice() {
    return localStorage.getItem('lastPenMac');
}

// Auto reconnect on startup
window.addEventListener('load', () => {
    const lastMac = getLastDevice();
    if (lastMac) {
        console.log('Attempting auto-reconnect to last pen:', lastMac);
        statusSpan.innerText = "Reconnecting...";
        // Wait a bit for SDK to initialize
        setTimeout(() => {
            PenHelper.scanPen().catch(err => {
                console.log('Auto-reconnect failed:', err);
                statusSpan.innerText = "Disconnected";
            });
        }, 1000);
    }
});

// Pen Event Listener
PenHelper.messageCallback = (mac, type, args) => {
    console.log(`Message from ${mac}: type=${type}`, args);
    switch (type) {
        case PenMessageType.PEN_CONNECTION_SUCCESS:
            statusSpan.innerText = "Connected";
            connectBtn.disabled = true;
            lastPoint = null;
            isPenDown = false;
            saveLastDevice(mac); // Save for auto-reconnect
            break;
        case PenMessageType.PEN_DISCONNECTED:
            statusSpan.innerText = "Disconnected";
            connectBtn.disabled = false;
            break;
        case PenMessageType.PEN_SETTING_INFO:
            // Battery info removed from UI for minimal design
            break;
    }
};


// Dot Listener (Drawing strokes)
PenHelper.dotCallback = (mac, dot) => {
    // Log raw coordinates for debugging
    if (dot.dotType === 0 || dot.dotType === 1 || dot.dotType === 2) {
        console.log(`Raw Dot: x=${dot.x}, y=${dot.y}, type=${dot.dotType}`);
    }

    // Ignore invalid 0,0 points which cause corner glitches
    if (dot.x <= 1 && dot.y <= 1) {
        console.log('Ignoring near-zero dot');
        return;
    }

    // Dynamic paper bounds - expand to fit all drawing
    if (dot.x !== 0 && dot.y !== 0 && !boundsLocked) {
        if (paperSize.width === 0) {
            // First dot - initialize bounds to exactly match user's 60×90 drawing area
            // 60mm width × 90mm height (portrait orientation)
            const drawWidth = 60;
            const drawHeight = 90;
            paperSize.Xmin = dot.x - (drawWidth / 2);
            paperSize.Xmax = dot.x + (drawWidth / 2);
            paperSize.Ymin = dot.y - (drawHeight / 2);
            paperSize.Ymax = dot.y + (drawHeight / 2);
            paperSize.width = drawWidth;
            paperSize.height = drawHeight;
            console.log('Initialized paper bounds to 60×90:', paperSize);
            redrawAll(); // Redraw after initializing bounds
        } else {
            // Expand bounds to include new dot
            const padding = 2;
            let changed = false;

            if (dot.x < paperSize.Xmin) { paperSize.Xmin = dot.x - padding; changed = true; }
            if (dot.y < paperSize.Ymin) { paperSize.Ymin = dot.y - padding; changed = true; }
            if (dot.x > paperSize.Xmax) { paperSize.Xmax = dot.x + padding; changed = true; }
            if (dot.y > paperSize.Ymax) { paperSize.Ymax = dot.y + padding; changed = true; }

            if (changed) {
                paperSize.width = paperSize.Xmax - paperSize.Xmin;
                paperSize.height = paperSize.Ymax - paperSize.Ymin;
                console.log('Bounds expanded - rescaling canvas');
                // If bounds changed, we must redraw everything at the new scale
                redrawAll();
            }
        }
    }

    // Map paper coordinate space directly to canvas space
    const view = { width: canvas.width, height: canvas.height };
    const pPercent = 0.01; // Reduced padding from 5% to 1% for near-100% screen fit
    const uw = view.width * (1 - 2 * pPercent);
    const uh = view.height * (1 - 2 * pPercent);

    const pw = Math.max(paperSize.width, 1);
    const ph = Math.max(paperSize.height, 1);

    const scaleX = uw / pw;
    const scaleY = uh / ph;
    const scale = Math.min(scaleX, scaleY);

    const sw = pw * scale;
    const sh = ph * scale;
    const ox = (view.width - sw) / 2;
    const oy = (view.height - sh) / 2;

    const screenX = (dot.x - paperSize.Xmin) * scale + ox;
    const screenY = (dot.y - paperSize.Ymin) * scale + oy;

    // Coordinates removed from UI for minimal design - available in console
    console.log(`Scale: ${scale.toFixed(2)}, ScreenXY: (${Math.round(screenX)}, ${Math.round(screenY)}), Canvas: (${canvas.width}, ${canvas.height})`);

    // Handle Current Stroke History
    if (dot.dotType === 0) { // Down
        currentStroke = { points: [{ x: dot.x, y: dot.y }] };
        isPenDown = true;
        lastPoint = { x: screenX, y: screenY };

        console.log('Pen DOWN - Drawing initial dot at:', screenX, screenY);
        ctx.lineWidth = 2 * (canvas.width / 1000);
        ctx.strokeStyle = '#ffffff';
        ctx.shadowBlur = 0;
        ctx.shadowColor = 'transparent';
        ctx.beginPath();
        ctx.arc(screenX, screenY, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
    }
    else if (dot.dotType === 1) { // Move
        // Auto-start stroke if we receive MOVE without prior DOWN
        if (!isPenDown || !currentStroke) {
            console.log('Pen MOVE received without DOWN - auto-starting stroke at:', screenX, screenY);
            currentStroke = { points: [{ x: dot.x, y: dot.y }] };
            isPenDown = true;
            lastPoint = { x: screenX, y: screenY };
            
            // Draw initial dot
            ctx.lineWidth = 2 * (canvas.width / 1000);
            ctx.strokeStyle = '#ffffff';
            ctx.shadowBlur = 0;
            ctx.shadowColor = 'transparent';
            ctx.beginPath();
            ctx.arc(screenX, screenY, ctx.lineWidth / 2, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
        } else {
            currentStroke.points.push({ x: dot.x, y: dot.y });

            console.log('Pen MOVE - Drawing line to:', screenX, screenY);
            ctx.beginPath();
            ctx.lineWidth = 2 * (canvas.width / 1000);
            ctx.strokeStyle = '#ffffff';
            ctx.shadowBlur = 0;
            ctx.shadowColor = 'transparent';
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.moveTo(lastPoint.x, lastPoint.y);
            ctx.lineTo(screenX, screenY);
            ctx.stroke();
            lastPoint = { x: screenX, y: screenY };
        }
    }
    else if (dot.dotType === 2) { // Up
        console.log('Pen UP - Finishing stroke');
        if (isPenDown && currentStroke) {
            currentStroke.points.push({ x: dot.x, y: dot.y });
            strokeHistory.push(currentStroke);
            console.log('Stroke saved. Total strokes:', strokeHistory.length);
            currentStroke = null;
        }
        isPenDown = false;
        lastPoint = null;
    }
};

// IPC Listener for Bluetooth Device List
ipcRenderer.on('bluetooth-device-list', (event, deviceList) => {
    console.log("Device list received in renderer:", deviceList);
    showDevicePicker(deviceList);
});

function showDevicePicker(devices) {
    let picker = document.getElementById('device-picker');
    if (!picker) {
        picker = document.createElement('div');
        picker.id = 'device-picker';
        picker.style.position = 'fixed';
        picker.style.top = '50%';
        picker.style.left = '50%';
        picker.style.transform = 'translate(-50%, -50%)';
        picker.style.backgroundColor = '#141414';
        picker.style.border = '1px solid #333';
        picker.style.padding = '20px';
        picker.style.boxShadow = '0 0 40px rgba(0, 0, 0, 0.8)';
        picker.style.zIndex = '1000';
        picker.style.maxHeight = '300px';
        picker.style.overflowY = 'auto';
        document.body.appendChild(picker);
    }

    picker.innerHTML = '<h3>Select a Device</h3>';

    if (devices.length === 0) {
        picker.innerHTML += '<p>No devices found. Ensure pen is in pairing mode.</p>';
        const closeBtn = document.createElement('button');
        closeBtn.innerText = 'Cancel';
        closeBtn.onclick = () => {
            ipcRenderer.send('bluetooth-device-selected', '');
            picker.remove();
        };
        picker.appendChild(closeBtn);
        return;
    }

    const list = document.createElement('ul');
    list.style.listStyle = 'none';
    list.style.padding = '0';

    devices.forEach(device => {
        const item = document.createElement('li');
        item.style.padding = '10px';
        item.style.borderBottom = '1px solid #eee';
        item.style.cursor = 'pointer';
        item.innerText = device.deviceName || `Unknown Device (${device.deviceId})`;

        item.onclick = () => {
            console.log("Selected device:", device.deviceId);
            ipcRenderer.send('bluetooth-device-selected', device.deviceId);
            picker.remove();
        };

        item.onmouseover = () => { item.style.backgroundColor = '#f0f0f0'; };
        item.onmouseout = () => { item.style.backgroundColor = 'transparent'; };

        list.appendChild(item);
    });

    picker.appendChild(list);

    const cancelBtn = document.createElement('button');
    cancelBtn.innerText = 'Cancel';
    cancelBtn.style.marginTop = '10px';
    cancelBtn.onclick = () => {
        ipcRenderer.send('bluetooth-device-selected', '');
        picker.remove();
    };
    picker.appendChild(cancelBtn);
}
