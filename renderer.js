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
const osc = require('osc');

// Settings
let oscEnabled = false;
let oscRemotePort = 9000;
let autoReconnectEnabled = false;
let lastConnectedMac = null;
let reconnectAttempts = 0;
let maxReconnectAttempts = 3;
let reconnectTimeout = null;

// OSC Setup
const oscPort = new osc.UDPPort({
    localAddress: "0.0.0.0",
    localPort: 0,
    remoteAddress: "127.0.0.1",
    remotePort: oscRemotePort,
    metadata: true
});

oscPort.open();
oscPort.on("ready", () => {
    console.log("OSC initialized - use toggle to enable");
});

// Load settings from localStorage
function loadSettings() {
    const savedOscEnabled = localStorage.getItem('oscEnabled');
    const savedOscPort = localStorage.getItem('oscPort');
    const savedAutoReconnect = localStorage.getItem('autoReconnect');
    
    if (savedOscEnabled !== null) {
        oscEnabled = savedOscEnabled === 'true';
    }
    if (savedOscPort !== null) {
        oscRemotePort = parseInt(savedOscPort);
    }
    if (savedAutoReconnect !== null) {
        autoReconnectEnabled = savedAutoReconnect === 'true';
    }
    
    console.log('Settings loaded:', { oscEnabled, oscRemotePort, autoReconnectEnabled });
}

// Save settings to localStorage
function saveSettings() {
    localStorage.setItem('oscEnabled', oscEnabled);
    localStorage.setItem('oscPort', oscRemotePort);
    localStorage.setItem('autoReconnect', autoReconnectEnabled);
    console.log('Settings saved');
}

// Load settings on startup
loadSettings();

const connectBtn = document.getElementById('connectBtn');
const zoomInBtn = document.getElementById('zoomInBtn');
const zoomOutBtn = document.getElementById('zoomOutBtn');
const rotateBtn = document.getElementById('rotateBtn');
const lockBoundsBtn = document.getElementById('lockBoundsBtn');
const clearBtn = document.getElementById('clearBtn');
const exportPngBtn = document.getElementById('exportPngBtn');
const exportEpsBtn = document.getElementById('exportEpsBtn');
const statusSpan = document.getElementById('status');
const canvas = document.getElementById('penCanvas');
const ctx = canvas.getContext('2d');
const coordinatesDiv = document.getElementById('coordinates');

// Fixed paper bounds based on actual pen coordinates
// Upper Left: (0.01, 0.36), Upper Right: (0.7, 0.36)
// Lower Left: (0.01, 0.95), Lower Right: (0.7, 0.95)
let paperSize = { 
    Xmin: 0.01, 
    Xmax: 0.7, 
    Ymin: 0.36, 
    Ymax: 0.95, 
    width: 0.69, 
    height: 0.59 
};
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
        statusSpan.innerText = "Web Bluetooth Unavailable";
        return;
    }

    try {
        connectBtn.innerText = "Connecting...";
        connectBtn.disabled = true;
        console.log("Calling PenHelper.scanPen()...");
        await PenHelper.scanPen();
        console.log("PenHelper.scanPen() called.");
    } catch (e) {
        console.error("Connection failed or cancelled:", e);
        statusSpan.innerText = "Connection Failed";
        connectBtn.innerText = "Connect";
        connectBtn.disabled = false;
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
        zoomInfo.innerText = `Zoom: ${Math.round(canvasZoom * 100)}%`;
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
    if (boundsLocked) {
        lockBoundsBtn.classList.add('locked');
    } else {
        lockBoundsBtn.classList.remove('locked');
    }
    console.log(`Bounds ${boundsLocked ? 'locked' : 'unlocked'} at:`, paperSize);
});

// Clear button handler
clearBtn.addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Reset to fixed paper bounds
    paperSize = { 
        Xmin: 0.01, 
        Xmax: 0.7, 
        Ymin: 0.36, 
        Ymax: 0.95, 
        width: 0.69, 
        height: 0.59 
    };
    strokeHistory = [];
    currentStroke = null;
    boundsLocked = false;
    lockBoundsBtn.innerText = 'Lock';
    lockBoundsBtn.classList.remove('locked');
    console.log('Canvas cleared - reset to fixed bounds:', paperSize);
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

// Auto reconnect on startup - removed due to Bluetooth security requirements
// Web Bluetooth requires user gesture to request device access
window.addEventListener('load', () => {
    const lastMac = getLastDevice();
    if (lastMac) {
        console.log('Last connected device:', lastMac);
        statusSpan.innerText = "Click Connect to reconnect";
    }
});

