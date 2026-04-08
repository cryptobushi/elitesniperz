// gun-builder.js — Modular gun builder (Mega Blocks style)
import * as THREE from 'three';

// ─── COLOR PALETTE ─────────────────────────────────────────────
const PALETTE = [
    0x1a1a1a, // 0  black
    0x444444, // 1  dark gray
    0x888888, // 2  medium gray
    0xcccccc, // 3  light gray
    0xcc2222, // 4  red
    0x22cc22, // 5  green
    0x2244cc, // 6  blue
    0xcccc22, // 7  yellow
    0xcc8822, // 8  orange
    0x8822cc, // 9  purple
    0x22cccc, // 10 cyan
    0xff66aa, // 11 pink
    0x4a2a10, // 12 wood brown
    0x7a5a3a, // 13 light wood
    0xffffff, // 14 white
    0x886622, // 15 gold
];

const PALETTE_NAMES = [
    'Black','Dark Gray','Gray','Light Gray',
    'Red','Green','Blue','Yellow',
    'Orange','Purple','Cyan','Pink',
    'Dark Wood','Light Wood','White','Gold'
];

// ─── PART TYPES ────────────────────────────────────────────────
// type index: 0=block, 1=tube, 2=cone, 3=sphere, 4=wedge, 5=plate
const PART_TYPES = [
    { name: 'Block',  icon: '█' },
    { name: 'Tube',   icon: '○' },
    { name: 'Cone',   icon: '▲' },
    { name: 'Sphere', icon: '●' },
    { name: 'Wedge',  icon: '◣' },
    { name: 'Plate',  icon: '▬' },
];

const GRID_UNIT = 0.15; // World units per grid cell

// ─── MATERIAL CACHE ────────────────────────────────────────────
const _materialCache = new Map();
function getMaterial(colorIndex) {
    if (_materialCache.has(colorIndex)) return _materialCache.get(colorIndex);
    const mat = new THREE.MeshStandardMaterial({
        color: PALETTE[colorIndex] || 0xff00ff,
        roughness: 0.55,
        metalness: 0.15,
    });
    _materialCache.set(colorIndex, mat);
    return mat;
}

// ─── GEOMETRY FACTORIES ────────────────────────────────────────
function createPartGeometry(typeIndex, sx, sy, sz) {
    const w = sx * GRID_UNIT;
    const h = sy * GRID_UNIT;
    const d = sz * GRID_UNIT;

    switch (typeIndex) {
        case 0: // Block
            return new THREE.BoxGeometry(w, h, d);
        case 1: // Tube (along Z)
            return new THREE.CylinderGeometry(w / 2, w / 2, d, 8).rotateX(Math.PI / 2);
        case 2: // Cone (along Z, tip forward)
            return new THREE.ConeGeometry(w / 2, d, 8).rotateX(Math.PI / 2);
        case 3: // Sphere
            return new THREE.SphereGeometry(w / 2, 8, 6);
        case 4: { // Wedge (triangular prism)
            const shape = new THREE.Shape();
            shape.moveTo(-w / 2, -h / 2);
            shape.lineTo(w / 2, -h / 2);
            shape.lineTo(-w / 2, h / 2);
            shape.closePath();
            const geo = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
            geo.translate(0, 0, -d / 2);
            return geo;
        }
        case 5: // Plate (thin block)
            return new THREE.BoxGeometry(w, GRID_UNIT * 0.3, d);
        default:
            return new THREE.BoxGeometry(w, h, d);
    }
}

// ─── GUN MESH FACTORY ──────────────────────────────────────────
// Part format: [gridX, gridY, gridZ, typeIndex, sizeX, sizeY, sizeZ, colorIndex]
function buildGunMesh(gunData) {
    const group = new THREE.Group();
    if (!gunData || !gunData.parts || gunData.parts.length === 0) {
        // Fallback: single gray block
        const geo = new THREE.BoxGeometry(0.15, 0.15, 0.6);
        group.add(new THREE.Mesh(geo, getMaterial(1)));
        return group;
    }

    for (const part of gunData.parts) {
        const [gx, gy, gz, type, sx, sy, sz, col] = part;
        const geo = createPartGeometry(type, sx, sy, sz);
        const mesh = new THREE.Mesh(geo, getMaterial(col));
        mesh.position.set(
            gx * GRID_UNIT,
            gy * GRID_UNIT,
            gz * GRID_UNIT + (sz * GRID_UNIT) / 2 // offset so Z=0 is the back edge
        );
        mesh.castShadow = true;
        group.add(mesh);
    }

    return group;
}

