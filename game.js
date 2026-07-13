'use strict';
/* ============================================================
   三角洲行动 · 搜打撤 原型
   核心循环：进入战场 → 搜索物资(集装箱) → 与AI交火 → 抵达撤离点撤离
   成功撤离：保留本次搜刮价值；阵亡/超时未撤离：丢失全部战利品
   ============================================================ */

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let W = window.innerWidth, H = window.innerHeight;
function resize(){ W = window.innerWidth; H = window.innerHeight; canvas.width = W; canvas.height = H; }
window.addEventListener('resize', resize); resize();

/* ---------------- 工具函数 ---------------- */
const TAU = Math.PI * 2;
const clamp = (v,a,b)=> v<a?a:(v>b?b:v);
const dist = (ax,ay,bx,by)=> Math.hypot(ax-bx, ay-by);
const lerp = (a,b,t)=> a+(b-a)*t;
const rand = (a,b)=> a+Math.random()*(b-a);
const randi = (a,b)=> Math.floor(rand(a,b+1));
const choice = arr => arr[Math.floor(Math.random()*arr.length)];

function segSeg(x1,y1,x2,y2,x3,y3,x4,y4){
  const d=(x2-x1)*(y4-y3)-(y2-y1)*(x4-x3);
  if(d===0) return false;
  const t=((x3-x1)*(y4-y3)-(y3-y1)*(x4-x3))/d;
  const u=((x3-x1)*(y2-y1)-(y3-y1)*(x2-x1))/d;
  return t>=0&&t<=1&&u>=0&&u<=1;
}
function segRect(x1,y1,x2,y2,r){
  if(Math.max(x1,x2)<r.x || Math.min(x1,x2)>r.x+r.w) return false;
  if(Math.max(y1,y2)<r.y || Math.min(y1,y2)>r.y+r.h) return false;
  if(x1>=r.x&&x1<=r.x+r.w&&y1>=r.y&&y1<=r.y+r.h) return true;
  if(x2>=r.x&&x2<=r.x+r.w&&y2>=r.y&&y2<=r.y+r.h) return true;
  const e=[[r.x,r.y,r.x+r.w,r.y],[r.x+r.w,r.y,r.x+r.w,r.y+r.h],
           [r.x+r.w,r.y+r.h,r.x,r.y+r.h],[r.x,r.y+r.h,r.x,r.y]];
  for(const s of e){ if(segSeg(x1,y1,x2,y2,s[0],s[1],s[2],s[3])) return true; }
  return false;
}
function lineOfSight(x1,y1,x2,y2){
  for(const w of walls){ if(segRect(x1,y1,x2,y2,w)) return false; }
  return true;
}
// 圆 vs 矩形，返回修正后的 {x,y}
function resolveCircleRect(cx,cy,r,rect){
  const nx=clamp(cx,rect.x,rect.x+rect.w);
  const ny=clamp(cy,rect.y,rect.y+rect.h);
  const dx=cx-nx, dy=cy-ny, d2=dx*dx+dy*dy;
  if(d2<r*r){
    const d=Math.sqrt(d2)||0.0001, push=r-d;
    return {x:cx+dx/d*push, y:cy+dy/d*push};
  }
  return {x:cx,y:cy};
}
function pointInRect(x,y,r){ return x>=r.x&&x<=r.x+r.w&&y>=r.y&&y<=r.y+r.h; }

/* ---------------- 世界 ---------------- */
const WORLD_W = 2600, WORLD_H = 1800;
let walls = [];
let crates = [];
let enemies = [];
let bullets = [];
let pickups = [];
let extracts = [];
let particles = [];
let bosses = [];
let scoreboard = [];

let mapData=null, currentMapName='', currentMapId='';
const MAP_BUILD = { hq:mapHQ, port:mapPort, factory:mapFactory, canyon:mapCanyon };
// 行动难度（与 meta.js 的 OPS_TIERS 对应；带兜底）
const OPS_TIERS = window.OPS_TIERS || {
  normal:      {name:'常规', enemyN:7,  enemyHp:40, loot:1.0, extract:5, dmg:1.00, bossCount:0, bossHp:0},
  confidential:{name:'机密', enemyN:9,  enemyHp:45, loot:1.4, extract:6, dmg:1.15, bossCount:1, bossHp:450},
  topsecret:   {name:'绝密', enemyN:12, enemyHp:50, loot:2.0, extract:8, dmg:1.35, bossCount:1, bossHp:650}
};
// 护甲等级（1~6）：max=甲量(耐久)，reduce=伤害减免比例
const ARMOR_TIERS = {
  1:{max:30,  reduce:0.15},
  2:{max:55,  reduce:0.28},
  3:{max:80,  reduce:0.38},
  4:{max:105, reduce:0.48},
  5:{max:135, reduce:0.58},
  6:{max:170, reduce:0.68}
};
window.ARMOR_TIERS = ARMOR_TIERS;
function buildWorld(mapId){
  walls=[];
  // 外围边界
  const t = 40;
  walls.push({x:0,y:0,w:WORLD_W,h:t});
  walls.push({x:0,y:WORLD_H-t,w:WORLD_W,h:t});
  walls.push({x:0,y:0,w:t,h:WORLD_H});
  walls.push({x:WORLD_W-t,y:0,w:t,h:WORLD_H});
  // 选择地图（random 或指定 id）
  const list=(window.OPS_MAPS||[]).filter(m=>m.id!=='random');
  let chosen=null;
  if(mapId && mapId!=='random'){ const info=list.find(m=>m.id===mapId); if(info) chosen={id:info.id,name:info.name,build:MAP_BUILD[info.id]}; }
  if(!chosen){ const info=list[Math.floor(Math.random()*list.length)]; chosen={id:info.id,name:info.name,build:MAP_BUILD[info.id]}; }
  currentMapName=chosen.name; currentMapId=chosen.id;
  mapData = chosen.build();
}

// 地图1：中央指挥楼 + 两侧仓库 + 下方兵营
function mapHQ(){
  walls.push({x:1080,y:680,w:440,h:40});
  walls.push({x:1080,y:1080,w:440,h:40});
  walls.push({x:1080,y:680,w:40,h:440});
  walls.push({x:1480,y:680,w:40,h:440});
  walls.push({x:1280,y:680,w:40,h:200});
  walls.push({x:1280,y:920,w:40,h:200});
  walls.push({x:300,y:300,w:40,h:420});
  walls.push({x:300,y:300,w:360,h:40});
  walls.push({x:620,y:300,w:40,h:420});
  walls.push({x:300,y:720,w:360,h:40});
  walls.push({x:1960,y:300,w:40,h:420});
  walls.push({x:1960,y:300,w:360,h:40});
  walls.push({x:2280,y:300,w:40,h:420});
  walls.push({x:1960,y:720,w:360,h:40});
  walls.push({x:400,y:1300,w:40,h:340});
  walls.push({x:400,y:1300,w:520,h:40});
  walls.push({x:880,y:1300,w:40,h:340});
  walls.push({x:400,y:1600,w:520,h:40});
  const covers=[[760,820,120,40],[1700,820,120,40],[900,1180,40,160],
                [1500,1180,40,160],[500,1000,140,40],[2000,1000,140,40],
                [1180,420,40,120],[1180,1280,40,120]];
  for(const c of covers) walls.push({x:c[0],y:c[1],w:c[2],h:c[3]});
  const crateSpots=[[420,480],[560,560],[2100,480],[2240,560],[760,500],[1820,500],
                    [1280,560],[1300,1140],[700,980],[1980,980],[1180,920],[1180,1000],
                    [500,1420],[820,1480],[1500,1420],[2150,1420],[980,300],[2000,300],
                    [340,1180],[2300,1180]];
  return finalizeMap(crateSpots, [
    {kind:'safe',  x:1280, y:900},
    {kind:'weapon',x:1180, y:1180}
  ]);
}

// 地图2：港口堆叠集装箱矩阵
function mapPort(){
  for(let r=0;r<5;r++) for(let c=0;c<7;c++){
    const x=260+c*340, y=240+r*280;
    if((r+c)%2===0) walls.push({x,y,w:160,h:60});
    else walls.push({x,y,w:60,h:160});
  }
  walls.push({x:200,y:1420,w:2200,h:50});
  walls.push({x:200,y:200,w:50,h:1220});
  walls.push({x:2350,y:200,w:50,h:1220});
  const crateSpots=[];
  for(let r=0;r<5;r++) for(let c=0;c<7;c++){ crateSpots.push([260+c*340+80, 240+r*280-30]); }
  return finalizeMap(crateSpots, [
    {kind:'safe',  x:1500, y:900},
    {kind:'weapon',x:700,  y:900}
  ]);
}

