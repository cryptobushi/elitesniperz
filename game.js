import * as THREE from 'three';

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
    firstBlood: false
};

// Audio System
class AudioManager {
    constructor() {
        this.sounds = {};
        this.enabled = true;
        this.loadSounds();
    }

    loadSounds() {
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
            this.sounds[name] = new Audio(path);
            // Louder volume for gun sound, normal for announcer
            this.sounds[name].volume = (name === 'sniperFire') ? 0.5 : 0.7;
        }
    }

    play(soundName) {
        if (!this.enabled || !this.sounds[soundName]) return;

        const sound = this.sounds[soundName];
        sound.currentTime = 0;
        sound.play().catch(err => console.log('Audio play failed:', err));
    }

    playKillStreak(streak) {
        // Kill streak announcements (every 5 kills)
        if (streak === 5) this.play('killingSpree');
        else if (streak === 10) this.play('rampage');
        else if (streak === 15) this.play('dominating');
        else if (streak === 20) this.play('unstoppable');
        else if (streak === 25) this.play('godlike');
    }

    playMultiKill(count) {
        // Multi-kill announcements (rapid kills)
        if (count === 2) this.play('doubleKill');
        else if (count === 3) this.play('multiKill');
        else if (count === 4) this.play('megaKill');
        else if (count === 5) this.play('ultraKill');
        else if (count === 6) this.play('monsterKill');
        else if (count >= 7) this.play('ludicrousKill');
    }
}

const audioManager = new AudioManager();

