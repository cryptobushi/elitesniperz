import * as THREE from 'three';
import { initPrivy } from './dist/privy-bundle.js';
import { initWagerUI } from './client/wager-ui.js';

// Initialize wager system (after DOM ready)
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { initPrivy('cmnq87gi501w40cibx5gcfz9a'); initWagerUI(); });
} else {
    initPrivy('cmnq87gi501w40cibx5gcfz9a');
    initWagerUI();
}

// Online mode state (declared early to avoid temporal dead zone)
let isOnlineMode = false;
let _remotePlayers = new Map();

// Game State
const gameState = {
    player: null,
    players: new Map(),
    bots: [],
    username: '',
    team: '',
    kills: 0,
    deaths: 0,
    gameStarted: false,
    abilities: {
        windwalk: { cooldown: 0, maxCooldown: 10, duration: 3, active: false },
        farsight: { cooldown: 0, maxCooldown: 15, duration: 5, active: false }
    },
    mousePos: new THREE.Vector2(),
    keys: {},
    attackWalk: false,
    targetLock: null,

    cameraTarget: new THREE.Vector3(0, 0, 0),
    cameraOffset: new THREE.Vector3(0, 14, 14), // Zoomed in closer
    isDraggingCamera: false,
    lastMousePos: new THREE.Vector2(),
    // Click to move
    moveTarget: null,
    // Kill streak tracking
    killStreak: 0,
    multiKillTimer: 0,
    multiKillCount: 0,
    firstBlood: false,
    // Gold + Shop
    gold: 0,
    // Debug
    debug: {
        godMode: false,
        showFPS: true,
    }
};
const SHOP_ITEMS = {
    boots1:    { name: 'Swift Boots',      cost: 100, icon: '🥾', desc: '+20% speed',        stat: 'speed',     mult: 1.2, tier: 1, group: 'boots' },
    boots2:    { name: 'Windrider Boots',  cost: 300, icon: '💨', desc: '+50% speed',        stat: 'speed',     mult: 1.5, tier: 2, group: 'boots', requires: 'boots1' },
    cloak1:    { name: 'Shadow Cloak',     cost: 150, icon: '🌑', desc: '+3s windwalk',      stat: 'wwDur',     val: 3,    tier: 1, group: 'cloak' },
    cloak2:    { name: 'Phantom Shroud',   cost: 400, icon: '👻', desc: '+6s windwalk',      stat: 'wwDur',     val: 6,    tier: 2, group: 'cloak', requires: 'cloak1' },
    scope1:    { name: 'Scout Scope',      cost: 150, icon: '🔭', desc: '+25% range',        stat: 'range',     mult: 1.25, tier: 1, group: 'scope' },
    scope2:    { name: 'Eagle Eye',        cost: 400, icon: '🦅', desc: '+50% range',        stat: 'range',     mult: 1.5, tier: 2, group: 'scope', requires: 'scope1' },
    shield:    { name: 'Iron Buckler',     cost: 200, icon: '🛡', desc: 'Survive 1 shot',    stat: 'shield',    val: 1,    tier: 1, group: 'shield' },
    rapidfire: { name: 'Hair Trigger',     cost: 250, icon: '⚡', desc: '-30% shot cooldown', stat: 'firerate',  mult: 0.7, tier: 1, group: 'firerate' },
    bounty:    { name: 'Bounty Hunter',    cost: 200, icon: '💰', desc: '+50% gold per kill', stat: 'goldMult',  mult: 1.5, tier: 1, group: 'bounty' },
};
class AudioManager {
    constructor() {
        this.ctx = null;
        this.buffers = {};
        this.enabled = true;
        this.ready = false;
        this.pendingFetches = {};
        this.volumes = { sniperFire: 0.4 };

        // Start fetching immediately
        const soundFiles = {
            firstBlood: '/sounds/first_blood.wav',
            doubleKill: '/sounds/Double_Kill.wav',
            multiKill: '/sounds/MultiKill.wav',
            megaKill: '/sounds/MegaKill.wav',
            ultraKill: '/sounds/UltraKill.wav',
            monsterKill: '/sounds/MonsterKill.wav',
            ludicrousKill: '/sounds/LudicrousKill.wav',
            killingSpree: '/sounds/Killing_Spree.wav',
            rampage: '/sounds/Rampage.wav',
            dominating: '/sounds/Dominating.wav',
            unstoppable: '/sounds/Unstoppable.wav',
            godlike: '/sounds/GodLike.wav',
            headshot: '/sounds/Headshot.wav',
            sniperFire: '/sounds/sniper_fire_h3_1.wav'
        };

        for (const [name, path] of Object.entries(soundFiles)) {
            this.pendingFetches[name] = fetch(path).then(r => r.arrayBuffer()).catch(() => null);
        }
    }

    async init() {
        if (this.ready) return;
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.ready = true;

        // Decode all fetched audio
        for (const [name, promise] of Object.entries(this.pendingFetches)) {
            try {
                const buf = await promise;
                if (buf) this.buffers[name] = await this.ctx.decodeAudioData(buf);
            } catch {}
        }
        this.pendingFetches = {};
    }

    play(soundName) {
        if (!this.enabled || !this.ctx || !this.buffers[soundName]) return;
        if (this.ctx.state === 'suspended') this.ctx.resume();
        const source = this.ctx.createBufferSource();
        source.buffer = this.buffers[soundName];
        const gain = this.ctx.createGain();
        gain.gain.value = this.volumes[soundName] || 0.7;
        source.connect(gain).connect(this.ctx.destination);
        source.start(0);
    }
}

const audioManager = new AudioManager();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a0a2e);
scene.fog = new THREE.Fog(0x1a1030, 120, 350);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(0, 20, 20);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById('gameCanvas'),
    antialias: true
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

function updateCRT() {}
const ambientLight = new THREE.AmbientLight(0x8888cc, 1.8); // Bright cool ambient
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xfff4dd, 2.0); // Strong warm sun
dirLight.position.set(50, 100, 50);
dirLight.castShadow = true;
dirLight.shadow.camera.left = -150;
dirLight.shadow.camera.right = 150;
dirLight.shadow.camera.top = 150;
dirLight.shadow.camera.bottom = -150;
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
scene.add(dirLight);
const hemiLight = new THREE.HemisphereLight(0x88bbff, 0x44aa44, 1.0);
scene.add(hemiLight);
const visionLight = new THREE.PointLight(0xfff8ee, 5.0, 120, 1.0);
visionLight.position.set(0, 12, 0);
scene.add(visionLight);
const previewGeometry = new THREE.PlaneGeometry(80, 80);
const previewMaterial = new THREE.MeshStandardMaterial({
    color: 0x2a3a2a,
    roughness: 0.8
});
const previewGround = new THREE.Mesh(previewGeometry, previewMaterial);
previewGround.rotation.x = -Math.PI / 2;
previewGround.receiveShadow = true;
scene.add(previewGround);
const MAP_SIZE = 200;

const _windMaterials = [];

const createMap = () => {

    const groundGeometry = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, 50, 50);
    const vertices = groundGeometry.attributes.position.array;
    for (let i = 0; i < vertices.length; i += 3) {
        const x = vertices[i];
        const z = vertices[i + 1];
        vertices[i + 2] = Math.sin(x * 0.1) * Math.cos(z * 0.1) * 2;
    }
    groundGeometry.computeVertexNormals();

    const groundMaterial = new THREE.ShaderMaterial({
        lights: true,
        uniforms: THREE.UniformsUtils.merge([
            THREE.UniformsLib.lights,
            THREE.UniformsLib.fog,
            {
                uMapSize: { value: MAP_SIZE }
            }
        ]),
        vertexShader: `
            varying vec3 vWorldPos;
            varying vec3 vNormal;
            varying vec2 vUv;
            void main() {
                vUv = uv;
                vec4 worldPos = modelMatrix * vec4(position, 1.0);
                vWorldPos = worldPos.xyz;
                vNormal = normalize(normalMatrix * normal);
                gl_Position = projectionMatrix * viewMatrix * worldPos;
            }
        `,
        fragmentShader: `
            uniform float uMapSize;
            varying vec3 vWorldPos;
            varying vec3 vNormal;
            varying vec2 vUv;
            #include <common>
            #include <lights_pars_begin>
            float hash(vec2 p) {
                return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
            }
            float noise(vec2 p) {
                vec2 i = floor(p);
                vec2 f = fract(p);
                f = f * f * (3.0 - 2.0 * f);
                float a = hash(i);
                float b = hash(i + vec2(1.0, 0.0));
                float c = hash(i + vec2(0.0, 1.0));
                float d = hash(i + vec2(1.0, 1.0));
                return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
            }
            float fbm(vec2 p) {
                float v = 0.0;
                float a = 0.5;
                for (int i = 0; i < 4; i++) {
                    v += a * noise(p);
                    p *= 2.0;
                    a *= 0.5;
                }
                return v;
            }

            void main() {

                float height = vWorldPos.y;
                float slope = 1.0 - dot(vNormal, vec3(0.0, 1.0, 0.0));
                vec3 grassDark = vec3(0.18, 0.48, 0.12);
                vec3 grassMid = vec3(0.25, 0.55, 0.14);
                vec3 grassLight = vec3(0.32, 0.62, 0.16);
                float n1 = fbm(vWorldPos.xz * 0.05);
                float n3 = fbm(vWorldPos.xz * 0.3 + 100.0);
                vec3 col = n1 < 0.4
                    ? mix(grassDark, grassMid, n1 / 0.4)
                    : mix(grassMid, grassLight, (n1 - 0.4) / 0.6);
                float heightFactor = smoothstep(-2.0, 2.0, height);
                col = mix(col * 0.92, col * 1.06, heightFactor);
                col *= 0.95 + 0.05 * n3;
                vec3 lightDir = normalize(vec3(0.5, 0.8, 0.3));
                float diff = max(dot(vNormal, lightDir), 0.0);
                vec3 ambient = vec3(0.25, 0.28, 0.22);
                vec3 lightCol = vec3(1.0, 0.95, 0.85);
                col = col * (ambient + lightCol * diff * 0.75);

                gl_FragColor = vec4(col, 1.0);
            }
        `
    });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    const terrainY = (x, z) => Math.sin(x * 0.1) * Math.cos(z * 0.1) * 2;
    const createTree = (x, z) => {
        const treeGroup = new THREE.Group();
        const seed = Math.abs(x * 137.3 + z * 259.7);
        const rng = (offset) => fract(Math.sin(seed + offset) * 43758.5453);
        function fract(v) { return v - Math.floor(v); }

        const scaleFactor = 0.85 + rng(0) * 0.3; // 0.85 - 1.15
        const rotY = rng(1) * Math.PI * 2;
        const trunkGeometry = new THREE.CylinderGeometry(0.25 * scaleFactor, 0.4 * scaleFactor, 3.2 * scaleFactor, 8);
        const trunkMaterial = new THREE.ShaderMaterial({
            vertexShader: `
                varying vec3 vPos;
                varying vec3 vNormal;
                void main() {
                    vPos = position;
                    vNormal = normalize(normalMatrix * normal);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                varying vec3 vPos;
                varying vec3 vNormal;
                float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
                void main() {
                    vec3 darkBark = vec3(0.30, 0.18, 0.08);
                    vec3 lightBark = vec3(0.50, 0.32, 0.16);
                    float n = hash(vec2(vPos.y * 8.0, atan(vPos.x, vPos.z) * 3.0));
                    vec3 col = mix(darkBark, lightBark, n);

                    float diff = max(dot(vNormal, normalize(vec3(0.5, 0.8, 0.3))), 0.0);
                    col *= 0.4 + diff * 0.6;
                    gl_FragColor = vec4(col, 1.0);
                }
            `
        });
        const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
        trunk.position.y = 1.6 * scaleFactor;
        trunk.castShadow = true;
        treeGroup.add(trunk);
        const foliageLayers = [
            { y: 3.2, radius: 1.8, height: 2.2, colorShift: 0.0 },
            { y: 4.6, radius: 1.4, height: 1.8, colorShift: 0.05 },
            { y: 5.6, radius: 0.9, height: 1.4, colorShift: 0.1 }
        ];

        foliageLayers.forEach((layer, li) => {
            const r = layer.radius * scaleFactor * (0.9 + rng(li + 2) * 0.2);
            const h = layer.height * scaleFactor;
            const foliageGeometry = new THREE.ConeGeometry(r, h, 7);
            const colors = new Float32Array(foliageGeometry.attributes.position.count * 3);
            const pos = foliageGeometry.attributes.position.array;
            for (let i = 0; i < colors.length; i += 3) {
                const vy = pos[i + 1];
                const t = rng(li + i * 0.01) * 0.15;

                colors[i] = 0.12 + layer.colorShift + t * 0.2;     // R
                colors[i + 1] = 0.50 + layer.colorShift * 0.5 + t; // G — much greener
                colors[i + 2] = 0.08 + t * 0.15;                   // B
            }
            foliageGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

            const worldX = x;
            const worldZ = z;
            const foliageMaterial = new THREE.ShaderMaterial({
                uniforms: {
                    uTime: { value: 0.0 },
                    uWindStrength: { value: 0.015 },
                    uTreePos: { value: new THREE.Vector2(worldX, worldZ) }
                },
                vertexShader: `
                    attribute vec3 color;
                    uniform float uTime;
                    uniform float uWindStrength;
                    uniform vec2 uTreePos;
                    varying vec3 vColor;
                    varying vec3 vNormal;
                    varying float vHeight;
                    void main() {
                        vColor = color;
                        vNormal = normalize(normalMatrix * normal);
                        vHeight = position.y;
                        vec3 pos = position;

                        float heightFactor = max(0.0, position.y) / 2.0;
                        float phase = uTreePos.x * 0.1 + uTreePos.y * 0.13;
                        pos.x += sin(uTime * 1.5 + phase) * uWindStrength * heightFactor;
                        pos.z += cos(uTime * 1.2 + phase + 1.5) * uWindStrength * heightFactor * 0.7;
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
                    }
                `,
                fragmentShader: `
                    varying vec3 vColor;
                    varying vec3 vNormal;
                    varying float vHeight;
                    void main() {
                        vec3 lightDir = normalize(vec3(0.5, 0.8, 0.3));
                        float diff = max(dot(vNormal, lightDir), 0.0);

                        float wrap = max(dot(vNormal, vec3(0.0, -1.0, 0.0)) * 0.3, 0.0);
                        vec3 col = vColor * (0.35 + diff * 0.55 + wrap * 0.15);

                        col *= 0.85 + 0.15 * smoothstep(-0.5, 1.0, vHeight);
                        gl_FragColor = vec4(col, 1.0);
                    }
                `
            });
            _windMaterials.push(foliageMaterial);

            const foliage = new THREE.Mesh(foliageGeometry, foliageMaterial);
            foliage.position.y = layer.y * scaleFactor;
            foliage.rotation.y = rotY + li * 0.4;
            foliage.castShadow = true;
            treeGroup.add(foliage);
        });

        treeGroup.position.set(x, terrainY(x, z), z);
        treeGroup.userData.isWall = true;
        scene.add(treeGroup);
        return treeGroup;
    };
    const _staticTrees = [[-30,20],[25,-15],[-45,-30],[50,25],[-20,45],[35,-40],[-55,5],[15,50],[-10,-35],[60,-10],[-35,60],[40,45],[-50,-45],[20,-60],[-15,-50],[55,-35],[-40,25],[30,15],[-25,-15],[45,-5],[-60,40],[10,35],[-5,-55],[50,55],[-30,-60],[65,30],[-45,50],[20,-30],[-55,-15],[35,65],[-20,30],[55,-50],[-65,15],[40,-15],[-10,60],[25,-45],[-35,-25],[60,50],[-50,35],[15,-55],[-25,-45],[45,20],[-40,-10],[30,55],[-15,15],[50,-25],[-55,-50],[20,40],[-30,50],[65,-20],[-45,-5],[35,-55],[-60,55],[10,-40],[-5,25],[55,10]];
    _staticTrees.forEach(([x,z]) => createTree(x, z));
    const createRock = (x, z, size) => {

        const rockGeometry = new THREE.IcosahedronGeometry(size, 2);
        const rpos = rockGeometry.attributes.position.array;
        const rnormals = rockGeometry.attributes.normal.array;
        const rcolors = new Float32Array(rpos.length);
        const seedR = Math.abs(x * 73.7 + z * 157.3 + size * 311.1);
        for (let i = 0; i < rpos.length; i += 3) {

            const nx = rpos[i], ny = rpos[i+1], nz = rpos[i+2];
            const disp = (Math.sin(nx * 5.0 + seedR) * Math.cos(ny * 7.0) * Math.sin(nz * 6.0 + seedR * 0.5)) * size * 0.12;
            rpos[i] += rnormals[i] * disp;
            rpos[i+1] += rnormals[i+1] * disp;
            rpos[i+2] += rnormals[i+2] * disp;
            const worldNy = rnormals[i+1]; // approximate
            const mossAmount = Math.max(0, worldNy) * 0.6;
            const stoneVariation = Math.sin(nx * 8.0 + seedR) * 0.08;
            let r = 0.52 + stoneVariation;
            let g = 0.48 + stoneVariation;
            let b = 0.42 + stoneVariation * 0.5;
            r = r * (1.0 - mossAmount) + 0.20 * mossAmount;
            g = g * (1.0 - mossAmount) + 0.55 * mossAmount;
            b = b * (1.0 - mossAmount) + 0.12 * mossAmount;
            const tint = (Math.sin(seedR + i * 0.37) * 0.5 + 0.5) * 0.06;
            r += tint;
            g += tint * 0.5;

            rcolors[i] = r;
            rcolors[i+1] = g;
            rcolors[i+2] = b;
        }
        rockGeometry.attributes.position.needsUpdate = true;
        rockGeometry.computeVertexNormals();
        rockGeometry.setAttribute('color', new THREE.BufferAttribute(rcolors, 3));

        const rockMaterial = new THREE.ShaderMaterial({
            vertexShader: `
                attribute vec3 color;
                varying vec3 vColor;
                varying vec3 vNormal;
                void main() {
                    vColor = color;
                    vNormal = normalize(normalMatrix * normal);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                varying vec3 vColor;
                varying vec3 vNormal;
                void main() {
                    vec3 lightDir = normalize(vec3(0.5, 0.8, 0.3));
                    float diff = max(dot(vNormal, lightDir), 0.0);

                    float ao = 0.5 + 0.5 * vNormal.y;
                    vec3 col = vColor * (0.3 + diff * 0.6) * (0.7 + ao * 0.3);
                    gl_FragColor = vec4(col, 1.0);
                }
            `
        });

        const rock = new THREE.Mesh(rockGeometry, rockMaterial);
        rock.position.set(x, terrainY(x, z) + size * 0.7, z);
        rock.rotation.set(x * 0.5, z * 0.3, size); // Deterministic rotation from position
        rock.castShadow = true;
        rock.receiveShadow = true;
        rock.userData.isWall = true;
        scene.add(rock);
        return rock;
    };
    const _staticRocks = [[-25,10,1.2],[30,-20,1.5],[-40,-35,0.9],[50,15,1.8],[-15,40,1.1],[35,-50,1.4],[-55,20,1.0],[20,55,1.6],[-10,-25,0.8],[60,-5,1.3],[-35,55,1.5],[45,35,1.0],[-50,-40,1.7],[15,-55,0.9],[-20,-50,1.2],[55,-30,1.1],[-45,15,1.4],[25,25,0.8],[-30,-10,1.6],[40,-40,1.3],[-60,45,1.0],[10,30,1.5],[-5,-45,1.2],[50,50,1.8],[-25,-55,0.9],[65,20,1.1],[-40,40,1.4],[20,-35,1.0],[-55,-20,1.3],[35,60,1.5]];
    _staticRocks.forEach(([x,z,s]) => createRock(x, z, s));
    const wallMaterial = new THREE.ShaderMaterial({
        vertexShader: `
            varying vec3 vPos;
            varying vec3 vNormal;
            varying vec3 vWorldPos;
            void main() {
                vPos = position;
                vNormal = normalize(normalMatrix * normal);
                vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            varying vec3 vPos;
            varying vec3 vNormal;
            varying vec3 vWorldPos;

            float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

            void main() {

                vec2 uv = vWorldPos.xz;

                float absNx = abs(vNormal.x);
                float absNz = abs(vNormal.z);
                if (absNx > 0.5) uv = vWorldPos.zy;
                else if (absNz > 0.5) uv = vWorldPos.xy;
                float brickW = 1.5;
                float brickH = 0.75;
                float mortarW = 0.08;
                vec2 brickUV = uv / vec2(brickW, brickH);

                float row = floor(brickUV.y);
                brickUV.x += mod(row, 2.0) * 0.5;
                vec2 brickFract = fract(brickUV);
                float mortar = step(mortarW, brickFract.x) * step(mortarW, brickFract.y);
                vec2 brickID = floor(brickUV);
                float brickNoise = hash(brickID);

                vec3 stoneBase = vec3(0.55, 0.50, 0.42);
                vec3 stoneDark = vec3(0.35, 0.30, 0.25);
                vec3 mortarColor = vec3(0.30, 0.28, 0.24);

                vec3 brickCol = mix(stoneDark, stoneBase, brickNoise);

                brickCol += vec3(0.03, -0.01, -0.02) * (hash(brickID + 7.0) - 0.5);

                vec3 col = mix(mortarColor, brickCol, mortar);
                vec3 lightDir = normalize(vec3(0.5, 0.8, 0.3));
                float diff = max(dot(vNormal, lightDir), 0.0);
                col *= 0.35 + diff * 0.65;
                float bottomDark = smoothstep(-4.0, 0.0, vPos.y);
                col *= 0.8 + 0.2 * bottomDark;

                gl_FragColor = vec4(col, 1.0);
            }
        `
    });

    const createWall = (x, y, width, height) => {
        const wallGeometry = new THREE.BoxGeometry(width, 8, height);
        const wall = new THREE.Mesh(wallGeometry, wallMaterial);
        wall.position.set(x, terrainY(x, y), y);
        wall.castShadow = true;
        wall.receiveShadow = true;
        wall.userData.isWall = true;
        scene.add(wall);
        return wall;
    };
    createWall(0, MAP_SIZE/2, MAP_SIZE, 2);
    createWall(0, -MAP_SIZE/2, MAP_SIZE, 2);
    createWall(MAP_SIZE/2, 0, 2, MAP_SIZE);
    createWall(-MAP_SIZE/2, 0, 2, MAP_SIZE);
    createWall(0, 0, 15, 3);
    createWall(0, 10, 3, 10);
    createWall(0, -10, 3, 10);
    createWall(15, 8, 12, 3);
    createWall(-15, 8, 12, 3);
    createWall(15, -8, 12, 3);
    createWall(-15, -8, 12, 3);
    const _staticWalls = [[-45,35,6,4],[30,-50,5,7],[-60,-20,4,5],[55,40,7,3],[-25,55,5,6],[40,-25,3,8],[-50,-55,6,4],[60,15,4,5],[-35,-40,5,3],[25,60,7,4],[-55,10,4,6],[45,-60,5,5],[-20,-65,6,3],[35,30,3,7],[-40,65,5,4]];
    _staticWalls.forEach(([x,z,w,h]) => createWall(x, z, w, h));
    const redSpawnGeometry = new THREE.CircleGeometry(5, 32);
    const redSpawnMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.3 });
    const redSpawn = new THREE.Mesh(redSpawnGeometry, redSpawnMaterial);
    redSpawn.rotation.x = -Math.PI / 2;
    redSpawn.position.set(-70, 0.1, -70);
    scene.add(redSpawn);

    const blueSpawnGeometry = new THREE.CircleGeometry(5, 32);
    const blueSpawnMaterial = new THREE.MeshBasicMaterial({ color: 0x0088ff, transparent: true, opacity: 0.3 });
    const blueSpawn = new THREE.Mesh(blueSpawnGeometry, blueSpawnMaterial);
    blueSpawn.rotation.x = -Math.PI / 2;
    blueSpawn.position.set(70, 0.1, 70);
    scene.add(blueSpawn);

};

