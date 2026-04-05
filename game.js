import * as THREE from 'three';

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
    // Camera controls
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

// === SHOP ITEM DEFINITIONS ===
const SHOP_ITEMS = {
    boots1:    { name: 'Swift Boots',      cost: 100, icon: '🥾', desc: '+20% speed',        stat: 'speed',     mult: 1.2, tier: 1, group: 'boots' },
    boots2:    { name: 'Windrider Boots',  cost: 300, icon: '💨', desc: '+50% speed',        stat: 'speed',     mult: 1.5, tier: 2, group: 'boots', requires: 'boots1' },
    cloak1:    { name: 'Shadow Cloak',     cost: 150, icon: '🌑', desc: '+3s windwalk',      stat: 'wwDur',     val: 3,    tier: 1, group: 'cloak' },
    cloak2:    { name: 'Phantom Shroud',   cost: 400, icon: '👻', desc: '+6s windwalk',      stat: 'wwDur',     val: 6,    tier: 2, group: 'cloak', requires: 'cloak1' },
    scope1:    { name: 'Scout Scope',      cost: 150, icon: '🔭', desc: '+25% range',        stat: 'range',     mult: 1.25, tier: 1, group: 'scope' },
    scope2:    { name: 'Eagle Eye',        cost: 400, icon: '🦅', desc: '+50% range',        stat: 'range',     mult: 1.5, tier: 2, group: 'scope', requires: 'scope1' },
    ward:      { name: 'Vision Ward',      cost: 75,  icon: '👁', desc: 'Place a ward',      stat: 'ward',      val: 1,    tier: 1, group: 'ward', stackable: true },
    shield:    { name: 'Iron Buckler',     cost: 200, icon: '🛡', desc: 'Survive 1 shot',    stat: 'shield',    val: 1,    tier: 1, group: 'shield' },
    rapidfire: { name: 'Hair Trigger',     cost: 250, icon: '⚡', desc: '-30% shot cooldown', stat: 'firerate',  mult: 0.7, tier: 1, group: 'firerate' },
    bounty:    { name: 'Bounty Hunter',    cost: 200, icon: '💰', desc: '+50% gold per kill', stat: 'goldMult',  mult: 1.5, tier: 1, group: 'bounty' },
};

// === AUDIO SYSTEM — Web Audio API for zero-skip playback ===
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
            firstBlood: 'sounds/first_blood.wav',
            doubleKill: 'sounds/Double_Kill.wav',
            multiKill: 'sounds/MultiKill.wav',
            megaKill: 'sounds/MegaKill.wav',
            ultraKill: 'sounds/UltraKill.wav',
            monsterKill: 'sounds/MonsterKill.wav',
            ludicrousKill: 'sounds/LudicrousKill.wav',
            killingSpree: 'sounds/Killing_Spree.wav',
            rampage: 'sounds/Rampage.wav',
            dominating: 'sounds/Dominating.wav',
            unstoppable: 'sounds/Unstoppable.wav',
            godlike: 'sounds/GodLike.wav',
            headshot: 'sounds/Headshot.wav',
            sniperFire: 'sounds/sniper_fire_h3_1.wav'
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

// === RUNESCAPE-STYLE PROCEDURAL SOUNDTRACK ===
class MedievalSoundtrack {
    constructor() {
        this.ctx = null;
        this.masterGain = null;
        this.playing = false;
        this.volume = 0.85;
        this.timers = [];
    }

    start(audioCtx) {
        if (this.playing) return;
        this.ctx = audioCtx;
        this.playing = true;

        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = this.volume;
        this.masterGain.connect(this.ctx.destination);

        this.bpm = 120;
        this.beat = 60 / this.bpm; // seconds per beat

        // D minor pentatonic + natural minor for that RS feel
        // D4=293.66 E4=329.63 F4=349.23 G4=392 A4=440 Bb4=466.16 C5=523.25 D5=587.33
        this.notes = {
            D3: 146.83, E3: 164.81, F3: 174.61, G3: 196.00, A3: 220.00, Bb3: 233.08, C4: 261.63,
            D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.00, A4: 440.00, Bb4: 466.16, C5: 523.25,
            D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.00,
        };

        // Pre-composed melody phrases (scale degrees in D minor)
        // Each phrase = [[note, duration_in_beats], ...]
        this.melodyPhrases = [
            // Heroic ascending — like "Newbie Melody"
            [['D4',1],['F4',0.5],['A4',0.5],['D5',1.5],['C5',0.5],['A4',1],['Bb4',0.5],['A4',0.5],['G4',1],['F4',1]],
            // Descending run
            [['D5',1],['C5',0.5],['Bb4',0.5],['A4',1],['G4',0.5],['F4',0.5],['E4',0.5],['D4',1.5]],
            // Call and response
            [['A4',0.75],['Bb4',0.25],['A4',0.5],['G4',0.5],['F4',1],['E4',0.5],['F4',0.5],['G4',0.5],['A4',1.5]],
            // Bold fanfare
            [['D4',0.5],['D4',0.5],['A4',1],['A4',0.5],['Bb4',0.5],['A4',0.5],['G4',0.5],['F4',1],['D4',1]],
            // Marching theme
            [['D4',0.5],['F4',0.5],['G4',0.5],['A4',0.5],['Bb4',1],['A4',0.5],['G4',0.5],['A4',0.5],['F4',0.5],['D4',1]],
            // Longing phrase
            [['A4',1.5],['G4',0.5],['F4',1],['G4',1],['A4',0.5],['Bb4',0.5],['C5',1],['A4',1]],
        ];

        // Chord progressions: Dm - Bb - C - Dm, Dm - F - Gm - Am, etc.
        this.chordProgs = [
            [['D3','F3','A3'], ['Bb3','D4','F3'], ['C4','E3','G3'], ['D3','F3','A3']],
            [['D3','F3','A3'], ['F3','A3','C4'], ['G3','Bb3','D4'], ['A3','C4','E4']],
            [['D3','F3','A3'], ['G3','Bb3','D4'], ['Bb3','D4','F3'], ['A3','C4','E4']],
        ];
        this.currentChordProg = 0;
        this.currentChord = 0;

        this._startBass();
        this._startMelody();
        this._startHarpsichord();
        this._startPercussion();
        this._startStrings();
    }

    stop() {
        this.playing = false;
        this.timers.forEach(t => clearTimeout(t));
        this.timers = [];
        if (this.masterGain) {
            this.masterGain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 1);
        }
    }

    // Synth voice — type, freq, start, duration, volume, attack, release
    _voice(type, freq, time, dur, vol, attack = 0.01, release = 0.1) {
        const now = this.ctx.currentTime + time;
        const osc = this.ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = freq;

        const env = this.ctx.createGain();
        env.gain.setValueAtTime(0, now);
        env.gain.linearRampToValueAtTime(vol, now + attack);
        env.gain.setValueAtTime(vol, now + dur - release);
        env.gain.linearRampToValueAtTime(0, now + dur);

        osc.connect(env).connect(this.masterGain);
        osc.start(now);
        osc.stop(now + dur + 0.01);
    }

    // Pluck sound — harpsichord / lute
    _pluck(freq, time, dur, vol) {
        const now = this.ctx.currentTime + time;
        const osc = this.ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = freq;

        const osc2 = this.ctx.createOscillator();
        osc2.type = 'square';
        osc2.frequency.value = freq;

        const mix = this.ctx.createGain();
        mix.gain.value = 0.3; // Blend square for brightness

        const env = this.ctx.createGain();
        env.gain.setValueAtTime(0, now);
        env.gain.linearRampToValueAtTime(vol, now + 0.005);
        env.gain.exponentialRampToValueAtTime(0.001, now + dur);

        osc.connect(env);
        osc2.connect(mix).connect(env);
        env.connect(this.masterGain);
        osc.start(now);
        osc2.start(now);
        osc.stop(now + dur);
        osc2.stop(now + dur);
    }

    _drum(freq, vol, decay) {
        const now = this.ctx.currentTime;
        const noise = this.ctx.createBufferSource();
        const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.2, this.ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        noise.buffer = buf;

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = freq;

        const env = this.ctx.createGain();
        env.gain.setValueAtTime(vol, now);
        env.gain.exponentialRampToValueAtTime(0.001, now + decay);

        noise.connect(filter).connect(env).connect(this.masterGain);
        noise.start(now);
        noise.stop(now + decay);
    }

    // Brass-like lead melody — the iconic RS sound
    _startMelody() {
        let phraseIdx = 0;
        const playPhrase = () => {
            if (!this.playing) return;

            const phrase = this.melodyPhrases[phraseIdx % this.melodyPhrases.length];
            phraseIdx++;
            let t = 0;

            for (const [noteName, beats] of phrase) {
                const freq = this.notes[noteName];
                const dur = beats * this.beat;
                // Loud brass lead — square + triangle + octave shimmer
                this._voice('square', freq, t, dur * 0.9, 0.22, 0.015, 0.05);
                this._voice('triangle', freq, t, dur * 0.9, 0.18, 0.015, 0.05);
                this._voice('sine', freq * 2, t, dur * 0.9, 0.06, 0.02, 0.08); // Octave above for brightness
                t += dur;
            }

            // Short rest (1 bar) then next phrase — keeps it continuous
            const rest = this.beat * 4;
            this.timers.push(setTimeout(playPhrase, (t + rest) * 1000));
        };
        // Start immediately
        playPhrase();
    }

    // Harpsichord arpeggios — classic RS accompaniment
    _startHarpsichord() {
        const arp = () => {
            if (!this.playing) return;

            const prog = this.chordProgs[this.currentChordProg];
            const chord = prog[this.currentChord];
            let t = 0;

            // Arpeggiate the chord up and down (sixteenth notes)
            const pattern = [...chord, ...chord.slice().reverse()];
            for (const noteName of pattern) {
                const freq = this.notes[noteName] * 2; // Up an octave
                this._pluck(freq, t, this.beat * 0.4, 0.16);
                t += this.beat / 4;
            }

            this.currentChord = (this.currentChord + 1) % prog.length;
            if (this.currentChord === 0) {
                this.currentChordProg = Math.floor(Math.random() * this.chordProgs.length);
            }

            this.timers.push(setTimeout(arp, this.beat * 2 * 1000));
        };
        arp();
    }

    // Sustained string pad — warmth underneath
    _startStrings() {
        const pad = () => {
            if (!this.playing) return;

            const prog = this.chordProgs[this.currentChordProg];
            const chord = prog[this.currentChord];
            const dur = this.beat * 4;

            for (const noteName of chord) {
                const freq = this.notes[noteName];
                this._voice('sawtooth', freq, 0, dur, 0.04, 0.5, 0.5);
                // Slight detune for richness
                this._voice('sawtooth', freq * 1.003, 0, dur, 0.03, 0.5, 0.5);
            }

            this.timers.push(setTimeout(pad, dur * 1000));
        };
        this.timers.push(setTimeout(pad, 500));
    }

    // Walking bass line
    _startBass() {
        const bassPatterns = [
            ['D3','D3','A3','G3'],
            ['D3','F3','G3','A3'],
            ['Bb3','A3','G3','F3'],
            ['D3','G3','A3','D3'],
        ];
        let patIdx = 0;
        let noteIdx = 0;

        const playBass = () => {
            if (!this.playing) return;
            const pat = bassPatterns[patIdx % bassPatterns.length];
            const noteName = pat[noteIdx % pat.length];
            const freq = this.notes[noteName] / 2; // Down an octave for deep bass

            this._voice('triangle', freq, 0, this.beat * 0.8, 0.15, 0.01, 0.1);
            // Sub-octave for weight
            this._voice('sine', freq / 2, 0, this.beat * 0.8, 0.1, 0.01, 0.1);

            noteIdx++;
            if (noteIdx % 4 === 0) patIdx++;

            this.timers.push(setTimeout(playBass, this.beat * 1000));
        };
        playBass();
    }

    // Steady march percussion
    _startPercussion() {
        // 8 eighth-notes per bar: BOOM . tap . BOOM tap TAP .
        const pattern = [
            { t: 'k', v: 0.2 },
            null,
            { t: 's', v: 0.08 },
            null,
            { t: 'k', v: 0.15 },
            { t: 's', v: 0.06 },
            { t: 's', v: 0.12 },
            null,
        ];
        let step = 0;
        const tick = () => {
            if (!this.playing) return;
            const p = pattern[step % pattern.length];
            if (p) {
                if (p.t === 'k') this._drum(120, p.v, 0.15);
                else this._drum(1200, p.v, 0.06);
            }
            step++;
            this.timers.push(setTimeout(tick, (this.beat / 2) * 1000));
        };
        tick();
    }
}