// 地图3：废弃工厂立柱阵 + 中央车间
function mapFactory(){
  for(let r=0;r<4;r++) for(let c=0;c<6;c++){ walls.push({x:320+c*380,y:300+r*360,w:70,h:70}); }
  walls.push({x:1100,y:760,w:400,h:40});
  walls.push({x:1100,y:1040,w:400,h:40});
  walls.push({x:1100,y:760,w:40,h:320});
  walls.push({x:1460,y:760,w:40,h:320});
  const crateSpots=[[400,400],[760,420],[1120,400],[1480,420],[1840,400],
                    [400,900],[1840,900],[400,1300],[760,1320],[1480,1320],[1840,1300],
                    [1120,1300],[1480,760],[760,760]];
  return finalizeMap(crateSpots, [
    {kind:'safe',  x:1300, y:900},
    {kind:'weapon',x:760,  y:560}
  ]);
}

// 地图4：峡谷哨站，斜向岩壁走廊
function mapCanyon(){
  for(let i=0;i<6;i++){ const x=200+i*400; walls.push({x,y:300,w:260,h:40}); walls.push({x,y:1120,w:260,h:40}); }
  walls.push({x:1180,y:760,w:240,h:40});
  walls.push({x:1180,y:1000,w:240,h:40});
  walls.push({x:1180,y:760,w:40,h:280});
  walls.push({x:1380,y:760,w:40,h:280});
  const crateSpots=[[300,500],[700,520],[1100,500],[1500,520],[1900,500],[2300,520],
                    [300,900],[700,920],[1900,900],[2300,920],[1100,1300],[1500,1320],[500,1360],[2100,1360]];
  return finalizeMap(crateSpots, [
    {kind:'safe',  x:1300, y:880},
    {kind:'weapon',x:700,  y:700}
  ]);
}

// 通用收尾：生成撤离点（角落安全区）+ 高价值容器布局
function finalizeMap(crateSpots, specials){
  const ex1=safePos(80); ex1.x=clamp(ex1.x,120,520); ex1.y=clamp(ex1.y,120,520);
  const ex2=safePos(80); ex2.x=clamp(ex2.x,WORLD_W-520,WORLD_W-120); ex2.y=clamp(ex2.y,WORLD_H-520,WORLD_H-120);
  return { crateSpots, specials:specials||[], extracts:[
    {x:ex1.x,y:ex1.y,r:60,label:'撤离点 A'},
    {x:ex2.x,y:ex2.y,r:60,label:'撤离点 B'}
  ]};
}

function farFromWalls(x,y,pad){
  for(const w of walls){ if(x>w.x-pad&&x<w.x+w.w+pad&&y>w.y-pad&&y<w.y+w.h+pad) return false; }
  return true;
}
function safePos(pad){ // 在世界中随机找一个不贴墙的位置
  for(let i=0;i<200;i++){
    const x=rand(120,WORLD_W-120), y=rand(120,WORLD_H-120);
    if(farFromWalls(x,y,pad)) return {x,y};
  }
  return {x:WORLD_W/2,y:WORLD_H/2};
}

/* ---------------- 武器 ---------------- */
const WEAPONS = {
  rifle:  {name:'突击步枪', dmg:22, rpm:540, mag:30, magMax:30, reserve:120, reserveMax:240,
           spread:0.025, speed:1150, range:1000, auto:true,  pellets:1, color:'#73e0ff'},
  smg:    {name:'冲锋枪',   dmg:15, rpm:900, mag:35, magMax:35, reserve:140, reserveMax:280,
           spread:0.06,  speed:1000, range:680,  auto:true,  pellets:1, color:'#ffd86b'},
  shotgun:{name:'霰弹枪',   dmg:11, rpm:85,  mag:8,  magMax:8,  reserve:32,  reserveMax:64,
           spread:0.14,  speed:900,  range:420,  auto:false, pellets:8, color:'#ff9a5a'},
  sniper: {name:'狙击枪',   dmg:95, rpm:45,  mag:5,  magMax:5,  reserve:25,  reserveMax:50,
           spread:0.004, speed:1500, range:1500, auto:false, pellets:1, color:'#c08bff'},
  lmg:    {name:'轻机枪',   dmg:18, rpm:680, mag:80, magMax:80, reserve:240, reserveMax:480,
           spread:0.055, speed:1100, range:900,  auto:true,  pellets:1, color:'#ff6b6b'},
  pistol: {name:'手枪',     dmg:14, rpm:320, mag:12, magMax:12, reserve:60,  reserveMax:120,
           spread:0.04,  speed:1000, range:600,  auto:false, pellets:1, color:'#cfd6dd'}
};

/* ---------------- 游戏状态 ---------------- */
let state = 'menu'; // menu | play | dead | win | base
window.setGameState = function(s){ state = s; };
let player, loadoutValue, raidValue, kills, matchTime, timeLeft;
let remotePlayers={}, currentTier='normal', extractNeed=5, netMyColor='#39b6ff', lastDamager=null, netSendT=0;
let camX=0, camY=0, shake=0, lastTime=0;
let searchTarget=null, searchProg=0;
const MATCH_SECONDS = 360; // 6分钟

function newPlayer(){
  return {
    x:200, y:200, r:14, angle:0,
    hp:100, hpMax:100, armor:55, armorMax:55, armorReduce:0.28, armorLevel:2,
    meds:2, speed:200, sprint:330,
    weapons:{rifle:{...WEAPONS.rifle}},
    slots:['rifle'],
    cur:'rifle',
    name:'玩家', color:'#39b6ff',
    fireCd:0, reloadT:0,
    flash:0, hitFlash:0
  };
}

function startGame(loadout){
  if(window.Meta) Meta.hideBase();
  for(const k in keys) keys[k]=false; mouse.down=false;
  remotePlayers={}; lastDamager=null; netSendT=0;
  currentTier = (loadout && loadout.tier) || 'normal';
  const tier = OPS_TIERS[currentTier] || OPS_TIERS.normal;
  extractNeed = tier.extract;
  buildWorld(loadout && loadout.map);
  player = newPlayer();
  // 接入局外配装（主/副双槽 + 护甲等级 + 代号）
  if(loadout && window.Meta){
    const slotIds=[loadout.weapon, loadout.weapon2].filter(id=>id && WEAPONS[id]);
    player.weapons={}; player.slots=[];
    for(const id of slotIds){ player.weapons[id]={...WEAPONS[id]}; if(!player.slots.includes(id)) player.slots.push(id); }
    player.cur=player.slots[0]||'rifle';
    const lvl = loadout.armorLevel||2;
    const at = ARMOR_TIERS[lvl]||ARMOR_TIERS[2];
    player.armorMax = at.max; player.armor = at.max; player.armorReduce = at.reduce; player.armorLevel=lvl;
    player.meds = loadout.meds;
    const bonus = loadout.ammo*60;
    for(const id in player.weapons){ const w=player.weapons[id]; w.reserve=Math.min(w.reserveMax, w.reserve+bonus); }
    player.name = (loadout.name||'玩家'); player.color = netMyColor;
    loadoutValue = Meta.itemValue(loadout.weapon) + (loadout.weapon2&&loadout.weapon2!=='pistol'?Meta.itemValue(loadout.weapon2):0) + Meta.itemValue('armor'+lvl);
  } else {
    player.armorMax=55; player.armor=55; player.armorReduce=0.28; player.armorLevel=2;
    loadoutValue = 1500;
  }
  // 合理出生点
  const sp = safePos(60); player.x=sp.x; player.y=sp.y;
  raidValue = 0; kills = 0;
  timeLeft = MATCH_SECONDS; matchTime = 0;
  bullets=[]; pickups=[]; particles=[];
  searchTarget=null; searchProg=0;

  // 集装箱 / 高价值容器（搜索点）—— 来自地图布局
  crates=[];
  for(const s of (mapData.crateSpots||[])){
    if(!farFromWalls(s[0],s[1],20)) continue;
    crates.push({x:s[0],y:s[1],r:18,kind:'normal',searched:false,loot:rollLoot(),searchNeed:1.4});
  }
  // 高价值容器：大保险(5s) / 武器箱(4s)
  for(const s of (mapData.specials||[])){
    let x=s.x, y=s.y;
    if(!farFromWalls(x,y,30)){ const p=safePos(40); x=p.x; y=p.y; }
    const need = s.kind==='safe'?5:(s.kind==='weapon'?4:1.4);
    const r = s.kind==='safe'?26:(s.kind==='weapon'?22:18);
    crates.push({x,y,r,kind:s.kind,searched:false,
      loot:(s.kind==='safe'?rollSafeLoot():(s.kind==='weapon'?rollWeaponLoot():rollLoot())),
      searchNeed:need});
  }
  if(crates.length===0){ const sp=safePos(30); crates.push({x:sp.x,y:sp.y,r:18,kind:'normal',searched:false,loot:rollLoot(),searchNeed:1.4}); }

  // 敌人（数量随难度变化）
  enemies=[];
  const enemyN = tier.enemyN;
  for(let i=0;i<enemyN;i++){
    const p = safePos(40);
    enemies.push(makeEnemy(p.x,p.y));
  }

  // Boss 守卫（机密/绝密各 1 个，常规则无）
  bosses=[];
  const bc = tier.bossCount||0;
  for(let i=0;i<bc;i++){ const p=safePos(50); bosses.push(makeBoss(p.x,p.y, tier.bossHp||450)); }

  // 撤离点
  extracts = (mapData.extracts||[]).map(e=>({...e, t:0}));
  if(extracts.length===0){ const ex=safePos(60); extracts.push({x:ex.x,y:ex.y,r:60,label:'撤离点',t:0}); }

  state='play';
}