const VISION_RADIUS = 35;
const FARSIGHT_RADIUS = 55;

class FogOfWar {
    constructor() {
        this.visionSources = [];
        this.fogLayers = [];
        this._maxSources = 12;
    }

    init() {
        const fogVert = `
            varying vec2 vWorldPos;
            void main() {
                vec4 wp = modelMatrix * vec4(position, 1.0);
                vWorldPos = wp.xz;
                gl_Position = projectionMatrix * viewMatrix * wp;
            }
        `;

        const mainFogFrag = `
            uniform float uTime;
            uniform int uSourceCount;
            uniform vec3 uSources[12];
            varying vec2 vWorldPos;

            float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

            float noise(vec2 p) {
                vec2 i = floor(p), f = fract(p), u = f*f*(3.0-2.0*f);
                return mix(mix(hash(i), hash(i+vec2(1,0)), u.x),
                           mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
            }

            float fbm(vec2 p) {
                float v = 0.0, a = 0.5;
                mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
                for (int i = 0; i < 5; i++) { v += a * noise(p); p = rot * p * 2.0; a *= 0.5; }
                return v;
            }
            float cloudDensity(vec2 p) {
                vec2 q = vec2(fbm(p), fbm(p + vec2(5.2, 1.3)));
                vec2 r = vec2(
                    fbm(p + 3.0*q + vec2(1.7, 9.2) + uTime * 0.06),
                    fbm(p + 3.0*q + vec2(8.3, 2.8) + uTime * 0.04)
                );
                return fbm(p + 3.5 * r);
            }

            void main() {

                vec2 np = vWorldPos * 0.03;
                float density = cloudDensity(np);

                float detail = fbm(vWorldPos * 0.08 + uTime * vec2(0.03, -0.02));
                density = density * 0.7 + detail * 0.3;
                float reveal = 0.0;
                float edgeGlow = 0.0;
                for (int i = 0; i < 12; i++) {
                    if (i >= uSourceCount) break;
                    vec2 delta = vWorldPos - uSources[i].xy;
                    float dist = length(delta);
                    float r = uSources[i].z;
                    float normDist = dist / r;

                    if (normDist < 1.6) {

                        vec2 edgePos = vWorldPos * 0.06 + uTime * vec2(0.02, 0.015);
                        float edgeNoise = fbm(edgePos);
                        float threshold = 0.3 + (density * 0.5 + edgeNoise * 0.5) * 0.9;

                        float innerClear = 1.0 - smoothstep(0.0, 0.4, normDist);
                        float wispyClear = 1.0 - smoothstep(threshold - 0.15, threshold + 0.15, normDist);
                        float localReveal = max(innerClear, wispyClear);
                        reveal = max(reveal, localReveal);
                        float glowZone = smoothstep(threshold + 0.15, threshold - 0.1, normDist)
                                       * smoothstep(threshold - 0.3, threshold, normDist);
                        edgeGlow = max(edgeGlow, glowZone * density);
                    }
                }

                vec3 fogDeep = vec3(0.02, 0.03, 0.06); // Deep blue-black
                vec3 fogMid = vec3(0.05, 0.05, 0.08);  // Slightly lighter
                vec3 fogColor = mix(fogDeep, fogMid, density);
                vec3 scatterColor = vec3(0.15, 0.08, 0.03); // Warm amber
                fogColor += scatterColor * edgeGlow * 1.5;
                float fogAlpha = (0.4 + density * 0.3) * (1.0 - reveal);
                fogColor = fogColor * 0.5 + 0.5 * fogColor * fogColor * (3.0 - 2.0 * fogColor);

                gl_FragColor = vec4(fogColor, fogAlpha);
            }
        `;
        const wispFrag = `
            uniform float uTime;
            uniform int uSourceCount;
            uniform vec3 uSources[12];
            varying vec2 vWorldPos;

            float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
            float noise(vec2 p) {
                vec2 i = floor(p), f = fract(p), u = f*f*(3.0-2.0*f);
                return mix(mix(hash(i), hash(i+vec2(1,0)), u.x),
                           mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
            }
            float fbm(vec2 p) {
                float v = 0.0, a = 0.5;
                mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
                for (int i = 0; i < 5; i++) { v += a * noise(p); p = rot * p * 2.0; a *= 0.5; }
                return v;
            }

            void main() {

                vec2 np = vWorldPos * 0.02;
                vec2 q = vec2(fbm(np + uTime * 0.03), fbm(np + vec2(3.1, 7.2) + uTime * 0.02));
                float wisps = fbm(np + 2.5 * q + uTime * 0.01);
                wisps = smoothstep(0.35, 0.7, wisps);

                float reveal = 0.0;
                for (int i = 0; i < 12; i++) {
                    if (i >= uSourceCount) break;
                    float d = length(vWorldPos - uSources[i].xy) / uSources[i].z;
                    reveal = max(reveal, 1.0 - smoothstep(0.3, 0.85, d));
                }
                vec3 wispColor = vec3(0.03, 0.04, 0.07) * (1.0 + wisps * 0.5);
                float alpha = wisps * 0.2 * (1.0 - reveal);
                gl_FragColor = vec4(wispColor, alpha);
            }
        `;
        const mainMat = new THREE.ShaderMaterial({
            vertexShader: fogVert, fragmentShader: mainFogFrag,
            transparent: true, depthWrite: false, depthTest: false,
            uniforms: {
                uTime: { value: 0 },
                uSourceCount: { value: 0 },
                uSources: { value: new Array(this._maxSources).fill(null).map(() => new THREE.Vector3()) },
            }
        });
        const mainMesh = new THREE.Mesh(new THREE.PlaneGeometry(MAP_SIZE * 1.5, MAP_SIZE * 1.5), mainMat);
        mainMesh.rotation.x = -Math.PI / 2;
        mainMesh.position.y = 5;
        mainMesh.renderOrder = 10000;
        scene.add(mainMesh);
        this.fogLayers.push(mainMesh);
        const wispMat = new THREE.ShaderMaterial({
            vertexShader: fogVert, fragmentShader: wispFrag,
            transparent: true, depthWrite: false, depthTest: false,
            uniforms: {
                uTime: { value: 0 },
                uSourceCount: { value: 0 },
                uSources: { value: new Array(this._maxSources).fill(null).map(() => new THREE.Vector3()) },
            }
        });
        const wispMesh = new THREE.Mesh(new THREE.PlaneGeometry(MAP_SIZE * 1.5, MAP_SIZE * 1.5), wispMat);
        wispMesh.rotation.x = -Math.PI / 2;
        wispMesh.position.y = 2;
        wispMesh.renderOrder = 9999;
        scene.add(wispMesh);
        this.fogLayers.push(wispMesh);

        this.fogMesh = mainMesh;
    }

    update(player, allUnits, farsightPositions = []) {
        this.visionSources = [];
        const visionR = VISION_RADIUS;
        if (player && player.health > 0) {
            this.visionSources.push({ x: player.position.x, z: player.position.z, r: visionR });
        }
        allUnits.forEach(unit => {
            if (unit.team === gameState.team && unit.health > 0 && unit !== player) {
                this.visionSources.push({ x: unit.position.x, z: unit.position.z, r: visionR });
            }
        });
        farsightPositions.forEach(pos => {
            this.visionSources.push({ x: pos.x, z: pos.z, r: FARSIGHT_RADIUS });
        });

        const t = performance.now() * 0.001;
        const srcCount = Math.min(this.visionSources.length, this._maxSources);
        for (const layer of this.fogLayers) {
            const u = layer.material.uniforms;
            u.uTime.value = t;
            u.uSourceCount.value = srcCount;
            for (let i = 0; i < this._maxSources; i++) {
                if (i < this.visionSources.length) {
                    const src = this.visionSources[i];
                    u.uSources.value[i].set(src.x, src.z, src.r);
                } else {
                    u.uSources.value[i].set(0, 0, 0);
                }
            }
        }
    }

    isVisible(worldX, worldZ) {
        for (const src of this.visionSources) {
            const dx = worldX - src.x;
            const dz = worldZ - src.z;
            if (dx * dx + dz * dz <= src.r * src.r) return true;
        }
        return false;
    }
}

const fogOfWar = new FogOfWar();
fogOfWar.init();
class Player {
    constructor(username, team, isPlayer = false) {
        this.username = username;
        this.team = team;
        this.isPlayer = isPlayer;
        this.health = 100;
        this.maxHealth = 100;
        this.kills = 0;
        this.deaths = 0;
        this.speed = 8;
        this.normalSpeed = 8;
        this.windwalkSpeed = 14;
        this.shootRange = 25; // Match server SHOOT_RANGE
        this.damage = 25;
        this._spawnProtection = 3.0; // 3s invulnerable on spawn
        this.price = 1.00; // Everyone is a token
        this.isWindwalking = false;
        this.farsightActive = false;
        this.farsightPosition = null;
        this.shootCooldown = 0;
        this.shootCooldownTime = 1.0; // 1 second between shots
        this.gold = 0;
        this.inventory = {}; // { itemId: true }
        this.hasShield = false;
        this.goldMultiplier = 1.0;
        this.baseSpeed = 8;
        this.baseRange = 25;
        this.baseCooldown = 1.0;

        this.createMesh(team);
        this.position = this.mesh.position;
        if (team === 'red') {
            const x = -70 + Math.random() * 10 - 5;
            const z = -70 + Math.random() * 10 - 5;
            this.position.set(x, this.getTerrainHeight(x, z), z);
        } else {
            const x = 70 + Math.random() * 10 - 5;
            const z = 70 + Math.random() * 10 - 5;
            this.position.set(x, this.getTerrainHeight(x, z), z);
        }

        this.velocity = new THREE.Vector3();
        this.targetPosition = null;
        this.attackWalkTarget = null;
    }