const soundtrack = new MedievalSoundtrack();

// Three.js Setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2a30);
scene.fog = new THREE.Fog(0x2a2a30, 100, 300);

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

// Lighting - Much brighter!
const ambientLight = new THREE.AmbientLight(0x888888, 1.2); // Brighter ambient
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffffee, 1.5); // Brighter sun-like light
dirLight.position.set(50, 100, 50);
dirLight.castShadow = true;
dirLight.shadow.camera.left = -150;
dirLight.shadow.camera.right = 150;
dirLight.shadow.camera.top = 150;
dirLight.shadow.camera.bottom = -150;
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
scene.add(dirLight);

// Add a hemisphere light for better overall illumination
const hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x3a4a2a, 0.6);
scene.add(hemiLight);

// Add initial preview scene
const previewGeometry = new THREE.PlaneGeometry(80, 80);
const previewMaterial = new THREE.MeshStandardMaterial({
    color: 0x2a3a2a,
    roughness: 0.8
});
const previewGround = new THREE.Mesh(previewGeometry, previewMaterial);
previewGround.rotation.x = -Math.PI / 2;
previewGround.receiveShadow = true;
scene.add(previewGround);

// Map Creation (inspired by StarCraft Snipers middle section)
const MAP_SIZE = 200; // Much larger map!
const createMap = () => {
    // Ground with texture variation
    const groundGeometry = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, 50, 50);

    // Add height variation to ground
    const vertices = groundGeometry.attributes.position.array;
    for (let i = 0; i < vertices.length; i += 3) {
        const x = vertices[i];
        const z = vertices[i + 1];
        // Create gentle hills using noise
        vertices[i + 2] = Math.sin(x * 0.1) * Math.cos(z * 0.1) * 2;
    }
    groundGeometry.computeVertexNormals();

    const groundMaterial = new THREE.MeshStandardMaterial({
        color: 0x3a4a2a,
        roughness: 0.9,
        metalness: 0.1
    });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    // Terrain height helper
    const terrainY = (x, z) => Math.sin(x * 0.1) * Math.cos(z * 0.1) * 2;

    // Create trees
    const createTree = (x, z) => {
        const treeGroup = new THREE.Group();

        const trunkGeometry = new THREE.CylinderGeometry(0.3, 0.4, 3, 8);
        const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x4a3520 });
        const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
        trunk.position.y = 1.5;
        trunk.castShadow = true;
        treeGroup.add(trunk);

        const foliageGeometry = new THREE.ConeGeometry(1.5, 3, 8);
        const foliageMaterial = new THREE.MeshStandardMaterial({ color: 0x2d5016 });
        const foliage = new THREE.Mesh(foliageGeometry, foliageMaterial);
        foliage.position.y = 4;
        foliage.castShadow = true;
        treeGroup.add(foliage);

        treeGroup.position.set(x, terrainY(x, z), z);
        treeGroup.userData.isWall = true;
        scene.add(treeGroup);
        return treeGroup;
    };

    // Static trees from map-data.json (matches server collision)
    const _staticTrees = [[-30,20],[25,-15],[-45,-30],[50,25],[-20,45],[35,-40],[-55,5],[15,50],[-10,-35],[60,-10],[-35,60],[40,45],[-50,-45],[20,-60],[-15,-50],[55,-35],[-40,25],[30,15],[-25,-15],[45,-5],[-60,40],[10,35],[-5,-55],[50,55],[-30,-60],[65,30],[-45,50],[20,-30],[-55,-15],[35,65],[-20,30],[55,-50],[-65,15],[40,-15],[-10,60],[25,-45],[-35,-25],[60,50],[-50,35],[15,-55],[-25,-45],[45,20],[-40,-10],[30,55],[-15,15],[50,-25],[-55,-50],[20,40],[-30,50],[65,-20],[-45,-5],[35,-55],[-60,55],[10,-40],[-5,25],[55,10]];
    _staticTrees.forEach(([x,z]) => createTree(x, z));

    // Rocks/Boulders for cover
    const createRock = (x, z, size) => {
        const rockGeometry = new THREE.DodecahedronGeometry(size, 0);
        const rockMaterial = new THREE.MeshStandardMaterial({
            color: 0x666666,
            roughness: 0.95,
            metalness: 0
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

    // Static rocks from map-data.json (matches server collision)
    const _staticRocks = [[-25,10,1.2],[30,-20,1.5],[-40,-35,0.9],[50,15,1.8],[-15,40,1.1],[35,-50,1.4],[-55,20,1.0],[20,55,1.6],[-10,-25,0.8],[60,-5,1.3],[-35,55,1.5],[45,35,1.0],[-50,-40,1.7],[15,-55,0.9],[-20,-50,1.2],[55,-30,1.1],[-45,15,1.4],[25,25,0.8],[-30,-10,1.6],[40,-40,1.3],[-60,45,1.0],[10,30,1.5],[-5,-45,1.2],[50,50,1.8],[-25,-55,0.9],[65,20,1.1],[-40,40,1.4],[20,-35,1.0],[-55,-20,1.3],[35,60,1.5]];
    _staticRocks.forEach(([x,z,s]) => createRock(x, z, s));

    // Walls/Boundaries
    const wallMaterial = new THREE.MeshStandardMaterial({
        color: 0x3a3a3a,
        roughness: 0.9
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

    // Outer walls
    createWall(0, MAP_SIZE/2, MAP_SIZE, 2);
    createWall(0, -MAP_SIZE/2, MAP_SIZE, 2);
    createWall(MAP_SIZE/2, 0, 2, MAP_SIZE);
    createWall(-MAP_SIZE/2, 0, 2, MAP_SIZE);

    // Center structure (inspired by WC3 map)
    createWall(0, 0, 15, 3);
    createWall(0, 10, 3, 10);
    createWall(0, -10, 3, 10);
    createWall(15, 8, 12, 3);
    createWall(-15, 8, 12, 3);
    createWall(15, -8, 12, 3);
    createWall(-15, -8, 12, 3);

    // Static scattered walls from map-data.json (matches server collision)
    const _staticWalls = [[-45,35,6,4],[30,-50,5,7],[-60,-20,4,5],[55,40,7,3],[-25,55,5,6],[40,-25,3,8],[-50,-55,6,4],[60,15,4,5],[-35,-40,5,3],[25,60,7,4],[-55,10,4,6],[45,-60,5,5],[-20,-65,6,3],[35,30,3,7],[-40,65,5,4]];
    _staticWalls.forEach(([x,z,w,h]) => createWall(x, z, w, h));

    // Team spawn markers
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

// Fog of War — pure distance-based vision
// Vision radius = shoot range. No canvas overlay tricks.
const VISION_RADIUS = 50;
const FARSIGHT_RADIUS = 70;

class FogOfWar {
    constructor() {
        this.visionSources = [];
        this.fogMesh = null;
        this.canvas = document.createElement('canvas');
        this.canvas.width = 256;
        this.canvas.height = 256;
        this.ctx = this.canvas.getContext('2d');
    }

    init() {
        this.fogTexture = new THREE.CanvasTexture(this.canvas);
        this.fogTexture.magFilter = THREE.LinearFilter;
        this.fogTexture.minFilter = THREE.LinearFilter;

        const fogMaterial = new THREE.MeshBasicMaterial({
            map: this.fogTexture,
            transparent: true,
            opacity: 0.55,
            color: 0x000000,
            depthWrite: false,
            depthTest: false,
        });

        const fogGeometry = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE);
        this.fogMesh = new THREE.Mesh(fogGeometry, fogMaterial);
        this.fogMesh.rotation.x = -Math.PI / 2;
        this.fogMesh.position.y = 10;
        this.fogMesh.renderOrder = 10000;
        scene.add(this.fogMesh);
    }

    update(player, allUnits, farsightPositions = []) {
        this.visionSources = [];

        // Player vision
        if (player && player.health > 0) {
            this.visionSources.push({ x: player.position.x, z: player.position.z, r: VISION_RADIUS });
        }

        // Teammate vision
        allUnits.forEach(unit => {
            if (unit.team === gameState.team && unit.health > 0 && unit !== player) {
                this.visionSources.push({ x: unit.position.x, z: unit.position.z, r: VISION_RADIUS });
            }
        });

        // Farsight vision
        farsightPositions.forEach(pos => {
            this.visionSources.push({ x: pos.x, z: pos.z, r: FARSIGHT_RADIUS });
        });

        // Render visual fog overlay
        this.ctx.fillStyle = 'rgba(0, 0, 0, 1)';
        this.ctx.fillRect(0, 0, 256, 256);

        this.ctx.globalCompositeOperation = 'destination-out';
        for (const src of this.visionSources) {
            const x = ((src.x + MAP_SIZE / 2) / MAP_SIZE) * 256;
            const y = ((src.z + MAP_SIZE / 2) / MAP_SIZE) * 256;
            const rPx = (src.r / MAP_SIZE) * 256;

            const gradient = this.ctx.createRadialGradient(x, y, 0, x, y, rPx);
            gradient.addColorStop(0, 'rgba(255,255,255,1)');
            gradient.addColorStop(0.8, 'rgba(255,255,255,1)');
            gradient.addColorStop(1, 'rgba(255,255,255,0)');

            this.ctx.fillStyle = gradient;
            this.ctx.beginPath();
            this.ctx.arc(x, y, rPx, 0, Math.PI * 2);
            this.ctx.fill();
        }
        this.ctx.globalCompositeOperation = 'source-over';

        this.fogTexture.needsUpdate = true;
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

// Player Class
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
        this.shootRange = 45;
        this.damage = 25;
        this._spawnProtection = 3.0; // 3s invulnerable on spawn
        this.price = 1.00; // Everyone is a token
        this.isWindwalking = false;
        this.farsightActive = false;
        this.farsightPosition = null;

        // Auto-shoot cooldown
        this.shootCooldown = 0;
        this.shootCooldownTime = 1.0; // 1 second between shots

        // Gold + Inventory
        this.gold = 0;
        this.inventory = {}; // { itemId: true }
        this.wardCharges = 0;
        this.hasShield = false;
        this.goldMultiplier = 1.0;
        this.baseSpeed = 8;
        this.baseRange = 45;
        this.baseCooldown = 1.0;

        this.createMesh(team);
        this.position = this.mesh.position;

        // Spawn position
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
        const robeColor = team === 'red' ? 0x881111 : 0x112288;
        const robeDark = team === 'red' ? 0x550a0a : 0x0a1155;
        const robeLight = team === 'red' ? 0xaa3333 : 0x3344aa;
        const cloth = new THREE.MeshStandardMaterial({ color: robeColor, roughness: 0.9 });
        const clothDark = new THREE.MeshStandardMaterial({ color: robeDark, roughness: 0.9 });

        // === LEGS — thin sticks under the robe ===
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

        // === POINTY SHOES ===
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

        // === ROBE BODY — tapered cylinder, wider at bottom ===
        const robeGeo = new THREE.CylinderGeometry(0.2, 0.45, 1.1, 6);
        const robe = new THREE.Mesh(robeGeo, cloth);
        robe.position.y = 0.45;
        robe.castShadow = true;
        group.add(robe);

        // Belt/sash
        const beltGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.08, 6);
        const beltMat = new THREE.MeshStandardMaterial({ color: 0x886622, roughness: 0.7, metalness: 0.3 });
        const belt = new THREE.Mesh(beltGeo, beltMat);
        belt.position.y = 0.2;
        group.add(belt);

        // === WIZARD HAT — the head IS the hat ===
        const hatGroup = new THREE.Group();
        hatGroup.position.y = 1.05;

        // Hat brim — wide flat disc
        const brimGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.06, 8);
        const hatMat = new THREE.MeshStandardMaterial({ color: robeDark, roughness: 0.8 });
        const brim = new THREE.Mesh(brimGeo, hatMat);
        brim.position.y = -0.05;
        hatGroup.add(brim);

        // Hat cone — tall and pointy, slightly bent
        const coneGeo = new THREE.ConeGeometry(0.28, 0.9, 6);
        const cone = new THREE.Mesh(coneGeo, hatMat);
        cone.position.y = 0.4;
        cone.rotation.z = 0.15; // Slight tilt
        cone.castShadow = true;
        hatGroup.add(cone);

        // Hat tip — small sphere at the bent tip
        const tipGeo = new THREE.SphereGeometry(0.06, 4, 4);
        const tipMat = new THREE.MeshStandardMaterial({ color: robeLight, roughness: 0.7, emissive: robeLight, emissiveIntensity: 0.3 });
        const tip = new THREE.Mesh(tipGeo, tipMat);
        tip.position.set(0.12, 0.85, 0);
        hatGroup.add(tip);

        // Hat band — stripe of accent color
        const bandGeo = new THREE.CylinderGeometry(0.29, 0.29, 0.06, 6);
        const bandMat = new THREE.MeshStandardMaterial({ color: 0x886622, roughness: 0.6, metalness: 0.4 });
        const band = new THREE.Mesh(bandGeo, bandMat);
        band.position.y = 0.02;
        hatGroup.add(band);

        // Visor glow — two small glowing eyes under the brim
        const eyeGeo = new THREE.SphereGeometry(0.04, 4, 4);
        const eyeMat = new THREE.MeshBasicMaterial({
            color: team === 'red' ? 0xff4444 : 0x4488ff,
        });
        const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
        leftEye.position.set(-0.1, -0.12, 0.2);
        hatGroup.add(leftEye);
        const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
        rightEye.position.set(0.1, -0.12, 0.2);
        hatGroup.add(rightEye);

        group.add(hatGroup);

        // === ARMS — thin sleeves ===
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

        // === OVERSIZED SNIPER RIFLE ===
        const rifleGroup = new THREE.Group();
        const gunMetal = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.3, metalness: 0.9 });
        const woodMat = new THREE.MeshStandardMaterial({ color: 0x4a2a10, roughness: 0.8, metalness: 0.1 });

        // Barrel — extra long and thick
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.8, 6), gunMetal);
        barrel.rotation.x = Math.PI / 2;
        barrel.position.z = 1.2;
        barrel.castShadow = true;
        rifleGroup.add(barrel);

        // Muzzle brake
        const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.06, 0.2, 6), gunMetal);
        muzzle.rotation.x = Math.PI / 2;
        muzzle.position.z = 2.7;
        rifleGroup.add(muzzle);

        // Receiver body — chunky box
        const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.22, 0.8), gunMetal);
        receiver.position.set(0, 0.02, 0.1);
        receiver.castShadow = true;
        rifleGroup.add(receiver);

        // Scope — oversized
        const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.8, 6), new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.3, metalness: 0.9 }));
        scope.rotation.x = Math.PI / 2;
        scope.position.set(0, 0.2, 0.5);
        scope.castShadow = true;
        rifleGroup.add(scope);

        // Scope lens
        const lens = new THREE.Mesh(new THREE.CircleGeometry(0.09, 8), new THREE.MeshStandardMaterial({
            color: 0x2244aa, roughness: 0.1, metalness: 1, emissive: 0x0000aa, emissiveIntensity: 0.3
        }));
        lens.position.set(0, 0.2, 0.91);
        rifleGroup.add(lens);

        // Scope mount rings
        for (let i = 0; i < 2; i++) {
            const mount = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.02, 6, 8), gunMetal);
            mount.rotation.y = Math.PI / 2;
            mount.position.set(0, 0.2, 0.25 + i * 0.5);
            rifleGroup.add(mount);
        }

        // Stock — big chunky wood
        const stock = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.28, 0.7), woodMat);
        stock.position.set(0, 0, -0.4);
        stock.castShadow = true;
        rifleGroup.add(stock);

        // Stock butt
        const stockEnd = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), woodMat);
        stockEnd.position.z = -0.75;
        stockEnd.scale.set(1.5, 2, 0.8);
        rifleGroup.add(stockEnd);

        // Grip
        const grip = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.3, 0.2), woodMat);
        grip.position.set(0, -0.18, 0.2);
        rifleGroup.add(grip);

        // Magazine — oversized box mag
        const mag = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.35, 0.14), gunMetal);
        mag.position.set(0, -0.12, 0.05);
        rifleGroup.add(mag);

        // Bolt handle
        const bolt = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.18), gunMetal);
        bolt.position.set(0.06, 0.05, 0);
        rifleGroup.add(bolt);

        rifleGroup.position.set(0.3, 0.5, 0.3);
        rifleGroup.rotation.y = 0.1;
        group.add(rifleGroup);

        this.rifleGroup = rifleGroup;
        this.weapon = rifleGroup;

        // === CAPE — long flowing cape on all characters ===
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

        // === NAMEPLATE ===
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

        // === PLAYER GROUND HALO ===
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
        // Health (no bar — instant kill game)

        // Windwalk effect
        if (this.isWindwalking) {
            this.mesh.children[0].material.transparent = true;
            this.mesh.children[0].material.opacity = 0.3;
            this.speed = this.windwalkSpeed;
        } else {
            this.mesh.children[0].material.transparent = false;
            this.mesh.children[0].material.opacity = 1.0;
            this.speed = this.normalSpeed;
        }

        // Animation
        const isMoving = this.velocity.length() > 0.01;
        const time = Date.now() * 0.001;

        if (isMoving && this.leftLeg && this.rightLeg) {
            const runTime = time * 10;

            // Leg swing
            this.leftLeg.rotation.x = Math.sin(runTime) * 0.6;
            this.rightLeg.rotation.x = Math.sin(runTime + Math.PI) * 0.6;

            // Shoe follows leg
            if (this.leftShoe) this.leftShoe.rotation.x = -Math.PI / 2 + Math.sin(runTime) * 0.3;
            if (this.rightShoe) this.rightShoe.rotation.x = -Math.PI / 2 + Math.sin(runTime + Math.PI) * 0.3;

            // Arm swing (opposite to legs)
            if (this.leftArm) this.leftArm.rotation.x = Math.sin(runTime + Math.PI) * 0.4;
            if (this.rightArm) this.rightArm.rotation.x = Math.sin(runTime) * 0.4;

            // Body bob
            this.mesh.position.y += Math.sin(runTime * 2) * 0.025;

            // Cape billows back when running
            if (this.cape) this.cape.rotation.x = 0.3 + Math.sin(runTime * 1.5) * 0.15;
        } else if (this.leftLeg && this.rightLeg) {
            // Idle pose — gentle sway
            this.leftLeg.rotation.x = 0;
            this.rightLeg.rotation.x = 0;
            if (this.leftShoe) this.leftShoe.rotation.x = -Math.PI / 2;
            if (this.rightShoe) this.rightShoe.rotation.x = -Math.PI / 2;

            // Gentle breathing sway
            if (this.leftArm) this.leftArm.rotation.x = Math.sin(time * 2) * 0.05;
            if (this.rightArm) this.rightArm.rotation.x = Math.sin(time * 2 + 0.5) * 0.05;

            // Cape gentle sway
            if (this.cape) this.cape.rotation.x = 0.1 + Math.sin(time * 1.5) * 0.05;

            // Idle bob
            this.mesh.position.y += Math.sin(time * 2) * 0.008;
        }

        // Spawn protection countdown + visual
        if (this._spawnProtection > 0) {
            this._spawnProtection -= deltaTime;
            // Flicker transparency to show invulnerability
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

        // Update shoot cooldown
        if (this.shootCooldown > 0) {
            this.shootCooldown -= deltaTime;
        }

        // Auto-shoot at enemies in FOV (offline only — server handles shooting in online mode)
        if (!isOnlineMode && this.health > 0 && this.shootCooldown <= 0) {
            this.autoShootAtEnemies();
        }

        // Bot AI
        if (!this.isPlayer) {
            this.botAI(deltaTime);
        }
    }

    autoShootAtEnemies() {
        // Get all potential enemies
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

        // Get weapon direction (where the rifle is pointing)
        const weaponDirection = new THREE.Vector3(0, 0, 1);
        if (this.weapon) {
            weaponDirection.applyQuaternion(this.weapon.getWorldQuaternion(new THREE.Quaternion()));
        }

        const fovAngle = 30; // 30 degree FOV cone
        const fovRadians = (fovAngle * Math.PI) / 180;

        // Check each enemy
        for (let enemy of visibleEnemies) {
            const toEnemy = new THREE.Vector3().subVectors(enemy.position, this.position).normalize();
            const angle = weaponDirection.angleTo(toEnemy);

            // If enemy is within FOV cone and in range
            if (angle < fovRadians) {
                const distance = this.position.distanceTo(enemy.position);
                if (distance <= this.shootRange) {
                    // Double-check fog of war visibility
                    const enemyVisible = fogOfWar.isVisible(enemy.position.x, enemy.position.z);
                    if (!enemyVisible) {
                        continue; // Skip this enemy, can't see them in fog
                    }

                    // Check line of sight (walls blocking) — raycast from chest height
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
                        // SHOOT!
                        this.shoot(enemy);
                        this.shootCooldown = this.shootCooldownTime;
                        return; // Only shoot one target per check
                    }
                }
            }
        }
    }

    botAI(deltaTime) {
        // Bot AI: roam, camp, explore, avoid piling up

        // Initialize bot state
        if (!this._botState) {
            this._botState = 'explore'; // explore, camp, chase
            this._campTimer = 0;
            this._campDuration = 0;
            this._stuckFrames = 0;
            this._lastPos = this.position.clone();
        }

        // === STATE: CAMPING — sit still for a while, watch for enemies ===
        if (this._botState === 'camp') {
            this._campTimer += deltaTime;
            this.velocity.set(0, 0, 0); // Stop moving

            // Slowly rotate to look around while camping
            if (this.rifleGroup) {
                const lookAngle = Math.sin(Date.now() * 0.001) * Math.PI * 0.5;
                const lookTarget = this.position.clone().add(new THREE.Vector3(Math.sin(lookAngle), 0, Math.cos(lookAngle)).multiplyScalar(5));
                this.rifleGroup.lookAt(lookTarget);
            }

            if (this._campTimer >= this._campDuration) {
                this._botState = 'explore';
                this.targetPosition = null;
            }
        }

        // === STATE: EXPLORE — pick a destination and walk there ===
        if (this._botState === 'explore' || this._botState === 'chase') {
            // Pick new target if needed
            if (!this.targetPosition || this.position.distanceTo(this.targetPosition) < 3) {
                // Chance to camp instead of picking a new target
                if (Math.random() < 0.25 && this._botState !== 'chase') {
                    this._botState = 'camp';
                    this._campTimer = 0;
                    this._campDuration = 3 + Math.random() * 8; // Camp 3-11 seconds
                    this.velocity.set(0, 0, 0);
                } else {
                    // Pick new position — avoid other bots
                    for (let attempt = 0; attempt < 15; attempt++) {
                        const x = (Math.random() - 0.5) * (MAP_SIZE * 0.8);
                        const z = (Math.random() - 0.5) * (MAP_SIZE * 0.8);
                        const candidate = new THREE.Vector3(x, 0.5, z);

                        // Check distance from edges
                        if (Math.abs(x) > MAP_SIZE / 2 - 15 || Math.abs(z) > MAP_SIZE / 2 - 15) continue;

                        // Avoid piling on other bots — skip if another bot is within 8 units of target
                        let tooClose = false;
                        for (const other of gameState.bots) {
                            if (other === this || other.health <= 0) continue;
                            if (other.position.distanceTo(candidate) < 8) { tooClose = true; break; }
                        }
                        if (tooClose) continue;

                        this.targetPosition = candidate;
                        break;
                    }

                    // Fallback
                    if (!this.targetPosition) {
                        this.targetPosition = new THREE.Vector3(
                            this.position.x + (Math.random() - 0.5) * 50,
                            0.5,
                            this.position.z + (Math.random() - 0.5) * 50
                        );
                    }
                }
            }

            if (this.targetPosition && this._botState !== 'camp') {
                // Move toward target with wall sliding + bot avoidance
                const direction = new THREE.Vector3().subVectors(this.targetPosition, this.position);
                direction.y = 0;
                direction.normalize();

                // Avoid nearby bots — steer away from teammates within 3 units
                const avoidForce = new THREE.Vector3();
                for (const other of gameState.bots) {
                    if (other === this || other.health <= 0) continue;
                    const dist = this.position.distanceTo(other.position);
                    if (dist < 3 && dist > 0.1) {
                        const away = new THREE.Vector3().subVectors(this.position, other.position).normalize();
                        avoidForce.add(away.multiplyScalar(1.5 / dist));
                    }
                }
                direction.add(avoidForce).normalize();

                const speed = this.speed * deltaTime;
                this.velocity.copy(direction).multiplyScalar(speed);
                const newPos = this.position.clone().add(this.velocity);

                if (!this.checkCollision(newPos)) {
                    this.position.x = newPos.x;
                    this.position.z = newPos.z;
                    this._stuckFrames = 0;
                } else {
                    // Hit a wall — count all contacts including slides
                    this._stuckFrames++;

                    if (this._stuckFrames > 3) {
                        // Stop wall-riding — camp here or pick a new direction
                        if (Math.random() < 0.4 && this._botState !== 'chase') {
                            this._botState = 'camp';
                            this._campTimer = 0;
                            this._campDuration = 2 + Math.random() * 5;
                            this.velocity.set(0, 0, 0);
                            this.targetPosition = null;
                        } else {
                            // Navigate around: pick perpendicular direction
                            const angle = Math.atan2(direction.z, direction.x);
                            const turn = (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2 + Math.random() * 0.5);
                            const escapeDist = 15 + Math.random() * 20;
                            this.targetPosition = new THREE.Vector3(
                                Math.max(-MAP_SIZE/2+10, Math.min(MAP_SIZE/2-10, this.position.x + Math.cos(angle + turn) * escapeDist)),
                                0.5,
                                Math.max(-MAP_SIZE/2+10, Math.min(MAP_SIZE/2-10, this.position.z + Math.sin(angle + turn) * escapeDist))
                            );
                        }
                        this._stuckFrames = 0;
                    } else {
                        // Brief slide attempt before giving up
                        const slideX = this.position.clone(); slideX.x += this.velocity.x;
                        const slideZ = this.position.clone(); slideZ.z += this.velocity.z;
                        if (!this.checkCollision(slideX)) {
                            this.position.x = slideX.x;
                        } else if (!this.checkCollision(slideZ)) {
                            this.position.z = slideZ.z;
                        }
                    }
                }
                this.position.y = this.getTerrainHeight(this.position.x, this.position.z);
            }
        }

        // Look for enemies (including all bots and player)
        const allEnemies = [...gameState.bots, gameState.player].filter(p =>
            p && p !== this && p.team !== this.team && p.health > 0 && p.mesh.visible
        );

        let closestEnemy = null;
        let closestDistance = Infinity;

        // Find closest visible enemy (bots have shorter range)
        const visionRange = this.isPlayer ? 45 : 20;
        allEnemies.forEach(enemy => {
            const distance = this.position.distanceTo(enemy.position);
            if (distance < closestDistance && distance < visionRange) {
                closestDistance = distance;
                closestEnemy = enemy;
            }
        });

        // If enemy found, aim at them and chase
        if (closestEnemy) {
            this.weapon.lookAt(closestEnemy.position);

            const enemyDirection = new THREE.Vector3()
                .subVectors(closestEnemy.position, this.position)
                .normalize();

            // Switch to chase state and pursue enemy
            this._botState = 'chase';
            this._campTimer = 0;
            this.targetPosition = this.position.clone().add(enemyDirection.multiplyScalar(10));
        } else if (this.targetPosition) {
            // No enemy — aim in movement direction
            this.weapon.lookAt(this.targetPosition);
        }
    }

    getTerrainHeight(x, z) {
        // Calculate terrain height based on the ground formula
        const height = Math.sin(x * 0.1) * Math.cos(z * 0.1) * 2;
        return height + 0.5; // Add character offset
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
            // Clear path — move directly
            this.position.x = newPos.x;
            this.position.z = newPos.z;
        } else {
            // Wall hit — try sliding along it
            // Try X axis only
            const slideX = this.position.clone();
            slideX.x += this.velocity.x;
            if (!this.checkCollision(slideX)) {
                this.position.x = slideX.x;
            } else {
                // Try Z axis only
                const slideZ = this.position.clone();
                slideZ.z += this.velocity.z;
                if (!this.checkCollision(slideZ)) {
                    this.position.z = slideZ.z;
                } else {
                    // Try diagonal alternatives — slide 45 degrees each way
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
                    // If all blocked, character stays put
                }
            }
        }

        this.position.y = this.getTerrainHeight(this.position.x, this.position.z);

        // Face movement direction
        if (this.rifleGroup) {
            const lookTarget = this.position.clone().add(direction.multiplyScalar(5));
            this.rifleGroup.lookAt(lookTarget);
        }

        return false;
    }

    checkCollision(newPos) {
        // Check bounds
        if (Math.abs(newPos.x) > MAP_SIZE / 2 - 2 || Math.abs(newPos.z) > MAP_SIZE / 2 - 2) {
            return true;
        }

        // Check walls — raycast only against wall objects (not sprites)
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

        // Check bot-to-bot collision (bots only, not player)
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
        // Can't shoot if dead
        if (this.health <= 0) return;
        if (!target || target.health <= 0) return;

        const distance = this.position.distanceTo(target.position);
        if (distance > this.shootRange) return;

        // Check line of sight — from chest height
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

        // Play sniper fire sound
        audioManager.play('sniperFire');

        // HUGE CANNON-LIKE SHOOTING ANIMATION
        this.createShootingEffect(target.position);

        // Instant kill (classic snipers!) — goes through takeDamage for shield check
        target.takeDamage(999, this);
    }

    createShootingEffect(targetPos) {
        // EXTREME rifle recoil animation
        if (this.weapon) {
            const originalPos = this.weapon.position.clone();
            const originalRot = this.weapon.rotation.clone();

            // MASSIVE recoil - gun flies back
            this.weapon.position.z -= 0.8;
            this.weapon.rotation.x -= 0.3;
            this.weapon.position.y -= 0.2;

            // Shake the whole character violently
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

        // Calculate muzzle position (end of barrel)
        const muzzleOffset = new THREE.Vector3(0, 0, 2.5);
        if (this.weapon) {
            muzzleOffset.applyQuaternion(this.weapon.quaternion);
        }
        const muzzlePos = this.position.clone().add(muzzleOffset);
        muzzlePos.y += 0.5;

        // MASSIVE MUZZLE FLASH
        const flashGeometry = new THREE.SphereGeometry(2, 12, 12);
        const flashMaterial = new THREE.MeshBasicMaterial({
            color: 0xffdd00,
            transparent: true,
            opacity: 1
        });
        const flash = new THREE.Mesh(flashGeometry, flashMaterial);
        flash.position.copy(muzzlePos);
        scene.add(flash);

        // Secondary flash (outer)
        const flash2Geometry = new THREE.SphereGeometry(3, 12, 12);
        const flash2Material = new THREE.MeshBasicMaterial({
            color: 0xff6600,
            transparent: true,
            opacity: 0.6
        });
        const flash2 = new THREE.Mesh(flash2Geometry, flash2Material);
        flash2.position.copy(muzzlePos);
        scene.add(flash2);

        // INTENSE Flash light
        const flashLight = new THREE.PointLight(0xffaa00, 10, 40);
        flashLight.position.copy(muzzlePos);
        scene.add(flashLight);

        // Multiple expanding smoke rings
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

                // Animate ring expansion
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

        // Smoke particles
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

        // Remove flash quickly
        setTimeout(() => {
            scene.remove(flash);
            scene.remove(flash2);
            scene.remove(flashLight);
            flashGeometry.dispose();
            flashMaterial.dispose();
            flash2Geometry.dispose();
            flash2Material.dispose();
        }, 80);

        // SUPER THICK bullet tracer with glow
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

        // Multiple glowing tracer layers
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

        // EXTREME Camera shake if this is the player
        if (this.isPlayer) {
            this.cameraShake();
        }

        // MASSIVE Impact explosion at target
        this.createImpactEffect(targetPos);
    }

    createImpactEffect(pos) {
        // MASSIVE Impact flash
        const impactGeometry = new THREE.SphereGeometry(3, 12, 12);
        const impactMaterial = new THREE.MeshBasicMaterial({
            color: 0xff4400,
            transparent: true,
            opacity: 1
        });
        const impact = new THREE.Mesh(impactGeometry, impactMaterial);
        impact.position.copy(pos);
        scene.add(impact);

        // Secondary impact flash
        const impact2Geometry = new THREE.SphereGeometry(4, 12, 12);
        const impact2Material = new THREE.MeshBasicMaterial({
            color: 0xff6600,
            transparent: true,
            opacity: 0.7
        });
        const impact2 = new THREE.Mesh(impact2Geometry, impact2Material);
        impact2.position.copy(pos);
        scene.add(impact2);

        // HUGE Impact light
        const impactLight = new THREE.PointLight(0xff4400, 15, 50);
        impactLight.position.copy(pos);
        scene.add(impactLight);

        // Expanding shockwave rings
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

        // Impact debris/particles
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

        // Expanding impact wave
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
        // In online mode, all damage is server-authoritative
        if (isOnlineMode) return;
        // Spawn protection
        if (this._spawnProtection > 0) return;
        // Shield blocks one shot (check before god mode so it still consumes)
        if (this.hasShield) {
            this.hasShield = false;
            delete this.inventory['shield'];
            if (this.isPlayer) showStreakPopup('SHIELD BLOCKED!', '#44aaff');
            return;
        }
        // God mode — player can't die
        if (this.isPlayer && gameState.debug.godMode) return;
        // Instant kill - no health system
        this.die(attacker);
    }

    die(killer) {
        // Prevent dying twice
        if (this.health <= 0) return;

        this.health = 0; // Set health to 0 immediately
        this.deaths++;

        if (killer) {
            killer.kills++;

            // Determine if this kill triggers a special announcement
            let hasSpecial = false;

            // First blood — global
            if (!gameState.firstBlood) {
                gameState.firstBlood = true;
                audioManager.play('firstBlood');
                if (killer.isPlayer) showStreakPopup('FIRST BLOOD', '#ff4444');
                hasSpecial = true;
            }

            // Gold reward — scales with victim's price (killing whales pays more)
            const baseGold = 50;
            const streakBonus = (killer._streak || 0) * 10;
            const victimBonus = Math.round(this.price * 10);
            killer.earnGold(baseGold + streakBonus + victimBonus);

            // Price pump for killer (absorb victim's value)
            const pumpAmount = 0.5 + this.price * 0.3;
            killer.price += pumpAmount;
            if (killer.isPlayer) pumpPrice(pumpAmount);

            // Player-specific streak/multi-kill tracking
            if (killer.isPlayer) {
                gameState.kills = killer.kills;
                document.getElementById('killCount').textContent = `Kills: ${gameState.kills}`;

                // Kill streak
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

                // Multi-kill tracking (kills within 4 seconds)
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

                // Play headshot on every kill — it's short and punchy
                audioManager.play('headshot');

            } else {
                // Bot got a kill — play special sounds globally (no popup text)
                // Track per-bot streaks
                if (!killer._streak) killer._streak = 0;
                killer._streak++;
                const bs = killer._streak;
                const botStreakSounds = { 5: 'killingSpree', 10: 'rampage', 15: 'dominating', 20: 'unstoppable', 25: 'godlike' };
                if (botStreakSounds[bs]) audioManager.play(botStreakSounds[bs]);
            }

            // Show kill feed
            addKillFeed(killer.username, this.username);
        }

        // Lose all items on death
        this.inventory = {};
        this._applyItems();

        // Price dumps 50% on death
        this.price = Math.max(0.10, this.price * 0.5);

        // Reset kill streak when dying
        if (this.isPlayer) {
            gameState.killStreak = 0;
            resetStreakChart();
            gameState.gold = this.gold;
            updateGoldUI();
        }
        this._streak = 0;

        // Update UI if this is the player
        if (this.isPlayer) {
            gameState.deaths++;
            document.getElementById('deathCount').textContent = `Deaths: ${gameState.deaths}`;

            // Clear ALL move targets and commands
            gameState.moveTarget = null;
            gameState.targetLock = null;

            // Dark Souls death screen
            const popup = document.getElementById('deathPopup');
            const killerName = killer ? killer.username : 'the darkness';

            // Show killer's items
            let killerItems = '';
            if (killer && Object.keys(killer.inventory).length > 0) {
                const items = Object.keys(killer.inventory).map(id => {
                    const item = SHOP_ITEMS[id];
                    return item ? `${item.icon} ${item.name}` : '';
                }).filter(Boolean).join('  ');
                killerItems = `\n${items}`;
            }
            const preBefore = _playerPrice.toFixed(2);
            document.getElementById('deathKiller').innerHTML =
                `Rugged by ${killerName}` +
                `<div style="margin-top:0.4rem;font-size:0.9rem;color:#ff4444;">$${preBefore} → $${(_playerPrice * 0.5).toFixed(2)}</div>` +
                (killerItems ? `<div style="margin-top:0.3rem;font-size:0.7rem;color:#ffd700;">${killerItems}</div>` : '');

            popup.classList.add('hidden');
            void popup.offsetHeight;
            popup.classList.remove('hidden');

            // Draw the death chart — your price history ending in a crash
            drawDeathChart();

            setTimeout(() => popup.classList.add('hidden'), 5000);
        }

        // Hide during death
        this.mesh.visible = false;

        // Clear bot move targets too
        this.targetPosition = null;
        this.attackWalkTarget = null;

        // Auto-respawn after 5 seconds
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
            // Player alive
        } else {
            // Bot auto-buy: prioritize items they don't have
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
            // Float gold text
            showGoldPopup(`+${earned}c`);
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
        // Reset to base stats
        this.normalSpeed = this.baseSpeed;
        this.shootRange = this.baseRange;
        this.shootCooldownTime = this.baseCooldown;
        this.goldMultiplier = 1.0;
        this.hasShield = false;

        // Apply all owned items
        for (const id of Object.keys(this.inventory)) {
            const item = SHOP_ITEMS[id];
            if (!item) continue;

            if (item.stat === 'speed') this.normalSpeed = this.baseSpeed * item.mult;
            if (item.stat === 'range') this.shootRange = this.baseRange * item.mult;
            if (item.stat === 'firerate') this.shootCooldownTime = this.baseCooldown * item.mult;
            if (item.stat === 'goldMult') this.goldMultiplier *= item.mult;
            if (item.stat === 'shield') this.hasShield = true;
            if (item.stat === 'ward') this.wardCharges = (this.wardCharges || 0) + item.val;
        }

        // Update derived speed
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

// Gold + Shop UI
function updateGoldUI() {
    const el = document.getElementById('goldCount');
    if (el) el.textContent = `${gameState.gold}c`;
}

// === TRADING TERMINAL — price tracking + HUD chart ===
let _playerPrice = 1.00;
let _priceHistory = [1.00];
let _startPrice = 1.00;

function updateTerminal() {
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

    // Draw line chart
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

    // Fill under the line
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

// Flying candle animation — spawns center, flies to HUD chart
let _activeCandle = null;
let _candleHoldTimer = null;
let _streakCandleActive = false; // Prevents green candle from overriding streak candles

function spawnFlyingCandle(text, color, boost) {
    // If there's already a candle showing, send it flying immediately
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

    // Sparkle particles
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

    // Start at center — slam in big
    candle.style.left = '50%';
    candle.style.top = '35%';
    candle.style.transform = 'translate(-50%, -50%) scale(2.5)';
    candle.style.opacity = '1';
    candle.style.transition = 'transform 0.15s cubic-bezier(0,0.8,0.2,1.2)';
    document.body.appendChild(candle);
    _activeCandle = candle;

    // Pop to normal
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            candle.style.transform = 'translate(-50%, -50%) scale(1)';
        });
    });

    // Hold 1s, then fly to chart
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
    // Green candle for every kill — but skip if a streak candle is showing
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

    // Green section (full line up to crash point)
    ctx.beginPath();
    ctx.strokeStyle = '#00ff44';
    ctx.lineWidth = 2;
    for (let i = 0; i <= crashIdx && i < prices.length; i++) {
        if (i === 0) ctx.moveTo(toX(i), toY(prices[i]));
        else ctx.lineTo(toX(i), toY(prices[i]));
    }
    ctx.stroke();

    // Green fill
    ctx.lineTo(toX(crashIdx), h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,255,68,0.06)';
    ctx.fill();

    // Red crash section (connected from crash point to end)
    if (prices.length > crashIdx) {
        ctx.beginPath();
        ctx.strokeStyle = '#ff2222';
        ctx.lineWidth = 2.5;
        ctx.moveTo(toX(crashIdx), toY(prices[crashIdx]));
        for (let i = crashIdx + 1; i < prices.length; i++) {
            ctx.lineTo(toX(i), toY(prices[i]));
        }
        ctx.stroke();

        // Red fill under crash
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

    const nearSpawn = gameState.player.isNearSpawn();
    if (!nearSpawn) {
        panel.classList.add('hidden');
        return;
    }
    panel.classList.remove('hidden');

    const inv = gameState.player.inventory;
    const gold = gameState.player.gold;
    const shopGold = document.getElementById('shopGold');
    if (shopGold) shopGold.textContent = `${gold}c`;

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
            <span class="shop-cost">${item.cost}c</span>
            <span class="shop-desc">${item.desc}${status}</span>
        </div>`;
    }
    document.getElementById('shopItems').innerHTML = html;

    // Bind click handlers
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

// Check shop proximity every frame — only auto-CLOSE when leaving spawn
function checkShopProximity() {
    if (gameState.player && gameState.player.health > 0) {
        const nearSpawn = gameState.player.isNearSpawn();
        const panel = document.getElementById('shopPanel');
        if (panel && !nearSpawn) {
            panel.classList.add('hidden');
        }
    }
}

// UI Functions
function showStreakPopup(text, color) {
    const boosts = {
        'FIRST BLOOD':2, 'KILLING SPREE':3, 'RAMPAGE':5, 'DOMINATING':8,
        'UNSTOPPABLE':12, 'GODLIKE':20, 'DOUBLE KILL':2.5, 'MULTI KILL':4,
        'MEGA KILL':6, 'ULTRA KILL':9, 'MONSTER KILL':13, 'LUDICROUS KILL':25,
        'SHIELD BLOCKED!':0,
    };
    const boost = boosts[text] || 1;
    pumpPrice(boost);

    // Screen flash
    const flash = document.createElement('div');
    flash.style.cssText = `position:fixed;top:0;left:0;width:100%;height:100%;background:${color};opacity:0.2;pointer-events:none;z-index:9998;animation:screenFlash 0.3s ease-out forwards;`;
    document.body.appendChild(flash);
    setTimeout(() => flash.remove(), 400);

    // Big flying candle for streaks — mark active so green candle doesn't override
    _streakCandleActive = true;
    spawnFlyingCandle(text, color, boost * 5);
    setTimeout(() => { _streakCandleActive = false; }, 1200);
}

function addKillFeed(killer, victim) {
    const killFeed = document.getElementById('killFeed');
    const message = document.createElement('div');
    const isPlayerKill = gameState.player && killer === gameState.player.username;
    const isPlayerDeath = gameState.player && victim === gameState.player.username;
    message.className = 'kill-message ' + (isPlayerKill ? 'buy' : isPlayerDeath ? 'sell' : '');
    message.textContent = isPlayerKill ? `BUY $${killer} +${_playerPrice.toFixed(2)} (killed ${victim})`
        : isPlayerDeath ? `LIQUIDATED $${victim} (by ${killer})`
        : `${killer} > ${victim}`;
    killFeed.appendChild(message);

    setTimeout(() => message.remove(), 3000);
}

function updateScoreboard() {
    const sb = document.getElementById('scoreboard');
    if (!sb || sb.classList.contains('hidden')) return;

    // Collect all players (offline bots + online remote players)
    const all = [...gameState.bots];
    if (isOnlineMode && _remotePlayers.size > 0) {
        _remotePlayers.forEach(r => all.push(r.player));
    }
    if (gameState.player) all.push(gameState.player);

    // Sort by price descending
    all.sort((a, b) => b.price - a.price);

    // Track price history per player for sparklines
    all.forEach(p => {
        if (!p._priceHist) p._priceHist = [1.0];
        if (p._priceHist[p._priceHist.length - 1] !== p.price) {
            p._priceHist.push(p.price);
        }
        if (p._priceHist.length > 30) p._priceHist.shift();
    });

    let html = `<div class="sb-table-wrap">
        <div class="sb-title">WATCHLIST</div>
        <table class="sb-table">
            <tr><th>#</th><th>TICKER</th><th>K/D</th><th>CHART</th><th>PRICE</th></tr>
    `;

    all.forEach((p, i) => {
        const isMe = p === gameState.player;
        const teamClass = p.team === 'red' ? 'sb-team-red' : 'sb-team-blue';
        const ticker = '$' + p.username.toUpperCase().slice(0, 5);
        const pctChange = ((p.price - 1.0) / 1.0 * 100);
        const pctColor = pctChange >= 0 ? '#00ff44' : '#ff4444';
        const pctText = (pctChange >= 0 ? '+' : '') + pctChange.toFixed(0) + '%';

        html += `<tr class="sb-row ${teamClass} ${isMe ? 'me' : ''}">
            <td style="color:#555;">${i + 1}</td>
            <td class="sb-ticker">${ticker}</td>
            <td class="sb-kd">${p.kills}/${p.deaths}</td>
            <td><canvas class="sb-chart" data-player-idx="${i}" width="80" height="24"></canvas></td>
            <td class="sb-price" style="color:${pctColor};">$${p.price.toFixed(2)} <span style="font-size:0.6rem;">${pctText}</span></td>
        </tr>`;
    });

    html += '</table>';
    html += '<div style="color:#444;font-size:0.6rem;margin-top:0.8rem;text-align:center;">TAB to close</div>';
    html += '</div>';
    sb.innerHTML = html;

    // Draw sparkline charts
    sb.querySelectorAll('.sb-chart').forEach(canvas => {
        const idx = parseInt(canvas.dataset.playerIdx);
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

// Abilities
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

    // Place farsight at mouse position in world
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(gameState.mousePos, camera);

    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const intersectPoint = new THREE.Vector3();
    raycaster.ray.intersectPlane(plane, intersectPoint);

    // Create visual indicator
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

// Input Handlers
document.addEventListener('keydown', (e) => {
    // Skip game keybinds when typing in chat
    const chatInput = document.getElementById('chatInput');
    if (chatInput && document.activeElement === chatInput) {
        if (e.key === 'Escape') { chatInput.blur(); e.preventDefault(); }
        return; // Let normal typing happen
    }

    gameState.keys[e.key.toLowerCase()] = true;

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
        if (gameState.player && gameState.player.isNearSpawn()) {
            const panel = document.getElementById('shopPanel');
            panel.classList.toggle('hidden');
            if (!panel.classList.contains('hidden')) updateShopUI();
        }
    }
    if (e.key === '`') {
        const panel = document.getElementById('debugPanel');
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    }
    if (e.shiftKey) gameState.attackWalk = true;
});