function rollLoot(){
  // 返回 {type, value, label}
  const roll=Math.random();
  if(roll<0.45) return {type:'money', value:randi(200,900), label:'战利品'};
  if(roll<0.65) return {type:'ammo', value:0, label:'弹药箱'};
  if(roll<0.80) return {type:'med', value:0, label:'医疗包'};
  if(roll<0.92) return {type:'armor', value:0, label:'防弹插板'};
  if(roll<0.99) return {type:'smg', value:0, label:'冲锋枪'};
  return {type:'intel', value:2500, label:'机密情报'};
}
// 大保险：高价值现金（按难度倍率在搜出时再乘）
function rollSafeLoot(){ return {type:'money', value:randi(3000,8000), label:'大保险'}; }
// 武器箱：随机一把可拾取武器
function rollWeaponLoot(){ const ids=['smg','shotgun','sniper','lmg']; return {type:'weapon', value:choice(ids), label:'武器箱'}; }

function makeEnemy(x,y){
  const wps=[{x,y}];
  for(let i=0;i<3;i++){ const p=safePos(50); wps.push({x:p.x,y:p.y}); }
  return {
    x,y,r:13, hp:(OPS_TIERS[currentTier]||OPS_TIERS.normal).enemyHp, hpMax:(OPS_TIERS[currentTier]||OPS_TIERS.normal).enemyHp, angle:rand(0,TAU),
    state:'patrol', wps, wi:1, speed:92,
    sight:300, shootRange:430, fireCd:0, rpm:110,
    reactT:0, loseT:2, lastSeen:null, color:'#ff5a5a', name:'守卫'
  };
}

function makeBoss(x,y,hp){
  const wps=[{x,y}];
  for(let i=0;i<3;i++){ const p=safePos(60); wps.push({x:p.x,y:p.y}); }
  return {
    x,y,r:26, hp,hpMax:hp, angle:rand(0,TAU),
    state:'patrol', wps, wi:1, speed:78,
    sight:540, shootRange:680, fireCd:0, rpm:80,
    reactT:0, loseT:3, lastSeen:null, color:'#ff2d6b', name:'BOSS · 重装指挥官'
  };
}
function bossShoot(e){
  const dmg=14*(OPS_TIERS[currentTier]||OPS_TIERS.normal).dmg;
  const base=Math.atan2(player.y-e.y,player.x-e.x);
  for(let k=-1;k<=1;k++){
    const a=base + k*0.12 + (Math.random()-0.5)*0.06;
    const mx=e.x+Math.cos(e.angle)*e.r, my=e.y+Math.sin(e.angle)*e.r;
    bullets.push({x:mx,y:my,vx:Math.cos(a)*760,vy:Math.sin(a)*760,
                  dmg:dmg,range:720,travel:0,owner:'enemy',color:'#ff5a8a'});
  }
}
function updateBosses(dt){
  for(const e of bosses){
    if(e.hp<=0) continue;
    if(e.reactT>0) e.reactT-=dt;
    const seePlayer = dist(e.x,e.y,player.x,player.y)<e.sight && lineOfSight(e.x,e.y,player.x,player.y);
    e.fireCd=Math.max(0,e.fireCd-dt);
    if(seePlayer){ if(e.state!=='chase') e.reactT=0.8; e.state='chase'; e.lastSeen={x:player.x,y:player.y}; e.loseT=3; }
    else if(e.state==='chase'){ e.loseT-=dt; if(e.loseT<=0) e.state='patrol'; }
    if(e.state==='chase' && e.lastSeen){
      const d=dist(e.x,e.y,player.x,player.y);
      e.angle=Math.atan2(player.y-e.y,player.x-e.x);
      if(d>e.shootRange*0.7) moveEnemy(e,player.x,player.y,dt);
      const canShoot = d<e.shootRange && lineOfSight(e.x,e.y,player.x,player.y) && e.fireCd<=0 && e.reactT<=0;
      if(canShoot){ bossShoot(e); e.fireCd=60/e.rpm; }
    } else {
      const wp=e.wps[e.wi];
      e.angle=Math.atan2(wp.y-e.y,wp.x-e.x);
      if(dist(e.x,e.y,wp.x,wp.y)<28){ e.wi=(e.wi+1)%e.wps.length; }
      else moveEnemy(e,wp.x,wp.y,dt);
    }
  }
}
function bossDie(e){
  spawnHit(e.x,e.y,'#ffd');
  const v=Math.round(6000*lootMult());
  raidValue+=v; toast('★ BOSS 已消灭 +¥'+v);
  pickups.push({x:e.x+22,y:e.y,r:14,type:'diamond'});
  pickups.push({x:e.x-22,y:e.y,r:14,type:'intel'});
  shake=Math.max(shake,10);
}

function lootMult(){ return (OPS_TIERS[currentTier]||OPS_TIERS.normal).loot; }

/* ---------------- 输入 ---------------- */
const keys={}, mouse={x:W/2,y:H/2,down:false};
window.addEventListener('keydown',e=>{
  keys[e.key.toLowerCase()]=true;
  if((state==='menu'||state==='win'||state==='dead') && (e.key==='Enter'||e.key===' ')) Meta.showBase();
  if(state==='play'){
    if(e.key.toLowerCase()==='r') reload();
    const n=parseInt(e.key,10);
    if(!isNaN(n) && n>=1 && n<=9){ const id=player && player.slots[n-1]; if(id) player.cur=id; }
  }
  if([' ','arrowup','arrowdown','arrowleft','arrowright'].includes(e.key.toLowerCase())) e.preventDefault();
});
window.addEventListener('keyup',e=>{ keys[e.key.toLowerCase()]=false; });
window.addEventListener('blur',()=>{ for(const k in keys) keys[k]=false; mouse.down=false; });
canvas.addEventListener('mousemove',e=>{ mouse.x=e.clientX; mouse.y=e.clientY; });
canvas.addEventListener('mousedown',e=>{ if(e.button===0){ mouse.down=true; if(state==='play' && player){ const w=player.weapons[player.cur]; if(w && !w.auto) shoot(); } } });
canvas.addEventListener('mouseup',e=>{ if(e.button===0) mouse.down=false; });
canvas.addEventListener('click',()=>{ if(state==='menu'||state==='win'||state==='dead') Meta.showBase(); });