    createMesh(team) {
        const group = new THREE.Group();
        const robeColor = team === 'red' ? 0xcc2222 : 0x2244cc;
        const robeDark = team === 'red' ? 0x881515 : 0x152288;
        const robeLight = team === 'red' ? 0xff4444 : 0x4466ff;
        const cloth = new THREE.MeshStandardMaterial({ color: robeColor, roughness: 0.9 });
        const clothDark = new THREE.MeshStandardMaterial({ color: robeDark, roughness: 0.9 });
        const legGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.7, 4);
        const legMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 });

        const leftLeg = new THREE.Mesh(legGeo, legMat);
        leftLeg.position.set(-0.12, -0.15, 0);
        group.add(leftLeg);

        const rightLeg = new THREE.Mesh(legGeo, legMat);
        rightLeg.position.set(0.12, -0.15, 0);
        group.add(rightLeg);

        this.leftLeg = leftLeg;
        this.rightLeg = rightLeg;
        const shoeGeo = new THREE.ConeGeometry(0.1, 0.35, 4);
        const shoeMat = new THREE.MeshStandardMaterial({ color: robeDark, roughness: 0.8 });

        const leftShoe = new THREE.Mesh(shoeGeo, shoeMat);
        leftShoe.position.set(-0.12, -0.55, 0.08);
        leftShoe.rotation.x = -Math.PI / 2;
        group.add(leftShoe);
        this.leftShoe = leftShoe;

        const rightShoe = new THREE.Mesh(shoeGeo, shoeMat);
        rightShoe.position.set(0.12, -0.55, 0.08);
        rightShoe.rotation.x = -Math.PI / 2;
        group.add(rightShoe);
        this.rightShoe = rightShoe;
        const robeGeo = new THREE.CylinderGeometry(0.2, 0.45, 1.1, 6);
        const robe = new THREE.Mesh(robeGeo, cloth);
        robe.position.y = 0.45;
        robe.castShadow = true;
        group.add(robe);
        const beltGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.08, 6);
        const beltMat = new THREE.MeshStandardMaterial({ color: 0x886622, roughness: 0.7, metalness: 0.3 });
        const belt = new THREE.Mesh(beltGeo, beltMat);
        belt.position.y = 0.2;
        group.add(belt);
        const hatGroup = new THREE.Group();
        hatGroup.position.y = 1.05;
        const brimGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.06, 8);
        const hatMat = new THREE.MeshStandardMaterial({ color: robeDark, roughness: 0.8 });
        const brim = new THREE.Mesh(brimGeo, hatMat);
        brim.position.y = -0.05;
        hatGroup.add(brim);
        const coneGeo = new THREE.ConeGeometry(0.28, 0.9, 6);
        const cone = new THREE.Mesh(coneGeo, hatMat);
        cone.position.y = 0.4;
        cone.rotation.z = 0.15; // Slight tilt
        cone.castShadow = true;
        hatGroup.add(cone);
        const tipGeo = new THREE.SphereGeometry(0.06, 4, 4);
        const tipMat = new THREE.MeshStandardMaterial({ color: robeLight, roughness: 0.7, emissive: robeLight, emissiveIntensity: 0.3 });
        const tip = new THREE.Mesh(tipGeo, tipMat);
        tip.position.set(0.12, 0.85, 0);
        hatGroup.add(tip);
        const bandGeo = new THREE.CylinderGeometry(0.29, 0.29, 0.06, 6);
        const bandMat = new THREE.MeshStandardMaterial({ color: 0x886622, roughness: 0.6, metalness: 0.4 });
        const band = new THREE.Mesh(bandGeo, bandMat);
        band.position.y = 0.02;
        hatGroup.add(band);
        const eyeGeo = new THREE.SphereGeometry(0.04, 4, 4);
        const eyeMat = new THREE.MeshBasicMaterial({
            color: team === 'red' ? 0xff6666 : 0x66aaff,
        });
        const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
        leftEye.position.set(-0.1, -0.12, 0.2);
        hatGroup.add(leftEye);
        const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
        rightEye.position.set(0.1, -0.12, 0.2);
        hatGroup.add(rightEye);

        group.add(hatGroup);
        const armGeo = new THREE.CylinderGeometry(0.06, 0.1, 0.6, 4);

        const leftArm = new THREE.Mesh(armGeo, cloth);
        leftArm.position.set(-0.32, 0.5, 0);
        leftArm.rotation.z = 0.4;
        leftArm.castShadow = true;
        group.add(leftArm);
        this.leftArm = leftArm;

        const rightArm = new THREE.Mesh(armGeo, cloth);
        rightArm.position.set(0.32, 0.5, 0);
        rightArm.rotation.z = -0.4;
        rightArm.castShadow = true;
        group.add(rightArm);
        this.rightArm = rightArm;
        const rifleGroup = new THREE.Group();
        const gunMetal = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.3, metalness: 0.9 });
        const woodMat = new THREE.MeshStandardMaterial({ color: 0x4a2a10, roughness: 0.8, metalness: 0.1 });
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.8, 6), gunMetal);
        barrel.rotation.x = Math.PI / 2;
        barrel.position.z = 1.2;
        barrel.castShadow = true;
        rifleGroup.add(barrel);
        const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.06, 0.2, 6), gunMetal);
        muzzle.rotation.x = Math.PI / 2;
        muzzle.position.z = 2.7;
        rifleGroup.add(muzzle);
        const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.22, 0.8), gunMetal);
        receiver.position.set(0, 0.02, 0.1);
        receiver.castShadow = true;
        rifleGroup.add(receiver);
        const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.8, 6), new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.3, metalness: 0.9 }));
        scope.rotation.x = Math.PI / 2;
        scope.position.set(0, 0.2, 0.5);
        scope.castShadow = true;
        rifleGroup.add(scope);
        const lens = new THREE.Mesh(new THREE.CircleGeometry(0.09, 8), new THREE.MeshStandardMaterial({
            color: 0x2244aa, roughness: 0.1, metalness: 1, emissive: 0x0000aa, emissiveIntensity: 0.3
        }));
        lens.position.set(0, 0.2, 0.91);
        rifleGroup.add(lens);
        for (let i = 0; i < 2; i++) {
            const mount = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.02, 6, 8), gunMetal);
            mount.rotation.y = Math.PI / 2;
            mount.position.set(0, 0.2, 0.25 + i * 0.5);
            rifleGroup.add(mount);
        }
        const stock = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.28, 0.7), woodMat);
        stock.position.set(0, 0, -0.4);
        stock.castShadow = true;
        rifleGroup.add(stock);
        const stockEnd = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), woodMat);
        stockEnd.position.z = -0.75;
        stockEnd.scale.set(1.5, 2, 0.8);
        rifleGroup.add(stockEnd);
        const grip = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.3, 0.2), woodMat);
        grip.position.set(0, -0.18, 0.2);
        rifleGroup.add(grip);
        const mag = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.35, 0.14), gunMetal);
        mag.position.set(0, -0.12, 0.05);
        rifleGroup.add(mag);
        const bolt = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.18), gunMetal);
        bolt.position.set(0.06, 0.05, 0);
        rifleGroup.add(bolt);

        rifleGroup.position.set(0.3, 0.5, 0.3);
        rifleGroup.rotation.y = 0.1;
        group.add(rifleGroup);

        this.rifleGroup = rifleGroup;
        this.weapon = rifleGroup;
        const capeShape = new THREE.Shape();
        capeShape.moveTo(-0.3, 0);
        capeShape.lineTo(0.3, 0);
        capeShape.lineTo(0.35, -1.4);
        capeShape.lineTo(0.1, -1.6);
        capeShape.lineTo(-0.1, -1.6);
        capeShape.lineTo(-0.35, -1.4);
        capeShape.closePath();
        const capeGeo = new THREE.ShapeGeometry(capeShape);
        const capeMat = new THREE.MeshStandardMaterial({
            color: robeDark,
            side: THREE.DoubleSide,
            roughness: 0.9,
        });
        const cape = new THREE.Mesh(capeGeo, capeMat);
        cape.position.set(0, 0.95, -0.22);
        cape.rotation.x = 0.1;
        cape.castShadow = true;
        group.add(cape);
        this.cape = cape;
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = team === 'red' ? '#ff0000' : '#0088ff';
        ctx.font = 'bold 32px Courier New';
        ctx.textAlign = 'center';
        ctx.fillText(this.username, 128, 40);

        const texture = new THREE.CanvasTexture(canvas);
        const spriteMaterial = new THREE.SpriteMaterial({ map: texture });
        const sprite = new THREE.Sprite(spriteMaterial);
        sprite.scale.set(2, 0.5, 1);
        sprite.position.y = 2.1;
        sprite.raycast = () => {};
        group.add(sprite);

        this.healthBar = null;
        if (this.isPlayer) {
            const haloGeometry = new THREE.RingGeometry(0.6, 0.8, 16);
            const haloMaterial = new THREE.MeshBasicMaterial({
                color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.5,
            });
            const halo = new THREE.Mesh(haloGeometry, haloMaterial);
            halo.rotation.x = -Math.PI / 2;
            halo.position.y = -0.2;
            halo.raycast = () => {};
            group.add(halo);
        }

        group.position.y = 0.5;
        scene.add(group);
        this.mesh = group;
    }

    update(deltaTime) {

        if (this.isWindwalking) {
            this.mesh.children[0].material.transparent = true;
            this.mesh.children[0].material.opacity = 0.3;
            this.speed = this.windwalkSpeed;
        } else {
            this.mesh.children[0].material.transparent = false;
            this.mesh.children[0].material.opacity = 1.0;
            this.speed = this.normalSpeed;
        }
        const isMoving = this.velocity.length() > 0.01;
        const time = Date.now() * 0.001;

        if (isMoving && this.leftLeg && this.rightLeg) {
            const runTime = time * 10;
            this.leftLeg.rotation.x = Math.sin(runTime) * 0.6;
            this.rightLeg.rotation.x = Math.sin(runTime + Math.PI) * 0.6;
            if (this.leftShoe) this.leftShoe.rotation.x = -Math.PI / 2 + Math.sin(runTime) * 0.3;
            if (this.rightShoe) this.rightShoe.rotation.x = -Math.PI / 2 + Math.sin(runTime + Math.PI) * 0.3;
            if (this.leftArm) this.leftArm.rotation.x = Math.sin(runTime + Math.PI) * 0.4;
            if (this.rightArm) this.rightArm.rotation.x = Math.sin(runTime) * 0.4;
            this.mesh.position.y += Math.sin(runTime * 2) * 0.025;
            if (this.cape) this.cape.rotation.x = 0.3 + Math.sin(runTime * 1.5) * 0.15;
        } else if (this.leftLeg && this.rightLeg) {

            this.leftLeg.rotation.x = 0;
            this.rightLeg.rotation.x = 0;
            if (this.leftShoe) this.leftShoe.rotation.x = -Math.PI / 2;
            if (this.rightShoe) this.rightShoe.rotation.x = -Math.PI / 2;
            if (this.leftArm) this.leftArm.rotation.x = Math.sin(time * 2) * 0.05;
            if (this.rightArm) this.rightArm.rotation.x = Math.sin(time * 2 + 0.5) * 0.05;
            if (this.cape) this.cape.rotation.x = 0.1 + Math.sin(time * 1.5) * 0.05;
            this.mesh.position.y += Math.sin(time * 2) * 0.008;
        }
        if (this._spawnProtection > 0) {
            this._spawnProtection -= deltaTime;

            const flicker = Math.sin(Date.now() * 0.015) > 0;
            this.mesh.traverse(child => {
                if (child.material && !child.isSprite) {
                    child.material.transparent = true;
                    child.material.opacity = flicker ? 0.4 : 0.8;
                }
            });
        } else if (this._spawnProtection !== undefined && this._spawnProtection <= 0) {
            this.mesh.traverse(child => {
                if (child.material && !child.isSprite) {
                    child.material.transparent = false;
                    child.material.opacity = 1;
                }
            });
            this._spawnProtection = -1; // Don't keep resetting
        }
        if (this.shootCooldown > 0) {
            this.shootCooldown -= deltaTime;
        }
        if (!isOnlineMode && this.health > 0 && this.shootCooldown <= 0) {
            this.autoShootAtEnemies();
        }
        if (!this.isPlayer) {
            this.botAI(deltaTime);
        }
    }

    autoShootAtEnemies() {

        const allEnemies = [...gameState.bots];
        if (gameState.player && gameState.player.team !== this.team) {
            allEnemies.push(gameState.player);
        }

        const visibleEnemies = allEnemies.filter(enemy =>
            enemy &&
            enemy !== this &&
            enemy.team !== this.team &&
            enemy.health > 0 &&
            enemy.mesh.visible // This checks fog of war visibility
        );

        if (visibleEnemies.length === 0) return;
        const weaponDirection = new THREE.Vector3(0, 0, 1);
        if (this.weapon) {
            weaponDirection.applyQuaternion(this.weapon.getWorldQuaternion(new THREE.Quaternion()));
        }

        const fovAngle = 30; // 30 degree FOV cone
        const fovRadians = (fovAngle * Math.PI) / 180;
        for (let enemy of visibleEnemies) {
            const toEnemy = new THREE.Vector3().subVectors(enemy.position, this.position).normalize();
            const angle = weaponDirection.angleTo(toEnemy);
            if (angle < fovRadians) {
                const distance = this.position.distanceTo(enemy.position);
                if (distance <= this.shootRange) {

                    const enemyVisible = fogOfWar.isVisible(enemy.position.x, enemy.position.z);
                    if (!enemyVisible) {
                        continue; // Skip this enemy, can't see them in fog
                    }
                    const raycaster = new THREE.Raycaster();
                    const eyePos = this.position.clone();
                    eyePos.y += 1.0;
                    const enemyChest = enemy.position.clone();
                    enemyChest.y += 1.0;
                    const losDir = new THREE.Vector3().subVectors(enemyChest, eyePos).normalize();
                    raycaster.set(eyePos, losDir);
                    const intersects = raycaster.intersectObjects(gameState._wallObjects || [], false);

                    let blocked = false;
                    for (let intersect of intersects) {
                        if (intersect.distance < distance) {
                            blocked = true;
                            break;
                        }
                    }

                    if (!blocked) {

                        this.shoot(enemy);
                        this.shootCooldown = this.shootCooldownTime;
                        return; // Only shoot one target per check
                    }
                }
            }
        }
    }

    _pickExploreTarget() {
        for (let i = 0; i < 20; i++) {
            const x = (Math.random() - 0.5) * (MAP_SIZE * 0.7);
            const z = (Math.random() - 0.5) * (MAP_SIZE * 0.7);
            if (Math.abs(x) > MAP_SIZE / 2 - 15 || Math.abs(z) > MAP_SIZE / 2 - 15) continue;
            const candidate = new THREE.Vector3(x, 0.5, z);
            if (this.checkCollision(candidate)) continue;
            let tooClose = false;
            for (const other of gameState.bots) {
                if (other === this || other.health <= 0) continue;
                if (other.position.distanceTo(candidate) < 8) { tooClose = true; break; }
            }
            if (tooClose) continue;
            return candidate;
        }

        const s = this.team === 'red' ? -70 : 70;
        return new THREE.Vector3(s + Math.random()*10-5, 0.5, s + Math.random()*10-5);
    }

    _tryMoveClient(newPos) {
        if (!this.checkCollision(newPos)) {
            this.position.x = newPos.x;
            this.position.z = newPos.z;
            return true;
        }

        const slideX = this.position.clone(); slideX.x = newPos.x;
        if (!this.checkCollision(slideX)) {
            this.position.x = slideX.x;
            return true;
        }

        const slideZ = this.position.clone(); slideZ.z = newPos.z;
        if (!this.checkCollision(slideZ)) {
            this.position.z = slideZ.z;
            return true;
        }
        return false;
    }

    botAI(deltaTime) {
        if (!this._stuckFrames) this._stuckFrames = 0;
        if (this.checkCollision(this.position)) {
            for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
                for (let r = 1; r <= 5; r++) {
                    const test = this.position.clone();
                    test.x += Math.cos(a) * r;
                    test.z += Math.sin(a) * r;
                    if (!this.checkCollision(test)) {
                        this.position.x = test.x;
                        this.position.z = test.z;
                        a = 999; break;
                    }
                }
            }
        }
        const allEnemies = [...gameState.bots, gameState.player].filter(p =>
            p && p !== this && p.team !== this.team && p.health > 0 && p.mesh.visible
        );
        let closestEnemy = null, closestDistance = Infinity;
        for (const enemy of allEnemies) {
            const d = this.position.distanceTo(enemy.position);
            if (d < closestDistance && d < 50) { closestDistance = d; closestEnemy = enemy; }
        }
        if (closestEnemy && closestDistance < 50) {

            const hasLOS = fogOfWar.isVisible(closestEnemy.position.x, closestEnemy.position.z);
            if (hasLOS && !this.checkCollision(closestEnemy.position)) {
                this.targetPosition = closestEnemy.position.clone();
                this._chaseDetour = false;
                this._stuckFrames = 0;
            } else if (!this._chaseDetour) {

                const toEnemy = new THREE.Vector3().subVectors(closestEnemy.position, this.position);
                const angle = Math.atan2(toEnemy.z, toEnemy.x);
                const side = (Math.random() < 0.5) ? 1 : -1;
                const detourAngle = angle + side * (Math.PI / 2 + Math.random() * 0.5);
                const detourDist = 15 + Math.random() * 15;
                this.targetPosition = new THREE.Vector3(
                    Math.max(-MAP_SIZE/2+5, Math.min(MAP_SIZE/2-5, this.position.x + Math.cos(detourAngle) * detourDist)),
                    0.5,
                    Math.max(-MAP_SIZE/2+5, Math.min(MAP_SIZE/2-5, this.position.z + Math.sin(detourAngle) * detourDist))
                );
                this._chaseDetour = true;
                this._stuckFrames = 0;
            }
        }
        if (!this.targetPosition || this.position.distanceTo(this.targetPosition) < 3) {
            this.targetPosition = this._pickExploreTarget();
            this._chaseDetour = false;
            this._stuckFrames = 0;
        }
        const direction = new THREE.Vector3().subVectors(this.targetPosition, this.position);
        direction.y = 0;
        const d = direction.length();
        if (d > 0.1) {
            direction.normalize();
            const speed = this.speed * deltaTime;
            this.velocity.copy(direction).multiplyScalar(speed);
            const newPos = this.position.clone().add(this.velocity);

            if (!this._tryMoveClient(newPos)) {
                this._stuckFrames++;
                if (this._stuckFrames > 8) {
                    this.targetPosition = this._pickExploreTarget();
                    this._stuckFrames = 0;
                } else {

                    const angle = Math.atan2(direction.z, direction.x);
                    const side = (this._stuckFrames % 2 === 0) ? 1 : -1;
                    const nudge = this.position.clone();
                    nudge.x += Math.cos(angle + side * Math.PI/2) * speed;
                    nudge.z += Math.sin(angle + side * Math.PI/2) * speed;
                    this._tryMoveClient(nudge);
                }
            } else {
                this._stuckFrames = 0;
            }
            this.position.y = this.getTerrainHeight(this.position.x, this.position.z);
        }
        if (closestEnemy) {
            this.weapon.lookAt(closestEnemy.position);
        } else if (this.targetPosition) {
            this.weapon.lookAt(this.targetPosition);
        }
    }

    getTerrainHeight(x, z) {

        const height = Math.sin(x * 0.1) * Math.cos(z * 0.1) * 2;
        return height + 0.6; // Add character offset
    }

    move(direction, deltaTime) {
        this.velocity.copy(direction).normalize().multiplyScalar(this.speed * deltaTime);

        const newPos = this.position.clone().add(this.velocity);
        if (!this.checkCollision(newPos)) {
            this.position.x = newPos.x;
            this.position.z = newPos.z;
            this.position.y = this.getTerrainHeight(this.position.x, this.position.z);
        }
    }

    moveTowards(target, deltaTime) {
        const direction = new THREE.Vector3().subVectors(target, this.position);
        direction.y = 0;
        const distance = direction.length();

        if (distance < 0.5) {
            return true; // Reached target
        }

        direction.normalize();
        const speed = this.speed * deltaTime;
        this.velocity.copy(direction).multiplyScalar(speed);

        const newPos = this.position.clone().add(this.velocity);

        if (!this.checkCollision(newPos)) {

            this.position.x = newPos.x;
            this.position.z = newPos.z;
        } else {
            const slideX = this.position.clone();
            slideX.x += this.velocity.x;
            if (!this.checkCollision(slideX)) {
                this.position.x = slideX.x;
            } else {

                const slideZ = this.position.clone();
                slideZ.z += this.velocity.z;
                if (!this.checkCollision(slideZ)) {
                    this.position.z = slideZ.z;
                } else {

                    const angle1 = Math.atan2(direction.z, direction.x) + Math.PI / 4;
                    const alt1 = this.position.clone();
                    alt1.x += Math.cos(angle1) * speed;
                    alt1.z += Math.sin(angle1) * speed;

                    const angle2 = Math.atan2(direction.z, direction.x) - Math.PI / 4;
                    const alt2 = this.position.clone();
                    alt2.x += Math.cos(angle2) * speed;
                    alt2.z += Math.sin(angle2) * speed;

                    if (!this.checkCollision(alt1)) {
                        this.position.x = alt1.x;
                        this.position.z = alt1.z;
                    } else if (!this.checkCollision(alt2)) {
                        this.position.x = alt2.x;
                        this.position.z = alt2.z;
                    }

                }
            }
        }

        this.position.y = this.getTerrainHeight(this.position.x, this.position.z);
        if (this.rifleGroup) {
            const lookTarget = this.position.clone().add(direction.multiplyScalar(5));
            this.rifleGroup.lookAt(lookTarget);
        }

        return false;
    }

    checkCollision(newPos) {

        if (Math.abs(newPos.x) > MAP_SIZE / 2 - 2 || Math.abs(newPos.z) > MAP_SIZE / 2 - 2) {
            return true;
        }
        const dir = new THREE.Vector3().subVectors(newPos, this.position);
        if (dir.length() < 0.001) return false;
        dir.normalize();

        if (!gameState._wallObjects || gameState._wallCacheFrame !== gameState._frame) {
            gameState._wallObjects = [];
            scene.traverse(child => {
                if (child.userData.isWall) gameState._wallObjects.push(child);
            });
            gameState._wallCacheFrame = gameState._frame;
        }

        const raycaster = new THREE.Raycaster();
        raycaster.set(this.position, dir);
        const intersects = raycaster.intersectObjects(gameState._wallObjects, false);

        for (let intersect of intersects) {
            if (intersect.distance < 1.5) {
                return true;
            }
        }
        if (!this.isPlayer) {
            for (const other of gameState.bots) {
                if (other === this || other.health <= 0) continue;
                const dist = newPos.distanceTo(other.position);
                if (dist < 1.2) return true; // Don't walk into other bots
            }
        }

        return false;
    }

    shoot(target) {

        if (this.health <= 0) return;
        if (!target || target.health <= 0) return;

        const distance = this.position.distanceTo(target.position);
        if (distance > this.shootRange) return;
        const raycaster = new THREE.Raycaster();
        const eyePos = this.position.clone();
        eyePos.y += 1.0;
        const targetChest = target.position.clone();
        targetChest.y += 1.0;
        const direction = new THREE.Vector3().subVectors(targetChest, eyePos).normalize();
        raycaster.set(eyePos, direction);

        const intersects = raycaster.intersectObjects(gameState._wallObjects || [], false);
        for (let intersect of intersects) {
            if (intersect.distance < distance) {
                return; // Wall blocking
            }
        }
        audioManager.play('sniperFire');
        this.createShootingEffect(target.position);
        target.takeDamage(999, this);
    }

    createShootingEffect(targetPos) {

        if (this.weapon) {
            const originalPos = this.weapon.position.clone();
            const originalRot = this.weapon.rotation.clone();
            this.weapon.position.z -= 0.8;
            this.weapon.rotation.x -= 0.3;
            this.weapon.position.y -= 0.2;
            const originalCharPos = this.mesh.position.clone();
            this.mesh.position.z -= 0.3;

            setTimeout(() => {
                if (this.weapon) {
                    this.weapon.position.copy(originalPos);
                    this.weapon.rotation.copy(originalRot);
                }
                this.mesh.position.copy(originalCharPos);
            }, 150);
        }
        const muzzleOffset = new THREE.Vector3(0, 0, 2.5);
        if (this.weapon) {
            muzzleOffset.applyQuaternion(this.weapon.quaternion);
        }
        const muzzlePos = this.position.clone().add(muzzleOffset);
        muzzlePos.y += 0.5;
        const flashGeometry = new THREE.SphereGeometry(2, 12, 12);
        const flashMaterial = new THREE.MeshBasicMaterial({
            color: 0xffdd00,
            transparent: true,
            opacity: 1
        });
        const flash = new THREE.Mesh(flashGeometry, flashMaterial);
        flash.position.copy(muzzlePos);
        scene.add(flash);
        const flash2Geometry = new THREE.SphereGeometry(3, 12, 12);
        const flash2Material = new THREE.MeshBasicMaterial({
            color: 0xff6600,
            transparent: true,
            opacity: 0.6
        });
        const flash2 = new THREE.Mesh(flash2Geometry, flash2Material);
        flash2.position.copy(muzzlePos);
        scene.add(flash2);
        const flashLight = new THREE.PointLight(0xffaa00, 10, 40);
        flashLight.position.copy(muzzlePos);
        scene.add(flashLight);
        for (let i = 0; i < 3; i++) {
            setTimeout(() => {
                const ringGeometry = new THREE.RingGeometry(0.5, 1, 16);
                const ringMaterial = new THREE.MeshBasicMaterial({
                    color: 0xaaaaaa,
                    transparent: true,
                    opacity: 0.9,
                    side: THREE.DoubleSide
                });
                const ring = new THREE.Mesh(ringGeometry, ringMaterial);
                ring.position.copy(muzzlePos);
                ring.lookAt(targetPos);
                scene.add(ring);
                let ringScale = 1 + i * 0.5;
                const ringInterval = setInterval(() => {
                    ringScale += 0.8;
                    ring.scale.set(ringScale, ringScale, 1);
                    ringMaterial.opacity -= 0.08;
                    if (ringMaterial.opacity <= 0) {
                        clearInterval(ringInterval);
                        scene.remove(ring);
                        ringGeometry.dispose();
                        ringMaterial.dispose();
                    }
                }, 30);
            }, i * 30);
        }
        for (let i = 0; i < 8; i++) {
            const smokeGeometry = new THREE.SphereGeometry(0.3, 6, 6);
            const smokeMaterial = new THREE.MeshBasicMaterial({
                color: 0x666666,
                transparent: true,
                opacity: 0.7
            });
            const smoke = new THREE.Mesh(smokeGeometry, smokeMaterial);
            smoke.position.copy(muzzlePos);
            smoke.position.x += (Math.random() - 0.5) * 2;
            smoke.position.y += (Math.random() - 0.5) * 2;
            smoke.position.z += (Math.random() - 0.5) * 2;
            scene.add(smoke);

            let smokeScale = 1;
            const smokeInterval = setInterval(() => {
                smokeScale += 0.2;
                smoke.scale.set(smokeScale, smokeScale, smokeScale);
                smoke.position.y += 0.1;
                smokeMaterial.opacity -= 0.05;
                if (smokeMaterial.opacity <= 0) {
                    clearInterval(smokeInterval);
                    scene.remove(smoke);
                    smokeGeometry.dispose();
                    smokeMaterial.dispose();
                }
            }, 40);
        }
        setTimeout(() => {
            scene.remove(flash);
            scene.remove(flash2);
            scene.remove(flashLight);
            flashGeometry.dispose();
            flashMaterial.dispose();
            flash2Geometry.dispose();
            flash2Material.dispose();
        }, 80);
        const bulletGeometry = new THREE.BufferGeometry().setFromPoints([
            muzzlePos.clone(),
            targetPos.clone()
        ]);
        const bulletMaterial = new THREE.LineBasicMaterial({
            color: this.team === 'red' ? 0xff0000 : 0x0088ff,
            linewidth: 5
        });
        const bullet = new THREE.Line(bulletGeometry, bulletMaterial);
        scene.add(bullet);
        for (let i = 1; i <= 3; i++) {
            const tracerGeometry = new THREE.BufferGeometry().setFromPoints([
                muzzlePos.clone(),
                targetPos.clone()
            ]);
            const tracerMaterial = new THREE.LineBasicMaterial({
                color: this.team === 'red' ? 0xffaaaa : 0xaaccff,
                transparent: true,
                opacity: 0.8 - (i * 0.2),
                linewidth: 8 - (i * 2)
            });
            const tracer = new THREE.Line(tracerGeometry, tracerMaterial);
            scene.add(tracer);

            setTimeout(() => {
                scene.remove(tracer);
                tracerGeometry.dispose();
                tracerMaterial.dispose();
            }, 200);
        }

        setTimeout(() => {
            scene.remove(bullet);
            bulletGeometry.dispose();
            bulletMaterial.dispose();
        }, 200);
        if (this.isPlayer) {
            this.cameraShake();
        }
        this.createImpactEffect(targetPos);
    }

    createImpactEffect(pos) {

        const impactGeometry = new THREE.SphereGeometry(3, 12, 12);
        const impactMaterial = new THREE.MeshBasicMaterial({
            color: 0xff4400,
            transparent: true,
            opacity: 1
        });
        const impact = new THREE.Mesh(impactGeometry, impactMaterial);
        impact.position.copy(pos);
        scene.add(impact);
        const impact2Geometry = new THREE.SphereGeometry(4, 12, 12);
        const impact2Material = new THREE.MeshBasicMaterial({
            color: 0xff6600,
            transparent: true,
            opacity: 0.7
        });
        const impact2 = new THREE.Mesh(impact2Geometry, impact2Material);
        impact2.position.copy(pos);
        scene.add(impact2);
        const impactLight = new THREE.PointLight(0xff4400, 15, 50);
        impactLight.position.copy(pos);
        scene.add(impactLight);
        for (let i = 0; i < 3; i++) {
            setTimeout(() => {
                const shockGeometry = new THREE.RingGeometry(1, 2, 24);
                const shockMaterial = new THREE.MeshBasicMaterial({
                    color: 0xff8800,
                    transparent: true,
                    opacity: 0.8,
                    side: THREE.DoubleSide
                });
                const shock = new THREE.Mesh(shockGeometry, shockMaterial);
                shock.position.copy(pos);
                shock.rotation.x = -Math.PI / 2;
                scene.add(shock);

                let shockScale = 1;
                const shockInterval = setInterval(() => {
                    shockScale += 1.2;
                    shock.scale.set(shockScale, shockScale, 1);
                    shockMaterial.opacity -= 0.1;
                    if (shockMaterial.opacity <= 0) {
                        clearInterval(shockInterval);
                        scene.remove(shock);
                        shockGeometry.dispose();
                        shockMaterial.dispose();
                    }
                }, 30);
            }, i * 40);
        }
        for (let i = 0; i < 12; i++) {
            const debrisGeometry = new THREE.SphereGeometry(0.2, 4, 4);
            const debrisMaterial = new THREE.MeshBasicMaterial({
                color: 0xff3300,
                transparent: true,
                opacity: 1
            });
            const debris = new THREE.Mesh(debrisGeometry, debrisMaterial);
            debris.position.copy(pos);

            const angle = (i / 12) * Math.PI * 2;
            const speed = 0.3 + Math.random() * 0.3;
            const vx = Math.cos(angle) * speed;
            const vy = 0.3 + Math.random() * 0.3;
            const vz = Math.sin(angle) * speed;

            scene.add(debris);

            let life = 0;
            const debrisInterval = setInterval(() => {
                life += 0.05;
                debris.position.x += vx;
                debris.position.y += vy - (life * 0.3); // Gravity
                debris.position.z += vz;
                debrisMaterial.opacity -= 0.05;

                if (debrisMaterial.opacity <= 0 || life > 1) {
                    clearInterval(debrisInterval);
                    scene.remove(debris);
                    debrisGeometry.dispose();
                    debrisMaterial.dispose();
                }
            }, 30);
        }
        let impactScale = 1;
        const impactInterval = setInterval(() => {
            impactScale += 0.8;
            impact.scale.set(impactScale, impactScale, impactScale);
            impact2.scale.set(impactScale * 1.2, impactScale * 1.2, impactScale * 1.2);
            impactMaterial.opacity -= 0.12;
            impact2Material.opacity -= 0.1;
            if (impactMaterial.opacity <= 0) {
                clearInterval(impactInterval);
                scene.remove(impact);
                scene.remove(impact2);
                scene.remove(impactLight);
                impactGeometry.dispose();
                impactMaterial.dispose();
                impact2Geometry.dispose();
                impact2Material.dispose();
            }
        }, 30);
    }

    cameraShake() {
        const shakeIntensity = 0.8; // Much more intense!
        const shakeDuration = 300; // Longer duration
        const startTime = Date.now();

        const originalCameraTarget = gameState.cameraTarget.clone();

        const shakeInterval = setInterval(() => {
            const elapsed = Date.now() - startTime;
            const progress = elapsed / shakeDuration;

            if (progress >= 1) {
                clearInterval(shakeInterval);
                gameState.cameraTarget.copy(originalCameraTarget);
            } else {
                const intensity = shakeIntensity * (1 - progress);
                gameState.cameraTarget.x = originalCameraTarget.x + (Math.random() - 0.5) * intensity;
                gameState.cameraTarget.z = originalCameraTarget.z + (Math.random() - 0.5) * intensity;
            }
        }, 16);
    }

    takeDamage(damage, attacker) {

        if (isOnlineMode) return;

        if (this._spawnProtection > 0) return;

        if (this.hasShield) {
            this.hasShield = false;
            delete this.inventory['shield'];
            if (this.isPlayer) showStreakPopup('SHIELD BLOCKED!', '#44aaff');
            return;
        }

        if (this.isPlayer && gameState.debug.godMode) return;

        this.die(attacker);
    }

    die(killer) {

        if (this.health <= 0) return;

        this.health = 0; // Set health to 0 immediately
        this.deaths++;

        if (killer) {
            killer.kills++;
            let hasSpecial = false;
            if (!gameState.firstBlood) {
                gameState.firstBlood = true;
                audioManager.play('firstBlood');
                if (killer.isPlayer) showStreakPopup('FIRST BLOOD', '#ff4444');
                hasSpecial = true;
            }
            const baseGold = 50;
            const streakBonus = (killer._streak || 0) * 10;
            const victimBonus = Math.round(this.price * 10);
            killer.earnGold(baseGold + streakBonus + victimBonus);
            const pumpAmount = 0.5 + this.price * 0.3;
            killer.price += pumpAmount;
            if (killer.isPlayer) pumpPrice(pumpAmount);
            if (killer.isPlayer) {
                gameState.kills = killer.kills;
                document.getElementById('killCount').textContent = `Kills: ${gameState.kills}`;
                gameState.killStreak++;
                const streak = gameState.killStreak;
                const streakMap = {
                    5: ['killingSpree', 'KILLING SPREE', '#ff8800'],
                    10: ['rampage', 'RAMPAGE', '#ff4400'],
                    15: ['dominating', 'DOMINATING', '#ff0044'],
                    20: ['unstoppable', 'UNSTOPPABLE', '#cc00ff'],
                    25: ['godlike', 'GODLIKE', '#ffdd00'],
                };
                if (streakMap[streak]) {
                    audioManager.play(streakMap[streak][0]);
                    showStreakPopup(streakMap[streak][1], streakMap[streak][2]);
                    hasSpecial = true;
                }
                if (gameState.multiKillTimer > 0) {
                    gameState.multiKillCount++;
                } else {
                    gameState.multiKillCount = 1;
                }
                gameState.multiKillTimer = 4.0;

                const mk = gameState.multiKillCount;
                const multiMap = {
                    2: ['doubleKill', 'DOUBLE KILL', '#44ffaa'],
                    3: ['multiKill', 'MULTI KILL', '#44ddff'],
                    4: ['megaKill', 'MEGA KILL', '#4488ff'],
                    5: ['ultraKill', 'ULTRA KILL', '#aa44ff'],
                    6: ['monsterKill', 'MONSTER KILL', '#ff44aa'],
                };
                if (mk >= 7) {
                    audioManager.play('ludicrousKill');
                    showStreakPopup('LUDICROUS KILL', '#ff0000');
                    hasSpecial = true;
                } else if (multiMap[mk]) {
                    audioManager.play(multiMap[mk][0]);
                    showStreakPopup(multiMap[mk][1], multiMap[mk][2]);
                    hasSpecial = true;
                }
                audioManager.play('headshot');

            } else {
                if (!killer._streak) killer._streak = 0;
                killer._streak++;
                const bs = killer._streak;
                const botStreakSounds = { 5: 'killingSpree', 10: 'rampage', 15: 'dominating', 20: 'unstoppable', 25: 'godlike' };
                if (botStreakSounds[bs]) audioManager.play(botStreakSounds[bs]);
            }
            addKillFeed(killer.username, this.username);
        }
        this.inventory = {};
        this._applyItems();
        this.price = Math.max(0.10, this.price * 0.5);
        if (this.isPlayer) {
            gameState.killStreak = 0;
            resetStreakChart();
            gameState.gold = this.gold;
            updateGoldUI();
        }
        this._streak = 0;
        if (this.isPlayer) {
            gameState.deaths++;
            document.getElementById('deathCount').textContent = `Deaths: ${gameState.deaths}`;
            gameState.moveTarget = null;
            gameState.targetLock = null;
            const popup = document.getElementById('deathPopup');
            const killerName = killer ? killer.username : 'the darkness';
            let killerItems = '';
            if (killer && Object.keys(killer.inventory).length > 0) {
                const items = Object.keys(killer.inventory).map(id => {
                    const item = SHOP_ITEMS[id];
                    return item ? `${item.icon} ${item.name}` : '';
                }).filter(Boolean).join('  ');
                killerItems = `\n${items}`;
            }
            document.getElementById('deathKiller').innerHTML =
                `Killed by ${killerName}` +
                (killerItems ? `<div style="margin-top:0.3rem;font-size:0.7rem;color:#ffd700;">${killerItems}</div>` : '');

            popup.classList.add('hidden');
            void popup.offsetHeight;
            popup.classList.remove('hidden');

            setTimeout(() => popup.classList.add('hidden'), 5000);
        }
        this.mesh.visible = false;
        this.targetPosition = null;
        this.attackWalkTarget = null;
        setTimeout(() => this.respawn(), 5000);
    }

    respawn() {
        this.health = this.maxHealth;
        this._spawnProtection = 3.0; // 3 seconds invulnerable
        this.velocity.set(0, 0, 0);
        this.targetPosition = null;
        this.attackWalkTarget = null;
        if (this.isPlayer) gameState.moveTarget = null;

        if (this.team === 'red') {
            const x = -70 + Math.random() * 10 - 5;
            const z = -70 + Math.random() * 10 - 5;
            this.position.set(x, this.getTerrainHeight(x, z), z);
        } else {
            const x = 70 + Math.random() * 10 - 5;
            const z = 70 + Math.random() * 10 - 5;
            this.position.set(x, this.getTerrainHeight(x, z), z);
        }

        this.mesh.visible = true;

        if (this.isPlayer) {

        } else {

            this._botShop();
        }
    }

    _botShop() {
        const priorities = ['boots1', 'scope1', 'shield', 'rapidfire', 'boots2', 'scope2', 'bounty', 'cloak1'];
        for (const id of priorities) {
            const item = SHOP_ITEMS[id];
            if (!item) continue;
            if (this.inventory[id] && !item.stackable) continue;
            if (item.requires && !this.inventory[item.requires]) continue;
            if (this.gold >= item.cost) {
                this.gold -= item.cost;
                this.inventory[id] = true;
                this._applyItems();
            }
        }
    }

    earnGold(amount) {
        const earned = Math.round(amount * this.goldMultiplier);
        this.gold += earned;
        if (this.isPlayer) {
            gameState.gold = this.gold;
            updateGoldUI();

            showGoldPopup(`+${earned}g`);
        }
    }

    buyItem(itemId) {
        const item = SHOP_ITEMS[itemId];
        if (!item) return false;
        if (this.gold < item.cost) return false;
        if (this.inventory[itemId] && !item.stackable) return false;
        if (item.requires && !this.inventory[item.requires]) return false;

        this.gold -= item.cost;
        this.inventory[itemId] = true;
        if (this.isPlayer) gameState.gold = this.gold;

        this._applyItems();
        updateGoldUI();
        updateShopUI();
        return true;
    }

    _applyItems() {

        this.normalSpeed = this.baseSpeed;
        this.shootRange = this.baseRange;
        this.shootCooldownTime = this.baseCooldown;
        this.goldMultiplier = 1.0;
        this.hasShield = false;
        for (const id of Object.keys(this.inventory)) {
            const item = SHOP_ITEMS[id];
            if (!item) continue;

            if (item.stat === 'speed') this.normalSpeed = this.baseSpeed * item.mult;
            if (item.stat === 'range') this.shootRange = this.baseRange * item.mult;
            if (item.stat === 'firerate') this.shootCooldownTime = this.baseCooldown * item.mult;
            if (item.stat === 'goldMult') this.goldMultiplier *= item.mult;
            if (item.stat === 'shield') this.hasShield = true;
        }
        this.speed = this.normalSpeed;
        this.windwalkSpeed = this.normalSpeed * 1.75;
    }

    isNearSpawn() {
        const spawnX = this.team === 'red' ? -70 : 70;
        const spawnZ = this.team === 'red' ? -70 : 70;
        const dx = this.position.x - spawnX;
        const dz = this.position.z - spawnZ;
        return Math.sqrt(dx*dx + dz*dz) < 15;
    }
}
function updateGoldUI() {
    const el = document.getElementById('goldCount');
    if (el) el.textContent = gameState.gold;
}