// Debug panel checkboxes
document.getElementById('dbgGodMode').addEventListener('change', (e) => {
    gameState.debug.godMode = e.target.checked;
});
document.getElementById('dbgShowFPS').addEventListener('change', (e) => {
    gameState.debug.showFPS = e.target.checked;
});

// FPS counter
let _fpsFrames = 0, _fpsLast = performance.now();
function updateDebugFPS() {
    _fpsFrames++;
    const now = performance.now();
    if (now - _fpsLast >= 1000) {
        if (gameState.debug.showFPS) {
            document.getElementById('debugFPS').textContent = `FPS: ${_fpsFrames}`;
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

    // Camera dragging with middle/right mouse
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

    // Right click or middle mouse for camera drag
    if (e.button === 1 || e.button === 2) {
        gameState.isDraggingCamera = true;
        gameState.lastMousePos.set(e.clientX, e.clientY);
        e.preventDefault();
        return;
    }

    // Left click
    if (e.button === 0 && gameState.player) {
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(gameState.mousePos, camera);

        // Check if clicking on enemy
        const allPlayers = [...gameState.players.values(), ...gameState.bots]
            .filter(p => p.team !== gameState.team && p.health > 0 && p.mesh.visible);

        // Only raycast against the body meshes, not sprites
        const bodyMeshes = allPlayers.map(p => p.mesh.children[0]);
        const intersects = raycaster.intersectObjects(bodyMeshes, false);

        if (intersects.length > 0) {
            // Find which player was clicked
            for (let player of allPlayers) {
                if (player.mesh.children[0] === intersects[0].object) {
                    // Check if visible in fog of war
                    if (fogOfWar.isVisible(player.position.x, player.position.z)) {
                        gameState.targetLock = player;
                        gameState.moveTarget = null; // Stop moving
                        gameState.player.shoot(player);
                    }
                    return;
                }
            }
        }

        // Click on ground to move
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        const intersectPoint = new THREE.Vector3();
        raycaster.ray.intersectPlane(plane, intersectPoint);

        // Sanity check — ignore clicks that resolve too far from player (bad raycast)
        if (gameState.player) {
            const dist = intersectPoint.distanceTo(gameState.player.position);
            if (dist > 80) return; // Ignore wild raycasts
        }

        // Set move target
        gameState.moveTarget = intersectPoint.clone();
        gameState.targetLock = null; // Clear attack target

        // Visual feedback - create click marker
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

// Scroll wheel zoom
document.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomSpeed = 1.5;
    const delta = e.deltaY > 0 ? zoomSpeed : -zoomSpeed;
    const newZoom = THREE.MathUtils.clamp(gameState.cameraOffset.y + delta, 6, 40);
    gameState.cameraOffset.y = newZoom;
    gameState.cameraOffset.z = newZoom;
}, { passive: false });

// WC3-style move marker — three spinning arrows converging on point
function createMoveMarker(position) {
    const markerGroup = new THREE.Group();
    const terrainY = Math.sin(position.x * 0.1) * Math.cos(position.z * 0.1) * 2 + 0.6;

    // Three arrow shapes, 120 degrees apart
    for (let i = 0; i < 3; i++) {
        const arrow = new THREE.Group();

        // Arrow body — thin triangle pointing inward
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

        // Position arrow pointing inward from outside
        const angle = (i / 3) * Math.PI * 2;
        arrow.position.set(Math.cos(angle) * 0.8, 0, Math.sin(angle) * 0.8);
        arrow.rotation.x = -Math.PI / 2;
        arrow.rotation.z = -angle + Math.PI;

        markerGroup.add(arrow);
    }

    markerGroup.position.set(position.x, terrainY, position.z);
    scene.add(markerGroup);

    // Animate: spin + shrink + fade
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

// Game Setup
let selectedTeamValue = null;
// Mode selection (isOnlineMode declared at top of file)
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

document.getElementById('startBtn').addEventListener('click', () => {
    audioManager.init().then(() => {
        soundtrack.start(audioManager.ctx);
    }); // Unlock audio + start music on first user interaction
    const username = document.getElementById('usernameInput').value.trim() || 'Sniper';

    if (!selectedTeamValue) {
        alert('Please select a team!');
        return;
    }

    gameState.username = username;
    gameState.team = selectedTeamValue;
    gameState.gameStarted = true;

    console.log('Starting game as', username, 'on team', gameState.team);

    document.getElementById('usernameModal').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
    // Scoreboard starts hidden — Tab or tap kill count to toggle
    document.getElementById('abilities').classList.remove('hidden');
    // Controls panel removed
    document.querySelector('.minimap').classList.remove('hidden');

    // Set ticker to player name
    const tickerEl = document.getElementById('ticker');
    if (tickerEl) tickerEl.textContent = '$' + username.toUpperCase().slice(0, 5);
    _playerPrice = 1.00;
    _priceHistory = [1.00];
    _startPrice = 1.00;
    updateTerminal();

    startGame();
});

document.querySelectorAll('.ability').forEach(el => {
    el.addEventListener('click', () => {
        const ability = el.dataset.ability;
        if (ability === 'windwalk') useWindwalk();
        if (ability === 'farsight') useFarsight();
        if (el.id === 'shopBtn') {
            if (gameState.player && gameState.player.isNearSpawn()) {
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

// Scoreboard + shop close handlers — only when game is running
document.getElementById('scoreboard')?.addEventListener('click', () => {
    if (gameState.gameStarted) document.getElementById('scoreboard').classList.add('hidden');
});
document.addEventListener('click', (e) => {
    if (!gameState.gameStarted) return;
    const shop = document.getElementById('shopPanel');
    if (shop && !shop.classList.contains('hidden') && !e.target.closest('#shopPanel, .ability')) {
        shop.classList.add('hidden');
    }
});

function startGame() {
    console.log('startGame() called');
    try {

    // Remove preview ground (not fog mesh)
    const toRemove = scene.children.filter(child =>
        child.geometry && child.geometry.type === 'PlaneGeometry' && child !== fogOfWar.fogMesh
    );
    toRemove.forEach(child => scene.remove(child));

    console.log('About to createMap...');
    createMap();
    console.log('Map created');

    // Create player
    console.log('About to create player...');
    gameState.player = new Player(gameState.username, gameState.team, true);
    console.log('Player created at', gameState.player.position.x, gameState.player.position.z);

    // Initialize camera at player position
    gameState.cameraTarget.copy(gameState.player.position);

    // Create bots (5 per team) — only in offline mode
    if (!isOnlineMode) {
        const botNames = ['Elite', 'Anima', 'Game', 'ESi', 'Apathetic', 'Gem', 'Kflan', 'Jubei', 'Steve', 'Sean'];
        for (let i = 0; i < 10; i++) {
            const team = i < 5 ? 'red' : 'blue';
            const bot = new Player(botNames[i], team, false);
            gameState.bots.push(bot);
        }
        console.log('Bots created:', gameState.bots.length);
    } else {
        console.log('Online mode — bots managed by server');
        connectToServer();
    }

    updateScoreboard();
    console.log('Game started! Player can now move with WASD');

    // Make sure the window has focus for keyboard input
    window.focus();
    document.body.focus();

    animate();
    } catch(e) { console.error('startGame error:', e); }
}

// Minimap
const minimapCanvas = document.getElementById('minimap');
const minimapCtx = minimapCanvas.getContext('2d');
minimapCanvas.width = 150;
minimapCanvas.height = 150;

// Minimap interaction — tap or hold+drag to scroll camera to that map position
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

// Works for both mouse and touch
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

    // Draw players
    const allPlayers = [...gameState.bots];
    if (gameState.player) allPlayers.push(gameState.player);

    allPlayers.forEach(p => {
        if (!p.mesh.visible) return;

        const x = (p.position.x + MAP_SIZE / 2) * scale;
        const y = (p.position.z + MAP_SIZE / 2) * scale;

        const isMe = p === gameState.player;
        minimapCtx.fillStyle = isMe ? '#ffd700' : (p.team === 'red' ? '#ff0000' : '#0088ff');
        minimapCtx.beginPath();
        minimapCtx.arc(x, y, isMe ? 4 : 3, 0, Math.PI * 2);
        minimapCtx.fill();
    });
}

// Game Loop
let lastTime = performance.now();

function animate() {
    requestAnimationFrame(animate);

    gameState._frame = (gameState._frame || 0) + 1;
    const currentTime = performance.now();
    const deltaTime = (currentTime - lastTime) / 1000;
    lastTime = currentTime;

    if (!gameState.gameStarted) return;

    // Shop proximity check
    checkShopProximity();

    // Multi-kill timer countdown
    if (gameState.multiKillTimer > 0) {
        gameState.multiKillTimer -= deltaTime;
        if (gameState.multiKillTimer <= 0) {
            gameState.multiKillCount = 0;
        }
    }

    // Camera controls
    // Edge scrolling
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

    // Middle mouse drag
    if (gameState.isDraggingCamera) {
        // This will be handled in mousemove
    }

    // WASD camera movement (alternative to edge scroll)
    const camSpeed = 15;
    if (gameState.keys['w'] && !gameState.keys['s']) gameState.cameraTarget.z -= camSpeed * deltaTime;
    if (gameState.keys['s'] && !gameState.keys['w']) gameState.cameraTarget.z += camSpeed * deltaTime;
    if (gameState.keys['a'] && !gameState.keys['d']) gameState.cameraTarget.x -= camSpeed * deltaTime;
    if (gameState.keys['d'] && !gameState.keys['a']) gameState.cameraTarget.x += camSpeed * deltaTime;

    // Spacebar to center on player
    if (gameState.keys[' '] && gameState.player) {
        gameState.cameraTarget.copy(gameState.player.position);
        // space-to-center handled by cameraTarget.copy above
    }

    // No auto-follow on mobile — camera stays where you put it

    // Clamp camera to map bounds
    const mapBound = MAP_SIZE / 2 - 5;
    gameState.cameraTarget.x = THREE.MathUtils.clamp(gameState.cameraTarget.x, -mapBound, mapBound);
    gameState.cameraTarget.z = THREE.MathUtils.clamp(gameState.cameraTarget.z, -mapBound, mapBound);

    // Smooth camera movement
    camera.position.x = THREE.MathUtils.lerp(camera.position.x, gameState.cameraTarget.x + gameState.cameraOffset.x, 0.06);
    camera.position.y = gameState.cameraOffset.y;
    camera.position.z = THREE.MathUtils.lerp(camera.position.z, gameState.cameraTarget.z + gameState.cameraOffset.z, 0.06);
    camera.lookAt(gameState.cameraTarget);

    // Update player movement (click to move)
    if (gameState.player && gameState.player.health > 0) {
        // Move towards click target
        if (gameState.moveTarget) {
            const reached = gameState.player.moveTowards(gameState.moveTarget, deltaTime);
            if (reached) {
                gameState.moveTarget = null;
            }
        }

        // Aim weapon at mouse
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(gameState.mousePos, camera);
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        const intersectPoint = new THREE.Vector3();
        raycaster.ray.intersectPlane(plane, intersectPoint);

        gameState.player.weapon.lookAt(intersectPoint);

        // Gold display updated via earnGold()
    }

    // Update bots (offline only — online mode updates from server)
    if (!isOnlineMode) {
        gameState.bots.forEach(bot => bot.update(deltaTime));
    } else {
        // Online mode: interpolate remote players
        if (typeof updateRemotePlayers === 'function') updateRemotePlayers(deltaTime);
    }

    // Update player
    if (gameState.player) {
        gameState.player.update(deltaTime);
    }

    // Update abilities cooldown
    Object.values(gameState.abilities).forEach(ability => {
        if (ability.cooldown > 0) {
            ability.cooldown -= deltaTime;
            if (ability.cooldown < 0) ability.cooldown = 0;
        }
    });

    updateAbilityUI();
    updateScoreboard();
    updateMinimap();

    // Update fog of war with all units (player + all bots + remote teammates)
    const allUnits = [...gameState.bots];
    if (gameState.player) {
        allUnits.push(gameState.player);
    }
    // In online mode, include remote teammates for shared vision
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

    // Hide enemy units — instant hide when leaving vision, no linger
    gameState.bots.forEach(bot => {
        if (bot.team !== gameState.team) {
            const inVision = fogOfWar.isVisible(bot.position.x, bot.position.z);
            bot.mesh.visible = inVision && bot.health > 0;
            // Reset opacity when visible
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
}

// Handle window resize — ignore mobile keyboard resize
let _baseWidth = window.innerWidth;
let _baseHeight = window.innerHeight;
const _isMobileDevice = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || ('ontouchstart' in window);

function handleResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // On mobile, keyboard opening shrinks innerHeight but not width — skip that
    if (_isMobileDevice && w === _baseWidth && h < _baseHeight * 0.8) return;
    _baseWidth = w;
    _baseHeight = h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
}
window.addEventListener('resize', handleResize);

// Prevent scroll when focusing chat on mobile
if (_isMobileDevice) {
    const _chatEl = document.getElementById('chatInput');
    if (_chatEl) {
        _chatEl.addEventListener('focus', () => {
            setTimeout(() => { window.scrollTo(0, 0); }, 50);
            setTimeout(() => { window.scrollTo(0, 0); }, 300);
        });
    }
}

// Initial render loop (before game starts)
function preGameRender() {
    if (!gameState.gameStarted) {
        requestAnimationFrame(preGameRender);
        renderer.render(scene, camera);
    }
}

// Start pre-game rendering immediately
preGameRender();

// Respawn button — immediate respawn
document.getElementById('respawnBtn')?.addEventListener('click', () => {
    document.getElementById('deathPopup').classList.add('hidden');
    // Just snap camera to spawn — auto-respawn handles the actual respawn
    if (gameState.player) {
        const spawnX = gameState.player.team === 'red' ? -70 : 70;
        const spawnZ = gameState.player.team === 'red' ? -70 : 70;
        gameState.cameraTarget.x = spawnX;
        gameState.cameraTarget.z = spawnZ;
    }
});

// Also hide popup on respawn
const _origRespawn = Player.prototype.respawn;
Player.prototype.respawn = function() {
    _origRespawn.call(this);
    if (this.isPlayer) {
        document.getElementById('deathPopup')?.classList.add('hidden');
    }
};

// Smooth camera globals — used by mobile touch + minimap
// smoothCam removed — camera moves directly via cameraTarget

// === MOBILE TOUCH — drag anywhere to scroll camera, tap to move/attack ===
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || ('ontouchstart' in window);

if (isMobile) {
    const canvas = document.getElementById('gameCanvas');
    let touchStartPos = null;
    const touches = new Map();
    const DRAG_THRESHOLD = 15;
    const TAP_TIME = 200;

    // Camera velocity for flick momentum
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
                    // Move camera directly — no smoothCam indirection
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
                // No momentum on tap
                camVelX = 0;
                camVelZ = 0;
            }
            touches.delete(t.identifier);
        }

        if (e.touches.length === 0) {
            gameState._pinchStart = null;
        }
    }, { passive: false });

    // Momentum decay loop — runs every frame on mobile
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

if (!isMobile) {

    // Ability buttons work via tap on the HTML elements (pointer-events: all)
    document.querySelectorAll('.ability').forEach(btn => {
        btn.addEventListener('touchstart', (e) => {
            e.stopPropagation();
            const ability = btn.dataset.ability;
            if (ability === 'windwalk') { gameState.keys['q'] = true; setTimeout(() => gameState.keys['q'] = false, 100); }
            if (ability === 'farsight') { gameState.keys['e'] = true; setTimeout(() => gameState.keys['e'] = false, 100); }
        }, { passive: false });
    });

    // Fullscreen on game start
    document.getElementById('startBtn')?.addEventListener('click', () => {
        setTimeout(() => {
            if (document.documentElement.requestFullscreen) {
                document.documentElement.requestFullscreen().catch(() => {});
            } else if (document.documentElement.webkitRequestFullscreen) {
                document.documentElement.webkitRequestFullscreen();
            }
            // Lock to landscape
            if (screen.orientation?.lock) {
                screen.orientation.lock('landscape').catch(() => {});
            }
        }, 500);
    });
}

console.log('Elite Snipers - Loading complete!' + (isMobile ? ' (Mobile)' : ''));

// ============================================================================
// === AABB COLLISION (uses map-data.json, matches server collision) ===
// ============================================================================

let _aabbWalls = null; // Will be loaded from map-data.json
let _mapDataLoaded = null;

// Fetch map data for AABB collision (used in online mode + as alternative collision)
fetch('map-data.json').then(r => r.json()).then(data => {
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
    // Map bounds
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

// ============================================================================
// === MULTIPLAYER NETWORKING ===
// This section only activates when isOnlineMode is true
// All offline code above remains completely untouched
// ============================================================================

let _ws = null;
let _myServerId = null;
let _roster = {}; // id -> { username, team, isBot }
// _remotePlayers declared at top of file
let _serverState = new Map(); // serverId -> latest decoded state
let _lastSendTime = 0;

const BYTES_PER_PLAYER = 28;
const INTERP_SPEED = 12; // units/sec for interpolation

function _netDebug(text) {
    let el = document.getElementById('_netdbg');
    if (!el) {
        el = document.createElement('div');
        el.id = '_netdbg';
        el.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:rgba(0,0,0,0.8);color:#0f0;font:11px monospace;padding:4px 8px;z-index:99999;pointer-events:none;max-height:100px;overflow:hidden;';
        document.body.appendChild(el);
    }
    el.textContent = text;
}

function connectToServer() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = protocol + '//' + window.location.host;
    _netDebug('WS: ' + url + ' host=' + window.location.host + ' port=' + window.location.port);

    _ws = new WebSocket(url);
    _ws.binaryType = 'arraybuffer';

    // Timeout — if no connection in 3s, fall back to offline
    const connectTimeout = setTimeout(() => {
        if (_ws.readyState !== 1) {
            _netDebug('Connection timeout — falling back to offline');
            _ws.close();
            isOnlineMode = false;
            // Create local bots
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

        // Show chat box
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
        // Try reconnect after 3s
        setTimeout(() => {
            if (isOnlineMode && gameState.gameStarted) connectToServer();
        }, 3000);
    };

    _ws.onerror = (err) => {
        console.error('WebSocket error:', err);
    };
}

function handleBinaryState(buf) {
    const view = new DataView(buf);
    const count = view.getUint16(0, true);
    if (!handleBinaryState._logged) {
        console.log('First binary state: ' + count + ' players, ' + buf.byteLength + ' bytes');
        handleBinaryState._logged = true;
        // Visible debug on screen
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
        const team = isBlue ? 'blue' : 'red';

        seenIds.add(id);

        if (id === _myServerId) {
            // Update local player state from server
            if (gameState.player) {
                gameState.player.kills = kills;
                gameState.player.deaths = deaths;
                gameState.player.price = price;
                gameState.player.gold = gold;
                gameState.player.streak = streak;
                gameState.player._spawnProtection = isSpawnProt ? 1.0 : -1;

                // Sync health state
                const wasAlive = gameState.player.health > 0;
                if (alive && !wasAlive) {
                    // Respawned
                    gameState.player.health = 100;
                    gameState.player.mesh.visible = true;
                    gameState.player.position.set(x, Math.sin(x * 0.1) * Math.cos(z * 0.1) * 2 + 0.5, z);
                    document.getElementById('deathPopup')?.classList.add('hidden');
                } else if (!alive && wasAlive) {
                    // Died (handled by kill event)
                }

                // Update HUD
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
            // Remote player
            _serverState.set(id, { x, z, rot, alive: !!alive, kills, deaths, price, gold, streak, team, isBot, isWindwalk, isSpawnProt });

            let remote = _remotePlayers.get(id);
            if (!remote) {
                // Create new remote player mesh
                const name = (_roster[id] && _roster[id].username) || (isBot ? 'Bot' : 'Player');
                console.log('Creating remote: ' + name + ' id=' + id + ' team=' + team);
                const rPlayer = new Player(name, team, false);
                rPlayer.position.set(x, Math.sin(x * 0.1) * Math.cos(z * 0.1) * 2 + 0.5, z);
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

            // Health sync
            const wasAlive = remote.player.health > 0;
            remote.player.health = alive ? 100 : 0;
            remote.player.mesh.visible = !!alive;

            // Windwalk visual
            remote.player.isWindwalking = isWindwalk;

            // Spawn prot
            remote.player._spawnProtection = isSpawnProt ? 1.0 : -1;
        }
    }

    // Remove remote players no longer in state (left or out of vision)
    for (const [rid, remote] of _remotePlayers) {
        if (!seenIds.has(rid) && rid !== _myServerId) {
            // Hide but keep for potential re-appear
            remote.player.mesh.visible = false;
        }
    }
}

function handleJsonMessage(msg) {
    switch (msg.t) {
        case 'j': {
            // Join confirmation
            _myServerId = msg.id;
            console.log('Joined as id', _myServerId);
            // Store roster
            if (msg.roster) {
                msg.roster.forEach(r => {
                    _roster[r.id] = { username: r.n, team: r.m, isBot: !!r.b };
                });
            }
            // Init team score HUD
            if (msg.limit) {
                _matchKillLimit = msg.limit;
                _matchTimeLimit = msg.timeLimit || 1200;
                _matchStartTime = Date.now() - (msg.elapsed || 0) * 1000;
                updateTeamScore(msg.rk || 0, msg.bk || 0);
                document.getElementById('teamScore')?.classList.remove('hidden');
            }
            break;
        }
        case 'pj': {
            // Player joined
            addChatSystem(msg.n + ' joined ' + msg.m);
            break;
        }
        case 'pl': {
            // Player left
            addChatSystem(msg.n + ' left');
            break;
        }
        case 'k': {
            // Kill event — play shooting VFX
            addKillFeed(msg.kn, msg.vn);
            audioManager.play('sniperFire');

            // Update team score HUD
            if (msg.rk !== undefined) updateTeamScore(msg.rk, msg.bk);

            // Find killer + victim meshes for tracer VFX
            const killer = msg.ki === _myServerId ? gameState.player :
                _remotePlayers.get(msg.ki)?.player;
            const victim = msg.vi === _myServerId ? gameState.player :
                _remotePlayers.get(msg.vi)?.player;
            if (killer && victim && killer.createShootingEffect) {
                killer.createShootingEffect(victim.position);
            }

            // If the killer is our player
            if (msg.ki === _myServerId) {
                audioManager.play('headshot');

                // First blood
                if (msg.fb) {
                    audioManager.play('firstBlood');
                    showStreakPopup('FIRST BLOOD', '#ff4444');
                }

                // Streak sounds
                const streakMap = {
                    5: ['killingSpree', 'KILLING SPREE', '#ff8800'],
                    10: ['rampage', 'RAMPAGE', '#ff4400'],
                    15: ['dominating', 'DOMINATING', '#ff0044'],
                    20: ['unstoppable', 'UNSTOPPABLE', '#cc00ff'],
                    25: ['godlike', 'GODLIKE', '#ffdd00'],
                };
                if (streakMap[msg.s]) {
                    audioManager.play(streakMap[msg.s][0]);
                    showStreakPopup(streakMap[msg.s][1], streakMap[msg.s][2]);
                }

                showGoldPopup('+' + msg.g + 'c');
            }

            // If the victim is our player
            if (msg.vi === _myServerId && gameState.player) {
                gameState.player.health = 0;
                gameState.player.mesh.visible = false;
                gameState.moveTarget = null;
                gameState.targetLock = null;

                const popup = document.getElementById('deathPopup');
                document.getElementById('deathKiller').innerHTML =
                    'Rugged by ' + msg.kn +
                    '<div style="margin-top:0.4rem;font-size:0.9rem;color:#ff4444;">$' + _playerPrice.toFixed(2) + ' -> $' + (_playerPrice * 0.5).toFixed(2) + '</div>';
                popup.classList.add('hidden');
                void popup.offsetHeight;
                popup.classList.remove('hidden');
                drawDeathChart();
                setTimeout(() => popup.classList.add('hidden'), 5000);
                resetStreakChart();
            }

            break;
        }
        case 'r': {
            // Respawn event
            if (msg.id === _myServerId && gameState.player) {
                gameState.player.health = 100;
                gameState.player.mesh.visible = true;
                const ty = Math.sin(msg.x * 0.1) * Math.cos(msg.z * 0.1) * 2 + 0.5;
                gameState.player.position.set(msg.x, ty, msg.z);
                gameState.player._spawnProtection = 1.5;
                // Clear move targets — player should sit idle until clicked
                gameState.moveTarget = null;
                gameState.targetLock = null;
                _lastMoveTarget = null;
                document.getElementById('deathPopup')?.classList.add('hidden');
            }
            break;
        }
        case 'shld': {
            // Shield blocked
            if (msg.vi === _myServerId) {
                showStreakPopup('SHIELD BLOCKED!', '#44aaff');
            }
            break;
        }
        case 'bought': {
            // Shop purchase confirmed
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
            // Chat message
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

// === MATCH STATE ===
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

    // Set class for styling
    el.className = isDraw ? 'draw' : (isWin ? 'win' : 'lose');

    // Title
    document.getElementById('matchEndTitle').textContent =
        isDraw ? 'DRAW' : (isWin ? 'VICTORY' : 'DEFEAT');

    // Score
    document.getElementById('matchEndScore').innerHTML =
        '<span style="color:#ff4444">' + msg.rk + '</span>' +
        ' <span style="color:#555">—</span> ' +
        '<span style="color:#4488ff">' + msg.bk + '</span>';

    // MVP (top killer)
    const mvp = msg.stats && msg.stats[0];
    if (mvp) {
        const mvpColor = mvp.m === 'red' ? '#ff4444' : '#4488ff';
        document.getElementById('matchEndMVP').innerHTML =
            'MVP: <span style="color:' + mvpColor + '">' + mvp.n + '</span> — ' +
            mvp.k + ' kills / ' + mvp.d + ' deaths';
    }

    // Stats table
    if (msg.stats) {
        let html = '';
        msg.stats.forEach(function(s) {
            const isMe = s.n === gameState.username;
            const teamClass = s.m === 'red' ? 'me-red' : 'me-blue';
            html += '<div class="me-row ' + teamClass + '"' + (isMe ? ' style="color:#fff;font-weight:bold;"' : '') + '>' +
                s.n + (s.b ? ' [BOT]' : '') + '  ' + s.k + '/' + s.d + '  $' + s.p.toFixed(2) +
                '</div>';
        });
        document.getElementById('matchEndStats').innerHTML = html;
    }

    // Format match time
    const mins = Math.floor(msg.time / 60);
    const secs = msg.time % 60;
    const timeStr = mins + ':' + (secs < 10 ? '0' : '') + secs;

    el.classList.remove('hidden');

    // Countdown to next match
    let remaining = 12;
    const timerEl = document.getElementById('matchEndTimer');
    timerEl.textContent = 'Match time: ' + timeStr + '  •  Next match in ' + remaining + 's';
    _matchEndCountdown = setInterval(function() {
        remaining--;
        if (remaining <= 0) {
            clearInterval(_matchEndCountdown);
            timerEl.textContent = 'Starting...';
        } else {
            timerEl.textContent = 'Match time: ' + timeStr + '  •  Next match in ' + remaining + 's';
        }
    }, 1000);
}

function handleNewMatch(msg) {
    // Hide match end screen
    document.getElementById('matchEnd')?.classList.add('hidden');
    document.getElementById('deathPopup')?.classList.add('hidden');
    if (_matchEndCountdown) { clearInterval(_matchEndCountdown); _matchEndCountdown = null; }

    // Reset match state
    _matchKillLimit = msg.limit || 50;
    _matchTimeLimit = msg.timeLimit || 1200;
    _matchStartTime = Date.now();
    updateTeamScore(0, 0);

    // Update roster
    if (msg.roster) {
        for (const r of msg.roster) {
            _roster[r.id] = { username: r.n, team: r.m, isBot: !!r.b };
        }
    }

    // Reset local player
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
        // Clear move targets — idle until player clicks
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

    // Reset remote players
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

        // Interpolate position
        const dx = remote.targetX - p.position.x;
        const dz = remote.targetZ - p.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist > 20) {
            // Snap if too far (first frame or teleport)
            p.position.x = remote.targetX;
            p.position.z = remote.targetZ;
        } else if (dist > 0.1) {
            const step = Math.min(INTERP_SPEED * dt, dist);
            p.position.x += (dx / dist) * step;
            p.position.z += (dz / dist) * step;
            p.position.y = Math.sin(p.position.x * 0.1) * Math.cos(p.position.z * 0.1) * 2 + 0.5;
            p.velocity.set(dx, 0, dz).normalize().multiplyScalar(step);
        } else {
            p.velocity.set(0, 0, 0);
        }

        // Interpolate rotation
        let rotDiff = remote.targetRot - (p.mesh.rotation.y || 0);
        while (rotDiff > Math.PI) rotDiff -= 2 * Math.PI;
        while (rotDiff < -Math.PI) rotDiff += 2 * Math.PI;
        if (p.weapon) {
            const lookTarget = p.position.clone().add(
                new THREE.Vector3(Math.sin(remote.targetRot), 0, Math.cos(remote.targetRot)).multiplyScalar(5)
            );
            p.weapon.lookAt(lookTarget);
        }

        // Run animation updates (handles leg swing, cape, etc.)
        // Call the animation part only (shootCooldown, spawn prot visual, etc.)
        if (p.shootCooldown > 0) p.shootCooldown -= dt;

        // Spawn protection visual
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
            // Spawn protection ended — restore full opacity
            p.mesh.traverse(child => {
                if (child.material && !child.isSprite) {
                    child.material.transparent = false;
                    child.material.opacity = 1;
                }
            });
            p._wasSpawnProt = false;
        }

        // Animation (movement idle/walk)
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

    // Send player rotation to server for FOV-based auto-aim
    if (_ws && _ws.readyState === 1 && gameState.player && gameState.player.weapon) {
        const now2 = performance.now();
        if (now2 - _lastSendTime > 33) { // 30hz rotation updates
            const wdir = new THREE.Vector3(0, 0, 1);
            wdir.applyQuaternion(gameState.player.weapon.getWorldQuaternion(new THREE.Quaternion()));
            const rot = Math.atan2(wdir.x, wdir.z);
            _ws.send(JSON.stringify({ t: 'rot', r: rot }));
            _lastSendTime = now2;
        }
    }
}

// === ONLINE MODE: Override movement to send to server ===
// Intercept click-to-move in online mode
const _origMouseDown = document.onmousedown;

// We hook into the existing mousedown handler by checking isOnlineMode in
// the move target section. The existing code sets gameState.moveTarget which
// drives local movement. In online mode, we also send the move command.
// We add a frame-level check to send move commands.
let _lastMoveTarget = null;

function checkAndSendMove() {
    if (!isOnlineMode || !_ws || _ws.readyState !== 1) return;
    if (!gameState.moveTarget) return;

    const mt = gameState.moveTarget;
    if (_lastMoveTarget && _lastMoveTarget.x === mt.x && _lastMoveTarget.z === mt.z) return;
    _lastMoveTarget = { x: mt.x, z: mt.z };

    _ws.send(JSON.stringify({ t: 'mv', x: mt.x, z: mt.z }));
}

// Abilities in online mode send network messages via the keydown listener below
// Local ability functions still run for client-side visuals

// Override shop buying in online mode
const _origBuyItem = Player.prototype.buyItem;
Player.prototype.buyItem = function(itemId) {
    if (isOnlineMode && _ws && _ws.readyState === 1) {
        _ws.send(JSON.stringify({ t: 'buy', i: itemId }));
        return true; // Optimistic — server confirms
    }
    return _origBuyItem.call(this, itemId);
};

// Override ability key handlers to also send to server
document.addEventListener('keydown', (e) => {
    if (!isOnlineMode || !_ws || _ws.readyState !== 1) return;
    // Allow typing in chat (except Enter which is handled below)
    const chatInput = document.getElementById('chatInput');
    if (chatInput && document.activeElement === chatInput && e.key !== 'Enter') return;
    if (e.key.toLowerCase() === 'q') {
        _ws.send(JSON.stringify({ t: 'ab', a: 'ww' }));
    }
    if (e.key.toLowerCase() === 'e' && gameState.player) {
        // Send farsight with position
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(gameState.mousePos, camera);
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        const pt = new THREE.Vector3();
        raycaster.ray.intersectPlane(plane, pt);
        _ws.send(JSON.stringify({ t: 'ab', a: 'fs', x: pt.x, z: pt.z }));
    }
    // Chat
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

// Chat UI helpers
function addChatMessage(name, team, text) {
    const el = document.getElementById('chatMessages');
    if (!el) return;
    const msg = document.createElement('div');
    msg.className = 'chat-msg';
    const nameClass = team === 'red' ? 'chat-name-red' : 'chat-name-blue';
    msg.innerHTML = '<span class="' + nameClass + '">' + escapeHtml(name) + ':</span> ' + escapeHtml(text);
    el.appendChild(msg);
    el.scrollTop = el.scrollHeight;
    // Trim old messages
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

// Start network tick loop (does nothing in offline mode)
requestAnimationFrame(function netLoop() {
    requestAnimationFrame(netLoop);
    if (isOnlineMode) checkAndSendMove();
});

console.log('Multiplayer module loaded');