/* ---------------- 战斗 ---------------- */
function reload(){
  const w=player.weapons[player.cur];
  if(!w || w.mag>=w.magMax || w.reserve<=0 || player.reloadT>0) return;
  player.reloadT = 1.6;
}
function shoot(){
  const w=player.weapons[player.cur];
  if(!w || player.reloadT>0 || w.mag<=0) return;
  if(player.fireCd>0) return;
  w.mag--;
  player.fireCd = 60/w.rpm;
  player.flash = 0.05;
  const mx=player.x+Math.cos(player.angle)*player.r;
  const my=player.y+Math.sin(player.angle)*player.r;
  const pellets = w.pellets||1;
  const angles=[];
  for(let i=0;i<pellets;i++){
    const spread=(Math.random()-0.5)*w.spread*2;
    const a=player.angle+spread;
    angles.push(a);
    bullets.push({x:mx,y:my,vx:Math.cos(a)*w.speed,vy:Math.sin(a)*w.speed,
                  dmg:w.dmg,range:w.range,travel:0,owner:'player',color:w.color});
  }
  shake=Math.max(shake, w.name==='霰弹枪'?6:3);
  sfx(180+Math.random()*40,0.04,0.05);
  // 联机：把本次开火（含每发弹道角度）广播给其他玩家
  if(window.Net && Net.isConnected()){
    Net.sendFire({x:mx,y:my,angle:player.angle,pellets:angles,speed:w.speed,range:w.range,dmg:w.dmg,color:w.color,name:w.name});
  }
}
function enemyShoot(e,p){
  // 削弱后精度更差（散布更大）；伤害随难度缩放
  const a=Math.atan2(p.y-e.y,p.x-e.x)+(Math.random()-0.5)*0.20;
  const mx=e.x+Math.cos(e.angle)*e.r, my=e.y+Math.sin(e.angle)*e.r;
  const dmg=8*(OPS_TIERS[currentTier]||OPS_TIERS.normal).dmg;
  bullets.push({x:mx,y:my,vx:Math.cos(a)*780,vy:Math.sin(a)*780,
                dmg:dmg,range:600,travel:0,owner:'enemy',color:'#ff8a5a'});
}

/* ---------------- 更新 ---------------- */
function update(dt){
  if(state!=='play') return;
  matchTime+=dt; timeLeft-=dt;
  shake=Math.max(0,shake-dt*20);
  if(timeLeft<=0){ endGame(false,'超时未撤离'); return; }

  // 相机
  camX=clamp(player.x-W/2,0,WORLD_W-W);
  camY=clamp(player.y-H/2,0,WORLD_H-H);

  updatePlayer(dt);
  updateEnemies(dt);
  updateBosses(dt);
  updateBullets(dt);
  updatePickups(dt);
  updateParticles(dt);
  updateSearch(dt);
  checkExtract(dt);
  syncNet(dt);

  if(player.hp<=0) endGame(false,'阵亡 KIA');
}

// 联机：清理掉线玩家 + 节流上报自身状态
function syncNet(dt){
  const now=performance.now();
  for(const id in remotePlayers){ if(now-(remotePlayers[id].last||0)>6000) delete remotePlayers[id]; }
  if(window.Net && Net.isConnected()){
    netSendT+=dt;
    if(netSendT>=0.05){
      netSendT=0;
      Net.sendState({x:player.x,y:player.y,angle:player.angle,hp:player.hp,armor:Math.ceil(player.armor),
                     cur:player.cur, wname:player.weapons[player.cur]?player.weapons[player.cur].name:'', name:player.name});
    }
  }
}

function updatePlayer(dt){
  const p=player;
  let mx=0,my=0;
  if(keys['w'])my-=1; if(keys['s'])my+=1;
  if(keys['a'])mx-=1; if(keys['d'])mx+=1;
  const len=Math.hypot(mx,my)||1; mx/=len; my/=len;
  const spd=(keys['shift']?p.sprint:p.speed);
  let nx=p.x+mx*spd*dt, ny=p.y+my*spd*dt;
  for(const w of walls){ const r=resolveCircleRect(nx,ny,p.r,w); nx=r.x; ny=r.y; }
  p.x=clamp(nx,p.r,WORLD_W-p.r); p.y=clamp(ny,p.r,WORLD_H-p.r);

  // 瞄准
  const mwx=mouse.x+camX, mwy=mouse.y+camY;
  p.angle=Math.atan2(mwy-p.y,mwx-p.x);

  // 射击
  p.fireCd=Math.max(0,p.fireCd-dt);
  p.flash=Math.max(0,p.flash-dt);
  p.hitFlash=Math.max(0,p.hitFlash-dt);
  if(player.reloadT>0){ player.reloadT-=dt; if(player.reloadT<=0){ const w=p.weapons[p.cur]; const need=w.magMax-w.mag; const take=Math.min(need,w.reserve); w.mag+=take; w.reserve-=take; } }
  const w=p.weapons[p.cur];
  if(mouse.down && w.auto) shoot();
}

function updateEnemies(dt){
  for(const e of enemies){
    if(e.hp<=0) continue;
    if(e.reactT>0) e.reactT-=dt;
    const seePlayer = dist(e.x,e.y,player.x,player.y)<e.sight && lineOfSight(e.x,e.y,player.x,player.y);
    e.fireCd=Math.max(0,e.fireCd-dt);

    if(seePlayer){
      if(e.state!=='chase') e.reactT=0.55; // 刚发现目标，反应延迟
      e.state='chase'; e.lastSeen={x:player.x,y:player.y}; e.loseT=2;
    } else if(e.state==='chase'){
      e.loseT-=dt; if(e.loseT<=0) e.state='patrol';
    }

    if(e.state==='chase' && e.lastSeen){
      const d=dist(e.x,e.y,player.x,player.y);
      e.angle=Math.atan2(player.y-e.y,player.x-e.x);
      if(d>e.shootRange*0.8){ moveEnemy(e,player.x,player.y,dt); }
      // 攻击（需度过反应延迟且冷却就绪）
      const canShoot = d<e.shootRange && lineOfSight(e.x,e.y,player.x,player.y) && e.fireCd<=0 && e.reactT<=0;
      if(canShoot){ enemyShoot(e,player); e.fireCd=60/e.rpm; }
    } else {
      // 巡逻
      const wp=e.wps[e.wi];
      e.angle=Math.atan2(wp.y-e.y,wp.x-e.x);
      if(dist(e.x,e.y,wp.x,wp.y)<24){ e.wi=(e.wi+1)%e.wps.length; }
      else moveEnemy(e,wp.x,wp.y,dt);
    }
  }
}
function moveEnemy(e,tx,ty,dt){
  const a=Math.atan2(ty-e.y,tx-e.x);
  let nx=e.x+Math.cos(a)*e.speed*dt, ny=e.y+Math.sin(a)*e.speed*dt;
  for(const w of walls){ const r=resolveCircleRect(nx,ny,e.r,w); nx=r.x; ny=r.y; }
  e.x=clamp(nx,e.r,WORLD_W-e.r); e.y=clamp(ny,e.r,WORLD_H-e.r);
}

function updateBullets(dt){
  for(let i=bullets.length-1;i>=0;i--){
    const b=bullets[i];
    const steps=3;
    let dead=false;
    for(let s=0;s<steps && !dead;s++){
      const sx=b.x+b.vx*dt/steps, sy=b.y+b.vy*dt/steps;
      b.x=sx; b.y=sy; b.travel+=Math.hypot(b.vx,b.vy)*dt/steps;
      // 撞墙
      for(const w of walls){ if(pointInRect(b.x,b.y,w)){ dead=true; spawnHit(b.x,b.y,'#888'); break; } }
      if(dead) break;
      if(b.owner==='player'){
        for(const e of enemies){ if(e.hp>0 && dist(b.x,b.y,e.x,e.y)<e.r){ e.hp-=b.dmg; dead=true; spawnHit(b.x,b.y,'#ff5a5a'); if(e.hp<=0){ kills++; spawnHit(e.x,e.y,'#ffd'); } break; } }
        if(!dead){ for(const e of bosses){ if(e.hp>0 && dist(b.x,b.y,e.x,e.y)<e.r){ e.hp-=b.dmg; dead=true; spawnHit(b.x,b.y,'#ff2d6b'); if(e.hp<=0){ kills++; bossDie(e); } break; } } }
      } else if(b.owner==='enemy'){
        if(dist(b.x,b.y,player.x,player.y)<player.r){
          dead=true; spawnHit(b.x,b.y,'#73e0ff');
          let dmg=b.dmg;
          if(player.armor>0){ const ab=Math.min(player.armor,dmg*player.armorReduce); player.armor-=ab; dmg-=ab; }
          player.hp-=dmg; player.hitFlash=0.12; shake=Math.max(shake,5); sfx(110,0.05,0.06);
        }
      } else if(b.owner && b.owner.indexOf('peer:')===0){
        if(dist(b.x,b.y,player.x,player.y)<player.r){
          dead=true; spawnHit(b.x,b.y,'#ff8888');
          let dmg=b.dmg;
          if(player.armor>0){ const ab=Math.min(player.armor,dmg*player.armorReduce); player.armor-=ab; dmg-=ab; }
          player.hp-=dmg; player.hitFlash=0.12; shake=Math.max(shake,5); sfx(110,0.05,0.06);
          lastDamager = b.owner.slice(5);
        }
      }
    }
    if(dead || b.travel>b.range) bullets.splice(i,1);
  }
}