let _playerPrice = 1.00;
let _priceHistory = [1.00];
let _startPrice = 1.00;
function updateTerminal() {}
function drawHudChart() {}
function pumpPrice() {}
function dumpPrice() {}
function spawnFlyingCandle() {}
function resetStreakChart() {}
function drawDeathChart() {}
function showStreakPopup(text, color) {
    const popup = document.getElementById('streakPopup');
    if (!popup) return;
    popup.innerHTML = `<div class="streak-text" style="color:${color || '#fff'}">${text}</div>`;
}
function updateShopUI() {
    const gold = gameState.gold || 0;
    const shopGold = document.getElementById('shopGold');
    if (shopGold) shopGold.textContent = `Gold: ${gold}`;
    const itemsEl = document.getElementById('shopItems');
    if (!itemsEl || !gameState.player) return;
    let html = '';
    Object.entries(SHOP_ITEMS).forEach(([id, item]) => {
        const owned = gameState.player.inventory && gameState.player.inventory[id];
        const canAfford = gold >= item.cost;
        const locked = item.requires && !(gameState.player.inventory && gameState.player.inventory[item.requires]);
        let status = '';
        if (owned && !item.stackable) status = ' [OWNED]';
        else if (locked) status = ' [LOCKED]';
        else if (!canAfford) status = ' [NEED GOLD]';
        const dimClass = (owned && !item.stackable) || locked || !canAfford ? 'opacity:0.4;' : 'cursor:pointer;';
        html += `<div class="shop-item" data-item="${id}" style="${dimClass}">
            <span class="shop-icon">${item.icon}</span>
            <span class="shop-name">${item.name}</span>
            <span class="shop-cost">${item.cost}g</span>
            <span class="shop-desc">${item.desc}${status}</span>
        </div>`;
    });
    itemsEl.innerHTML = html;
    itemsEl.querySelectorAll('.shop-item').forEach(el => {
        el.addEventListener('click', () => {
            const itemId = el.dataset.item;
            if (gameState.player && gameState.player.buyItem) gameState.player.buyItem(itemId);
        });
    });
}
function checkShopProximity() {

    if (!gameState.player || gameState.player.health <= 0) return;
    const shopBtn = document.querySelector('#shopBtn');
    if (shopBtn) shopBtn.style.opacity = '1';
}
function showGoldPopup(text) {

    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;top:40%;left:50%;transform:translate(-50%,-50%);color:#ffd700;font-family:Oswald,sans-serif;font-size:1.5rem;font-weight:700;pointer-events:none;z-index:9999;text-shadow:0 0 10px rgba(255,215,0,0.5);animation:goldFloat 1s ease-out forwards;';
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1000);
}

/* --- REMOVED: updateTerminal, drawHudChart, pumpPrice, dumpPrice,
   spawnFlyingCandle, resetStreakChart, drawDeathChart, flying candle system,
   price tracking chart code --- */