function getMuzzlePosition(gunData) {
    if (!gunData || !gunData.parts || gunData.parts.length === 0) {
        return new THREE.Vector3(0, 0, 0.6);
    }
    let maxZ = -Infinity;
    for (const part of gunData.parts) {
        const [gx, gy, gz, type, sx, sy, sz] = part;
        const tipZ = (gz + sz) * GRID_UNIT;
        if (tipZ > maxZ) maxZ = tipZ;
    }
    return new THREE.Vector3(0, 0, maxZ);
}

// ─── DEFAULT GUN ───────────────────────────────────────────────
// A classic sniper shape: stock → body → barrel → muzzle, scope on top
const DEFAULT_GUN = {
    v: 1,
    parts: [
        // Stock (brown blocks extending backward)
        [-0, 0, -6, 0, 2, 2, 3, 12],  // main stock
        [ 0, 1, -5, 0, 1, 1, 2, 13],  // cheek rest

        // Receiver body (dark gray)
        [ 0, 0, -3, 0, 2, 2, 4, 1],   // receiver

        // Barrel (black tube)
        [ 0, 0,  1, 1, 1, 1, 8, 0],   // main barrel

        // Muzzle brake (dark gray cone)
        [ 0, 0,  9, 2, 1, 1, 2, 1],   // muzzle

        // Scope (black tube on top)
        [ 0, 2, -2, 1, 1, 1, 4, 0],   // scope body
        [ 0, 2,  2, 3, 1, 1, 1, 6],   // scope lens (blue)

        // Magazine (dark gray block below)
        [ 0,-2, -2, 0, 1, 2, 1, 1],   // magazine

        // Grip
        [ 0,-2, -1, 0, 1, 1, 1, 0],   // grip

        // Bolt handle
        [ 1, 1, -1, 0, 1, 1, 1, 2],   // bolt
    ]
};

// ─── RANDOM GUN (for bots) ─────────────────────────────────────
function randomGun() {
    const parts = [];
    const mainCol = Math.floor(Math.random() * PALETTE.length);
    const accentCol = Math.floor(Math.random() * PALETTE.length);

    // Always has a body
    parts.push([0, 0, -2, 0, 2, 2, 3, mainCol]);

    // Random barrel length (1-3 tubes)
    const barrelLen = 4 + Math.floor(Math.random() * 8);
    parts.push([0, 0, 1, 1, 1, 1, barrelLen, 0]);

    // Maybe muzzle
    if (Math.random() > 0.3) {
        const muzzleType = Math.random() > 0.5 ? 2 : 0;
        parts.push([0, 0, 1 + barrelLen, muzzleType, 1, 1, 1, accentCol]);
    }

    // Stock
    const stockLen = 2 + Math.floor(Math.random() * 3);
    parts.push([0, 0, -2 - stockLen, 0, 2, 2, stockLen, mainCol]);

    // Maybe scope
    if (Math.random() > 0.3) {
        const scopeLen = 2 + Math.floor(Math.random() * 3);
        parts.push([0, 2, -1, 1, 1, 1, scopeLen, 0]);
    }

    // Maybe mag
    if (Math.random() > 0.3) {
        parts.push([0, -2, -1, 0, 1, Math.ceil(Math.random() * 2), 1, accentCol]);
    }

    // Random extra blocks
    const extras = Math.floor(Math.random() * 4);
    for (let i = 0; i < extras; i++) {
        const x = Math.floor(Math.random() * 3) - 1;
        const y = Math.floor(Math.random() * 3) - 1;
        const z = Math.floor(Math.random() * 6) - 3;
        const t = Math.floor(Math.random() * 6);
        const c = Math.random() > 0.5 ? mainCol : accentCol;
        parts.push([x, y, z, t, 1, 1, 1, c]);
    }

    return { v: 1, parts };
}

// ─── GUN BUILDER UI ────────────────────────────────────────────
class GunBuilderUI {
    constructor(onSave) {
        this.onSave = onSave;
        this.gunData = null;
        this.selectedType = 0;
        this.selectedColor = 0;
        this.selectedSize = [1, 1, 2];
        this.overlay = null;
        this.renderer = null;
        this.scene = null;
        this.camera = null;
        this.gunGroup = null;
        this.gridHelper = null;
        this.ghostMesh = null;
        this.isOpen = false;
        this._animFrame = null;
        this._raycaster = new THREE.Raycaster();
        this._mouse = new THREE.Vector2();
        this._gridPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    }