function updatePickups(dt){
  for(let i=pickups.length-1;i>=0;i--){
    const pk=pickups[i];
    if(dist(pk.x,pk.y,player.x,player.y)<player.r+pk.r){
      applyPickup(pk); pickups.splice(i,1);
    }
  }
}
function applyPickup(pk){
  if(pk.type==='med'){ player.meds++; toast('+1 医疗包'); }
  else if(pk.type==='armor'){ player.armor=Math.min(player.armorMax,player.armor+40); toast('+防弹插板'); }
  else if(pk.type==='ammo'){ const w=player.weapons[player.cur]; w.reserve=Math.min(w.reserveMax,w.reserve+60); toast('+弹药'); }
  else if(pk.type==='smg'){ if(!player.weapons.smg){ player.weapons.smg={...WEAPONS.smg}; if(!player.slots.includes('smg')) player.slots.push('smg'); player.cur='smg'; toast('获得 冲锋枪 (按数字键切换)'); } else { player.weapons.smg.reserve+=80; toast('+冲锋枪弹药'); } }
  else if(pk.type==='weapon'){ const id=pk.value; if(WEAPONS[id]){ if(!player.weapons[id]){ player.weapons[id]={...WEAPONS[id]}; if(!player.slots.includes(id)) player.slots.push(id); } player.cur=id; toast('拾取武器：'+WEAPONS[id].name+' (按数字键切换)'); } }
  else if(pk.type==='money'){ raidValue+=Math.round(pk.value*lootMult()); toast('+¥'+Math.round(pk.value*lootMult())); }
  else if(pk.type==='intel'){ raidValue+=Math.round(pk.value*lootMult()); toast('机密情报 +¥'+Math.round(pk.value*lootMult())); }
}
function updatePickupSpawn(){ /* 敌人掉落简化：直接搜索集装箱获得 */ }

function updateSearch(dt){
  let near=null;
  for(const c of crates){ if(!c.searched && dist(c.x,c.y,player.x,player.y)<c.r+player.r+14){ near=c; break; } }
  if(near && keys['e']){
    searchTarget=near; searchProg+=dt;
    if(searchProg>=near.searchNeed){ completeSearch(near); }
  } else {
    if(!near || !keys['e']){ if(searchTarget && searchTarget!==near) searchProg=Math.max(0,searchProg-dt*2); if(!near) searchProg=0; searchTarget=near; }
  }
}
function completeSearch(c){
  c.searched=true; searchProg=0; searchTarget=null;
  const L=c.loot;
  if(c.kind==='safe'){
    const v=Math.round(L.value*lootMult()); raidValue+=v; toast('★ 大保险 +¥'+v);
    pickups.push({x:c.x+18,y:c.y,r:14,type: Math.random()<0.5?'diamond':'intel'});
    toast('大保险内还有高价值物资，靠近拾取');
  } else if(c.kind==='weapon'){
    pickups.push({x:c.x,y:c.y+22,r:14,type:'weapon',value:L.value}); toast('搜出：武器箱 (靠近拾取)');
  } else if(L.type==='money'||L.type==='intel'){
    const v=Math.round(L.value*lootMult()); raidValue+=v; toast((L.type==='intel'?'机密情报 ':'战利品 ')+'+¥'+v);
  } else {
    pickups.push({x:c.x,y:c.y+26,r:14,type:L.type}); toast('搜出：'+L.label+' (靠近拾取)');
  }
  spawnHit(c.x,c.y,'#ffd86b');
}

function checkExtract(dt){
  let inEx=null;
  for(const ex of extracts){ if(dist(player.x,player.y,ex.x,ex.y)<ex.r){ inEx=ex; break; } }
  if(inEx){
    inEx.t=(inEx.t||0)+dt;
    if(inEx.t>=extractNeed){ endGame(true,'成功撤离'); }
  } else { for(const ex of extracts) ex.t=0; }
}

/* ---------------- 粒子 ---------------- */
function spawnHit(x,y,color){ for(let i=0;i<6;i++){ const a=rand(0,TAU),s=rand(40,160); particles.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,life:rand(0.2,0.5),color}); } }
function updateParticles(dt){ for(let i=particles.length-1;i>=0;i--){ const p=particles[i]; p.x+=p.vx*dt; p.y+=p.vy*dt; p.life-=dt; if(p.life<=0) particles.splice(i,1); } }

/* ---------------- 提示 ---------------- */
let toasts=[];
function toast(msg){ toasts.push({msg,life:2.2}); }
function updateToasts(dt){ for(let i=toasts.length-1;i>=0;i--){ toasts[i].life-=dt; if(toasts[i].life<=0) toasts.splice(i,1); } }

/* ---------------- 结束 ---------------- */
let endInfo=null;
function endGame(win,reason){
  const total = win ? (loadoutValue+raidValue) : 0;
  endInfo={win,reason,raidValue,kills,total,loadoutValue};
  // 联机：通知服务器本局结果并断开
  if(window.Net && Net.isConnected()){
    if(win) Net.sendExtract(); else Net.sendDead(lastDamager);
    Net.disconnect();
  }
  if(window.Meta) Meta.onRaidEnd({win, raidValue, kills});
  state = win?'win':'dead';
}

/* ---------------- 音效（极简，可失败） ---------------- */
let actx=null;
function sfx(freq,dur,vol){ try{ actx=actx||new (window.AudioContext||window.webkitAudioContext)(); const o=actx.createOscillator(),g=actx.createGain(); o.frequency.value=freq; o.type='square'; g.gain.value=vol; o.connect(g); g.connect(actx.destination); o.start(); setTimeout(()=>{o.stop();},dur*1000); }catch(e){} }

/* ---------------- 渲染 ---------------- */
function render(){
  ctx.save();
  ctx.clearRect(0,0,W,H);
  // 背景
  ctx.fillStyle='#11161c'; ctx.fillRect(0,0,W,H);

  if(state==='menu'){ drawMenu(); ctx.restore(); return; }
  if(state==='base'){ ctx.fillStyle='#0a0e12'; ctx.fillRect(0,0,W,H); ctx.restore(); return; }

  const sx=shake>0?rand(-shake,shake):0, sy=shake>0?rand(-shake,shake):0;
  ctx.translate(-camX+sx,-camY+sy);

  drawFloor();
  drawExtracts();
  drawCrates();
  drawWalls();
  drawPickups();
  drawBullets();
  drawEnemies();
  drawBosses();
  drawRemotePlayers();
  drawParticles();
  drawPlayer();
  drawCrosshairWorld();

  ctx.restore();

  drawHUD();
  drawMinimap();
  drawToasts();
  if(state==='win'||state==='dead') drawEnd();
}