/* Old price/candle/chart code removed — block starts here
if (false) {
    const pct = ((_playerPrice - _startPrice) / _startPrice * 100);
    const el = document.getElementById('price');
    if (el) el.textContent = _playerPrice.toFixed(2);
    const pctEl = document.getElementById('pctChange');
    if (pctEl) {
        pctEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
        pctEl.style.color = pct >= 0 ? '#00ff44' : '#ff4444';
    }
    drawHudChart();
}

function drawHudChart() {
    const canvas = document.getElementById('hudChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (_priceHistory.length < 2) return;

    const prices = _priceHistory.slice(-60); // Last 60 data points
    const min = Math.min(...prices) * 0.95;
    const max = Math.max(...prices) * 1.05;
    const range = max - min || 1;
    ctx.beginPath();
    ctx.strokeStyle = _playerPrice >= _startPrice ? '#00ff44' : '#ff4444';
    ctx.lineWidth = 1.5;
    prices.forEach((p, i) => {
        const x = (i / (prices.length - 1)) * w;
        const y = h - ((p - min) / range) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.stroke();
    const lastX = w;
    const lastY = h - ((prices[prices.length - 1] - min) / range) * h;
    ctx.lineTo(lastX, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = _playerPrice >= _startPrice ? 'rgba(0,255,68,0.08)' : 'rgba(255,68,68,0.08)';
    ctx.fill();
}

function pumpPrice(amount) {
    if (gameState.player) _playerPrice = gameState.player.price;
    else _playerPrice += amount;
    _priceHistory.push(_playerPrice);
    updateTerminal();
}

function dumpPrice() {
    if (gameState.player) _playerPrice = gameState.player.price;
    else _playerPrice = Math.max(0.10, _playerPrice * 0.5);
    _priceHistory.push(_playerPrice);
    updateTerminal();
}
let _activeCandle = null;
let _candleHoldTimer = null;
let _streakCandleActive = false; // Prevents green candle from overriding streak candles

function spawnFlyingCandle(text, color, boost) {

    if (_activeCandle) {
        const old = _activeCandle;
        clearTimeout(_candleHoldTimer);
        old.style.transition = 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
        const chart = document.getElementById('hudChart');
        if (chart) {
            const rect = chart.getBoundingClientRect();
            old.style.left = rect.left + rect.width / 2 + 'px';
            old.style.top = rect.top + rect.height / 2 + 'px';
            old.style.transform = 'translate(-50%, -50%) scale(0.2)';
            old.style.opacity = '0';
        }
        setTimeout(() => old.remove(), 500);
        _activeCandle = null;
    }

    const candle = document.createElement('div');
    candle.className = 'flying-candle';

    const bodyH = Math.min(30 + boost * 3, 120);
    const wickH = Math.round(bodyH * 0.35);
    const bodyW = Math.min(16 + boost * 1.5, 40);
    const glowSize = Math.min(bodyH, 60);
    let particles = '';
    const numParticles = Math.floor(6 + boost);
    for (let i = 0; i < numParticles; i++) {
        const angle = (i / numParticles) * 360;
        const dist = 15 + Math.random() * 30;
        const size = 2 + Math.random() * 4;
        const delay = Math.random() * 0.4;
        const dur = 0.5 + Math.random() * 0.3;
        particles += `<div style="position:absolute;width:${size}px;height:${size}px;background:${color};border-radius:50%;box-shadow:0 0 ${size*2}px ${color};left:50%;top:50%;opacity:0;animation:particleBurst ${dur}s ${delay}s ease-out forwards;transform:translate(-50%,-50%) rotate(${angle}deg) translateY(-${dist}px);"></div>`;
    }

    candle.innerHTML = `
        <div style="position:relative;display:flex;flex-direction:column;align-items:center;">
            ${particles}
            <div style="width:3px;height:${wickH}px;background:linear-gradient(to top,${color},${color}cc);box-shadow:0 0 6px ${color};"></div>
            <div style="width:${bodyW}px;height:${bodyH}px;background:linear-gradient(to top,${color}cc,${color});border-radius:2px;box-shadow:0 0 ${glowSize}px ${color},0 0 ${glowSize*2}px ${color}44;animation:candleGrow 0.12s cubic-bezier(0,0.8,0.2,1.3) forwards;transform-origin:bottom;"></div>
            <div style="width:3px;height:${Math.round(wickH*0.3)}px;background:${color}88;margin-top:1px;"></div>
        </div>
        <div style="color:${color};font-size:clamp(1rem,4vw,1.8rem);font-weight:900;margin-top:8px;font-family:monospace;text-shadow:0 0 15px ${color},0 0 30px ${color}66;letter-spacing:0.05em;white-space:nowrap;">${text}</div>
    `;
    candle.style.left = '50%';
    candle.style.top = '35%';
    candle.style.transform = 'translate(-50%, -50%) scale(2.5)';
    candle.style.opacity = '1';
    candle.style.transition = 'transform 0.15s cubic-bezier(0,0.8,0.2,1.2)';
    document.body.appendChild(candle);
    _activeCandle = candle;
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            candle.style.transform = 'translate(-50%, -50%) scale(1)';
        });
    });
    _candleHoldTimer = setTimeout(() => {
        if (_activeCandle !== candle) return; // Replaced by newer candle
        _activeCandle = null;
        candle.style.transition = 'all 0.6s cubic-bezier(0.4, 0, 0.2, 1)';
        const chart = document.getElementById('hudChart');
        if (chart) {
            const rect = chart.getBoundingClientRect();
            candle.style.left = rect.left + rect.width / 2 + 'px';
            candle.style.top = rect.top + rect.height / 2 + 'px';
            candle.style.transform = 'translate(-50%, -50%) scale(0.2)';
            candle.style.opacity = '0';
        }
        setTimeout(() => candle.remove(), 700);
    }, 1000);
}

function showGoldPopup(text) {
    const boost = parseFloat(text.replace(/[^0-9.]/g, '')) / 50 || 0.5;
    pumpPrice(boost);

    if (!_streakCandleActive) {
        spawnFlyingCandle(text, '#00ff44', boost * 8);
    }
}

function drawDeathChart() {
    const canvas = document.getElementById('deathChart');
    if (!canvas || _priceHistory.length < 2) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const prices = _priceHistory.slice(-60);
    const min = Math.min(...prices) * 0.9;
    const max = Math.max(...prices) * 1.1;
    const range = max - min || 1;
    const toX = (i) => (i / (prices.length - 1)) * w;
    const toY = (p) => h - ((p - min) / range) * h;
    const crashIdx = Math.max(1, prices.length - 3);
    ctx.beginPath();
    ctx.strokeStyle = '#00ff44';
    ctx.lineWidth = 2;
    for (let i = 0; i <= crashIdx && i < prices.length; i++) {
        if (i === 0) ctx.moveTo(toX(i), toY(prices[i]));
        else ctx.lineTo(toX(i), toY(prices[i]));
    }
    ctx.stroke();
    ctx.lineTo(toX(crashIdx), h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,255,68,0.06)';
    ctx.fill();
    if (prices.length > crashIdx) {
        ctx.beginPath();
        ctx.strokeStyle = '#ff2222';
        ctx.lineWidth = 2.5;
        ctx.moveTo(toX(crashIdx), toY(prices[crashIdx]));
        for (let i = crashIdx + 1; i < prices.length; i++) {
            ctx.lineTo(toX(i), toY(prices[i]));
        }
        ctx.stroke();
        ctx.lineTo(toX(prices.length - 1), h);
        ctx.lineTo(toX(crashIdx), h);
        ctx.closePath();
        ctx.fillStyle = 'rgba(255,34,34,0.12)';
        ctx.fill();
    }
}

function resetStreakChart() {
    dumpPrice();
}

function updateShopUI() {
    const panel = document.getElementById('shopPanel');
    if (!panel || !gameState.player) return;


    const inv = gameState.player.inventory;
    const gold = gameState.player.gold;
    const shopGold = document.getElementById('shopGold');
    if (shopGold) shopGold.textContent = `Gold: ${gold}`;

    let html = '';
    for (const [id, item] of Object.entries(SHOP_ITEMS)) {
        const owned = inv[id] && !item.stackable;
        const canAfford = gold >= item.cost;
        const needsReq = item.requires && !inv[item.requires];
        const disabled = owned || !canAfford || needsReq;

        let status = '';
        if (owned) status = ' owned';
        else if (needsReq) status = ` (need ${SHOP_ITEMS[item.requires].name})`;
        else if (!canAfford) status = ' (need coins)';

        html += `<div class="shop-item${disabled ? ' disabled' : ''}" data-item="${id}">
            <span class="shop-icon">${item.icon}</span>
            <span class="shop-name">${item.name}</span>
            <span class="shop-cost">${item.cost}g</span>
            <span class="shop-desc">${item.desc}${status}</span>
        </div>`;
    }
    document.getElementById('shopItems').innerHTML = html;
    panel.querySelectorAll('.shop-item:not(.disabled)').forEach(el => {
        el.onclick = () => {
            const itemId = el.dataset.item;
            if (gameState.player.buyItem(itemId)) {
                audioManager.play('headshot'); // Reuse as buy sound
                showGoldPopup(`Bought ${SHOP_ITEMS[itemId].name}!`);
            }
        };
    });
}
function checkShopProximity() {}
function showStreakPopup(text, color) {
    const boosts = {
        'FIRST BLOOD':2, 'KILLING SPREE':3, 'RAMPAGE':5, 'DOMINATING':8,
        'UNSTOPPABLE':12, 'GODLIKE':20, 'DOUBLE KILL':2.5, 'MULTI KILL':4,
        'MEGA KILL':6, 'ULTRA KILL':9, 'MONSTER KILL':13, 'LUDICROUS KILL':25,
        'SHIELD BLOCKED!':0,
    };
    const boost = boosts[text] || 1;
    pumpPrice(boost);
    const flash = document.createElement('div');
    flash.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;background:${color};opacity:0.2;pointer-events:none;z-index:9998;animation:screenFlash 0.3s ease-out forwards;`;
    document.body.appendChild(flash);
    setTimeout(() => flash.remove(), 400);
    _streakCandleActive = true;
    spawnFlyingCandle(text, color, boost * 5);
End of removed price code block */

function addKillFeed(killer, victim) {
    const killFeed = document.getElementById('killFeed');
    const message = document.createElement('div');
    const isPlayerKill = gameState.player && killer === gameState.player.username;
    const isPlayerDeath = gameState.player && victim === gameState.player.username;
    message.className = 'kill-message ' + (isPlayerKill ? 'buy' : isPlayerDeath ? 'sell' : '');
    message.textContent = isPlayerKill ? `${killer} killed ${victim}`
        : isPlayerDeath ? `${killer} killed ${victim}`
        : `${killer} > ${victim}`;
    killFeed.appendChild(message);

    setTimeout(() => message.remove(), 3000);
}

function updateScoreboard() {
    const sb = document.getElementById('scoreboard');
    if (!sb || sb.classList.contains('hidden')) return;
    const all = [];
    if (isOnlineMode) {

        _remotePlayers.forEach(r => all.push(r.player));
        if (gameState.player) all.push(gameState.player);
    } else {

        all.push(...gameState.bots);
        if (gameState.player) all.push(gameState.player);
    }
    all.sort((a, b) => b.kills - a.kills);
    all.forEach(p => {
        if (!p._priceHist) p._priceHist = [1.0];
        if (p._priceHist[p._priceHist.length - 1] !== p.price) {
            p._priceHist.push(p.price);
        }
        if (p._priceHist.length > 30) p._priceHist.shift();
    });

    let html = `<div class="sb-table-wrap">
        <div class="sb-title">SCOREBOARD</div>
        <table class="sb-table">
            <tr><th>#</th><th>PLAYER</th><th>KILLS</th><th>DEATHS</th><th>GOLD</th></tr>
    `;

    all.forEach((p, i) => {
        const isMe = p === gameState.player;
        const teamClass = p.team === 'red' ? 'sb-team-red' : 'sb-team-blue';

        html += `<tr class="sb-row ${teamClass} ${isMe ? 'me' : ''}">
            <td style="color:#555;">${i + 1}</td>
            <td class="sb-ticker">${p.username}</td>
            <td style="color:#00ff66;font-weight:600;">${p.kills}</td>
            <td style="color:#ff3344;font-weight:600;">${p.deaths}</td>
            <td style="color:#ffd700;">${p.gold || 0}</td>
        </tr>`;
    });

    html += '</table>';
    html += '<div style="color:#444;font-size:0.6rem;margin-top:0.8rem;text-align:center;">TAB to close</div>';
    html += '</div>';
    sb.innerHTML = html;
    sb.querySelectorAll('.sb-chart').forEach(canvas => {
        const idx = parseInt(canvas.dataset.playerIdx, 10);
        const p = all[idx];
        if (!p || !p._priceHist || p._priceHist.length < 2) return;

        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        const prices = p._priceHist;
        const min = Math.min(...prices) * 0.9;
        const max = Math.max(...prices) * 1.1;
        const range = max - min || 1;
        const up = prices[prices.length - 1] >= prices[0];

        ctx.beginPath();
        ctx.strokeStyle = up ? '#00ff44' : '#ff4444';
        ctx.lineWidth = 1.5;
        prices.forEach((pr, i) => {
            const x = (i / (prices.length - 1)) * w;
            const y = h - ((pr - min) / range) * h;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();
    });
}
function useWindwalk() {
    const ability = gameState.abilities.windwalk;
    if (ability.cooldown > 0 || !gameState.player) return;

    gameState.player.isWindwalking = true;
    ability.active = true;
    ability.cooldown = ability.maxCooldown;

    setTimeout(() => {
        if (gameState.player) {
            gameState.player.isWindwalking = false;
        }
        ability.active = false;
    }, ability.duration * 1000);
}

function useFarsight() {
    const ability = gameState.abilities.farsight;
    if (ability.cooldown > 0 || !gameState.player) return;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(gameState.mousePos, camera);

    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const intersectPoint = new THREE.Vector3();
    raycaster.ray.intersectPlane(plane, intersectPoint);
    const farsightGeometry = new THREE.CircleGeometry(2, 32);
    const farsightMaterial = new THREE.MeshBasicMaterial({
        color: 0x00ff00,
        transparent: true,
        opacity: 0.5
    });
    const farsightMesh = new THREE.Mesh(farsightGeometry, farsightMaterial);
    farsightMesh.rotation.x = -Math.PI / 2;
    farsightMesh.position.copy(intersectPoint);
    farsightMesh.position.y = 0.15;
    scene.add(farsightMesh);

    gameState.player.farsightActive = true;
    gameState.player.farsightPosition = intersectPoint.clone();
    ability.active = true;
    ability.cooldown = ability.maxCooldown;

    setTimeout(() => {
        scene.remove(farsightMesh);
        if (gameState.player) {
            gameState.player.farsightActive = false;
            gameState.player.farsightPosition = null;
        }
        ability.active = false;
    }, ability.duration * 1000);
}

function updateAbilityUI() {
    Object.keys(gameState.abilities).forEach(abilityName => {
        const ability = gameState.abilities[abilityName];
        const abilityEl = document.querySelector(`[data-ability="${abilityName}"]`);
        const cdEl = abilityEl.querySelector('.ability-cd');

        if (ability.cooldown > 0) {
            abilityEl.classList.add('cooldown');
            cdEl.textContent = Math.ceil(ability.cooldown) + 's';
        } else {
            abilityEl.classList.remove('cooldown');
            cdEl.textContent = '';
        }
    });
}
document.addEventListener('keydown', (e) => {

    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
        if (e.key === 'Escape') { active.blur(); e.preventDefault(); }
        return; // Let normal typing happen
    }

    gameState.keys[e.key.toLowerCase()] = true;

    if (e.key === 'Escape' && gameState.gameStarted) {
        e.preventDefault();
        const menu = document.getElementById('gameMenu');
        if (menu) menu.classList.toggle('hidden');
        return;
    }

    if (e.key === ' ' && gameState.player && gameState.player.health <= 0) {
        e.preventDefault();
        document.getElementById('respawnBtn')?.click();
        return;
    }
    if (e.key.toLowerCase() === 'q') {
        e.preventDefault();
        useWindwalk();
    }
    if (e.key.toLowerCase() === 'e') {
        e.preventDefault();
        useFarsight();
    }
    if (e.key === 'Tab') {
        e.preventDefault();
        document.getElementById('scoreboard').classList.remove('hidden');
        updateScoreboard();
    }
    if (e.key.toLowerCase() === 'b') {
        e.preventDefault();
        if (gameState.player) {
            const panel = document.getElementById('shopPanel');
            panel.classList.toggle('hidden');
            if (!panel.classList.contains('hidden')) updateShopUI();
        }
    }
    if (e.shiftKey) gameState.attackWalk = true;
});
let _fpsFrames = 0, _fpsLast = performance.now();
function updateDebugFPS() {
    _fpsFrames++;
    const now = performance.now();
    if (now - _fpsLast >= 1000) {

        const lastDigit = Math.random() < 0.15 ? Math.floor(Math.random() * 4) : 2;
        const fpsText = 'FPS: 800813' + lastDigit;
        const fpsEl = document.getElementById('fpsCounter');
        if (fpsEl) fpsEl.textContent = fpsText;
        if (gameState.debug.showFPS) {
            const dbgFps = document.getElementById('debugFPS');
            if (dbgFps) dbgFps.textContent = fpsText;
        }
        _fpsFrames = 0;
        _fpsLast = now;
    }
    requestAnimationFrame(updateDebugFPS);
}
updateDebugFPS();

document.addEventListener('keyup', (e) => {
    gameState.keys[e.key.toLowerCase()] = false;
    if (!e.shiftKey) gameState.attackWalk = false;
    if (e.key === 'Tab') {
        document.getElementById('scoreboard').classList.add('hidden');
    }
});

document.addEventListener('mousemove', (e) => {
    gameState.mousePos.x = (e.clientX / window.innerWidth) * 2 - 1;
    gameState.mousePos.y = -(e.clientY / window.innerHeight) * 2 + 1;
    if (gameState.isDraggingCamera) {
        const deltaX = e.clientX - gameState.lastMousePos.x;
        const deltaY = e.clientY - gameState.lastMousePos.y;

        gameState.cameraTarget.x -= deltaX * 0.05;
        gameState.cameraTarget.z -= deltaY * 0.05;

        gameState.lastMousePos.set(e.clientX, e.clientY);
    }
});

document.addEventListener('mousedown', (e) => {
    if (!gameState.gameStarted) return;
    if (e.button === 1 || e.button === 2) {
        gameState.isDraggingCamera = true;
        gameState.lastMousePos.set(e.clientX, e.clientY);
        e.preventDefault();
        return;
    }
    if (e.button === 0 && gameState.player) {
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(gameState.mousePos, camera);
        const allPlayers = [...gameState.players.values(), ...gameState.bots]
            .filter(p => p.team !== gameState.team && p.health > 0 && p.mesh.visible);
        const bodyMeshes = allPlayers.map(p => p.mesh.children[0]);
        const intersects = raycaster.intersectObjects(bodyMeshes, false);

        if (intersects.length > 0) {

            for (let player of allPlayers) {
                if (player.mesh.children[0] === intersects[0].object) {

                    if (fogOfWar.isVisible(player.position.x, player.position.z)) {
                        gameState.targetLock = player;
                        gameState.moveTarget = null; // Stop moving
                        gameState.player.shoot(player);
                    }
                    return;
                }
            }
        }
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        const intersectPoint = new THREE.Vector3();
        raycaster.ray.intersectPlane(plane, intersectPoint);
        intersectPoint.x = Math.max(-MAP_SIZE/2 + 2, Math.min(MAP_SIZE/2 - 2, intersectPoint.x));
        intersectPoint.z = Math.max(-MAP_SIZE/2 + 2, Math.min(MAP_SIZE/2 - 2, intersectPoint.z));
        gameState.moveTarget = intersectPoint.clone();
        gameState.targetLock = null; // Clear attack target
        createMoveMarker(intersectPoint);
    }
});

document.addEventListener('mouseup', (e) => {
    if (e.button === 1 || e.button === 2) {
        gameState.isDraggingCamera = false;
    }
});

document.addEventListener('contextmenu', (e) => {
    e.preventDefault(); // Prevent right-click menu
});
document.addEventListener('wheel', (e) => {
    if (!gameState.gameStarted) return; // Allow normal page scroll on landing
    e.preventDefault();
    const zoomSpeed = 1.5;
    const delta = e.deltaY > 0 ? zoomSpeed : -zoomSpeed;
    const newZoom = THREE.MathUtils.clamp(gameState.cameraOffset.y + delta, 6, 40);
    gameState.cameraOffset.y = newZoom;
    gameState.cameraOffset.z = newZoom;
}, { passive: false });
function createMoveMarker(position) {
    const markerGroup = new THREE.Group();
    const terrainY = Math.sin(position.x * 0.1) * Math.cos(position.z * 0.1) * 2 + 0.6;
    for (let i = 0; i < 3; i++) {
        const arrow = new THREE.Group();
        const shape = new THREE.Shape();
        shape.moveTo(0, 0);
        shape.lineTo(-0.12, 0.5);
        shape.lineTo(0.12, 0.5);
        shape.closePath();
        const geo = new THREE.ShapeGeometry(shape);
        const mat = new THREE.MeshBasicMaterial({
            color: 0x00ff00,
            transparent: true,
            opacity: 0.9,
            side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geo, mat);
        arrow.add(mesh);
        const angle = (i / 3) * Math.PI * 2;
        arrow.position.set(Math.cos(angle) * 0.8, 0, Math.sin(angle) * 0.8);
        arrow.rotation.x = -Math.PI / 2;
        arrow.rotation.z = -angle + Math.PI;

        markerGroup.add(arrow);
    }

    markerGroup.position.set(position.x, terrainY, position.z);
    scene.add(markerGroup);
    let time = 0;
    let opacity = 0.9;
    const animInterval = setInterval(() => {
        time += 0.05;
        markerGroup.rotation.y += 0.15;
        const scale = Math.max(0.3, 1 - time * 0.5);
        markerGroup.scale.set(scale, scale, scale);
        opacity -= 0.03;
        markerGroup.children.forEach(arrow => {
            arrow.children[0].material.opacity = opacity;
        });
        if (opacity <= 0) {
            clearInterval(animInterval);
            scene.remove(markerGroup);
            markerGroup.children.forEach(arrow => {
                arrow.children[0].geometry.dispose();
                arrow.children[0].material.dispose();
            });
        }
    }, 25);
}
let selectedTeamValue = null;

document.querySelectorAll('.modeBtn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.modeBtn').forEach(b => {
            b.classList.remove('selected');
            b.style.background = '#111';
            b.style.color = '#00ff00';
        });
        btn.classList.add('selected');
        btn.style.background = '#00ff00';
        btn.style.color = '#000';
        isOnlineMode = btn.dataset.mode === 'online';
        console.log('Mode:', isOnlineMode ? 'ONLINE' : 'OFFLINE');
    });
});