// Three.js Setup
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a1a);
scene.fog = new THREE.Fog(0x000000, 30, 80);

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

    // Create trees
    const createTree = (x, z) => {
        const treeGroup = new THREE.Group();

        // Trunk
        const trunkGeometry = new THREE.CylinderGeometry(0.3, 0.4, 3, 8);
        const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x4a3520 });
        const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
        trunk.position.y = 1.5;
        trunk.castShadow = true;
        treeGroup.add(trunk);

        // Foliage
        const foliageGeometry = new THREE.ConeGeometry(1.5, 3, 8);
        const foliageMaterial = new THREE.MeshStandardMaterial({ color: 0x2d5016 });
        const foliage = new THREE.Mesh(foliageGeometry, foliageMaterial);
        foliage.position.y = 4;
        foliage.castShadow = true;
        treeGroup.add(foliage);

        treeGroup.position.set(x, 0, z);
        treeGroup.userData.isWall = true; // Trees block movement
        scene.add(treeGroup);
        return treeGroup;
    };

    // Plant trees randomly across the map
    for (let i = 0; i < 80; i++) {
        const x = (Math.random() - 0.5) * MAP_SIZE * 0.9;
        const z = (Math.random() - 0.5) * MAP_SIZE * 0.9;
        // Don't plant trees in spawn areas or center
        const distFromCenter = Math.sqrt(x*x + z*z);
        if (distFromCenter > 15 && distFromCenter < MAP_SIZE * 0.45) {
            createTree(x, z);
        }
    }

    // Rocks/Boulders for cover
    const createRock = (x, z, size) => {
        const rockGeometry = new THREE.DodecahedronGeometry(size, 0);
        const rockMaterial = new THREE.MeshStandardMaterial({
            color: 0x666666,
            roughness: 0.95,
            metalness: 0
        });
        const rock = new THREE.Mesh(rockGeometry, rockMaterial);
        rock.position.set(x, size * 0.7, z);
        rock.rotation.set(Math.random(), Math.random(), Math.random());
        rock.castShadow = true;
        rock.receiveShadow = true;
        rock.userData.isWall = true;
        scene.add(rock);
        return rock;
    };

    // Add rocks
    for (let i = 0; i < 40; i++) {
        const x = (Math.random() - 0.5) * MAP_SIZE * 0.85;
        const z = (Math.random() - 0.5) * MAP_SIZE * 0.85;
        const size = 0.8 + Math.random() * 1.5;
        createRock(x, z, size);
    }

    // Walls/Boundaries
    const wallMaterial = new THREE.MeshStandardMaterial({
        color: 0x3a3a3a,
        roughness: 0.9
    });

    const createWall = (x, y, width, height) => {
        const wallGeometry = new THREE.BoxGeometry(width, 4, height);
        const wall = new THREE.Mesh(wallGeometry, wallMaterial);
        wall.position.set(x, 2, y);
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

    // Additional scattered walls for cover
    for (let i = 0; i < 15; i++) {
        const x = (Math.random() - 0.5) * MAP_SIZE * 0.7;
        const z = (Math.random() - 0.5) * MAP_SIZE * 0.7;
        const width = 3 + Math.random() * 5;
        const height = 3 + Math.random() * 5;
        const distFromCenter = Math.sqrt(x*x + z*z);
        if (distFromCenter > 25) {
            createWall(x, z, width, height);
        }
    }

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

// Fog of War System
class FogOfWar {
    constructor() {
        this.fogTexture = null;
        this.fogMesh = null;
        this.canvas = document.createElement('canvas');
        this.canvas.width = 256;
        this.canvas.height = 256;
        this.ctx = this.canvas.getContext('2d');
        this.visibilityMap = new Array(256 * 256).fill(0);

        // Explored areas (partially revealed, darker fog)
        this.exploredCanvas = document.createElement('canvas');
        this.exploredCanvas.width = 256;
        this.exploredCanvas.height = 256;
        this.exploredCtx = this.exploredCanvas.getContext('2d');
        this.exploredCtx.fillStyle = 'rgba(0, 0, 0, 1)';
        this.exploredCtx.fillRect(0, 0, 256, 256);

        this.init();
    }

    init() {
        this.fogTexture = new THREE.CanvasTexture(this.canvas);
        this.fogTexture.magFilter = THREE.LinearFilter;
        this.fogTexture.minFilter = THREE.LinearFilter;

        const fogMaterial = new THREE.MeshBasicMaterial({
            map: this.fogTexture,
            transparent: true,
            opacity: 0.95,
            color: 0x000000,
            depthWrite: false,
            depthTest: false, // Don't test depth so it renders on top
            blending: THREE.NormalBlending
        });

        const fogGeometry = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE);
        this.fogMesh = new THREE.Mesh(fogGeometry, fogMaterial);
        this.fogMesh.rotation.x = -Math.PI / 2;
        this.fogMesh.position.y = 10; // Raised high above terrain to cover everything
        this.fogMesh.renderOrder = 10000; // Render last
        scene.add(this.fogMesh);
    }

    update(player, allUnits, farsightPositions = []) {
        const revealRadius = 25; // Much larger vision radius (in world units)
        const farsightRadius = 45; // Far sight radius

        // Mark explored areas (areas you've been to before)
        if (player && player.health > 0) {
            this.markExplored(player.position.x, player.position.z, revealRadius);
        }
        allUnits.forEach(unit => {
            if (unit.team === gameState.team && unit.health > 0 && unit !== player) {
                this.markExplored(unit.position.x, unit.position.z, revealRadius);
            }
        });

        // Start with explored fog (dark gray, not pure black)
        this.ctx.drawImage(this.exploredCanvas, 0, 0);

        // Clear fog around player (current vision)
        if (player && player.health > 0) {
            this.revealArea(player.position.x, player.position.z, revealRadius);
        }

        // Clear fog around ALL teammates (including bots)
        allUnits.forEach(unit => {
            if (unit.team === gameState.team && unit.health > 0 && unit !== player) {
                this.revealArea(unit.position.x, unit.position.z, revealRadius);
            }
        });

        // Clear fog around farsight areas
        farsightPositions.forEach(pos => {
            this.revealArea(pos.x, pos.z, farsightRadius);
        });

        this.fogTexture.needsUpdate = true;
    }

    markExplored(worldX, worldZ, radius) {
        // Mark this area as explored (permanently partially revealed)
        const x = ((worldX + MAP_SIZE / 2) / MAP_SIZE) * 256;
        const y = ((worldZ + MAP_SIZE / 2) / MAP_SIZE) * 256;
        const radiusPixels = (radius / MAP_SIZE) * 256;

        this.exploredCtx.globalCompositeOperation = 'destination-out';

        // Create semi-transparent explored area
        const gradient = this.exploredCtx.createRadialGradient(x, y, 0, x, y, radiusPixels);
        gradient.addColorStop(0, 'rgba(255, 255, 255, 0.5)'); // 50% revealed
        gradient.addColorStop(0.7, 'rgba(255, 255, 255, 0.4)');
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

        this.exploredCtx.fillStyle = gradient;
        this.exploredCtx.beginPath();
        this.exploredCtx.arc(x, y, radiusPixels, 0, Math.PI * 2);
        this.exploredCtx.fill();

        this.exploredCtx.globalCompositeOperation = 'source-over';
    }

    revealArea(worldX, worldZ, radius) {
        // Convert world coordinates to texture coordinates
        const x = ((worldX + MAP_SIZE / 2) / MAP_SIZE) * 256;
        const y = ((worldZ + MAP_SIZE / 2) / MAP_SIZE) * 256;
        const radiusPixels = (radius / MAP_SIZE) * 256;

        // Create irregular vision area (not a perfect circle)
        this.ctx.globalCompositeOperation = 'destination-out';

        // Draw multiple overlapping circles with slight offsets to create irregular shape
        const numCircles = 8;
        for (let i = 0; i < numCircles; i++) {
            const angle = (i / numCircles) * Math.PI * 2;
            const offset = radiusPixels * 0.15; // 15% variation
            const offsetX = Math.cos(angle) * offset * (Math.random() * 0.5 + 0.5);
            const offsetY = Math.sin(angle) * offset * (Math.random() * 0.5 + 0.5);

            const gradient = this.ctx.createRadialGradient(
                x + offsetX, y + offsetY, 0,
                x + offsetX, y + offsetY, radiusPixels * 0.9
            );
            gradient.addColorStop(0, 'rgba(255, 255, 255, 0.3)');
            gradient.addColorStop(0.6, 'rgba(255, 255, 255, 0.25)');
            gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

            this.ctx.fillStyle = gradient;
            this.ctx.beginPath();
            this.ctx.arc(x + offsetX, y + offsetY, radiusPixels * 0.9, 0, Math.PI * 2);
            this.ctx.fill();
        }

        // Main central clear area
        const gradient = this.ctx.createRadialGradient(x, y, 0, x, y, radiusPixels);
        gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
        gradient.addColorStop(0.7, 'rgba(255, 255, 255, 0.9)');
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

        this.ctx.fillStyle = gradient;
        this.ctx.beginPath();
        this.ctx.arc(x, y, radiusPixels, 0, Math.PI * 2);
        this.ctx.fill();

        this.ctx.globalCompositeOperation = 'source-over';
    }

    isVisible(worldX, worldZ) {
        const x = Math.floor(((worldX + MAP_SIZE / 2) / MAP_SIZE) * 256);
        const y = Math.floor(((worldZ + MAP_SIZE / 2) / MAP_SIZE) * 256);

        if (x < 0 || x >= 256 || y < 0 || y >= 256) return false;

        const imageData = this.ctx.getImageData(x, y, 1, 1);
        return imageData.data[3] < 200; // Check alpha channel
    }
}