    open(gunData) {
        this.gunData = JSON.parse(JSON.stringify(gunData || DEFAULT_GUN));
        this.isOpen = true;
        this._createOverlay();
        this._setupScene();
        this._rebuildPreview();
        this._animate();
    }

    close() {
        this.isOpen = false;
        if (this._animFrame) cancelAnimationFrame(this._animFrame);
        if (this.renderer) {
            this.renderer.dispose();
            this.renderer = null;
        }
        if (this.overlay && this.overlay.parentNode) {
            this.overlay.parentNode.removeChild(this.overlay);
        }
        this.overlay = null;
    }

    _createOverlay() {
        if (this.overlay) this.close();

        const ov = document.createElement('div');
        ov.id = 'gunBuilderOverlay';
        ov.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:10000;display:flex;background:rgba(0,0,0,0.95);font-family:monospace;color:#fff;';

        // Left: 3D viewport
        const left = document.createElement('div');
        left.style.cssText = 'flex:1;position:relative;cursor:crosshair;';
        left.id = 'gunBuilderViewport';
        ov.appendChild(left);

        // Right: controls panel
        const right = document.createElement('div');
        right.style.cssText = 'width:260px;padding:15px;overflow-y:auto;border-left:1px solid #333;display:flex;flex-direction:column;gap:12px;';

        // Title
        right.innerHTML = '<div style="font-size:1.1rem;font-weight:bold;text-align:center;color:#ffcc00;">GUN BUILDER</div>';

        // Part type buttons
        let html = '<div style="font-size:0.75rem;color:#aaa;">PART TYPE</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;">';
        PART_TYPES.forEach((pt, i) => {
            html += `<button class="gb-type" data-type="${i}" style="padding:8px 4px;background:${i === 0 ? '#444' : '#222'};border:1px solid #555;color:#fff;border-radius:4px;cursor:pointer;font-size:0.8rem;">${pt.icon} ${pt.name}</button>`;
        });
        html += '</div>';

        // Size controls
        html += '<div style="font-size:0.75rem;color:#aaa;">SIZE</div>';
        ['X (Width)', 'Y (Height)', 'Z (Length)'].forEach((label, i) => {
            const axis = ['x', 'y', 'z'][i];
            const val = this.selectedSize[i];
            html += `<div style="display:flex;align-items:center;gap:6px;"><span style="font-size:0.7rem;width:65px;">${label}</span>`;
            for (let s = 1; s <= 4; s++) {
                html += `<button class="gb-size" data-axis="${i}" data-val="${s}" style="padding:4px 8px;background:${s === val ? '#444' : '#222'};border:1px solid #555;color:#fff;border-radius:3px;cursor:pointer;font-size:0.75rem;">${s}</button>`;
            }
            html += '</div>';
        });

        // Color palette
        html += '<div style="font-size:0.75rem;color:#aaa;">COLOR</div><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:3px;">';
        PALETTE.forEach((col, i) => {
            const hex = '#' + col.toString(16).padStart(6, '0');
            const border = i === 0 ? '#ffcc00 2px solid' : '#555 1px solid';
            html += `<button class="gb-color" data-col="${i}" style="width:100%;aspect-ratio:1;background:${hex};border:${border};border-radius:4px;cursor:pointer;" title="${PALETTE_NAMES[i]}"></button>`;
        });
        html += '</div>';

        // Action buttons
        html += '<div style="display:flex;flex-direction:column;gap:6px;margin-top:auto;">';
        html += '<button id="gbClear" style="padding:8px;background:#662222;border:1px solid #aa4444;color:#fff;border-radius:4px;cursor:pointer;">CLEAR ALL</button>';
        html += '<button id="gbRandom" style="padding:8px;background:#225522;border:1px solid #44aa44;color:#fff;border-radius:4px;cursor:pointer;">RANDOM</button>';
        html += '<button id="gbDone" style="padding:10px;background:#cc8800;border:none;color:#000;font-weight:bold;border-radius:4px;cursor:pointer;font-size:1rem;">DONE</button>';
        html += '</div>';

        right.innerHTML += html;
        ov.appendChild(right);
        document.body.appendChild(ov);
        this.overlay = ov;

        // Event handlers
        right.querySelectorAll('.gb-type').forEach(btn => {
            btn.addEventListener('click', () => {
                this.selectedType = parseInt(btn.dataset.type);
                right.querySelectorAll('.gb-type').forEach(b => b.style.background = '#222');
                btn.style.background = '#444';
            });
        });

        right.querySelectorAll('.gb-size').forEach(btn => {
            btn.addEventListener('click', () => {
                const axis = parseInt(btn.dataset.axis);
                this.selectedSize[axis] = parseInt(btn.dataset.val);
                right.querySelectorAll(`.gb-size[data-axis="${axis}"]`).forEach(b => b.style.background = '#222');
                btn.style.background = '#444';
            });
        });

        right.querySelectorAll('.gb-color').forEach(btn => {
            btn.addEventListener('click', () => {
                this.selectedColor = parseInt(btn.dataset.col);
                right.querySelectorAll('.gb-color').forEach(b => b.style.border = '1px solid #555');
                btn.style.border = '2px solid #ffcc00';
            });
        });

        document.getElementById('gbClear').addEventListener('click', () => {
            this.gunData = { v: 1, parts: [] };
            this._rebuildPreview();
        });

        document.getElementById('gbRandom').addEventListener('click', () => {
            this.gunData = randomGun();
            this._rebuildPreview();
        });

        document.getElementById('gbDone').addEventListener('click', () => {
            if (this.gunData.parts.length === 0) this.gunData = JSON.parse(JSON.stringify(DEFAULT_GUN));
            if (this.onSave) this.onSave(this.gunData);
            localStorage.setItem('sniperz_gun_v1', JSON.stringify(this.gunData));
            this.close();
        });

        // Viewport click: add part
        left.addEventListener('click', (e) => this._onViewportClick(e, false));
        // Right-click: remove part
        left.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this._onViewportClick(e, true);
        });
        left.addEventListener('mousemove', (e) => this._onViewportHover(e));
    }

    _setupScene() {
        const container = document.getElementById('gunBuilderViewport');
        const w = container.clientWidth;
        const h = container.clientHeight;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x111118);

        this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100);
        this.camera.position.set(2, 1.5, 2);
        this.camera.lookAt(0, 0, 0);

        // Lights
        const amb = new THREE.AmbientLight(0xffffff, 0.5);
        this.scene.add(amb);
        const dir = new THREE.DirectionalLight(0xffffff, 1);
        dir.position.set(3, 5, 3);
        this.scene.add(dir);

        // Grid
        const gridSize = 16;
        const gridGeo = new THREE.BufferGeometry();
        const gridVerts = [];
        const half = gridSize / 2 * GRID_UNIT;
        for (let i = -gridSize / 2; i <= gridSize / 2; i++) {
            const p = i * GRID_UNIT;
            gridVerts.push(-half, 0, p, half, 0, p);
            gridVerts.push(p, 0, -half, p, 0, half);
        }
        gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridVerts, 3));
        const gridMat = new THREE.LineBasicMaterial({ color: 0x333333, transparent: true, opacity: 0.4 });
        const grid = new THREE.LineSegments(gridGeo, gridMat);
        this.scene.add(grid);

        // Axis indicator at origin
        const axisGeo = new THREE.BufferGeometry();
        axisGeo.setAttribute('position', new THREE.Float32BufferAttribute([
            0, 0, 0, 0, 0, GRID_UNIT * 3, // Z forward (barrel direction)
        ], 3));
        const axisMat = new THREE.LineBasicMaterial({ color: 0xffcc00 });
        const axis = new THREE.LineSegments(axisGeo, axisMat);
        this.scene.add(axis);

        // Gun group
        this.gunGroup = new THREE.Group();
        this.scene.add(this.gunGroup);

        // Ghost mesh (preview of part to place)
        this.ghostMesh = new THREE.Mesh(
            new THREE.BoxGeometry(GRID_UNIT, GRID_UNIT, GRID_UNIT),
            new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, wireframe: true })
        );
        this.ghostMesh.visible = false;
        this.scene.add(this.ghostMesh);

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(w, h);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        container.appendChild(this.renderer.domElement);

        // Mouse drag to orbit
        this._isDragging = false;
        this._orbitTheta = Math.PI / 4;
        this._orbitPhi = Math.PI / 6;
        this._orbitDist = 3;
        this._lastMouse = { x: 0, y: 0 };

        container.addEventListener('mousedown', (e) => {
            if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
                this._isDragging = true;
                this._lastMouse = { x: e.clientX, y: e.clientY };
            }
        });
        window.addEventListener('mousemove', (e) => {
            if (!this._isDragging) return;
            const dx = e.clientX - this._lastMouse.x;
            const dy = e.clientY - this._lastMouse.y;
            this._orbitTheta -= dx * 0.01;
            this._orbitPhi = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, this._orbitPhi + dy * 0.01));
            this._lastMouse = { x: e.clientX, y: e.clientY };
        });
        window.addEventListener('mouseup', () => { this._isDragging = false; });
        container.addEventListener('wheel', (e) => {
            e.preventDefault();
            this._orbitDist = Math.max(1, Math.min(8, this._orbitDist + e.deltaY * 0.003));
        }, { passive: false });
    }

    _rebuildPreview() {
        // Clear old
        while (this.gunGroup.children.length) this.gunGroup.remove(this.gunGroup.children[0]);
        // Build new
        const mesh = buildGunMesh(this.gunData);
        this.gunGroup.add(mesh);
    }

    _getGridPos(e) {
        const container = document.getElementById('gunBuilderViewport');
        const rect = container.getBoundingClientRect();
        this._mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this._mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        this._raycaster.setFromCamera(this._mouse, this.camera);

        // Try different Y planes to find the best grid hit
        const planes = [0, GRID_UNIT, -GRID_UNIT, GRID_UNIT * 2, -GRID_UNIT * 2];
        let bestHit = null;
        let bestDist = Infinity;

        for (const yOff of planes) {
            const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -yOff);
            const pt = new THREE.Vector3();
            if (this._raycaster.ray.intersectPlane(plane, pt)) {
                const gx = Math.round(pt.x / GRID_UNIT);
                const gz = Math.round(pt.z / GRID_UNIT);
                const gy = Math.round(yOff / GRID_UNIT);
                const dist = pt.distanceTo(this.camera.position);
                if (dist < bestDist && Math.abs(gx) <= 8 && Math.abs(gz) <= 12 && Math.abs(gy) <= 4) {
                    bestHit = { gx, gy, gz };
                    bestDist = dist;
                }
            }
        }
        return bestHit;
    }

    _onViewportClick(e, isDelete) {
        if (this._isDragging) return;
        const pos = this._getGridPos(e);
        if (!pos) return;

        if (isDelete) {
            // Remove part at this grid position
            this.gunData.parts = this.gunData.parts.filter(p => {
                const [gx, gy, gz] = p;
                return !(gx === pos.gx && gy === pos.gy && gz === pos.gz);
            });
        } else {
            // Check max parts
            if (this.gunData.parts.length >= 50) return;
            // Add part
            this.gunData.parts.push([
                pos.gx, pos.gy, pos.gz,
                this.selectedType,
                this.selectedSize[0], this.selectedSize[1], this.selectedSize[2],
                this.selectedColor
            ]);
        }
        this._rebuildPreview();
    }

    _onViewportHover(e) {
        if (!this.ghostMesh) return;
        const pos = this._getGridPos(e);
        if (pos) {
            const geo = createPartGeometry(this.selectedType, this.selectedSize[0], this.selectedSize[1], this.selectedSize[2]);
            this.ghostMesh.geometry.dispose();
            this.ghostMesh.geometry = geo;
            this.ghostMesh.position.set(
                pos.gx * GRID_UNIT,
                pos.gy * GRID_UNIT,
                pos.gz * GRID_UNIT + (this.selectedSize[2] * GRID_UNIT) / 2
            );
            this.ghostMesh.visible = true;
        } else {
            this.ghostMesh.visible = false;
        }
    }

    _animate() {
        if (!this.isOpen) return;
        this._animFrame = requestAnimationFrame(() => this._animate());

        // Orbit camera
        if (!this._isDragging) {
            this._orbitTheta += 0.003; // Slow auto-rotate
        }
        this.camera.position.x = Math.sin(this._orbitTheta) * Math.cos(this._orbitPhi) * this._orbitDist;
        this.camera.position.y = Math.sin(this._orbitPhi) * this._orbitDist + 0.5;
        this.camera.position.z = Math.cos(this._orbitTheta) * Math.cos(this._orbitPhi) * this._orbitDist;
        this.camera.lookAt(0, 0, 0);

        if (this.renderer) {
            this.renderer.render(this.scene, this.camera);
        }
    }
}

// ─── LOAD FROM STORAGE ─────────────────────────────────────────
function loadGunData() {
    try {
        const stored = localStorage.getItem('sniperz_gun_v1');
        if (stored) {
            const data = JSON.parse(stored);
            if (data && data.parts && data.parts.length > 0) return data;
        }
    } catch (e) {}
    return JSON.parse(JSON.stringify(DEFAULT_GUN));
}

// ─── EXPORTS ───────────────────────────────────────────────────
export {
    PALETTE,
    PALETTE_NAMES,
    PART_TYPES,
    GRID_UNIT,
    buildGunMesh,
    getMuzzlePosition,
    DEFAULT_GUN,
    randomGun,
    GunBuilderUI,
    loadGunData,
};