document.querySelectorAll('.teamBtn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.teamBtn').forEach(b => {
            b.classList.remove('selected');
            b.style.background = '#111';
            b.style.color = b.classList.contains('red') ? '#ff0000' : '#0088ff';
        });
        btn.classList.add('selected');
        btn.style.background = btn.classList.contains('red') ? '#ff0000' : '#0088ff';
        btn.style.color = '#fff';
        selectedTeamValue = btn.dataset.team;
        console.log('Selected team:', selectedTeamValue);
    });
});
{
    const vc = document.getElementById('visitorNum');
    if (vc) {
        const n = 4831 + Math.floor(Math.random() * 200);
        vc.textContent = String(n).padStart(6, '0').replace(/(\d)(?=(\d{3})+$)/g, '$1,');
    }
}

document.getElementById('startBtn').addEventListener('click', () => {
    audioManager.init(); // Unlock audio on first user interaction
    const username = document.getElementById('usernameInput').value.trim() || 'Sniper';

    if (!selectedTeamValue) {
        alert('Please select a team!');
        return;
    }

    gameState.username = username;
    gameState.team = selectedTeamValue;
    gameState.gameStarted = true;

    console.log('Starting game as', username, 'on team', gameState.team);

    document.getElementById('usernameModal')?.classList.add('hidden');
    document.getElementById('landingPage')?.classList.add('hidden');
    document.getElementById('gameCanvas').style.display = 'block';
    document.getElementById('ui').style.display = '';
    document.body.classList.add('game-active', 'game-playing');
    document.getElementById('hud')?.classList.remove('hidden');
    document.getElementById('abilities')?.classList.remove('hidden');
    document.querySelector('.minimap')?.classList.remove('hidden');
    const tickerEl = document.getElementById('ticker');
    if (tickerEl) tickerEl.textContent = '$' + username.toUpperCase().slice(0, 5);
    _playerPrice = 1.00;
    _priceHistory = [1.00];
    _startPrice = 1.00;
    updateTerminal();

    startGame();
});

document.querySelectorAll('.ability').forEach(el => {
    el.addEventListener('mousedown', (e) => { e.stopPropagation(); });
    el.addEventListener('click', (e) => {
        e.stopPropagation();
        const ability = el.dataset.ability;
        if (ability === 'windwalk') useWindwalk();
        if (ability === 'farsight') useFarsight();
        if (el.id === 'shopBtn') {
            if (gameState.player) {
                const panel = document.getElementById('shopPanel');
                panel.classList.toggle('hidden');
                if (!panel.classList.contains('hidden')) updateShopUI();
            }
        }
        if (el.id === 'scoreBtn') {
            const sb = document.getElementById('scoreboard');
            sb.classList.toggle('hidden');
            if (!sb.classList.contains('hidden')) updateScoreboard();
        }
    });
});
document.getElementById('scoreboard')?.addEventListener('click', () => {
    if (gameState.gameStarted) document.getElementById('scoreboard').classList.add('hidden');
});

document.getElementById('menuBtn')?.addEventListener('mousedown', (e) => { e.stopPropagation(); });
document.getElementById('menuBtn')?.addEventListener('click', () => {
    document.getElementById('gameMenu')?.classList.remove('hidden');
});
document.getElementById('menuResume')?.addEventListener('click', () => {
    document.getElementById('gameMenu')?.classList.add('hidden');
});
document.getElementById('menuMute')?.addEventListener('click', () => {
    audioManager.enabled = !audioManager.enabled;
    const btn = document.getElementById('menuMute');
    if (btn) btn.textContent = audioManager.enabled ? '🔊 SOUND: ON' : '🔇 SOUND: OFF';
});
document.getElementById('menuQuit')?.addEventListener('click', () => {
    document.getElementById('gameMenu')?.classList.add('hidden');
    if (window._isWagerMatch && _ws && _ws.readyState === 1) {
        _ws.send(JSON.stringify({ t: 'wager_forfeit' }));
    }
    if (_ws) { try { _ws.close(); } catch(e) {} _ws = null; }
    gameState.gameStarted = false;
    isOnlineMode = false;
    window._isWagerMatch = false;
    window._gameStarted = false;
    document.getElementById('hud')?.classList.add('hidden');
    document.getElementById('abilities')?.classList.add('hidden');
    document.querySelector('.minimap')?.classList.add('hidden');
    document.getElementById('teamScore')?.classList.add('hidden');
    document.getElementById('landingPage')?.classList.remove('hidden');
    document.getElementById('gameCanvas').style.display = 'none';
    document.getElementById('ui').style.display = 'none';
    document.body.classList.remove('game-active', 'game-playing');
    window.scrollTo(0, 0);
    _remotePlayers.forEach((r) => { if (r.player.mesh.parent) r.player.mesh.parent.remove(r.player.mesh); });
    _remotePlayers.clear();
    _serverState.clear();
    _roster = {};
    _myServerId = null;
});

document.addEventListener('mousedown', (e) => {
    if (!gameState.gameStarted) return;
    const shop = document.getElementById('shopPanel');
    if (shop && !shop.classList.contains('hidden') && !e.target.closest('#shopPanel, .ability')) {
        shop.classList.add('hidden');
    }
}, true); // capture phase — runs before stopPropagation on abilities
document.addEventListener('touchstart', (e) => {
    if (!gameState.gameStarted) return;
    const shop = document.getElementById('shopPanel');
    if (shop && !shop.classList.contains('hidden') && !e.target.closest('#shopPanel, .ability')) {
        shop.classList.add('hidden');
    }
}, true);

function startGame() {
    console.log('startGame() called');
    const fogLayers = new Set(fogOfWar.fogLayers || []);
    const toRemove = scene.children.filter(child =>
        child.geometry && child.geometry.type === 'PlaneGeometry' && !fogLayers.has(child)
    );
    toRemove.forEach(child => scene.remove(child));

    console.log('About to createMap...');
    createMap();
    console.log('Map created');
    console.log('About to create player...');
    gameState.player = new Player(gameState.username, gameState.team, true);
    console.log('Player created at', gameState.player.position.x, gameState.player.position.z);
    gameState.cameraTarget.copy(gameState.player.position);
    if (!isOnlineMode) {
        const botNames = ['Elite', 'Anima', 'Game', 'ESi', 'Apathetic', 'Gem', 'Kflan', 'Jubei', 'Steve', 'Sean'];
        for (let i = 0; i < 10; i++) {
            const team = i < 5 ? 'red' : 'blue';
            const bot = new Player(botNames[i], team, false);
            gameState.bots.push(bot);
        }
        console.log('Bots created:', gameState.bots.length);
    } else if (!_ws) {

        console.log('Online mode — connecting to server');
        connectToServer();
    } else {
        console.log('Online mode — using existing WebSocket (wager match)');
    }

    updateScoreboard();
    window.focus();
    document.body.focus();

    animate();
}
const minimapCanvas = document.getElementById('minimap');
const minimapCtx = minimapCanvas.getContext('2d');
minimapCanvas.width = 150;
minimapCanvas.height = 150;

function minimapToWorld(clientX, clientY) {
    const rect = minimapCanvas.getBoundingClientRect();
    const mx = (clientX - rect.left) / rect.width;  // 0-1
    const my = (clientY - rect.top) / rect.height;   // 0-1
    return {
        x: (mx - 0.5) * MAP_SIZE,
        z: (my - 0.5) * MAP_SIZE,
    };
}

function jumpCameraTo(worldX, worldZ) {
    gameState.cameraTarget.x += (worldX - gameState.cameraTarget.x) * 0.4;
    gameState.cameraTarget.z += (worldZ - gameState.cameraTarget.z) * 0.4;
}
minimapCanvas.style.pointerEvents = 'all';
minimapCanvas.style.touchAction = 'none';

let minimapDragging = false;
minimapCanvas.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    minimapDragging = true;
    const pos = minimapToWorld(e.clientX, e.clientY);
    jumpCameraTo(pos.x, pos.z);
});
document.addEventListener('mousemove', (e) => {
    if (!minimapDragging) return;
    const pos = minimapToWorld(e.clientX, e.clientY);
    jumpCameraTo(pos.x, pos.z);
});
document.addEventListener('mouseup', () => { minimapDragging = false; });

minimapCanvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    e.stopPropagation();
    minimapDragging = true;
    const t = e.touches[0];
    const pos = minimapToWorld(t.clientX, t.clientY);
    jumpCameraTo(pos.x, pos.z);
}, { passive: false });

minimapCanvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!minimapDragging) return;
    const t = e.touches[0];
    const pos = minimapToWorld(t.clientX, t.clientY);
    jumpCameraTo(pos.x, pos.z);
}, { passive: false });

minimapCanvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    e.stopPropagation();
    minimapDragging = false;
}, { passive: false });

function updateMinimap() {
    minimapCtx.fillStyle = '#000';
    minimapCtx.fillRect(0, 0, 150, 150);

    const scale = 150 / MAP_SIZE;

    const allPlayers = [...gameState.bots];
    if (isOnlineMode) {
        for (const [, remote] of _remotePlayers) {
            allPlayers.push(remote.player);
        }
    }
    if (gameState.player) allPlayers.push(gameState.player);

    allPlayers.forEach(p => {
        if (p.health <= 0) return;

        const isMe = p === gameState.player;
        const isTeammate = p.team === gameState.team;
        if (!isTeammate && !isMe) {
            if (!p.mesh.visible) return;
            if (!fogOfWar.isVisible(p.position.x, p.position.z)) return;
        }

        const x = (p.position.x + MAP_SIZE / 2) * scale;
        const y = (p.position.z + MAP_SIZE / 2) * scale;

        minimapCtx.fillStyle = isMe ? '#ffd700' : (p.team === 'red' ? '#ff4444' : '#4488ff');
        minimapCtx.beginPath();
        minimapCtx.arc(x, y, isMe ? 4 : 3, 0, Math.PI * 2);
        minimapCtx.fill();
    });
}
let lastTime = performance.now();

function animate() {
    requestAnimationFrame(animate);

    gameState._frame = (gameState._frame || 0) + 1;
    const currentTime = performance.now();
    const deltaTime = (currentTime - lastTime) / 1000;
    lastTime = currentTime;

    if (!gameState.gameStarted) return;
    const windTime = currentTime * 0.001;
    for (let i = 0; i < _windMaterials.length; i++) {
        _windMaterials[i].uniforms.uTime.value = windTime;
    }
    checkShopProximity();
    if (gameState.multiKillTimer > 0) {
        gameState.multiKillTimer -= deltaTime;
        if (gameState.multiKillTimer <= 0) {
            gameState.multiKillCount = 0;
        }
    }

    const edgeScrollSpeed = 20;
    const edgeThreshold = 50;
    const mouseX = (gameState.mousePos.x + 1) * window.innerWidth / 2;
    const mouseY = (-gameState.mousePos.y + 1) * window.innerHeight / 2;

    if (mouseX < edgeThreshold) {
        gameState.cameraTarget.x -= edgeScrollSpeed * deltaTime;
    } else if (mouseX > window.innerWidth - edgeThreshold) {
        gameState.cameraTarget.x += edgeScrollSpeed * deltaTime;
    }

    if (mouseY < edgeThreshold) {
        gameState.cameraTarget.z -= edgeScrollSpeed * deltaTime;
    } else if (mouseY > window.innerHeight - edgeThreshold) {
        gameState.cameraTarget.z += edgeScrollSpeed * deltaTime;
    }
    if (gameState.isDraggingCamera) {

    }
    const camSpeed = 15;
    if (gameState.keys['w'] && !gameState.keys['s']) gameState.cameraTarget.z -= camSpeed * deltaTime;
    if (gameState.keys['s'] && !gameState.keys['w']) gameState.cameraTarget.z += camSpeed * deltaTime;
    if (gameState.keys['a'] && !gameState.keys['d']) gameState.cameraTarget.x -= camSpeed * deltaTime;
    if (gameState.keys['d'] && !gameState.keys['a']) gameState.cameraTarget.x += camSpeed * deltaTime;
    if (gameState.keys[' '] && gameState.player) {
        gameState.cameraTarget.copy(gameState.player.position);

    }
    const mapBound = MAP_SIZE / 2 - 5;
    gameState.cameraTarget.x = THREE.MathUtils.clamp(gameState.cameraTarget.x, -mapBound, mapBound);
    gameState.cameraTarget.z = THREE.MathUtils.clamp(gameState.cameraTarget.z, -mapBound, mapBound);
    camera.position.x = THREE.MathUtils.lerp(camera.position.x, gameState.cameraTarget.x + gameState.cameraOffset.x, 0.06);
    camera.position.y = gameState.cameraOffset.y;
    camera.position.z = THREE.MathUtils.lerp(camera.position.z, gameState.cameraTarget.z + gameState.cameraOffset.z, 0.06);
    camera.lookAt(gameState.cameraTarget);
    if (gameState.player && gameState.player.health > 0) {

        if (gameState.moveTarget) {
            const reached = gameState.player.moveTowards(gameState.moveTarget, deltaTime);
            if (reached) {
                gameState.moveTarget = null;
            }
        }

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(gameState.mousePos, camera);
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        const intersectPoint = new THREE.Vector3();
        raycaster.ray.intersectPlane(plane, intersectPoint);

        gameState.player.weapon.lookAt(intersectPoint);
    }
    if (!isOnlineMode) {
        gameState.bots.forEach(bot => bot.update(deltaTime));
    } else {

        if (typeof updateRemotePlayers === 'function') updateRemotePlayers(deltaTime);
    }
    if (gameState.player) {
        gameState.player.update(deltaTime);
    }
    Object.values(gameState.abilities).forEach(ability => {
        if (ability.cooldown > 0) {
            ability.cooldown -= deltaTime;
            if (ability.cooldown < 0) ability.cooldown = 0;
        }
    });

    updateAbilityUI();
    updateScoreboard();
    updateMinimap();
    const allUnits = [...gameState.bots];
    if (gameState.player) {
        allUnits.push(gameState.player);
    }

    if (isOnlineMode) {
        for (const [, remote] of _remotePlayers) {
            if (remote.player.team === gameState.team && remote.player.health > 0) {
                allUnits.push(remote.player);
            }
        }
    }

    const farsightPositions = [];
    if (gameState.player && gameState.player.farsightActive) {
        farsightPositions.push(gameState.player.farsightPosition);
    }

    fogOfWar.update(gameState.player, allUnits, farsightPositions);
    if (gameState.player) {
        visionLight.position.set(gameState.player.position.x, 12, gameState.player.position.z);
    }
    gameState.bots.forEach(bot => {
        if (bot.team !== gameState.team) {
            const inVision = fogOfWar.isVisible(bot.position.x, bot.position.z);
            bot.mesh.visible = inVision && bot.health > 0;

            if (bot.mesh.visible) {
                bot.mesh.traverse(child => {
                    if (child.material && !child.isSprite) {
                        child.material.transparent = false;
                        child.material.opacity = 1;
                    }
                });
            }
        } else {
            bot.mesh.visible = bot.health > 0;
        }
    });

    renderer.render(scene, camera);
    updateCRT();
}
let _baseWidth = window.innerWidth;
let _baseHeight = window.innerHeight;
const _isMobileDevice = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || ('ontouchstart' in window);

function handleResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    if (_isMobileDevice && w === _baseWidth && h < _baseHeight * 0.8) return;
    _baseWidth = w;
    _baseHeight = h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
}
window.addEventListener('resize', handleResize);
if (_isMobileDevice) {
    const _chatEl = document.getElementById('chatInput');
    if (_chatEl) {
        _chatEl.addEventListener('focus', () => {
            setTimeout(() => { window.scrollTo(0, 0); }, 50);
            setTimeout(() => { window.scrollTo(0, 0); }, 300);
        });
    }
}
function preGameRender() {
    if (!gameState.gameStarted) {
        requestAnimationFrame(preGameRender);
        renderer.render(scene, camera);
    }
}
preGameRender();
document.getElementById('respawnBtn')?.addEventListener('click', () => {
    document.getElementById('deathPopup').classList.add('hidden');

    if (gameState.player) {
        const spawnX = gameState.player.team === 'red' ? -70 : 70;
        const spawnZ = gameState.player.team === 'red' ? -70 : 70;
        gameState.cameraTarget.x = spawnX;
        gameState.cameraTarget.z = spawnZ;
    }
});
const _origRespawn = Player.prototype.respawn;
Player.prototype.respawn = function() {
    _origRespawn.call(this);
    if (this.isPlayer) {
        document.getElementById('deathPopup')?.classList.add('hidden');
    }
};

const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || ('ontouchstart' in window);