const fogOfWar = new FogOfWar();

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
        this.shootRange = 50;
        this.damage = 25;
        this.isWindwalking = false;
        this.farsightActive = false;
        this.farsightPosition = null;

        // Auto-shoot cooldown
        this.shootCooldown = 0;
        this.shootCooldownTime = 1.0; // 1 second between shots

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

        // Legs
        const legGeometry = new THREE.CapsuleGeometry(0.15, 0.8, 6, 8);
        const legMaterial = new THREE.MeshStandardMaterial({
            color: 0x2a2a2a,
            roughness: 0.8
        });
        const leftLeg = new THREE.Mesh(legGeometry, legMaterial);
        leftLeg.position.set(-0.15, -0.2, 0);
        leftLeg.castShadow = true;
        group.add(leftLeg);

        const rightLeg = new THREE.Mesh(legGeometry, legMaterial);
        rightLeg.position.set(0.15, -0.2, 0);
        rightLeg.castShadow = true;
        group.add(rightLeg);

        this.leftLeg = leftLeg;
        this.rightLeg = rightLeg;

        // Torso
        const torsoGeometry = new THREE.BoxGeometry(0.6, 0.8, 0.4);
        const torsoMaterial = new THREE.MeshStandardMaterial({
            color: team === 'red' ? 0xcc0000 : 0x0066cc,
            roughness: 0.7,
            metalness: 0.2
        });
        const torso = new THREE.Mesh(torsoGeometry, torsoMaterial);
        torso.position.y = 0.4;
        torso.castShadow = true;
        torso.receiveShadow = true;
        group.add(torso);

        // Head
        const headGeometry = new THREE.SphereGeometry(0.25, 12, 12);
        const headMaterial = new THREE.MeshStandardMaterial({
            color: 0xffdbac,
            roughness: 0.9
        });
        const head = new THREE.Mesh(headGeometry, headMaterial);
        head.position.y = 1;
        head.castShadow = true;
        group.add(head);

        // Helmet/Hat
        const helmetGeometry = new THREE.CylinderGeometry(0.28, 0.28, 0.15, 12);
        const helmetMaterial = new THREE.MeshStandardMaterial({
            color: team === 'red' ? 0x880000 : 0x003388,
            roughness: 0.6
        });
        const helmet = new THREE.Mesh(helmetGeometry, helmetMaterial);
        helmet.position.y = 1.15;
        helmet.castShadow = true;
        group.add(helmet);

        // Arms
        const armGeometry = new THREE.CapsuleGeometry(0.12, 0.6, 6, 8);
        const armMaterial = new THREE.MeshStandardMaterial({
            color: team === 'red' ? 0xaa0000 : 0x0055aa,
            roughness: 0.7
        });
        const leftArm = new THREE.Mesh(armGeometry, armMaterial);
        leftArm.position.set(-0.4, 0.3, 0);
        leftArm.rotation.z = 0.3;
        leftArm.castShadow = true;
        group.add(leftArm);

        const rightArm = new THREE.Mesh(armGeometry, armMaterial);
        rightArm.position.set(0.4, 0.3, 0);
        rightArm.rotation.z = -0.3;
        rightArm.castShadow = true;
        group.add(rightArm);

        // SNIPER RIFLE
        const rifleGroup = new THREE.Group();

        // Main barrel (long and sleek)
        const barrelGeometry = new THREE.CylinderGeometry(0.04, 0.04, 2.0, 12);
        const barrelMaterial = new THREE.MeshStandardMaterial({
            color: 0x1a1a1a,
            roughness: 0.3,
            metalness: 0.9
        });
        const barrel = new THREE.Mesh(barrelGeometry, barrelMaterial);
        barrel.rotation.x = Math.PI / 2;
        barrel.position.z = 1.0;
        barrel.castShadow = true;
        rifleGroup.add(barrel);

        // Muzzle brake (small tip)
        const muzzleGeometry = new THREE.CylinderGeometry(0.06, 0.04, 0.15, 8);
        const muzzle = new THREE.Mesh(muzzleGeometry, barrelMaterial);
        muzzle.rotation.x = Math.PI / 2;
        muzzle.position.z = 2.075;
        muzzle.castShadow = true;
        rifleGroup.add(muzzle);

        // Scope
        const scopeGeometry = new THREE.CylinderGeometry(0.08, 0.08, 0.6, 12);
        const scopeMaterial = new THREE.MeshStandardMaterial({
            color: 0x0a0a0a,
            roughness: 0.3,
            metalness: 0.9
        });
        const scope = new THREE.Mesh(scopeGeometry, scopeMaterial);
        scope.rotation.x = Math.PI / 2;
        scope.position.set(0, 0.15, 0.5);
        scope.castShadow = true;
        rifleGroup.add(scope);

        // Scope lens
        const lensGeometry = new THREE.CircleGeometry(0.07, 16);
        const lensMaterial = new THREE.MeshStandardMaterial({
            color: 0x2244aa,
            roughness: 0.1,
            metalness: 1,
            emissive: 0x0000aa,
            emissiveIntensity: 0.3
        });
        const lens = new THREE.Mesh(lensGeometry, lensMaterial);
        lens.position.set(0, 0.15, 0.81);
        rifleGroup.add(lens);

        // Scope mount rings
        for (let i = 0; i < 2; i++) {
            const mountGeometry = new THREE.TorusGeometry(0.09, 0.015, 8, 12);
            const mount = new THREE.Mesh(mountGeometry, barrelMaterial);
            mount.rotation.y = Math.PI / 2;
            mount.position.set(0, 0.15, 0.3 + (i * 0.4));
            mount.castShadow = true;
            rifleGroup.add(mount);
        }

        // Wooden stock
        const stockGeometry = new THREE.BoxGeometry(0.15, 0.25, 0.6);
        const stockMaterial = new THREE.MeshStandardMaterial({
            color: 0x4a2a10,
            roughness: 0.8,
            metalness: 0.1
        });
        const stock = new THREE.Mesh(stockGeometry, stockMaterial);
        stock.position.z = -0.3;
        stock.castShadow = true;
        rifleGroup.add(stock);

        // Stock end
        const stockEndGeometry = new THREE.SphereGeometry(0.1, 8, 8);
        const stockEnd = new THREE.Mesh(stockEndGeometry, stockMaterial);
        stockEnd.position.z = -0.6;
        stockEnd.scale.set(1.5, 1.8, 0.8);
        stockEnd.castShadow = true;
        rifleGroup.add(stockEnd);

        // Trigger/grip area
        const gripGeometry = new THREE.BoxGeometry(0.12, 0.25, 0.2);
        const grip = new THREE.Mesh(gripGeometry, stockMaterial);
        grip.position.set(0, -0.15, 0.2);
        grip.castShadow = true;
        rifleGroup.add(grip);

        // Trigger guard
        const triggerGuardGeometry = new THREE.TorusGeometry(0.06, 0.01, 8, 12);
        const triggerGuard = new THREE.Mesh(triggerGuardGeometry, barrelMaterial);
        triggerGuard.rotation.x = Math.PI / 2;
        triggerGuard.position.set(0, -0.12, 0.15);
        triggerGuard.castShadow = true;
        rifleGroup.add(triggerGuard);

        // Magazine
        const magGeometry = new THREE.BoxGeometry(0.08, 0.3, 0.12);
        const magMaterial = new THREE.MeshStandardMaterial({
            color: 0x1a1a1a,
            roughness: 0.4,
            metalness: 0.8
        });
        const magazine = new THREE.Mesh(magGeometry, magMaterial);
        magazine.position.set(0, -0.08, 0.1);
        magazine.castShadow = true;
        rifleGroup.add(magazine);

        // Bolt/action
        const boltGeometry = new THREE.BoxGeometry(0.06, 0.06, 0.15);
        const bolt = new THREE.Mesh(boltGeometry, barrelMaterial);
        bolt.position.set(0.04, 0.03, 0);
        bolt.castShadow = true;
        rifleGroup.add(bolt);

        // Position rifle in character's hands
        rifleGroup.position.set(0.3, 0.5, 0.3);
        rifleGroup.rotation.y = 0.1;
        group.add(rifleGroup);

        this.rifleGroup = rifleGroup;
        this.weapon = rifleGroup; // Keep for backward compatibility

        // Nameplate
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
        sprite.position.y = 1.5;
        sprite.raycast = () => {}; // Disable raycasting for sprites
        group.add(sprite);

        // Health bar
        const healthBarGeometry = new THREE.PlaneGeometry(1, 0.1);
        const healthBarMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
        const healthBar = new THREE.Mesh(healthBarGeometry, healthBarMaterial);
        healthBar.position.y = 1.2;
        group.add(healthBar);
        this.healthBar = healthBar;

        // Player-only features: ground halo + cape
        if (this.isPlayer) {
            // White ground halo ring
            const haloGeometry = new THREE.RingGeometry(0.6, 0.8, 32);
            const haloMaterial = new THREE.MeshBasicMaterial({
                color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.5,
            });
            const halo = new THREE.Mesh(haloGeometry, haloMaterial);
            halo.rotation.x = -Math.PI / 2;
            halo.position.y = -0.45;
            halo.raycast = () => {};
            group.add(halo);

            // Cape — cloth hanging from shoulders
            const capeShape = new THREE.Shape();
            capeShape.moveTo(-0.25, 0);
            capeShape.lineTo(0.25, 0);
            capeShape.lineTo(0.2, -1.2);
            capeShape.lineTo(-0.2, -1.2);
            capeShape.closePath();
            const capeGeometry = new THREE.ShapeGeometry(capeShape);
            const capeMaterial = new THREE.MeshStandardMaterial({
                color: team === 'red' ? 0x660000 : 0x002266,
                side: THREE.DoubleSide,
                roughness: 0.9,
            });
            const cape = new THREE.Mesh(capeGeometry, capeMaterial);
            cape.position.set(0, 0.8, -0.22);
            cape.rotation.x = 0.15; // Slight backward tilt
            cape.castShadow = true;
            group.add(cape);
            this.cape = cape;
        }

        group.position.y = 0.5;
        scene.add(group);
        this.mesh = group;
    }

    update(deltaTime) {
        // Update health bar
        const healthPercent = this.health / this.maxHealth;
        this.healthBar.scale.x = healthPercent;
        this.healthBar.material.color.setHex(
            healthPercent > 0.5 ? 0x00ff00 :
            healthPercent > 0.25 ? 0xffff00 :
            0xff0000
        );

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

        // Running animation
        const isMoving = this.velocity.length() > 0.01;
        if (isMoving && this.leftLeg && this.rightLeg) {
            const runSpeed = 10; // Animation speed
            const time = Date.now() * 0.001 * runSpeed;

            // Leg swing animation
            this.leftLeg.rotation.x = Math.sin(time) * 0.5;
            this.rightLeg.rotation.x = Math.sin(time + Math.PI) * 0.5;

            // Slight body bob
            this.mesh.position.y += Math.sin(time * 2) * 0.02;
        } else if (this.leftLeg && this.rightLeg) {
            // Reset to standing position
            this.leftLeg.rotation.x = 0;
            this.rightLeg.rotation.x = 0;
        }

        // Update shoot cooldown
        if (this.shootCooldown > 0) {
            this.shootCooldown -= deltaTime;
        }

        // Auto-shoot at enemies in FOV
        if (this.health > 0 && this.shootCooldown <= 0) {
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

                    // Check line of sight (walls blocking)
                    const raycaster = new THREE.Raycaster();
                    raycaster.set(this.position, toEnemy);
                    const intersects = raycaster.intersectObjects(scene.children, true);

                    let blocked = false;
                    for (let intersect of intersects) {
                        if (intersect.object.userData.isWall && intersect.distance < distance) {
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
                } else {
                    // Wall slide
                    let moved = false;
                    const slideX = this.position.clone(); slideX.x += this.velocity.x;
                    const slideZ = this.position.clone(); slideZ.z += this.velocity.z;

                    if (!this.checkCollision(slideX)) {
                        this.position.x = slideX.x; moved = true;
                    } else if (!this.checkCollision(slideZ)) {
                        this.position.z = slideZ.z; moved = true;
                    } else {
                        const angle = Math.atan2(direction.z, direction.x);
                        for (const offset of [Math.PI/4, -Math.PI/4, Math.PI/3, -Math.PI/3, Math.PI/2, -Math.PI/2]) {
                            const alt = this.position.clone();
                            alt.x += Math.cos(angle + offset) * speed;
                            alt.z += Math.sin(angle + offset) * speed;
                            if (!this.checkCollision(alt)) {
                                this.position.x = alt.x;
                                this.position.z = alt.z;
                                moved = true;
                                break;
                            }
                        }
                    }

                    if (!moved) {
                        this._stuckFrames++;
                        if (this._stuckFrames > 10) {
                            // Find nearest bot and run AWAY from it + the wall
                            let escapeDir = new THREE.Vector3((Math.random() - 0.5), 0, (Math.random() - 0.5)).normalize();

                            for (const other of gameState.bots) {
                                if (other === this || other.health <= 0) continue;
                                const dist = this.position.distanceTo(other.position);
                                if (dist < 5) {
                                    // Run away from nearby bot
                                    escapeDir.add(new THREE.Vector3().subVectors(this.position, other.position).normalize());
                                }
                            }
                            escapeDir.normalize();

                            this.targetPosition = new THREE.Vector3(
                                this.position.x + escapeDir.x * 25,
                                0.5,
                                this.position.z + escapeDir.z * 25
                            );
                            // Clamp to map bounds
                            this.targetPosition.x = Math.max(-MAP_SIZE/2 + 10, Math.min(MAP_SIZE/2 - 10, this.targetPosition.x));
                            this.targetPosition.z = Math.max(-MAP_SIZE/2 + 10, Math.min(MAP_SIZE/2 - 10, this.targetPosition.z));
                            this._stuckFrames = 0;
                        }
                    } else {
                        this._stuckFrames = 0;
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

        // Check walls — raycast with larger check radius
        const dir = new THREE.Vector3().subVectors(newPos, this.position);
        if (dir.length() < 0.001) return false;
        dir.normalize();

        const raycaster = new THREE.Raycaster();
        raycaster.set(this.position, dir);
        const intersects = raycaster.intersectObjects(scene.children, true);

        for (let intersect of intersects) {
            if (intersect.object.userData.isWall && intersect.distance < 1.5) {
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

        // Check line of sight
        const raycaster = new THREE.Raycaster();
        const direction = new THREE.Vector3().subVectors(target.position, this.position).normalize();
        raycaster.set(this.position, direction);

        const intersects = raycaster.intersectObjects(scene.children, true);
        for (let intersect of intersects) {
            if (intersect.object.userData.isWall && intersect.distance < distance) {
                return; // Wall blocking
            }
        }

        // Play sniper fire sound
        audioManager.play('sniperFire');

        // HUGE CANNON-LIKE SHOOTING ANIMATION
        this.createShootingEffect(target.position);

        // Instant kill (classic snipers!)
        target.die(this);
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

            // Update UI if killer is player
            if (killer.isPlayer) {
                gameState.kills = killer.kills;
                document.getElementById('killCount').textContent = `Kills: ${gameState.kills}`;

                // First blood
                if (!gameState.firstBlood) {
                    gameState.firstBlood = true;
                    audioManager.play('firstBlood');
                }

                // Always play headshot for kills (it's a sniper game!)
                audioManager.play('headshot');

                // Kill streak tracking
                gameState.killStreak++;
                audioManager.playKillStreak(gameState.killStreak);

                // Multi-kill tracking (kills within 4 seconds)
                if (gameState.multiKillTimer > 0) {
                    gameState.multiKillCount++;
                } else {
                    gameState.multiKillCount = 1;
                }
                gameState.multiKillTimer = 4.0; // 4 second window

                if (gameState.multiKillCount >= 2) {
                    audioManager.playMultiKill(gameState.multiKillCount);
                }
            }

            // Show kill feed
            addKillFeed(killer.username, this.username);
        }

        // Reset kill streak when you die
        if (this.isPlayer) {
            gameState.killStreak = 0;
        }

        // Update UI if this is the player
        if (this.isPlayer) {
            gameState.deaths++;
            document.getElementById('deathCount').textContent = `Deaths: ${gameState.deaths}`;
            document.getElementById('healthStat').textContent = `Status: DEAD`;

            // Clear ALL move targets and commands
            gameState.moveTarget = null;
            gameState.targetLock = null;

            // Show death popup
            const popup = document.getElementById('deathPopup');
            const killerName = killer ? killer.username : 'Unknown';
            document.getElementById('deathKiller').textContent = `Killed by ${killerName}`;
            popup.classList.remove('hidden');
        }

        // Hide during death
        this.mesh.visible = false;

        // Clear bot move targets too
        this.targetPosition = null;
        this.attackWalkTarget = null;

        // Respawn after 3 seconds
        setTimeout(() => this.respawn(), 3000);
    }

    respawn() {
        this.health = this.maxHealth;

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
            document.getElementById('healthStat').textContent = `Status: ALIVE`;
        }
    }
}

// UI Functions
function addKillFeed(killer, victim) {
    const killFeed = document.getElementById('killFeed');
    const message = document.createElement('div');
    message.className = 'kill-message';
    message.textContent = `${killer} eliminated ${victim}`;
    killFeed.appendChild(message);

    setTimeout(() => message.remove(), 3000);
}

function updateScoreboard() {
    const redScores = document.getElementById('redScores');
    const blueScores = document.getElementById('blueScores');

    const redPlayers = [];
    const bluePlayers = [];

    if (gameState.player) {
        if (gameState.player.team === 'red') {
            redPlayers.push(gameState.player);
        } else {
            bluePlayers.push(gameState.player);
        }
    }

    gameState.players.forEach(p => {
        if (p.team === 'red') redPlayers.push(p);
        else bluePlayers.push(p);
    });

    gameState.bots.forEach(b => {
        if (b.team === 'red') redPlayers.push(b);
        else bluePlayers.push(b);
    });

    redScores.innerHTML = redPlayers
        .sort((a, b) => b.kills - a.kills)
        .map(p => `<div class="player-score">${p.username}: ${p.kills}-${p.deaths}</div>`)
        .join('');

    blueScores.innerHTML = bluePlayers
        .sort((a, b) => b.kills - a.kills)
        .map(p => `<div class="player-score">${p.username}: ${p.kills}-${p.deaths}</div>`)
        .join('');
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
    gameState.keys[e.key.toLowerCase()] = true;

    // Debug key presses
    if (['w', 'a', 's', 'd'].includes(e.key.toLowerCase())) {
        console.log('Key pressed:', e.key.toLowerCase());
    }

    if (e.key.toLowerCase() === 'q') {
        e.preventDefault();
        useWindwalk();
    }
    if (e.key.toLowerCase() === 'w' && !gameState.keys['w']) {
        // Only use farsight if W is for ability (not movement)
        // Skip this for now - W is for movement
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
    if (e.shiftKey) gameState.attackWalk = true;
});

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

// Create visual move marker
function createMoveMarker(position) {
    const markerGeometry = new THREE.RingGeometry(0.3, 0.5, 16);
    const markerMaterial = new THREE.MeshBasicMaterial({
        color: 0x00ff00,
        transparent: true,
        opacity: 0.8
    });
    const marker = new THREE.Mesh(markerGeometry, markerMaterial);
    marker.rotation.x = -Math.PI / 2;
    marker.position.copy(position);
    marker.position.y = 0.1;
    scene.add(marker);

    // Animate and remove
    let opacity = 0.8;
    const fadeInterval = setInterval(() => {
        opacity -= 0.05;
        markerMaterial.opacity = opacity;
        if (opacity <= 0) {
            clearInterval(fadeInterval);
            scene.remove(marker);
            markerGeometry.dispose();
            markerMaterial.dispose();
        }
    }, 30);
}

// Game Setup
let selectedTeamValue = null;

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
    document.getElementById('controls').classList.remove('hidden');
    document.querySelector('.minimap').classList.remove('hidden');

    document.getElementById('playerName').textContent = username;

    startGame();
});

document.querySelectorAll('.ability').forEach(el => {
    el.addEventListener('click', () => {
        const ability = el.dataset.ability;
        if (ability === 'windwalk') useWindwalk();
        if (ability === 'farsight') useFarsight();
        if (el.id === 'scoreBtn') {
            const sb = document.getElementById('scoreboard');
            sb.classList.toggle('hidden');
            if (!sb.classList.contains('hidden')) updateScoreboard();
        }
    });
});

function startGame() {
    console.log('startGame() called');

    // Remove preview ground
    scene.children.forEach(child => {
        if (child.geometry && child.geometry.type === 'PlaneGeometry') {
            scene.remove(child);
        }
    });

    createMap();
    console.log('Map created');

    // Create player
    gameState.player = new Player(gameState.username, gameState.team, true);
    console.log('Player created:', gameState.player);

    // Initialize camera at player position
    gameState.cameraTarget.copy(gameState.player.position);

    // Create bots (5 per team)
    const botNames = ['Elite', 'Anima', 'Game', 'ESi', 'Apathetic', 'Gem', 'Kflan', 'Jubei', 'Steve', 'Sean'];
    for (let i = 0; i < 10; i++) {
        const team = i < 5 ? 'red' : 'blue';
        const bot = new Player(botNames[i], team, false);
        gameState.bots.push(bot);
    }
    console.log('Bots created:', gameState.bots.length);

    updateScoreboard();
    console.log('Game started! Player can now move with WASD');

    // Make sure the window has focus for keyboard input
    window.focus();
    document.body.focus();

    animate();
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
    smoothCamX = worldX;
    smoothCamZ = worldZ;
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

        minimapCtx.fillStyle = p.team === 'red' ? '#ff0000' : '#0088ff';
        minimapCtx.beginPath();
        minimapCtx.arc(x, y, 3, 0, Math.PI * 2);
        minimapCtx.fill();
    });
}