// Pen Event Listener
PenHelper.messageCallback = (mac, type, args) => {
    console.log(`Message from ${mac}: type=${type}`, args);
    switch (type) {
        case PenMessageType.PEN_CONNECTION_SUCCESS:
            connectBtn.innerText = "Connected";
            connectBtn.disabled = true;
            statusSpan.innerText = "";
            lastPoint = null;
            isPenDown = false;
            lastConnectedMac = mac;
            reconnectAttempts = 0; // Reset reconnect attempts on successful connection
            saveLastDevice(mac); // Save for auto-reconnect
            
            // Clear any pending reconnect timeout
            if (reconnectTimeout) {
                clearTimeout(reconnectTimeout);
                reconnectTimeout = null;
            }
            console.log('Connected to pen:', mac);
            break;
        case PenMessageType.PEN_DISCONNECTED:
            connectBtn.innerText = "Connect";
            connectBtn.disabled = false;
            statusSpan.innerText = "Disconnected - Click Connect to reconnect";
            console.log('Pen disconnected');
            
            // Note: Auto-reconnect cannot work due to Web Bluetooth security requirements
            // User must manually click Connect button to reconnect
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

    // Optional: Dynamic paper bounds expansion (if pen draws outside fixed area)
    if (dot.x !== 0 && dot.y !== 0 && !boundsLocked) {
        // Optionally expand bounds to include new dot if outside the fixed area
        const padding = 0.01;
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

    // Update coordinate display
    const normalizedX = (dot.x - paperSize.Xmin) / Math.max(paperSize.width, 1);
    const normalizedY = (dot.y - paperSize.Ymin) / Math.max(paperSize.height, 1);
    coordinatesDiv.innerText = `x: ${normalizedX.toFixed(3)} y: ${normalizedY.toFixed(3)}`;
    
    console.log(`Scale: ${scale.toFixed(2)}, ScreenXY: (${Math.round(screenX)}, ${Math.round(screenY)}), Canvas: (${canvas.width}, ${canvas.height})`);

    // Send OSC coordinates (normalized 0-1) if enabled
    if (oscEnabled) {
        const normalizedX = (dot.x - paperSize.Xmin) / Math.max(paperSize.width, 1);
        const normalizedY = (dot.y - paperSize.Ymin) / Math.max(paperSize.height, 1);
        
        oscPort.send({
            address: "/pen",
            args: [
                { type: "f", value: normalizedX },
                { type: "f", value: normalizedY },
                { type: "i", value: dot.dotType }
            ]
        });
    }

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

// Settings Modal
const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const oscToggleCheckbox = document.getElementById('oscToggle');
const oscPortInput = document.getElementById('oscPort');

// Initialize settings UI
function updateSettingsUI() {
    oscToggleCheckbox.checked = oscEnabled;
    oscPortInput.value = oscRemotePort;
}

// Open settings modal
settingsBtn.addEventListener('click', () => {
    updateSettingsUI();
    settingsModal.classList.remove('hidden');
});

// Close settings modal
closeSettingsBtn.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
});

// Close modal when clicking outside
settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
        settingsModal.classList.add('hidden');
    }
});

// OSC Toggle
oscToggleCheckbox.addEventListener('change', () => {
    oscEnabled = oscToggleCheckbox.checked;
    saveSettings();
    console.log(`OSC ${oscEnabled ? 'enabled' : 'disabled'}`);
});

// OSC Port
oscPortInput.addEventListener('change', () => {
    const newPort = parseInt(oscPortInput.value);
    if (newPort >= 1024 && newPort <= 65535) {
        oscRemotePort = newPort;
        oscPort.close();
        oscPort.options.remotePort = oscRemotePort;
        oscPort.open();
        saveSettings();
        console.log('OSC port changed to:', oscRemotePort);
    } else {
        oscPortInput.value = oscRemotePort;
    }
});

// Initialize settings UI on load
updateSettingsUI();