function drawFloor(){
  ctx.strokeStyle='rgba(80,110,130,0.10)'; ctx.lineWidth=1;
  const gs=80;
  for(let x=0;x<=WORLD_W;x+=gs){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,WORLD_H); ctx.stroke(); }
  for(let y=0;y<=WORLD_H;y+=gs){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(WORLD_W,y); ctx.stroke(); }
}
function drawWalls(){
  for(const w of walls){ ctx.fillStyle='#2b3640'; ctx.fillRect(w.x,w.y,w.w,w.h); ctx.strokeStyle='#3d4b58'; ctx.lineWidth=2; ctx.strokeRect(w.x,w.y,w.w,w.h); }
}
function drawCrates(){
  for(const c of crates){
    ctx.save(); ctx.translate(c.x,c.y);
    let fill, stroke, label;
    if(c.searched){ fill='#3a3a32'; stroke='#555'; label='空'; }
    else if(c.kind==='safe'){ fill='#5a3a52'; stroke='#ffd86b'; label='保'; }
    else if(c.kind==='weapon'){ fill='#5a4326'; stroke='#ff9a5a'; label='武'; }
    else { fill='#6b5a2e'; stroke='#caa84a'; label='?'; }
    ctx.fillStyle=fill; ctx.strokeStyle=stroke;
    ctx.lineWidth=2; ctx.fillRect(-c.r,-c.r,c.r*2,c.r*2); ctx.strokeRect(-c.r,-c.r,c.r*2,c.r*2);
    ctx.fillStyle=c.searched?'#666':(c.kind==='safe'?'#ffe9a0':c.kind==='weapon'?'#ffd0a0':'#e0c060');
    ctx.font=(c.r>20?'bold 16px':'12px')+' monospace'; ctx.textAlign='center';
    ctx.fillText(label,0,4);
    ctx.restore();
    if(!c.searched && dist(c.x,c.y,player.x,player.y)<c.r+player.r+14){ ctx.strokeStyle=c.kind==='safe'?'#ffd86b':'#ff9a5a'; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(c.x,c.y,c.r+6,0,TAU); ctx.stroke(); }
  }
}
function drawExtracts(){
  for(const ex of extracts){
    const active=ex.t>0;
    ctx.save();
    const pulse=0.18+0.12*Math.sin(performance.now()/250);
    ctx.fillStyle=active?'rgba(80,255,140,'+(pulse+0.15)+')':'rgba(80,200,120,'+pulse+')';
    ctx.beginPath(); ctx.arc(ex.x,ex.y,ex.r,0,TAU); ctx.fill();
    ctx.strokeStyle='#5aff8c'; ctx.lineWidth=3; ctx.beginPath(); ctx.arc(ex.x,ex.y,ex.r,0,TAU); ctx.stroke();
    ctx.fillStyle='#bfffce'; ctx.font='bold 14px monospace'; ctx.textAlign='center';
    ctx.fillText(ex.label, ex.x, ex.y-ex.r-8);
    if(active){ ctx.fillStyle='#fff'; ctx.font='bold 22px monospace'; ctx.fillText(Math.ceil(5-ex.t)+'s', ex.x, ex.y+7); }
    ctx.restore();
  }
}
function drawPickups(){
  for(const pk of pickups){
    const col = pk.type==='med'?'#5aff8c':pk.type==='armor'?'#73e0ff':pk.type==='ammo'?'#ffd86b':pk.type==='smg'?'#ff9a5a':pk.type==='weapon'?'#ff8a3a':pk.type==='diamond'?'#7ad1ff':pk.type==='intel'?'#c08bff':'#fff';
    ctx.save(); ctx.translate(pk.x,pk.y);
    ctx.fillStyle=col; ctx.beginPath(); ctx.arc(0,0,pk.r,0,TAU); ctx.fill();
    ctx.fillStyle='#111'; ctx.font='bold 12px monospace'; ctx.textAlign='center';
    const ic = pk.type==='med'?'+':pk.type==='armor'?'A':pk.type==='ammo'?'*':pk.type==='smg'?'S':pk.type==='weapon'?'W':pk.type==='diamond'?'◆':pk.type==='intel'?'★':'?';
    ctx.fillText(ic,0,4); ctx.restore();
  }
}
function drawBullets(){
  for(const b of bullets){ ctx.strokeStyle=b.color; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(b.x,b.y); ctx.lineTo(b.x-b.vx*0.012,b.y-b.vy*0.012); ctx.stroke(); }
}
function drawEnemies(){
  for(const e of enemies){
    if(e.hp<=0) continue;
    ctx.save(); ctx.translate(e.x,e.y);
    // 视野指示
    ctx.fillStyle='rgba(255,90,90,0.06)'; ctx.beginPath(); ctx.moveTo(0,0);
    ctx.arc(0,0,e.sight,e.angle-0.5,e.angle+0.5); ctx.closePath(); ctx.fill();
    ctx.rotate(e.angle);
    ctx.fillStyle=e.state==='chase'?'#ff3b3b':'#ff7a5a';
    ctx.beginPath(); ctx.arc(0,0,e.r,0,TAU); ctx.fill();
    ctx.fillStyle='#2a0d0d'; ctx.fillRect(0,-3,e.r+8,6);
    ctx.restore();
    // 血条
    if(e.hp<e.hpMax){ ctx.fillStyle='#400'; ctx.fillRect(e.x-14,e.y-e.r-10,28,4); ctx.fillStyle='#f55'; ctx.fillRect(e.x-14,e.y-e.r-10,28*e.hp/e.hpMax,4); }
  }
}
function drawBosses(){
  for(const e of bosses){
    if(e.hp<=0) continue;
    ctx.save(); ctx.translate(e.x,e.y);
    ctx.fillStyle='rgba(255,45,107,0.08)'; ctx.beginPath(); ctx.moveTo(0,0);
    ctx.arc(0,0,e.sight,e.angle-0.5,e.angle+0.5); ctx.closePath(); ctx.fill();
    ctx.rotate(e.angle);
    ctx.fillStyle=e.state==='chase'?'#ff2d6b':'#ff6b9a';
    ctx.beginPath(); ctx.arc(0,0,e.r,0,TAU); ctx.fill();
    ctx.strokeStyle='#ffd86b'; ctx.lineWidth=3; ctx.beginPath(); ctx.arc(0,0,e.r,0,TAU); ctx.stroke();
    ctx.fillStyle='#2a0d18'; ctx.fillRect(0,-5,e.r+14,10);
    ctx.restore();
    // 名称 + 血条
    ctx.fillStyle='#ff8ab0'; ctx.font='bold 13px monospace'; ctx.textAlign='center';
    ctx.fillText(e.name, e.x, e.y-e.r-22);
    ctx.fillStyle='#400'; ctx.fillRect(e.x-34,e.y-e.r-16,68,6);
    ctx.fillStyle='#ff3b6b'; ctx.fillRect(e.x-34,e.y-e.r-16,68*clamp(e.hp/e.hpMax,0,1),6);
  }
}
function drawParticles(){
  for(const p of particles){ ctx.globalAlpha=clamp(p.life*2,0,1); ctx.fillStyle=p.color; ctx.fillRect(p.x-2,p.y-2,4,4); }
  ctx.globalAlpha=1;
}
function drawPlayer(){
  const p=player;
  ctx.save(); ctx.translate(p.x,p.y);
  if(p.hitFlash>0){ ctx.fillStyle='rgba(255,80,80,'+(p.hitFlash*3)+')'; ctx.beginPath(); ctx.arc(0,0,p.r+6,0,TAU); ctx.fill(); }
  ctx.rotate(p.angle);
  // 武器
  ctx.fillStyle=p.weapons[p.cur].color; ctx.fillRect(p.r-2,-3,p.r+10,6);
  ctx.rotate(-p.angle);
  ctx.fillStyle='#39b6ff'; ctx.beginPath(); ctx.arc(0,0,p.r,0,TAU); ctx.fill();
  ctx.strokeStyle='#bff0ff'; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(0,0,p.r,0,TAU); ctx.stroke();
  if(p.flash>0){ ctx.rotate(p.angle); ctx.fillStyle='#fff3b0'; ctx.beginPath(); ctx.moveTo(p.r,0); ctx.lineTo(p.r+16,-5); ctx.lineTo(p.r+16,5); ctx.closePath(); ctx.fill(); }
  ctx.restore();
}
function drawCrosshairWorld(){
  const mwx=mouse.x+camX, mwy=mouse.y+camY;
  ctx.strokeStyle='rgba(120,240,255,0.9)'; ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.arc(mwx,mwy,9,0,TAU); ctx.moveTo(mwx-14,mwy); ctx.lineTo(mwx-4,mwy); ctx.moveTo(mwx+4,mwy); ctx.lineTo(mwx+14,mwy); ctx.moveTo(mwx,mwy-14); ctx.lineTo(mwx,mwy-4); ctx.moveTo(mwx,mwy+4); ctx.lineTo(mwx,mwy+14); ctx.stroke();
}

function drawRemotePlayers(){
  for(const id in remotePlayers){
    const rp=remotePlayers[id];
    if(rp.dead) continue;
    ctx.save(); ctx.translate(rp.x,rp.y);
    ctx.rotate(rp.angle||0);
    ctx.fillStyle=rp.color||'#fff'; ctx.beginPath(); ctx.arc(0,0,14,0,TAU); ctx.fill();
    ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(0,0,14,0,TAU); ctx.stroke();
    ctx.fillStyle=rp.color||'#fff'; ctx.fillRect(14,-3,10,6);
    ctx.restore();
    ctx.fillStyle='#cfe'; ctx.font='11px monospace'; ctx.textAlign='center';
    ctx.fillText((rp.name||id), rp.x, rp.y-22);
    const hp=clamp((rp.hp||100)/100,0,1);
    ctx.fillStyle='#400'; ctx.fillRect(rp.x-14,rp.y-18,28,4);
    ctx.fillStyle='#5aff8c'; ctx.fillRect(rp.x-14,rp.y-18,28*hp,4);
  }
}