// Game Loop
let lastTime = performance.now();

function animate() {
    requestAnimationFrame(animate);

    const currentTime = performance.now();
    const deltaTime = (currentTime - lastTime) / 1000;
    lastTime = currentTime;

    if (!gameState.gameStarted) return;

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
    }

    // Clamp camera to map bounds
    const mapBound = MAP_SIZE / 2 - 5;
    gameState.cameraTarget.x = THREE.MathUtils.clamp(gameState.cameraTarget.x, -mapBound, mapBound);
    gameState.cameraTarget.z = THREE.MathUtils.clamp(gameState.cameraTarget.z, -mapBound, mapBound);

    // Smooth camera movement
    camera.position.x = THREE.MathUtils.lerp(camera.position.x, gameState.cameraTarget.x + gameState.cameraOffset.x, 0.18);
    camera.position.y = gameState.cameraOffset.y;
    camera.position.z = THREE.MathUtils.lerp(camera.position.z, gameState.cameraTarget.z + gameState.cameraOffset.z, 0.18);
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

        // Update health display (always alive now)
        document.getElementById('healthStat').textContent = `Status: ALIVE`;
    }

    // Update bots
    gameState.bots.forEach(bot => bot.update(deltaTime));

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

    // Update fog of war with all units (player + all bots)
    const allUnits = [...gameState.bots];
    if (gameState.player) {
        allUnits.push(gameState.player);
    }

    const farsightPositions = [];
    if (gameState.player && gameState.player.farsightActive) {
        farsightPositions.push(gameState.player.farsightPosition);
    }

    fogOfWar.update(gameState.player, allUnits, farsightPositions);

    // Hide ALL enemy units (bots) in fog
    gameState.bots.forEach(bot => {
        if (bot.team !== gameState.team) {
            const visible = fogOfWar.isVisible(bot.position.x, bot.position.z);
            bot.mesh.visible = visible && bot.health > 0;
        } else {
            // Always show friendly units if alive
            bot.mesh.visible = bot.health > 0;
        }
    });

    renderer.render(scene, camera);
}

