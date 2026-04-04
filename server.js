const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname)));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// === CONSTANTS ===
const MAP_SIZE = 200, TICK_RATE = 128, MAX_PLAYERS = 10;
const SHOOT_RANGE = 45, SHOOT_COOLDOWN = 1.0, SPAWN_PROTECTION = 1.5;
const BOT_NAMES = ['Archon','Vex','Nyx','Zara','Kael','Drax','Luna','Hex','Rune','Ash'];

// === MAP DATA — shared static map ===
const mapData = require('./map-data.json');

// Build AABB collision list from all geometry
const WALLS = []; // [minX, minZ, maxX, maxZ]
// Walls
mapData.walls.forEach(w => WALLS.push([w.x - w.w/2, w.z - w.d/2, w.x + w.w/2, w.z + w.d/2]));
// Trees (trunk radius ~0.4)
mapData.trees.forEach(t => WALLS.push([t.x - 0.5, t.z - 0.5, t.x + 0.5, t.z + 0.5]));
// Rocks
mapData.rocks.forEach(r => WALLS.push([r.x - r.s, r.z - r.s, r.x + r.s, r.z + r.s]));
console.log(`Loaded ${WALLS.length} collision objects from map-data.json`);

// Collision check — point vs walls (with radius)
function collidesWithWall(x, z, r = 1.0) {
    for (const [x1, z1, x2, z2] of WALLS) {
        if (x + r > x1 && x - r < x2 && z + r > z1 && z - r < z2) return true;
    }
    return false;
}

// LOS check — simple 2D ray vs AABB
function hasLineOfSight(ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.sqrt(dx*dx + dz*dz);
    if (len < 0.1) return true;
    const steps = Math.ceil(len / 1.0); // Check every 1 unit
    for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const px = ax + dx * t, pz = az + dz * t;
        if (collidesWithWall(px, pz, 0.1)) return false;
    }
    return true;
}

function terrainY(x,z){return Math.sin(x*0.1)*Math.cos(z*0.1)*2}
function dist(a,b){return Math.sqrt((a.x-b.x)**2+(a.z-b.z)**2)}
function spawnPos(team){const s=team==='red'?-70:70;return{x:s+Math.random()*10-5,z:s+Math.random()*10-5}}
function isNearSpawn(p){const s=p.team==='red'?-70:70;return Math.sqrt((p.x-s)**2+(p.z-s)**2)<15}

// === STATE ===
const players = new Map(); // id -> state
let nextId = 1;
let firstBlood = false;

function createPlayer(id,name,team,isBot){
    const pos = spawnPos(team);
    return {id,username:name,team,isBot,x:pos.x,z:pos.z,y:terrainY(pos.x,pos.z)+0.5,
        rot:0,health:100,kills:0,deaths:0,price:1.0,gold:0,streak:0,
        spawnProt:SPAWN_PROTECTION,windwalk:false,shootCd:0,
        moveTarget:null,botState:'explore',botTarget:null,campTimer:0};
}

// Init bots
for(let i=0;i<MAX_PLAYERS;i++){
    const team=i<5?'red':'blue';
    const bot=createPlayer(nextId++,BOT_NAMES[i],team,true);
    players.set(bot.id,bot);
}

// === BINARY STATE ENCODING ===
// Each player: 28 bytes (id:2, x:f32, z:f32, rot:f32, health:1, kills:2, deaths:2, price:f32, flags:1)
function encodeState(){
    const count = players.size;
    const buf = new ArrayBuffer(2 + count * 28);
    const view = new DataView(buf);
    view.setUint16(0, count, true);
    let off = 2;
    players.forEach(p => {
        view.setUint16(off, p.id, true); off+=2;
        view.setFloat32(off, p.x, true); off+=4;
        view.setFloat32(off, p.z, true); off+=4;
        view.setFloat32(off, p.rot, true); off+=4;
        view.setUint8(off, p.health > 0 ? 1 : 0); off+=1;
        view.setInt16(off, p.kills, true); off+=2;
        view.setInt16(off, p.deaths, true); off+=2;
        view.setFloat32(off, p.price, true); off+=4;
        // flags: bit0=windwalk, bit1=spawnProt, bit2=isBot, bit3=blue team
        let flags = 0;
        if(p.windwalk) flags |= 1;
        if(p.spawnProt > 0) flags |= 2;
        if(p.isBot) flags |= 4;
        if(p.team === 'blue') flags |= 8;
        view.setUint8(off, flags); off+=1;
        // streak + gold packed
        view.setInt16(off, p.streak, true); off+=2;
        view.setInt16(off, Math.min(p.gold, 32767), true); off+=2;
    });
    return buf;
}