/* ---------------- 联机：客户端钩子 ---------------- */
if(window.Net && Net.setHooks){
  Net.setHooks({
    onPeerJoin(id,name,color){ remotePlayers[id]={id,name:name||id,color:color||'#fff',x:0,y:0,angle:0,hp:100,armor:0,cur:'',wname:'',last:performance.now()}; },
    onPeerLeft(id){ delete remotePlayers[id]; },
    onPeerState(m){ const p=remotePlayers[m.id]; if(!p) return; p.x=m.x;p.y=m.y;p.angle=m.angle;p.hp=m.hp;p.armor=m.armor;p.cur=m.cur;p.wname=m.wname;p.name=m.name;p.last=performance.now(); },
    onPeerFire(m){ if(!m.pellets) return; for(const ang of m.pellets){ bullets.push({x:m.x,y:m.y,vx:Math.cos(ang)*m.speed,vy:Math.sin(ang)*m.speed,dmg:m.dmg,range:m.range,travel:0,owner:'peer:'+m.id,color:m.color}); } },
    onPeerDead(id,killer){ if(remotePlayers[id]) delete remotePlayers[id]; if(killer && killer===Net.myId){ kills++; toast('击杀玩家 '+id); if(window.Net) Net.sendKill(player?player.name:id); if(window.Meta) Meta.addPvpKill(); } },
    onPeerExtract(id){ if(remotePlayers[id]) delete remotePlayers[id]; toast('玩家 '+id+' 已撤离'); },
    onScore(list){ scoreboard = (list||[]).slice(); }
  });
}

/* ---------------- HUD ---------------- */
function drawHUD(){
  const p=player;
  // 地图名 + 难度（左上）
  ctx.fillStyle='#7a9'; ctx.font='12px monospace'; ctx.textAlign='left';
  const tierName=(OPS_TIERS[currentTier]||OPS_TIERS.normal).name;
  ctx.fillText('地图：'+currentMapName+'  ['+tierName+']', 20, 22);
  if(window.Net && Net.isConnected()){
    const n=Object.keys(remotePlayers).length+1;
    ctx.fillStyle='#9effa0'; ctx.fillText('联机对战 · '+n+'人在线', 20, 38);
    if(window.Meta && Meta.rank){ const r=Meta.rank(); ctx.fillStyle=r.color; ctx.fillText('段位：'+r.name+'（PvP击杀 '+r.kills+'）', 20, 54); }
  }
  // 左下：血量/护甲
  ctx.save();
  const bx=20, by=H-90;
  // 血
  ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(bx,by,240,22);
  ctx.fillStyle='#ff4d4d'; ctx.fillRect(bx+2,by+2,236*clamp(p.hp/p.hpMax,0,1),18);
  ctx.fillStyle='#fff'; ctx.font='bold 13px monospace'; ctx.textAlign='left'; ctx.fillText('HP '+Math.ceil(p.hp),bx+8,by+16);
  // 甲
  ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(bx,by+26,240,18);
  ctx.fillStyle='#73e0ff'; ctx.fillRect(bx+2,by+28,236*clamp(p.armor/p.armorMax,0,1),14);
  ctx.fillStyle='#062'; ctx.fillText('护甲 '+Math.ceil(p.armor)+' ('+p.armorLevel+'级)',bx+8,by+40);
  // 武器/弹药
  const w=p.weapons[p.cur];
  const wx=bx, wy=by-44;
  ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(wx,wy,200,30);
  ctx.fillStyle=w.color; ctx.font='bold 14px monospace'; ctx.textAlign='left';
  ctx.fillText(w.name, wx+8, wy+13);
  ctx.fillStyle='#fff'; ctx.font='bold 16px monospace'; ctx.textAlign='right';
  ctx.fillText((player.reloadT>0?'换弹...':w.mag)+' / '+w.reserve, wx+192, wy+22);
  // 武器槽
  let slotStr='';
  p.slots.forEach((id,i)=>{ const nm=p.weapons[id]?p.weapons[id].name.slice(0,3):'?'; slotStr+=(i+1)+':'+nm+(p.cur===id?'★':'')+'  '; });
  ctx.fillStyle='#9ab'; ctx.font='11px monospace'; ctx.textAlign='left';
  ctx.fillText(slotStr, wx+8, wy+26);
  ctx.fillStyle='#5aff8c'; ctx.textAlign='right'; ctx.fillText('医疗 x'+p.meds, wx+192, wy+13);
  ctx.restore();

  // 顶部中心：计时 + 战利品价值
  ctx.save();
  ctx.textAlign='center';
  const mm=Math.floor(timeLeft/60), ss=Math.floor(timeLeft%60);
  ctx.font='bold 24px monospace';
  ctx.fillStyle= timeLeft<60?'#ff5a5a':'#ffe27a';
  ctx.fillText((mm<10?'0':'')+mm+':'+(ss<10?'0':'')+ss, W/2, 36);
  ctx.font='bold 16px monospace'; ctx.fillStyle='#9effa0';
  ctx.fillText('战利品价值 ¥'+raidValue+'   击杀 '+kills, W/2, 60);
  ctx.restore();

  // Boss 血条（顶部居中）
  const aliveBosses = bosses.filter(b=>b.hp>0);
  if(aliveBosses.length>0){
    const bw=Math.min(520, W*0.5), bx2=W/2-bw/2, by2=82;
    ctx.fillStyle='#3a0010'; ctx.fillRect(bx2,by2,bw,10);
    ctx.fillStyle='#ff2d6b'; ctx.fillRect(bx2,by2,bw*clamp(aliveBosses[0].hp/aliveBosses[0].hpMax,0,1),10);
    ctx.strokeStyle='#ffd86b'; ctx.lineWidth=1; ctx.strokeRect(bx2,by2,bw,10);
    ctx.fillStyle='#ff8ab0'; ctx.font='bold 13px monospace'; ctx.textAlign='center';
    ctx.fillText('⚠ '+aliveBosses[0].name+'  HP '+Math.ceil(aliveBosses[0].hp), W/2, by2-6);
  }

  // 搜索进度
  if(searchTarget && searchProg>0){
    const c=searchTarget; const sxp=c.x-camX, syp=c.y-camY;
    const lab = c.kind==='safe'?'开启大保险中...':c.kind==='weapon'?'搜索武器箱中...':'搜索中...';
    ctx.fillStyle='rgba(0,0,0,0.6)'; ctx.fillRect(sxp-30,syp-c.r-30,60,8);
    ctx.fillStyle='#ffd86b'; ctx.fillRect(sxp-29,syp-c.r-29,58*clamp(searchProg/c.searchNeed,0,1),6);
    ctx.fillStyle='#fff'; ctx.font='11px monospace'; ctx.textAlign='center'; ctx.fillText(lab, sxp, syp-c.r-34);
  } else {
    // 提示附近可搜索
    let near=null; for(const c of crates){ if(!c.searched && dist(c.x,c.y,player.x,player.y)<c.r+player.r+14){ near=c; break; } }
    if(near){
      const lab = near.kind==='safe'?'按 E 开启大保险 (5s)':near.kind==='weapon'?'按 E 搜索武器箱 (4s)':'按 E 搜索集装箱';
      ctx.fillStyle=near.kind==='safe'?'#ffd86b':near.kind==='weapon'?'#ff9a5a':'#ffd86b';
      ctx.font='bold 14px monospace'; ctx.textAlign='center'; ctx.fillText(lab, W/2, H-130);
    }
    // 撤离提示
    let inEx=null; for(const ex of extracts){ if(dist(player.x,player.y,ex.x,ex.y)<ex.r){ inEx=ex; break; } }
    if(inEx){ ctx.fillStyle='#5aff8c'; ctx.font='bold 16px monospace'; ctx.textAlign='center'; ctx.fillText('停留撤离中...', W/2, H-130); }
  }
  ctx.restore();

  // 联机计分榜（右上，地图下方）
  if(window.Net && Net.isConnected() && scoreboard.length>0){
    ctx.save();
    const lx=W-224, ly=150, lw=208;
    ctx.fillStyle='rgba(8,12,16,0.78)'; ctx.fillRect(lx,ly,lw,18+scoreboard.length*18);
    ctx.strokeStyle='#3d4b58'; ctx.lineWidth=1; ctx.strokeRect(lx,ly,lw,18+scoreboard.length*18);
    ctx.textAlign='left'; ctx.fillStyle='#ffd86b'; ctx.font='bold 12px monospace';
    ctx.fillText('击杀榜', lx+8, ly+13);
    ctx.font='12px monospace';
    scoreboard.forEach((row,i)=>{
      const yy=ly+30+i*18, me = (window.Net.myId && row.id===window.Net.myId);
      ctx.fillStyle=me?'#9effa0':'#cfe';
      const nm=(row.name||row.id||'?').slice(0,10);
      ctx.fillText((i+1)+'. '+nm, lx+8, yy);
      ctx.textAlign='right'; ctx.fillStyle=me?'#9effa0':'#ff8a7a';
      ctx.fillText(row.kills+'杀', lx+lw-8, yy); ctx.textAlign='left';
    });
    ctx.restore();
  }
}