// Handle window resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Initial render loop (before game starts)
function preGameRender() {
    if (!gameState.gameStarted) {
        requestAnimationFrame(preGameRender);
        renderer.render(scene, camera);
    }
}

// Start pre-game rendering immediately
preGameRender();

// Death popup handlers
document.getElementById('respawnBtn')?.addEventListener('click', () => {
    document.getElementById('deathPopup').classList.add('hidden');
    // Teleport camera to spawn point
    if (gameState.player) {
        const spawnX = gameState.player.team === 'red' ? -70 : 70;
        const spawnZ = gameState.player.team === 'red' ? -70 : 70;
        smoothCamX = spawnX;
        smoothCamZ = spawnZ;
        gameState.cameraTarget.x = spawnX;
        gameState.cameraTarget.z = spawnZ;
    }
});
document.getElementById('deathPopupClose')?.addEventListener('click', () => {
    document.getElementById('deathPopup').classList.add('hidden');
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
let smoothCamX = gameState.cameraTarget.x;
let smoothCamZ = gameState.cameraTarget.z;

// === MOBILE TOUCH — drag anywhere to scroll camera, tap to move/attack ===
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || ('ontouchstart' in window);

if (isMobile) {
    const canvas = document.getElementById('gameCanvas');
    let touchStartPos = null;
    let touchStartTime = 0;
    let isDragging = false;
    // Track each finger separately
    const touches = new Map();
    const DRAG_THRESHOLD = 30;
    const TAP_TIME = 200;
    const HOLD_TIME = 400; // ms — hold this long to enter fast scroll mode
    let holdScrollInterval = null;

    // Smoothed camera uses global smoothCamX/Z

    canvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        for (const t of e.changedTouches) {
            touches.set(t.identifier, {
                startX: t.clientX, startY: t.clientY,
                lastX: t.clientX, lastY: t.clientY,
                startTime: Date.now(), isDrag: false,
            });
        }
        // Pinch setup
        if (e.touches.length === 2) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            gameState._pinchStart = Math.sqrt(dx * dx + dy * dy);
            gameState._pinchZoomStart = gameState.cameraOffset.y;
        }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault();

        // Single finger or first finger of two = camera drag
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
                    // Move the smooth target — actual camera lerps to it
                    smoothCamX -= dx * 0.12;
                    smoothCamZ -= dy * 0.12;
                }

                data.lastX = t.clientX;
                data.lastY = t.clientY;

                // Update mousePos using canvas bounds
                const rect = canvas.getBoundingClientRect();
                gameState.mousePos.x = ((t.clientX - rect.left) / rect.width) * 2 - 1;
                gameState.mousePos.y = -((t.clientY - rect.top) / rect.height) * 2 + 1;
            }
        }

        // Pinch zoom with 2 fingers
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

        for (const t of e.changedTouches) {
            const data = touches.get(t.identifier);
            if (data && !data.isDrag && (Date.now() - data.startTime < TAP_TIME)) {
                // TAP — move character to this position
                // Use canvas bounding rect to get accurate coordinates
                const rect = canvas.getBoundingClientRect();
                const x = data.startX - rect.left;
                const y = data.startY - rect.top;
                gameState.mousePos.x = (x / rect.width) * 2 - 1;
                gameState.mousePos.y = -(y / rect.height) * 2 + 1;
                document.dispatchEvent(new MouseEvent('mousedown', { clientX: data.startX, clientY: data.startY, button: 0, bubbles: true }));
                setTimeout(() => {
                    document.dispatchEvent(new MouseEvent('mouseup', { clientX: data.startX, clientY: data.startY, button: 0, bubbles: true }));
                }, 50);
            }
            touches.delete(t.identifier);
        }

        if (e.touches.length === 0) {
            gameState._pinchStart = null;
        }
    }, { passive: false });

}

// Smooth camera lerp — always runs (mobile + minimap clicks on desktop)
function smoothCameraUpdate() {
    requestAnimationFrame(smoothCameraUpdate);
    const lerp = 0.25;
    gameState.cameraTarget.x += (smoothCamX - gameState.cameraTarget.x) * lerp;
    gameState.cameraTarget.z += (smoothCamZ - gameState.cameraTarget.z) * lerp;
}
smoothCameraUpdate();

// Keep smoothCam in sync when game moves camera (space to center, etc)
if (!isMobile) {
    // On desktop, smoothCam just follows cameraTarget directly
    setInterval(() => {
        smoothCamX = gameState.cameraTarget.x;
        smoothCamZ = gameState.cameraTarget.z;
    }, 100);

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