// Export PNG button handler
exportPngBtn.addEventListener('click', () => {
    try {
        // Create a temporary canvas with white background for export
        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = canvas.width;
        exportCanvas.height = canvas.height;
        const exportCtx = exportCanvas.getContext('2d');
        
        // Fill with white background
        exportCtx.fillStyle = '#ffffff';
        exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
        
        // Draw all strokes on white background with black color
        strokeHistory.forEach(stroke => {
            if (!stroke.points || stroke.points.length === 0) return;
            
            const view = { width: exportCanvas.width, height: exportCanvas.height };
            const p = 0.01;
            const uw = view.width * (1 - 2 * p);
            const uh = view.height * (1 - 2 * p);
            const pw = Math.max(paperSize.width, 1);
            const ph = Math.max(paperSize.height, 1);
            const scaleX = uw / pw;
            const scaleY = uh / ph;
            const scale = Math.min(scaleX, scaleY);
            const sw = pw * scale;
            const sh = ph * scale;
            const ox = (view.width - sw) / 2;
            const oy = (view.height - sh) / 2;
            
            exportCtx.lineWidth = 2 * (exportCanvas.width / 1000);
            exportCtx.strokeStyle = '#000000'; // Black strokes for white background
            exportCtx.fillStyle = '#000000';
            exportCtx.shadowBlur = 0;
            exportCtx.shadowColor = 'transparent';
            exportCtx.lineCap = 'round';
            exportCtx.lineJoin = 'round';
            
            exportCtx.beginPath();
            stroke.points.forEach((dot, index) => {
                const sx = (dot.x - paperSize.Xmin) * scale + ox;
                const sy = (dot.y - paperSize.Ymin) * scale + oy;
                
                if (index === 0) {
                    exportCtx.moveTo(sx, sy);
                } else {
                    exportCtx.lineTo(sx, sy);
                }
            });
            exportCtx.stroke();
        });
        
        // Export as PNG
        const dataUrl = exportCanvas.toDataURL('image/png');
        const link = document.createElement('a');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        link.download = `airsketch_${timestamp}.png`;
        link.href = dataUrl;
        link.click();
        
        console.log('Canvas exported as PNG');
        statusSpan.innerText = 'Exported as PNG';
        setTimeout(() => { statusSpan.innerText = ''; }, 2000);
    } catch (error) {
        console.error('PNG export failed:', error);
        statusSpan.innerText = 'PNG export failed';
        setTimeout(() => { statusSpan.innerText = ''; }, 2000);
    }
});

// Export EPS button handler
exportEpsBtn.addEventListener('click', () => {
    try {
        if (strokeHistory.length === 0) {
            statusSpan.innerText = 'Nothing to export';
            setTimeout(() => { statusSpan.innerText = ''; }, 2000);
            return;
        }
        
        // Calculate bounding box for EPS
        const view = { width: canvas.width, height: canvas.height };
        const p = 0.01;
        const uw = view.width * (1 - 2 * p);
        const uh = view.height * (1 - 2 * p);
        const pw = Math.max(paperSize.width, 1);
        const ph = Math.max(paperSize.height, 1);
        const scaleX = uw / pw;
        const scaleY = uh / ph;
        const scale = Math.min(scaleX, scaleY);
        
        // EPS uses PostScript points (72 points per inch)
        // We'll use a standard page size (A4: 595x842 points)
        const epsWidth = 595;
        const epsHeight = 842;
        const epsScale = Math.min(epsWidth / canvas.width, epsHeight / canvas.height) * 0.9; // 90% of page
        
        // Build EPS file
        let eps = '%!PS-Adobe-3.0 EPSF-3.0\n';
        eps += `%%BoundingBox: 0 0 ${epsWidth} ${epsHeight}\n`;
        eps += '%%Creator: airsketch\n';
        eps += `%%CreationDate: ${new Date().toISOString()}\n`;
        eps += '%%Pages: 1\n';
        eps += '%%EndComments\n\n';
        
        // PostScript setup
        eps += '%%BeginProlog\n';
        eps += '/m {moveto} def\n';
        eps += '/l {lineto} def\n';
        eps += '/s {stroke} def\n';
        eps += '%%EndProlog\n\n';
        
        eps += '%%Page: 1 1\n';
        eps += 'gsave\n';
        eps += '1 setlinecap\n'; // Round cap
        eps += '1 setlinejoin\n'; // Round join
        eps += `${2 * epsScale} setlinewidth\n`;
        
        // Draw each stroke
        strokeHistory.forEach(stroke => {
            if (!stroke.points || stroke.points.length === 0) return;
            
            eps += 'newpath\n';
            
            stroke.points.forEach((dot, index) => {
                const sx = (dot.x - paperSize.Xmin) * scale * epsScale;
                // Flip Y axis for PostScript (origin at bottom-left)
                const sy = epsHeight - ((dot.y - paperSize.Ymin) * scale * epsScale);
                
                if (index === 0) {
                    eps += `${sx.toFixed(2)} ${sy.toFixed(2)} m\n`;
                } else {
                    eps += `${sx.toFixed(2)} ${sy.toFixed(2)} l\n`;
                }
            });
            
            eps += 's\n';
        });
        
        eps += 'grestore\n';
        eps += 'showpage\n';
        eps += '%%EOF\n';
        
        // Download EPS file
        const blob = new Blob([eps], { type: 'application/postscript' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        link.download = `airsketch_${timestamp}.eps`;
        link.href = url;
        link.click();
        URL.revokeObjectURL(url);
        
        console.log('Canvas exported as EPS');
        statusSpan.innerText = 'Exported as EPS';
        setTimeout(() => { statusSpan.innerText = ''; }, 2000);
    } catch (error) {
        console.error('EPS export failed:', error);
        statusSpan.innerText = 'EPS export failed';
        setTimeout(() => { statusSpan.innerText = ''; }, 2000);
    }
});