// === BOT AI ===
function updateBot(bot, dt){
    if(bot.health<=0)return;
    let closestEnemy=null,closestDist=Infinity;
    players.forEach(e=>{if(e!==bot&&e.team!==bot.team&&e.health>0){const d=dist(bot,e);if(d<closestDist){closestDist=d;closestEnemy=e}}});

    if(bot.botState==='camp'){bot.campTimer+=dt;if(bot.campTimer>5||closestEnemy&&closestDist<50)bot.botState='explore';return}
    if(closestEnemy&&closestDist<50)bot.botTarget={x:closestEnemy.x,z:closestEnemy.z};
    if(!bot.botTarget||dist(bot,{x:bot.botTarget.x,z:bot.botTarget.z})<3){
        if(Math.random()<0.15){bot.botState='camp';bot.campTimer=0;bot.botTarget=null;return}
        bot.botState='explore';bot.botTarget={x:(Math.random()-0.5)*MAP_SIZE*0.7,z:(Math.random()-0.5)*MAP_SIZE*0.7};
    }
    if(bot.botTarget){
        const dx=bot.botTarget.x-bot.x,dz=bot.botTarget.z-bot.z,d=Math.sqrt(dx*dx+dz*dz);
        if(d>0.5){
            const spd=8*dt;
            const nx=bot.x+dx/d*spd, nz=bot.z+dz/d*spd;
            if(!collidesWithWall(nx,nz)){
                bot.x=Math.max(-MAP_SIZE/2+2,Math.min(MAP_SIZE/2-2,nx));
                bot.z=Math.max(-MAP_SIZE/2+2,Math.min(MAP_SIZE/2-2,nz));
            } else {
                // Wall slide — try X only, then Z only
                if(!collidesWithWall(nx,bot.z)) bot.x=nx;
                else if(!collidesWithWall(bot.x,nz)) bot.z=nz;
                else bot.botTarget=null; // Stuck, pick new target
            }
            bot.y=terrainY(bot.x,bot.z)+0.5;bot.rot=Math.atan2(dx,dz);
        }
    }
}

// === SHOOTING ===
function tryShoot(attacker){
    if(attacker.health<=0)return; // Dead can't shoot
    let closest=null,closestDist=Infinity;
    players.forEach(p=>{
        if(p!==attacker&&p.team!==attacker.team&&p.health>0){
            const d=dist(attacker,p);
            if(d<closestDist&&d<=SHOOT_RANGE&&hasLineOfSight(attacker.x,attacker.z,p.x,p.z)){
                closest=p;closestDist=d;
            }
        }
    });
    if(!closest)return;
    attacker.shootCd=SHOOT_COOLDOWN;
    if(closest.spawnProt>0)return;

    closest.health=0;closest.deaths++;closest.price=Math.max(0.1,closest.price*0.5);
    attacker.kills++;attacker.streak++;attacker.price+=0.5+closest.price*0.3;
    const gold=50+attacker.streak*10+Math.round(closest.price*10);attacker.gold+=gold;
    const fb=!firstBlood;if(fb)firstBlood=true;

    broadcast(JSON.stringify({t:'k',ki:attacker.id,kn:attacker.username,vi:closest.id,vn:closest.username,g:gold,p:attacker.price,s:attacker.streak,fb:fb?1:0}));

    setTimeout(()=>{
        if(!players.has(closest.id))return;
        const pos=spawnPos(closest.team);closest.health=100;closest.x=pos.x;closest.z=pos.z;
        closest.y=terrainY(pos.x,pos.z)+0.5;closest.spawnProt=SPAWN_PROTECTION;closest.streak=0;
        broadcast(JSON.stringify({t:'r',id:closest.id,x:pos.x,z:pos.z}));
    },5000);
}