if (isMobile) {
    const canvas = document.getElementById('gameCanvas');
    let touchStartPos = null;
    const touches = new Map();
    const DRAG_THRESHOLD = 15;
    const TAP_TIME = 200;
    let camVelX = 0, camVelZ = 0;

    const _shopOpen = () => !document.getElementById('shopPanel').classList.contains('hidden');

    canvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        if (_shopOpen()) return;
        camVelX = 0;
        camVelZ = 0;

        for (const t of e.changedTouches) {
            touches.set(t.identifier, {
                startX: t.clientX, startY: t.clientY,
                lastX: t.clientX, lastY: t.clientY,
                startTime: Date.now(), isDrag: false,
            });
        }
        if (e.touches.length === 2) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            gameState._pinchStart = Math.sqrt(dx * dx + dy * dy);
            gameState._pinchZoomStart = gameState.cameraOffset.y;
        }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        if (_shopOpen()) return;

        if (e.touches.length >= 1) {
            const t = e.touches[0];
            const data = touches.get(t.identifier);
            if (data) {
                const totalDx = t.clientX - data.startX;
                const totalDy = t.clientY - data.startY;

                if (!data.isDrag && (Math.abs(totalDx) > DRAG_THRESHOLD || Math.abs(totalDy) > DRAG_THRESHOLD)) {
                    data.isDrag = true;
                }

                if (data.isDrag) {
                    const dx = t.clientX - data.lastX;
                    const dy = t.clientY - data.lastY;

                    gameState.cameraTarget.x -= dx * 0.06;
                    gameState.cameraTarget.z -= dy * 0.06;
                    camVelX = -dx * 0.06;
                    camVelZ = -dy * 0.06;
                }

                data.lastX = t.clientX;
                data.lastY = t.clientY;

                const rect = canvas.getBoundingClientRect();
                gameState.mousePos.x = ((t.clientX - rect.left) / rect.width) * 2 - 1;
                gameState.mousePos.y = -((t.clientY - rect.top) / rect.height) * 2 + 1;
            }
        }

        if (e.touches.length === 2 && gameState._pinchStart) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const scale = gameState._pinchStart / dist;
            const newZoom = Math.max(8, Math.min(30, gameState._pinchZoomStart * scale));
            gameState.cameraOffset.y = newZoom;
            gameState.cameraOffset.z = newZoom;
        }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
        e.preventDefault();
        if (_shopOpen()) { touches.clear(); return; }

        for (const t of e.changedTouches) {
            const data = touches.get(t.identifier);
            if (data && !data.isDrag && (Date.now() - data.startTime < TAP_TIME)) {
                const rect = canvas.getBoundingClientRect();
                const x = data.startX - rect.left;
                const y = data.startY - rect.top;
                gameState.mousePos.x = (x / rect.width) * 2 - 1;
                gameState.mousePos.y = -(y / rect.height) * 2 + 1;
                document.dispatchEvent(new MouseEvent('mousedown', { clientX: data.startX, clientY: data.startY, button: 0, bubbles: true }));
                setTimeout(() => {
                    document.dispatchEvent(new MouseEvent('mouseup', { clientX: data.startX, clientY: data.startY, button: 0, bubbles: true }));
                }, 50);

                camVelX = 0;
                camVelZ = 0;
            }
            touches.delete(t.identifier);
        }

        if (e.touches.length === 0) {
            gameState._pinchStart = null;
        }
    }, { passive: false });
    function applyMomentum() {
        requestAnimationFrame(applyMomentum);
        if (Math.abs(camVelX) > 0.01 || Math.abs(camVelZ) > 0.01) {
            gameState.cameraTarget.x += camVelX;
            gameState.cameraTarget.z += camVelZ;
            camVelX *= 0.9;
            camVelZ *= 0.9;
        }
    }
    applyMomentum();
}
document.querySelectorAll('.ability').forEach(btn => {
    btn.addEventListener('touchstart', (e) => {
        e.stopPropagation();
        const ability = btn.dataset.ability;
        if (ability === 'windwalk') {
            useWindwalk();
            if (_ws && _ws.readyState === 1) _ws.send(JSON.stringify({ t: 'ab', a: 'ww' }));
        }
        if (ability === 'farsight') {
            useFarsight();
            if (_ws && _ws.readyState === 1 && gameState.player) {
                const p = gameState.player.position;
                _ws.send(JSON.stringify({ t: 'ab', a: 'fs', x: p.x, z: p.z }));
            }
        }
    }, { passive: false });
    btn.addEventListener('click', (e) => {
        const ability = btn.dataset.ability;
        if (ability === 'windwalk') {
            useWindwalk();
            if (_ws && _ws.readyState === 1) _ws.send(JSON.stringify({ t: 'ab', a: 'ww' }));
        }
        if (ability === 'farsight') {
            useFarsight();
            if (_ws && _ws.readyState === 1 && gameState.player) {
                const p = gameState.player.position;
                _ws.send(JSON.stringify({ t: 'ab', a: 'fs', x: p.x, z: p.z }));
            }
        }
    });
});

if (!isMobile) {
    document.getElementById('startBtn')?.addEventListener('click', () => {
        setTimeout(() => {
            if (document.documentElement.requestFullscreen) {
                document.documentElement.requestFullscreen().catch(() => {});
            } else if (document.documentElement.webkitRequestFullscreen) {
                document.documentElement.webkitRequestFullscreen();
            }

            if (screen.orientation?.lock) {
                screen.orientation.lock('landscape').catch(() => {});
            }
        }, 500);
    });
}

console.log('Elite Snipers - Loading complete!' + (isMobile ? ' (Mobile)' : ''));

let _aabbWalls = null; // Will be loaded from map-data.json
let _mapDataLoaded = null;
fetch('/map-data.json').then(r => r.json()).then(data => {
    _mapDataLoaded = data;
    _aabbWalls = [];
    data.walls.forEach(w => {
        _aabbWalls.push([w.x - w.w/2, w.z - w.d/2, w.x + w.w/2, w.z + w.d/2]);
    });
    data.trees.forEach(t => {
        _aabbWalls.push([t.x - 0.5, t.z - 0.5, t.x + 0.5, t.z + 0.5]);
    });
    data.rocks.forEach(r => {
        _aabbWalls.push([r.x - r.s, r.z - r.s, r.x + r.s, r.z + r.s]);
    });
    console.log('AABB collision loaded:', _aabbWalls.length, 'objects');
}).catch(e => console.warn('Failed to load map-data.json for AABB:', e));

function checkCollisionAABB(x, z, radius) {
    if (!_aabbWalls) return false;
    if (radius === undefined) radius = 1.0;

    if (Math.abs(x) > MAP_SIZE / 2 - 2 || Math.abs(z) > MAP_SIZE / 2 - 2) return true;
    for (let i = 0; i < _aabbWalls.length; i++) {
        const w = _aabbWalls[i];
        if (x + radius > w[0] && x - radius < w[2] && z + radius > w[1] && z - radius < w[3]) return true;
    }
    return false;
}

function hasLineOfSightAABB(ax, az, bx, bz) {
    if (!_aabbWalls) return true;
    const dx = bx - ax, dz = bz - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.1) return true;
    const steps = Math.ceil(len / 1.0);
    for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const px = ax + dx * t, pz = az + dz * t;
        if (checkCollisionAABB(px, pz, 0.1)) return false;
    }
    return true;
}

let _ws = null;
let _myServerId = null;
let _roster = {}; // id -> { username, team, isBot }

let _serverState = new Map(); // serverId -> latest decoded state
let _lastSendTime = 0;
let _lastAimRot = 0;

const BYTES_PER_PLAYER = 28;
const INTERP_SPEED = 12; // units/sec for interpolation

function _netDebug(text) {

    console.log('[NET]', text);
}

function connectToServer() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = protocol + '//' + window.location.host;
    _netDebug('WS: ' + url + ' host=' + window.location.host + ' port=' + window.location.port);

    _ws = new WebSocket(url);
    _ws.binaryType = 'arraybuffer';
    const connectTimeout = setTimeout(() => {
        if (_ws.readyState !== 1) {
            _netDebug('Connection timeout — falling back to offline');
            _ws.close();
            isOnlineMode = false;

            const botNames = ['Elite','Anima','Game','ESi','Apathetic','Gem','Kflan','Jubei','Steve','Sean'];
            for (let i = 0; i < 10; i++) {
                const bot = new Player(botNames[i], i < 5 ? 'red' : 'blue', false);
                gameState.bots.push(bot);
            }
            setTimeout(() => { const el = document.getElementById('_netdbg'); if (el) el.remove(); }, 3000);
        }
    }, 3000);

    _ws.onopen = () => {
        clearTimeout(connectTimeout);
        _netDebug('Connected! Joining as ' + gameState.username + '...');
        _ws.send(JSON.stringify({
            t: 'join',
            n: gameState.username,
            m: gameState.team
        }));
        document.getElementById('chatBox')?.classList.remove('hidden');
    };

    let _msgCount = 0;
    _ws.onmessage = (evt) => {
        _msgCount++;
        const data = evt.data;
        if (_msgCount <= 3) _netDebug('msg#' + _msgCount + ' type=' + (typeof data) + ' ctor=' + (data && data.constructor && data.constructor.name) + ' size=' + (data.byteLength || data.size || data.length || '?'));
        if (typeof data === 'string') {
            try { handleJsonMessage(JSON.parse(data)); } catch(e) { _netDebug('JSON parse error: ' + e.message); }
        } else if (data instanceof ArrayBuffer) {
            handleBinaryState(data);
        } else if (data instanceof Blob) {
            _netDebug('Got Blob, converting...');
            data.arrayBuffer().then(ab => { _netDebug('Blob->AB ok, ' + ab.byteLength + 'b'); handleBinaryState(ab); });
        } else if (data && data.byteLength !== undefined) {
            handleBinaryState(data.buffer ? data.buffer : data);
        } else {
            _netDebug('Unknown data type: ' + (typeof data));
        }
    };

    _ws.onerror = (err) => { _netDebug('WS ERROR: ' + (err.message || 'unknown')); };
    _ws.onclose = () => {
        console.log('WebSocket disconnected');
        addChatSystem('Disconnected from server');

        setTimeout(() => {
            if (isOnlineMode && gameState.gameStarted) connectToServer();
        }, 3000);
    };

    _ws.onerror = (err) => {
        console.error('WebSocket error:', err);
    };
}

function handleBinaryState(buf) {

    if (!_myServerId) return;

    const view = new DataView(buf);
    const count = view.getUint16(0, true);
    if (!handleBinaryState._logged) {
        console.log('First binary state: ' + count + ' players, ' + buf.byteLength + ' bytes');
        handleBinaryState._logged = true;

        const dbg = document.createElement('div');
        dbg.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:#00ff44;font-size:1rem;z-index:99999;pointer-events:none;font-family:monospace;text-shadow:0 0 10px #00ff44;';
        dbg.textContent = 'Server: ' + count + ' players connected';
        document.body.appendChild(dbg);
        setTimeout(() => dbg.remove(), 3000);
    }
    let off = 2;

    const seenIds = new Set();

    for (let i = 0; i < count; i++) {
        const id = view.getUint16(off, true); off += 2;
        const x = view.getFloat32(off, true); off += 4;
        const z = view.getFloat32(off, true); off += 4;
        const rot = view.getFloat32(off, true); off += 4;
        const alive = view.getUint8(off); off += 1;
        const kills = view.getInt16(off, true); off += 2;
        const deaths = view.getInt16(off, true); off += 2;
        const price = view.getFloat32(off, true); off += 4;
        const flags = view.getUint8(off); off += 1;
        const streak = view.getInt16(off, true); off += 2;
        const gold = view.getInt16(off, true); off += 2;

        const isWindwalk = !!(flags & 1);
        const isSpawnProt = !!(flags & 2);
        const isBot = !!(flags & 4);
        const isBlue = !!(flags & 8);
        const inFog = !!(flags & 16);
        const team = isBlue ? 'blue' : 'red';

        seenIds.add(id);

        if (id === _myServerId) {

            if (gameState.player) {
                gameState.player.kills = kills;
                gameState.player.deaths = deaths;
                gameState.player.price = price;
                gameState.player.gold = gold;
                gameState.player.streak = streak;
                gameState.player._spawnProtection = isSpawnProt ? 1.0 : -1;
                const wasAlive = gameState.player.health > 0;
                if (alive && !wasAlive) {

                    gameState.player.health = 100;
                    gameState.player.mesh.visible = true;
                    gameState.player.position.set(x, Math.sin(x * 0.1) * Math.cos(z * 0.1) * 2 + 0.6, z);
                    document.getElementById('deathPopup')?.classList.add('hidden');
                } else if (!alive && wasAlive) {

                }
                if (alive) {
                    const cdx = x - gameState.player.position.x;
                    const cdz = z - gameState.player.position.z;
                    const drift = Math.sqrt(cdx * cdx + cdz * cdz);
                    if (drift > 10) {
                        gameState.player.position.x = x;
                        gameState.player.position.z = z;
                    } else if (drift > 0.1) {
                        gameState.player.position.x += cdx * 0.4;
                        gameState.player.position.z += cdz * 0.4;
                    }
                    gameState.player.position.y = Math.sin(gameState.player.position.x * 0.1) * Math.cos(gameState.player.position.z * 0.1) * 2 + 0.6;
                }
                gameState.kills = kills;
                gameState.deaths = deaths;
                gameState.gold = gold;
                gameState.killStreak = streak;
                _playerPrice = price;
                document.getElementById('killCount').textContent = kills;
                document.getElementById('deathCount').textContent = deaths;
                updateGoldUI();
                _priceHistory.push(price);
                if (_priceHistory.length > 120) _priceHistory.shift();
                updateTerminal();
            }
        } else {

            _serverState.set(id, { x, z, rot, alive: !!alive, kills, deaths, price, gold, streak, team, isBot, isWindwalk, isSpawnProt });

            let remote = _remotePlayers.get(id);
            if (!remote) {

                const name = (_roster[id] && _roster[id].username) || (isBot ? 'Bot' : 'Player');
                console.log('Creating remote: ' + name + ' id=' + id + ' team=' + team);
                const rPlayer = new Player(name, team, false);
                rPlayer.position.set(x, Math.sin(x * 0.1) * Math.cos(z * 0.1) * 2 + 0.6, z);
                rPlayer.kills = kills;
                rPlayer.deaths = deaths;
                rPlayer.price = price;
                rPlayer.gold = gold;
                rPlayer.health = alive ? 100 : 0;
                rPlayer.mesh.visible = !!alive;
                remote = { player: rPlayer, targetX: x, targetZ: z, targetRot: rot, lastUpdate: performance.now() };
                _remotePlayers.set(id, remote);
            }

            remote.targetX = x;
            remote.targetZ = z;
            remote.targetRot = rot;
            remote.lastUpdate = performance.now();
            remote.player.kills = kills;
            remote.player.deaths = deaths;
            remote.player.price = price;
            remote.player.gold = gold;
            remote.player.streak = streak;
            const wasDead = remote.player.health <= 0;
            remote.player.health = alive ? 100 : 0;
            if (wasDead && alive) {

                remote.player.position.x = x;
                remote.player.position.z = z;
                remote.player.position.y = Math.sin(x * 0.1) * Math.cos(z * 0.1) * 2 + 0.6;
            }
            remote.player._inFog = inFog;
            if (!alive) {
                remote.player.mesh.visible = false;
                remote.targetX = x;
                remote.targetZ = z;
                remote.targetRot = rot;
                continue;
            }
            if (remote.player.team === gameState.team) {
                remote.player.mesh.visible = true;
            } else {
                remote.player.mesh.visible = fogOfWar.isVisible(x, z);
            }
            remote.player.isWindwalking = isWindwalk;
            remote.player._spawnProtection = isSpawnProt ? 1.0 : -1;
        }
    }
    for (const [rid, remote] of _remotePlayers) {
        if (!seenIds.has(rid) && rid !== _myServerId) {
            if (remote.player.mesh.parent) remote.player.mesh.parent.remove(remote.player.mesh);
            _remotePlayers.delete(rid);
        }
    }
}

function handleJsonMessage(msg) {
    switch (msg.t) {
        case 'j': {

            _myServerId = msg.id;
            console.log('Joined as id', _myServerId);

            if (msg.roster) {
                msg.roster.forEach(r => {
                    _roster[r.id] = { username: r.n, team: r.m, isBot: !!r.b };
                });
            }

            if (msg.limit) {
                _matchKillLimit = msg.limit;
                _matchTimeLimit = msg.timeLimit || 1200;
                _matchStartTime = Date.now() - (msg.elapsed || 0) * 1000;
                if (!window._isWagerMatch) {
                    updateTeamScore(msg.rk || 0, msg.bk || 0);
                    document.getElementById('teamScore')?.classList.remove('hidden');
                }
            }
            break;
        }
        case 'pj': {

            addChatSystem(msg.n + ' joined ' + msg.m);
            break;
        }
        case 'pl': {

            addChatSystem(msg.n + ' left');
            break;
        }
        case 'roster': {

            if (msg.roster) {
                for (const r of msg.roster) {
                    _roster[r.id] = { username: r.n, team: r.m, isBot: !!r.b };
                }
            }
            break;
        }
        case 'k': {

            addKillFeed(msg.kn, msg.vn);
            audioManager.play('sniperFire');
            if (msg.rk !== undefined) {
                if (window._isWagerMatch && window._updateWagerScoreFromKill) {

                    const myTeam = gameState.team;
                    const myKills = myTeam === 'red' ? msg.rk : msg.bk;
                    const oppKills = myTeam === 'red' ? msg.bk : msg.rk;
                    window._updateWagerScoreFromKill(myKills, oppKills);
                } else {
                    updateTeamScore(msg.rk, msg.bk);
                }
            }
            const killer = msg.ki === _myServerId ? gameState.player :
                _remotePlayers.get(msg.ki)?.player;
            const victim = msg.vi === _myServerId ? gameState.player :
                _remotePlayers.get(msg.vi)?.player;
            if (killer && victim && killer.createShootingEffect) {
                killer.createShootingEffect(victim.position);
            }
            if (msg.vi !== _myServerId) {
                const remote = _remotePlayers.get(msg.vi);
                if (remote) {
                    remote.player.health = 0;
                    remote.player.mesh.visible = false;
                }
            }
            if (msg.ki === _myServerId) {
                audioManager.play('headshot');
                let hasSpecial = false;
                if (msg.fb) {
                    audioManager.play('firstBlood');
                    showStreakPopup('FIRST BLOOD', '#ff4444');
                    hasSpecial = true;
                }

                const streakMap = {
                    5: ['killingSpree', 'KILLING SPREE', '#ff8800'],
                    10: ['rampage', 'RAMPAGE', '#ff4400'],
                    15: ['dominating', 'DOMINATING', '#ff0044'],
                    20: ['unstoppable', 'UNSTOPPABLE', '#cc00ff'],
                    25: ['godlike', 'GODLIKE', '#ffdd00'],
                };
                if (streakMap[msg.s]) {
                    audioManager.play(streakMap[msg.s][0]);
                    if (!hasSpecial) showStreakPopup(streakMap[msg.s][1], streakMap[msg.s][2]);
                    hasSpecial = true;
                }
                if (!gameState._multiKillTimer) gameState._multiKillTimer = 0;
                if (!gameState._multiKillCount) gameState._multiKillCount = 0;
                const now = Date.now();
                if (now - gameState._multiKillTimer < 4000) {
                    gameState._multiKillCount++;
                } else {
                    gameState._multiKillCount = 1;
                }
                gameState._multiKillTimer = now;

                const mk = gameState._multiKillCount;
                const multiMap = {
                    2: ['doubleKill', 'DOUBLE KILL', '#44ffaa'],
                    3: ['multiKill', 'MULTI KILL', '#44ddff'],
                    4: ['megaKill', 'MEGA KILL', '#4488ff'],
                    5: ['ultraKill', 'ULTRA KILL', '#aa44ff'],
                    6: ['monsterKill', 'MONSTER KILL', '#ff44aa'],
                };
                if (mk >= 7) {
                    audioManager.play('ludicrousKill');
                    if (!hasSpecial) showStreakPopup('LUDICROUS KILL', '#ff0000');
                } else if (multiMap[mk]) {
                    audioManager.play(multiMap[mk][0]);
                    if (!hasSpecial) showStreakPopup(multiMap[mk][1], multiMap[mk][2]);
                }

                showGoldPopup('+' + msg.g + 'c');
            }
            if (msg.vi === _myServerId && gameState.player) {
                gameState.player.health = 0;
                gameState.player.mesh.visible = false;
                gameState.moveTarget = null;
                gameState.targetLock = null;

                const popup = document.getElementById('deathPopup');
                document.getElementById('deathKiller').innerHTML = 'Killed by ' + msg.kn;
                popup.classList.add('hidden');
                void popup.offsetHeight;
                popup.classList.remove('hidden');
                setTimeout(() => popup.classList.add('hidden'), 5000);
                resetStreakChart();
            }

            break;
        }
        case 'r': {

            if (msg.id === _myServerId && gameState.player) {
                gameState.player.health = 100;
                gameState.player.mesh.visible = true;
                const ty = Math.sin(msg.x * 0.1) * Math.cos(msg.z * 0.1) * 2 + 0.6;
                gameState.player.position.set(msg.x, ty, msg.z);
                gameState.player._spawnProtection = 1.5;

                gameState.moveTarget = null;
                gameState.targetLock = null;
                _lastMoveTarget = null;
                document.getElementById('deathPopup')?.classList.add('hidden');
            }
            break;
        }
        case 'shld': {

            if (msg.vi === _myServerId) {
                showStreakPopup('SHIELD BLOCKED!', '#44aaff');
            }
            break;
        }
        case 'bought': {

            if (gameState.player) {
                gameState.player.gold = msg.g;
                gameState.player.inventory[msg.i] = true;
                gameState.player._applyItems();
                gameState.gold = msg.g;
                updateGoldUI();
                updateShopUI();
                audioManager.play('headshot');
            }
            break;
        }
        case 'ch': {

            addChatMessage(msg.n, msg.m, msg.x);
            break;
        }
        case 'gameover': {
            showMatchEnd(msg);
            break;
        }
        case 'newmatch': {
            handleNewMatch(msg);
            break;
        }
    }
}
let _matchKillLimit = 50;
let _matchTimeLimit = 1200;
let _matchStartTime = Date.now();
let _matchEndCountdown = null;