function drawMinimap(){
  const mw=180, mh=mw*WORLD_H/WORLD_W, mx=W-mw-16, my=16;
  const sc=mw/WORLD_W;
  ctx.save();
  ctx.fillStyle='rgba(8,12,16,0.7)'; ctx.fillRect(mx,my,mw,mh);
  ctx.strokeStyle='#3d4b58'; ctx.lineWidth=1; ctx.strokeRect(mx,my,mw,mh);
  // 墙
  ctx.fillStyle='#46545f'; for(const w of walls){ ctx.fillRect(mx+w.x*sc,my+w.y*sc,w.w*sc,w.h*sc); }
  // 集装箱
  for(const c of crates){ if(!c.searched){ ctx.fillStyle='#caa84a'; ctx.fillRect(mx+c.x*sc-2,my+c.y*sc-2,4,4); } }
  // 撤离
  for(const ex of extracts){ ctx.fillStyle='#5aff8c'; ctx.beginPath(); ctx.arc(mx+ex.x*sc,my+ex.y*sc,3,0,TAU); ctx.fill(); }
  // 敌人(仅附近可见)
  for(const e of enemies){ if(e.hp>0 && e.state==='chase'){ ctx.fillStyle='#ff4d4d'; ctx.fillRect(mx+e.x*sc-1.5,my+e.y*sc-1.5,3,3); } }
  // 玩家
  ctx.fillStyle='#39b6ff'; ctx.beginPath(); ctx.arc(mx+player.x*sc,my+player.y*sc,3,0,TAU); ctx.fill();
  // 联机玩家
  for(const id in remotePlayers){ const rp=remotePlayers[id]; ctx.fillStyle=rp.color||'#fff'; ctx.beginPath(); ctx.arc(mx+rp.x*sc,my+rp.y*sc,3,0,TAU); ctx.fill(); }
  // Boss
  for(const e of bosses){ if(e.hp>0){ ctx.fillStyle='#ff2d6b'; ctx.beginPath(); ctx.arc(mx+e.x*sc,my+e.y*sc,4,0,TAU); ctx.fill(); ctx.strokeStyle='#ffd86b'; ctx.lineWidth=1; ctx.stroke(); } }
  ctx.restore();
}

function drawToasts(){
  ctx.save(); ctx.textAlign='center'; ctx.font='bold 14px monospace';
  let y=H-160;
  for(const t of toasts){ ctx.globalAlpha=clamp(t.life,0,1); ctx.fillStyle='#ffe27a'; ctx.fillText(t.msg,W/2,y); y-=22; }
  ctx.globalAlpha=1; ctx.restore();
}

function drawMenu(){
  ctx.fillStyle='#0a0e12'; ctx.fillRect(0,0,W,H);
  // 背景网格
  ctx.strokeStyle='rgba(60,120,140,0.12)'; ctx.lineWidth=1;
  for(let x=0;x<W;x+=40){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for(let y=0;y<H;y+=40){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
  ctx.textAlign='center';
  ctx.fillStyle='#73e0ff'; ctx.font='bold 52px monospace'; ctx.fillText('三角洲行动 · 搜打撤', W/2, H/2-120);
  ctx.fillStyle='#9effa0'; ctx.font='18px monospace';
  ctx.fillText('进入战场 → 搜索物资 → 击毙守卫 → 抵达撤离点全身而退', W/2, H/2-78);
  ctx.fillStyle='#cfe'; ctx.font='15px monospace';
  const lines=[
    'WASD 移动   鼠标 瞄准   左键 射击   R 换弹',
    'E 搜索集装箱   Shift 疾跑   数字键 1/2/3 切换武器',
    '基地可选：固定地图 / 难度(常规·机密·绝密) / 1~6级甲 / 联机',
    '成功撤离：保留本次所有战利品价值（可提前投保防丢失）',
    '阵亡或超时未撤离：丢失全部未保险装备与战利品'
  ];
  let y=H/2-30; for(const l of lines){ ctx.fillText(l,W/2,y); y+=26; }
  ctx.fillStyle='#ffd86b'; ctx.font='bold 22px monospace';
  const blink=0.5+0.5*Math.sin(performance.now()/400);
  ctx.globalAlpha=blink; ctx.fillText('点击屏幕 / 按 Enter 开始行动', W/2, H/2+110); ctx.globalAlpha=1;
  ctx.fillStyle='#5a7'; ctx.font='12px monospace'; ctx.fillText('提示：6 分钟倒计时，2 个撤离点，撤离需停留 5 秒', W/2, H/2+150);
}

function drawEnd(){
  ctx.fillStyle='rgba(5,8,12,0.82)'; ctx.fillRect(0,0,W,H);
  ctx.textAlign='center';
  const c=endInfo;
  ctx.font='bold 48px monospace';
  ctx.fillStyle= c.win?'#5aff8c':'#ff5a5a';
  ctx.fillText(c.win?'撤离成功':'行动失败', W/2, H/2-110);
  ctx.fillStyle='#cfe'; ctx.font='18px monospace'; ctx.fillText(c.reason, W/2, H/2-72);
  ctx.font='20px monospace'; ctx.fillStyle='#fff';
  ctx.fillText('本次战利品价值：¥'+c.raidValue, W/2, H/2-30);
  ctx.fillText('击杀守卫：'+c.kills, W/2, H/2);
  if(c.win){ ctx.fillStyle='#9effa0'; ctx.fillText('带回总价值：¥'+c.total+'（已入库）', W/2, H/2+34); }
  else { ctx.fillStyle='#ff7a7a'; ctx.fillText('装备与战利品全部损失', W/2, H/2+34); }
  // 段位（联机 PvP 击杀累计）
  if(window.Meta && Meta.rank){ const r=Meta.rank(); ctx.fillStyle=r.color; ctx.font='16px monospace';
    ctx.fillText('当前段位：'+r.name+'（累计 PvP 击杀 '+r.kills+'）', W/2, H/2+60); }
  // 联机本局击杀榜
  if(window.Net && Net.isConnected() && scoreboard.length>0){
    ctx.fillStyle='#ffd86b'; ctx.font='bold 16px monospace'; ctx.fillText('— 本局击杀榜 —', W/2, H/2+88);
    ctx.font='14px monospace';
    scoreboard.slice(0,5).forEach((row,i)=>{
      const me=(window.Net.myId && row.id===window.Net.myId);
      ctx.fillStyle=me?'#9effa0':'#cfe';
      ctx.fillText((i+1)+'. '+(row.name||row.id||'?').slice(0,12)+'  '+row.kills+'杀', W/2, H/2+112+i*20);
    });
  }
  ctx.fillStyle='#ffd86b'; ctx.font='bold 20px monospace';
  const blink=0.5+0.5*Math.sin(performance.now()/400); ctx.globalAlpha=blink;
  ctx.fillText('点击 / 按 Enter 返回基地', W/2, H/2+100); ctx.globalAlpha=1;
}

/* ---------------- 主循环 ---------------- */
function loop(ts){
  const dt=Math.min(0.05,(ts-lastTime)/1000||0); lastTime=ts;
  if(state==='play'){
    update(dt);
    updateToasts(dt);
  } else if(state==='win'||state==='dead'){
    updateParticles(dt); updateToasts(dt);
  } else if(state==='menu'){
    updateToasts(dt);
  }
  render();
  requestAnimationFrame(loop);
}

if(window.__TEST__){
  window.__game = {
    get state(){return state;}, get player(){return player;}, get enemies(){return enemies;},
    get bosses(){return bosses;}, get crates(){return crates;},
    get currentMapName(){return currentMapName;}, get currentMapId(){return currentMapId;},
    get extractNeed(){return extractNeed;}, get remotePlayers(){return remotePlayers;},
    get scoreboard(){return scoreboard;}, set scoreboard(v){ scoreboard=v; },
    update, shoot, reload, endGame, render
  };
}

requestAnimationFrame(loop);