function broadcast(data){wss.clients.forEach(ws=>{if(ws.readyState===1)ws.send(data)})}

// === GAME LOOP — 128hz simulation, 20hz network send ===
const SEND_RATE = 20;
let tickCount = 0;
const sendEvery = Math.round(TICK_RATE / SEND_RATE);

setInterval(()=>{
    const dt=1/TICK_RATE;
    tickCount++;
    players.forEach(p=>{
        if(p.health<=0)return;
        if(p.spawnProt>0){p.spawnProt-=dt;if(!isNearSpawn(p))p.spawnProt=0}
        if(p.shootCd>0)p.shootCd-=dt;
        if(p.isBot)updateBot(p,dt);
        else if(p.moveTarget){
            const dx=p.moveTarget.x-p.x,dz=p.moveTarget.z-p.z,d=Math.sqrt(dx*dx+dz*dz);
            if(d<1){p.moveTarget=null}else{
                const spd=(p.windwalk?14:8)*dt;
                const nx=p.x+dx/d*spd, nz=p.z+dz/d*spd;
                if(!collidesWithWall(nx,nz)){
                    p.x=Math.max(-MAP_SIZE/2+2,Math.min(MAP_SIZE/2-2,nx));
                    p.z=Math.max(-MAP_SIZE/2+2,Math.min(MAP_SIZE/2-2,nz));
                } else if(!collidesWithWall(nx,p.z)) p.x=nx;
                else if(!collidesWithWall(p.x,nz)) p.z=nz;
                p.y=terrainY(p.x,p.z)+0.5;p.rot=Math.atan2(dx,dz);
            }
        }
        if(p.shootCd<=0)tryShoot(p);
    });
    // Send state at lower rate to save bandwidth
    if(tickCount % sendEvery === 0){
        const buf=encodeState();
        wss.clients.forEach(ws=>{if(ws.readyState===1)ws.send(buf)});
    }
},1000/TICK_RATE);

// === CONNECTIONS ===
wss.on('connection',ws=>{
    ws.playerId=null;
    ws.on('message',data=>{
        try{
            const msg=JSON.parse(data);
            if(msg.t==='join'){
                const name=(msg.n||'Sniper').slice(0,12);
                const team=msg.m==='blue'?'blue':'red';
                // Remove a bot from this team
                for(const[id,p]of players){if(p.isBot&&p.team===team){players.delete(id);break}}
                const player=createPlayer(nextId++,name,team,false);
                players.set(player.id,player);
                ws.playerId=player.id;
                // Send join confirmation + roster
                const roster=[];players.forEach(p=>roster.push({id:p.id,n:p.username,m:p.team,b:p.isBot?1:0}));
                ws.send(JSON.stringify({t:'j',id:player.id,roster}));
                broadcast(JSON.stringify({t:'pj',n:name,m:team}));
                console.log(`${name} joined ${team}. Total: ${players.size}`);
            }
            else if(msg.t==='mv'&&ws.playerId){
                const p=players.get(ws.playerId);
                if(p)p.moveTarget={x:msg.x,z:msg.z};
            }
            else if(msg.t==='ch'&&ws.playerId){
                const p=players.get(ws.playerId);
                if(p&&msg.x)broadcast(JSON.stringify({t:'ch',n:p.username,m:p.team,x:String(msg.x).slice(0,200)}));
            }
            else if(msg.t==='ab'&&ws.playerId){
                const p=players.get(ws.playerId);
                if(p&&msg.a==='ww'){p.windwalk=true;setTimeout(()=>{p.windwalk=false},3000)}
            }
        }catch{}
    });
    ws.on('close',()=>{
        if(ws.playerId){
            const p=players.get(ws.playerId);
            if(p){
                const team=p.team;players.delete(ws.playerId);
                const bot=createPlayer(nextId++,BOT_NAMES[Math.floor(Math.random()*BOT_NAMES.length)],team,true);
                players.set(bot.id,bot);
                broadcast(JSON.stringify({t:'pl',n:p.username}));
                console.log(`${p.username} left, bot added`);
            }
        }
    });
});

const PORT=process.env.PORT||3000;
server.listen(PORT,'0.0.0.0',()=>console.log(`Elite Snipers server on port ${PORT} (${players.size} bots)`));