function updateTeamScore(redKills, blueKills) {
    const el = document.getElementById('teamScore');
    if (!el) return;
    el.classList.remove('hidden');
    document.getElementById('tsRedKills').textContent = redKills;
    document.getElementById('tsBlueKills').textContent = blueKills;
    document.getElementById('tsLimit').textContent = _matchKillLimit;
}

function showMatchEnd(msg) {
    const el = document.getElementById('matchEnd');
    if (!el) return;

    const isWin = msg.win === gameState.team;
    const isDraw = msg.win === 'draw';

    el.className = isDraw ? 'draw' : (isWin ? 'win' : 'lose');
    document.getElementById('matchEndTitle').textContent =
        isDraw ? 'DRAW' : (isWin ? 'VICTORY' : 'DEFEAT');
    document.getElementById('matchEndScore').innerHTML =
        '<span style="color:#ff5555">' + msg.rk + '</span>' +
        ' <span style="color:#555;font-size:0.6em;">vs</span> ' +
        '<span style="color:#55aaff">' + msg.bk + '</span>';
    const me = msg.stats && msg.stats.find(s => s.n === gameState.username);
    const yourStats = document.getElementById('matchEndYourStats');
    if (me) {
        const kd = me.d > 0 ? (me.k / me.d).toFixed(1) : me.k.toFixed(1);
        yourStats.innerHTML =
            '<div class="stat-box"><div class="stat-val">' + me.k + '</div><div class="stat-label">Kills</div></div>' +
            '<div class="stat-box"><div class="stat-val">' + me.d + '</div><div class="stat-label">Deaths</div></div>' +
            '<div class="stat-box"><div class="stat-val">' + kd + '</div><div class="stat-label">K/D</div></div>' +
            '<div class="stat-box"><div class="stat-val">' + (me.g || 0) + '</div><div class="stat-label">Gold</div></div>';
    } else {
        yourStats.innerHTML = '';
    }
    const mvp = msg.stats && msg.stats[0];
    if (mvp) {
        const mvpColor = mvp.m === 'red' ? '#ff5555' : '#55aaff';
        document.getElementById('matchEndMVP').innerHTML =
            'MVP <span style="color:' + mvpColor + ';font-weight:bold;">' + mvp.n + '</span> — ' +
            mvp.k + ' kills';
    }
    if (msg.stats) {
        let html = '';
        msg.stats.forEach(function(s) {
            const isMe = s.n === gameState.username;
            const teamClass = s.m === 'red' ? 'me-red' : 'me-blue';
            const style = isMe ? 'color:#fff;font-weight:bold;background:rgba(255,255,255,0.05);padding:1px 4px;border-radius:3px;' : '';
            html += '<div class="me-row ' + teamClass + '" style="' + style + '">' +
                s.n + (s.b ? ' [BOT]' : '') + '  ' + s.k + '/' + s.d +
                '</div>';
        });
        document.getElementById('matchEndStats').innerHTML = html;
    }

    const mins = Math.floor(msg.time / 60);
    const secs = msg.time % 60;
    const timeStr = mins + ':' + (secs < 10 ? '0' : '') + secs;

    el.classList.remove('hidden');
    document.getElementById('matchEndExit').onclick = function() {
        el.classList.add('hidden');
        if (_matchEndCountdown) { clearInterval(_matchEndCountdown); _matchEndCountdown = null; }
    };
    let remaining = 12;
    const timerEl = document.getElementById('matchEndTimer');
    timerEl.textContent = timeStr + '  •  Next match in ' + remaining + 's';
    _matchEndCountdown = setInterval(function() {
        remaining--;
        if (remaining <= 0) {
            clearInterval(_matchEndCountdown);
            timerEl.textContent = 'Starting...';
            setTimeout(() => el.classList.add('hidden'), 1000);
        } else {
            timerEl.textContent = timeStr + '  •  Next match in ' + remaining + 's';
        }
    }, 1000);
}

function handleNewMatch(msg) {

    document.getElementById('matchEnd')?.classList.add('hidden');
    document.getElementById('deathPopup')?.classList.add('hidden');
    if (_matchEndCountdown) { clearInterval(_matchEndCountdown); _matchEndCountdown = null; }
    _matchKillLimit = msg.limit || 50;
    _matchTimeLimit = msg.timeLimit || 1200;
    _matchStartTime = Date.now();
    updateTeamScore(0, 0);
    if (msg.roster) {
        for (const r of msg.roster) {
            _roster[r.id] = { username: r.n, team: r.m, isBot: !!r.b };
        }
    }
    if (gameState.player) {
        gameState.player.health = 100;
        gameState.player.kills = 0;
        gameState.player.deaths = 0;
        gameState.player.price = 1.0;
        gameState.player.gold = 0;
        gameState.player.streak = 0;
        gameState.player._streak = 0;
        gameState.player.inventory = {};
        gameState.player._applyItems();
        gameState.player.mesh.visible = true;
        gameState.player._spawnProtection = 1.5;

        const spawnX = gameState.player.team === 'red' ? -70 : 70;
        const spawnZ = gameState.player.team === 'red' ? -70 : 70;
        const spawnY = Math.sin(spawnX * 0.1) * Math.cos(spawnZ * 0.1) * 2 + 0.6;
        gameState.player.position.set(spawnX, spawnY, spawnZ);
        gameState.cameraTarget.x = spawnX;
        gameState.cameraTarget.z = spawnZ;

        gameState.moveTarget = null;
        gameState.targetLock = null;
        _lastMoveTarget = null;
        gameState.kills = 0;
        gameState.deaths = 0;
        gameState.killStreak = 0;
        gameState.gold = 0;
        gameState.firstBlood = false;
        _playerPrice = 1.0;
        _priceHistory.length = 0;
        _priceHistory.push(1.0);
        updateGoldUI();
        updateTerminal();
    }
    for (const [, remote] of _remotePlayers) {
        remote.player.kills = 0;
        remote.player.deaths = 0;
        remote.player.price = 1.0;
        remote.player.gold = 0;
        remote.player.streak = 0;
        remote.player.health = 100;
        remote.player.mesh.visible = true;
        remote.player.inventory = {};
    }

    addChatSystem('⚔ New match started — first to ' + _matchKillLimit + ' kills!');
}

function findRemoteOrLocal(serverId) {
    if (serverId === _myServerId) return gameState.player;
    const remote = _remotePlayers.get(serverId);
    return remote ? remote.player : null;
}

function updateRemotePlayers(dt) {
    const now = performance.now();
    for (const [id, remote] of _remotePlayers) {
        const p = remote.player;
        if (!p.mesh.visible) continue;
        const dx = remote.targetX - p.position.x;
        const dz = remote.targetZ - p.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist > 20) {

            p.position.x = remote.targetX;
            p.position.z = remote.targetZ;
        } else if (dist > 0.1) {
            const step = Math.min(INTERP_SPEED * dt, dist);
            p.position.x += (dx / dist) * step;
            p.position.z += (dz / dist) * step;
            p.position.y = Math.sin(p.position.x * 0.1) * Math.cos(p.position.z * 0.1) * 2 + 0.6;
            p.velocity.set(dx, 0, dz).normalize().multiplyScalar(step);
        } else {
            p.velocity.set(0, 0, 0);
        }
        let rotDiff = remote.targetRot - (p.mesh.rotation.y || 0);
        while (rotDiff > Math.PI) rotDiff -= 2 * Math.PI;
        while (rotDiff < -Math.PI) rotDiff += 2 * Math.PI;
        if (p.weapon) {
            const lookTarget = p.position.clone().add(
                new THREE.Vector3(Math.sin(remote.targetRot), 0, Math.cos(remote.targetRot)).multiplyScalar(5)
            );
            p.weapon.lookAt(lookTarget);
        }

        if (p.shootCooldown > 0) p.shootCooldown -= dt;

        if (p._spawnProtection > 0) {
            const flicker = Math.sin(Date.now() * 0.015) > 0;
            p.mesh.traverse(child => {
                if (child.material && !child.isSprite) {
                    child.material.transparent = true;
                    child.material.opacity = flicker ? 0.4 : 0.8;
                }
            });
            p._wasSpawnProt = true;
        } else if (p._wasSpawnProt) {
            p.mesh.traverse(child => {
                if (child.material && !child.isSprite) {
                    child.material.transparent = false;
                    child.material.opacity = 1;
                }
            });
            p._wasSpawnProt = false;
        }

        const isMoving = dist > 0.5;
        const time = Date.now() * 0.001;
        if (isMoving && p.leftLeg && p.rightLeg) {
            const runTime = time * 10;
            p.leftLeg.rotation.x = Math.sin(runTime) * 0.6;
            p.rightLeg.rotation.x = Math.sin(runTime + Math.PI) * 0.6;
            if (p.leftShoe) p.leftShoe.rotation.x = -Math.PI / 2 + Math.sin(runTime) * 0.3;
            if (p.rightShoe) p.rightShoe.rotation.x = -Math.PI / 2 + Math.sin(runTime + Math.PI) * 0.3;
            if (p.leftArm) p.leftArm.rotation.x = Math.sin(runTime + Math.PI) * 0.4;
            if (p.rightArm) p.rightArm.rotation.x = Math.sin(runTime) * 0.4;
            if (p.cape) p.cape.rotation.x = 0.3 + Math.sin(runTime * 1.5) * 0.15;
        } else if (p.leftLeg && p.rightLeg) {
            p.leftLeg.rotation.x = 0;
            p.rightLeg.rotation.x = 0;
            if (p.leftShoe) p.leftShoe.rotation.x = -Math.PI / 2;
            if (p.rightShoe) p.rightShoe.rotation.x = -Math.PI / 2;
            if (p.leftArm) p.leftArm.rotation.x = Math.sin(time * 2) * 0.05;
            if (p.rightArm) p.rightArm.rotation.x = Math.sin(time * 2 + 0.5) * 0.05;
            if (p.cape) p.cape.rotation.x = 0.1 + Math.sin(time * 1.5) * 0.05;
        }
    }
    if (_ws && _ws.readyState === 1 && gameState.player && gameState.player.health > 0 && isOnlineMode) {
        const now2 = performance.now();
        if (now2 - _lastSendTime > 33) { // 30hz rotation updates
            let rot;
            if (_isMobileDevice) {

                if (gameState.moveTarget) {
                    const dx = gameState.moveTarget.x - gameState.player.position.x;
                    const dz = gameState.moveTarget.z - gameState.player.position.z;
                    rot = Math.atan2(dx, dz);
                    _lastAimRot = rot;
                } else {
                    rot = _lastAimRot || 0;
                }
            } else {

                const raycaster = new THREE.Raycaster();
                raycaster.setFromCamera(gameState.mousePos, camera);
                const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
                const aimPoint = new THREE.Vector3();
                raycaster.ray.intersectPlane(plane, aimPoint);
                rot = Math.atan2(aimPoint.x - gameState.player.position.x, aimPoint.z - gameState.player.position.z);
            }
            _ws.send(JSON.stringify({ t: 'rot', r: rot }));
            _lastSendTime = now2;
        }
    }
}

const _origMouseDown = document.onmousedown;

let _lastMoveTarget = null;

function checkAndSendMove() {
    if (!isOnlineMode || !_ws || _ws.readyState !== 1) return;
    if (!gameState.moveTarget) return;

    const mt = gameState.moveTarget;
    if (_lastMoveTarget && _lastMoveTarget.x === mt.x && _lastMoveTarget.z === mt.z) return;
    _lastMoveTarget = { x: mt.x, z: mt.z };

    _ws.send(JSON.stringify({ t: 'mv', x: mt.x, z: mt.z }));
}

const _origBuyItem = Player.prototype.buyItem;
Player.prototype.buyItem = function(itemId) {
    if (isOnlineMode && _ws && _ws.readyState === 1) {
        _ws.send(JSON.stringify({ t: 'buy', i: itemId }));
        return true; // Optimistic — server confirms
    }
    return _origBuyItem.call(this, itemId);
};
document.addEventListener('keydown', (e) => {
    if (!isOnlineMode || !_ws || _ws.readyState !== 1) return;

    const chatInput = document.getElementById('chatInput');
    if (chatInput && document.activeElement === chatInput && e.key !== 'Enter') return;
    if (e.key.toLowerCase() === 'g') {
        _ws.send(JSON.stringify({ t: 'god' }));
    }
    if (e.key.toLowerCase() === 'q') {
        _ws.send(JSON.stringify({ t: 'ab', a: 'ww' }));
    }
    if (e.key.toLowerCase() === 'e' && gameState.player) {

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(gameState.mousePos, camera);
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        const pt = new THREE.Vector3();
        raycaster.ray.intersectPlane(plane, pt);
        _ws.send(JSON.stringify({ t: 'ab', a: 'fs', x: pt.x, z: pt.z }));
    }

    if (e.key === 'Enter') {
        const input = document.getElementById('chatInput');
        if (input && document.activeElement === input) {
            const text = input.value.trim();
            if (text) {
                _ws.send(JSON.stringify({ t: 'ch', x: text }));
                input.value = '';
            }
            input.blur();
            e.preventDefault();
        } else if (input) {
            input.focus();
            e.preventDefault();
        }
    }
});
function addChatMessage(name, team, text) {
    const el = document.getElementById('chatMessages');
    if (!el) return;
    const msg = document.createElement('div');
    msg.className = 'chat-msg';
    const nameClass = team === 'red' ? 'chat-name-red' : 'chat-name-blue';
    msg.innerHTML = '<span class="' + nameClass + '">' + escapeHtml(name) + ':</span> ' + escapeHtml(text);
    el.appendChild(msg);
    el.scrollTop = el.scrollHeight;

    while (el.children.length > 50) el.removeChild(el.firstChild);
}

function addChatSystem(text) {
    const el = document.getElementById('chatMessages');
    if (!el) return;
    const msg = document.createElement('div');
    msg.className = 'chat-sys';
    msg.textContent = text;
    el.appendChild(msg);
    el.scrollTop = el.scrollHeight;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
requestAnimationFrame(function netLoop() {
    requestAnimationFrame(netLoop);
    if (isOnlineMode) checkAndSendMove();
});

console.log('Multiplayer module loaded');

// Expose for wager-ui "play while waiting"
window.startGame = function(opts) {
    const username = (opts && opts.username) || gameState.username || 'Sniper';
    const team = (opts && opts.team) || gameState.team || 'red';
    isOnlineMode = false;
    gameState.username = username;
    gameState.team = team;
    gameState.gameStarted = true;
    gameState.kills = 0;
    gameState.deaths = 0;
    gameState.killStreak = 0;
    audioManager.init();
    document.getElementById('usernameModal')?.classList.add('hidden');
    document.getElementById('landingPage')?.classList.add('hidden');
    document.getElementById('gameCanvas').style.display = 'block';
    document.getElementById('ui').style.display = '';
    document.body.classList.add('game-active', 'game-playing');
    document.getElementById('hud')?.classList.remove('hidden');
    document.getElementById('abilities')?.classList.remove('hidden');
    document.querySelector('.minimap')?.classList.remove('hidden');
    document.getElementById('teamScore')?.classList.remove('hidden');
    startGame();
};
window.gameState = gameState;
window._remotePlayers = _remotePlayers;
window._serverState = _serverState;

window._startWagerGame = function(ws, matchData) {
    console.log('[WAGER] Starting wager game', matchData);
    const user = window._wagerUser;
    gameState.username = user?.twitter_handle || user?.display_name || 'Player';
    gameState.team = matchData.isCreator ? 'red' : 'blue';
    gameState.gameStarted = true;
    isOnlineMode = true;
    window._isWagerMatch = true;
    _ws = ws;
    _ws.binaryType = 'arraybuffer';
    _ws.addEventListener('message', function(evt) {
        const data = evt.data;
        if (typeof data === 'string') {
            try { handleJsonMessage(JSON.parse(data)); } catch(e) {}
        } else if (data instanceof ArrayBuffer) {
            handleBinaryState(data);
        } else if (data instanceof Blob) {
            data.arrayBuffer().then(ab => handleBinaryState(ab));
        }
    });
    document.getElementById('landingPage')?.classList.add('hidden');
    document.getElementById('usernameModal')?.classList.add('hidden');
    document.getElementById('gameCanvas').style.display = 'block';
    document.getElementById('ui').style.display = '';
    document.body.classList.add('game-active', 'game-playing');
    document.getElementById('hud')?.classList.remove('hidden');
    document.getElementById('abilities')?.classList.remove('hidden');
    document.querySelector('.minimap')?.classList.remove('hidden');
    document.getElementById('teamScore')?.classList.add('hidden');
    document.getElementById('shopPanel')?.classList.add('hidden');

    document.getElementById('goldDisplay')?.style.setProperty('display', 'none');
    if (!window._gameStarted) {
        startGame();
        window._gameStarted = true;
    } else {

        if (gameState.player && gameState.player.mesh.parent) {
            gameState.player.mesh.parent.remove(gameState.player.mesh);
        }
        gameState.player = new Player(gameState.username, gameState.team, true);
        gameState.cameraTarget.copy(gameState.player.position);

        _remotePlayers.forEach((r) => { if (r.player.mesh.parent) r.player.mesh.parent.remove(r.player.mesh); });
        _remotePlayers.clear();
        _serverState.clear();
        _roster = {};
    }
    _ws.send(JSON.stringify({
        t: 'join',
        n: gameState.username,
        m: gameState.team
    }));
};
