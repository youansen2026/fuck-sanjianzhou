'use strict';
/* ============================================================
   三角洲行动 · 局外系统 (Out-of-Raid Meta)
   - 持久化：金钱 / 仓库 / 战前配装 / 任务 / 统计 (localStorage)
   - 战前在基地配装、市场购买；撤离带回战利品，阵亡丢失携带装备
   - 新增：地图选择 / 行动难度(常规·机密·绝密) / 1~6级护甲 / 联机对战
   ============================================================ */
window.Meta = (function(){

const SAVE_KEY = 'delta_meta_v2';

// 行动地图（random=随机；其余为固定地图 id，名称与 game.js 的 MAP_BUILD 对应）
const OPS_MAPS = [
  {id:'random', name:'随机地图'},
  {id:'hq',     name:'指挥中心'},
  {id:'port',   name:'港口集装箱'},
  {id:'factory',name:'废弃工厂'},
  {id:'canyon', name:'峡谷哨站'}
];
// 行动难度：影响敌人数量/血量/伤害、战利品倍率、撤离停留时间、Boss 数量
const OPS_TIERS = {
  normal:      {name:'常规', enemyN:7,  enemyHp:40, loot:1.0, extract:5, dmg:1.00, bossCount:0, bossHp:0},
  confidential:{name:'机密', enemyN:9,  enemyHp:45, loot:1.4, extract:6, dmg:1.15, bossCount:1, bossHp:450},
  topsecret:   {name:'绝密', enemyN:12, enemyHp:50, loot:2.0, extract:8, dmg:1.35, bossCount:1, bossHp:650}
};
window.OPS_MAPS = OPS_MAPS;
window.OPS_TIERS = OPS_TIERS;

// PvP 段位（依据累计 PvP 击杀数）
const RANKS = [
  {min:0,   name:'新兵',   color:'#9aa7b0'},
  {min:1,   name:'青铜',   color:'#cd7f32'},
  {min:5,   name:'白银',   color:'#c0c8d0'},
  {min:15,  name:'黄金',   color:'#ffd24a'},
  {min:35,  name:'铂金',   color:'#5fe0c0'},
  {min:70,  name:'钻石',   color:'#7ad1ff'},
  {min:120, name:'大师',   color:'#c08bff'},
  {min:200, name:'王者',   color:'#ff5a7a'}
];
function rankOf(k){ let r=RANKS[0]; for(const x of RANKS){ if(k>=x.min) r=x; } return {name:r.name, color:r.color, kills:k}; }

// 物品目录：value=价值(用于结算/出售)，price=购买价(0表示不可购买)
const CATALOG = {
  rifle:  {name:'突击步枪', type:'weapon',   value:1200, price:0},
  smg:    {name:'冲锋枪',   type:'weapon',   value:1800, price:1800},
  shotgun:{name:'霰弹枪',   type:'weapon',   value:1400, price:1400},
  sniper: {name:'狙击枪',   type:'weapon',   value:2200, price:2200},
  lmg:    {name:'轻机枪',   type:'weapon',   value:2000, price:2000},
  armor1: {name:'1级甲(轻甲)',   type:'armor', value:300,  price:300},
  armor2: {name:'2级甲(战术)',   type:'armor', value:500,  price:500},
  armor3: {name:'3级甲(防弹)',   type:'armor', value:800,  price:800},
  armor4: {name:'4级甲(重型)',   type:'armor', value:1200, price:1200},
  armor5: {name:'5级甲(突击)',   type:'armor', value:1800, price:1800},
  armor6: {name:'6级甲(特种)',   type:'armor', value:2600, price:2600},
  med:    {name:'医疗包',   type:'med',      value:300,  price:300},
  ammo:   {name:'弹药箱',   type:'ammo',     value:250,  price:250},
  gold:   {name:'黄金',     type:'valuable', value:800,  price:0},
  diamond:{name:'钻石',     type:'valuable', value:1500, price:0},
  intel:  {name:'机密情报', type:'valuable', value:2500, price:0}
};
const TYPE_CN = {weapon:'武器', armor:'护甲', med:'医疗', ammo:'弹药', valuable:'物资'};
// 护甲等级->减伤与甲量（与 game.js 的 ARMOR_TIERS 保持一致；此处带兜底）
function armorTier(l){ return (window.ARMOR_TIERS && window.ARMOR_TIERS[l]) || {max:55, reduce:0.28, name:l+'级甲'}; }

let memFallback = null; // localStorage 不可用时的内存兜底

function load(){
  try{
    const raw = localStorage.getItem(SAVE_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){}
  return defaultProfile();
}
function save(){
  try{ localStorage.setItem(SAVE_KEY, JSON.stringify(Profile)); }
  catch(e){ memFallback = JSON.parse(JSON.stringify(Profile)); }
}
function defaultProfile(){
  return {
    money: 3000,
    stash: { rifle:1, armor2:1, med:2, ammo:1 },
    equipped: { weapon:'rifle', weapon2:'pistol', armorLevel:2, meds:2, ammo:1, insure:false,
                map:'random', tier:'normal', mp:false, name:'指挥官', room:'' },
    quests: [
      {id:'extract', name:'撤离专家', desc:'成功撤离 1 次',        reward:500,  goal:1, progress:0, claimable:false},
      {id:'scav',    name:'拾荒者',   desc:'单局搜刮价值 ≥ ¥2000', reward:800,  goal:1, progress:0, claimable:false},
      {id:'killer',  name:'清道夫',   desc:'累计击杀 5 名守卫/玩家', reward:1000, goal:5, progress:0, claimable:false}
    ],
    stats: { raids:0, extracts:0, kia:0, earned:0, pvpKills:0 }
  };
}

let Profile = load();
let deploySnapshot = null; // 本次出击携带的配装快照（用于阵亡结算）
let baseEl = null, panelEl = null;
let mpStatus = '';

/* ---------------- 仓库工具 ---------------- */
function count(id){ return Profile.stash[id] || 0; }
function has(id,n){ return count(id) >= (n||1); }
function add(id,n){ Profile.stash[id] = count(id) + (n||1); }
function remove(id,n){ const c=count(id)-(n||1); if(c<=0) delete Profile.stash[id]; else Profile.stash[id]=c; }
function itemValue(id){ return (CATALOG[id]&&CATALOG[id].value)||0; }

function availableWeapons(){
  const list=['pistol'];
  for(const id in CATALOG){ if(CATALOG[id].type==='weapon' && count(id)>0) list.push(id); }
  return list;
}
function normalize(){
  const e = Profile.equipped;
  const aw=availableWeapons();
  if(!aw.includes(e.weapon)) e.weapon='rifle';
  if(!aw.includes(e.weapon2)) e.weapon2='pistol';
  const owned=[1,2,3,4,5,6].filter(l=>has('armor'+l));
  if(!owned.includes(e.armorLevel)) e.armorLevel = owned.length ? Math.max.apply(null,owned) : 2;
  e.meds  = clamp(e.meds,  0, Math.min(5, count('med')));
  e.ammo  = clamp(e.ammo,  0, Math.min(5, count('ammo')));
}

/* ---------------- 装备调整 ---------------- */
function setSlot(slot,id){
  const e=Profile.equipped;
  if(id!=='pistol' && !has(id)) return;
  if(slot==='weapon2') e.weapon2=id; else e.weapon=id;
  save(); render();
}
function setArmor(l){ if(has('armor'+l)){ Profile.equipped.armorLevel=l; save(); render(); } }
function setMap(id){ Profile.equipped.map=id; save(); render(); }
function setTier(k){ if(OPS_TIERS[k]){ Profile.equipped.tier=k; save(); render(); } }
function setField(k,v){ Profile.equipped[k]=v; save(); }
function toggleMp(){ Profile.equipped.mp=!Profile.equipped.mp; save(); render(); }
function genRoom(){ Profile.equipped.room='R'+Math.floor(Math.random()*900000+100000); save(); render(); }

function insCost(){
  const e=Profile.equipped;
  const wv=itemValue(e.weapon)+(e.weapon2&&e.weapon2!=='pistol'?itemValue(e.weapon2):0);
  const av=itemValue('armor'+e.armorLevel);
  return Math.round((wv+av)*0.3);
}
function toggleInsure(){ Profile.equipped.insure=!Profile.equipped.insure; save(); render(); }
function step(kind, d){
  const e=Profile.equipped;
  if(kind==='meds')  e.meds  = clamp(e.meds+d,  0, Math.min(5, count('med')));
  if(kind==='ammo')  e.ammo  = clamp(e.ammo+d,  0, Math.min(5, count('ammo')));
  save(); render();
}

/* ---------------- 市场 / 仓库 ---------------- */
function buy(id){
  const c = CATALOG[id];
  if(!c || c.price<=0) return;
  if(Profile.money < c.price){ flash('金钱不足'); return; }
  Profile.money -= c.price; add(id,1); save(); render();
}
function sellAll(id){
  if(id==='rifle'){ flash('基础武器不可出售'); return; }
  const n = count(id); if(n<=0) return;
  Profile.money += itemValue(id)*n; delete Profile.stash[id];
  save(); render();
}

/* ---------------- 段位 / PvP 击杀 ---------------- */
function addPvpKill(){
  const s = Profile.stats; s.pvpKills = (s.pvpKills||0)+1; save();
}
function rank(){ return rankOf((Profile.stats.pvpKills)||0); }

/* ---------------- 任务 ---------------- */
function claim(id){
  const q = Profile.quests.find(x=>x.id===id);
  if(!q || !q.claimable) return;
  Profile.money += q.reward; q.progress -= q.goal; q.claimable=false;
  save(); render();
}

/* ---------------- 出击 / 结算 ---------------- */
function riskValue(){
  const e=Profile.equipped;
  return itemValue(e.weapon) + (e.weapon2&&e.weapon2!=='pistol'?itemValue(e.weapon2):0) + itemValue('armor'+e.armorLevel);
}
function deploy(){
  normalize();
  const e = Profile.equipped;
  const cost = insCost();
  if(e.insure){
    if(Profile.money < cost){ flash('保险金不足 ¥'+cost); return; }
    Profile.money -= cost;
  }
  // 消耗品在出击时扣除（不论胜负均已消耗）
  if(e.meds>0) remove('med', e.meds);
  if(e.ammo>0) remove('ammo', e.ammo);
  deploySnapshot = JSON.parse(JSON.stringify(e));
  save();
  hideBase();

  const cfg = {
    weapon:e.weapon, weapon2:e.weapon2, armorLevel:e.armorLevel, meds:e.meds, ammo:e.ammo,
    insure:e.insure, map:e.map, tier:e.tier, mp:e.mp,
    name:(e.name||'玩家').slice(0,12), room:e.room
  };
  if(e.mp && window.Net && Net.connect){
    let started=false;
    const startSP = ()=>{ if(started) return; started=true; window.startGame(cfg); };
    Net.connect({
      room: cfg.room || ('R'+Math.floor(Math.random()*900000+100000)),
      name: cfg.name, map: cfg.map, tier: cfg.tier,
      onReady:(info)=>{
        if(started) return; started=true;
        // 关键修复：以服务器房间配置（房主创建时确定的地图/难度）为准，
        // 避免双方各自随机/选择不同地图而进入不同的"世界"。
        const rc = (info && info.config) || {};
        const mpcfg = Object.assign({}, cfg, { map: rc.map || cfg.map, tier: rc.tier || cfg.tier });
        window.startGame(mpcfg);
      },
      onStatus:(s)=>{ mpStatus=s; flash(s); },
      onError:()=>{ flash('服务器未连接，单机模式'); startSP(); }
    });
    // 3 秒无响应则降级为单机
    setTimeout(()=>{ if(!started){ flash('服务器无响应，单机模式'); startSP(); } }, 3000);
  } else {
    window.startGame(cfg);
  }
}
function onRaidEnd(result){
  const s = Profile.stats; s.raids++;
  if(result.win){
    Profile.money += result.raidValue; s.extracts++; s.earned += result.raidValue;
    const loot = choice(['gold','gold','diamond','intel']);
    add(loot,1);
  } else {
    s.kia++;
    const e = deploySnapshot || Profile.equipped;
    if(e.insure){
      // 已投保：携带武器与护甲原样返还
    } else {
      const lost=[e.weapon, e.weapon2].filter(id=>id && id!=='pistol' && id!=='rifle');
      for(const wid of lost){ if(has(wid)) remove(wid,1); }
      if(e.armorLevel>0 && has('armor'+e.armorLevel)) remove('armor'+e.armorLevel, 1);
    }
  }
  const ex = result.win?1:0;
  for(const q of Profile.quests){
    if(q.id==='extract') q.progress += ex;
    else if(q.id==='scav'){ if(result.raidValue>=2000) q.progress += 1; }
    else if(q.id==='killer') q.progress += result.kills;
    if(q.progress>=q.goal) q.claimable=true;
  }
  save();
}

/* ---------------- 基地界面 (DOM) ---------------- */
function buildDOM(){
  const style = document.createElement('style');
  style.textContent = `
  #base{position:fixed;inset:0;display:none;align-items:center;justify-content:center;
    background:radial-gradient(circle at 50% 30%,#16202b,#070b0f);z-index:10;font-family:"Consolas","Courier New",monospace;}
  #base .panel{width:min(900px,95vw);max-height:92vh;overflow-y:auto;background:rgba(14,20,26,0.96);
    border:1px solid #2c3d4a;border-radius:10px;padding:18px 20px;color:#cfe;box-shadow:0 0 40px rgba(0,0,0,.6);}
  #base h1{color:#73e0ff;font-size:24px;margin:0 0 4px;}
  #base .sub{color:#7a9;font-size:12px;margin-bottom:12px;}
  #base .topbar{display:flex;gap:18px;flex-wrap:wrap;background:#0d141b;border:1px solid #233140;
    border-radius:8px;padding:10px 14px;margin-bottom:14px;}
  #base .topbar .k{color:#5a7;font-size:11px;}
  #base .topbar .v{color:#ffe27a;font-size:18px;font-weight:bold;}
  #base section{margin-bottom:16px;}
  #base .stitle{color:#9effa0;font-size:14px;border-left:3px solid #5aff8c;padding-left:8px;margin-bottom:8px;}
  #base .row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:6px 0;}
  #base button{background:#1c2a36;color:#cfe;border:1px solid #345;padding:6px 12px;border-radius:6px;
    cursor:pointer;font-family:inherit;font-size:13px;}
  #base button:hover{background:#27425a;border-color:#5af;}
  #base button:disabled{opacity:.35;cursor:not-allowed;}
  #base .pill{padding:5px 10px;border-radius:14px;border:1px solid #345;font-size:13px;}
  #base .pill.on{background:#1f4a3a;border-color:#5aff8c;color:#bfffce;}
  #base .item{display:flex;justify-content:space-between;align-items:center;gap:8px;
    background:#0e1720;border:1px solid #233140;border-radius:6px;padding:7px 10px;margin:5px 0;}
  #base .item .nm{font-size:13px;} #base .item .meta{color:#7a9;font-size:11px;}
  #base .val{color:#ffe27a;} #base .price{color:#9effa0;}
  #base .deploy{width:100%;padding:14px;font-size:18px;font-weight:bold;background:#1f6f4a;border:1px solid #5aff8c;color:#dfffe9;margin-top:6px;}
  #base .deploy:hover{background:#258a5c;}
  #base .risk{color:#ff8a7a;font-size:13px;}
  #base .claimbtn{background:#5a4a1f;border-color:#ffd86b;color:#ffe9b0;}
  #base .toast{position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#222;color:#ffd86b;
    padding:8px 16px;border-radius:6px;font-size:13px;opacity:0;transition:opacity .3s;pointer-events:none;}
  #base .toast.show{opacity:1;}
  #base input{outline:none;}
  `;
  document.head.appendChild(style);
  baseEl = document.createElement('div'); baseEl.id='base';
  baseEl.innerHTML = '<div class="panel" id="basePanel"></div><div class="toast" id="baseToast"></div>';
  document.body.appendChild(baseEl);
  panelEl = baseEl.querySelector('#basePanel');
}
let toastTimer=null;
function flash(msg){
  mpStatus = msg;
  if(!baseEl) return;
  const t=baseEl.querySelector('#baseToast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),1400);
}

function showBase(){
  if(!baseEl) buildDOM();
  normalize();
  if(window.setGameState) window.setGameState('base');
  render();
  baseEl.style.display='flex';
}
function hideBase(){ if(baseEl) baseEl.style.display='none'; }

function render(){
  if(!baseEl) buildDOM();
  normalize();
  const P=Profile, s=P.stats;
  const mapName = (OPS_MAPS.find(m=>m.id===P.equipped.map)||{}).name || '随机地图';
  const tierName = (OPS_TIERS[P.equipped.tier]||OPS_TIERS.normal).name;
  let h='';
  h+=`<h1>前线基地 · 仓库</h1><div class="sub">管理装备、资金与合约 — 出击有风险，撤离即收益（支持地图选择 / 难度 / 1~6级甲 / 联机）</div>`;
  // 顶栏
  h+=`<div class="topbar">
    <div><div class="k">资金</div><div class="v">¥${P.money}</div></div>
    <div><div class="k">出击次数</div><div class="v">${s.raids}</div></div>
    <div><div class="k">成功撤离</div><div class="v">${s.extracts}</div></div>
    <div><div class="k">阵亡</div><div class="v">${s.kia}</div></div>
    <div><div class="k">累计收益</div><div class="v">¥${s.earned}</div></div>
    <div><div class="k">段位</div><div class="v" style="color:${rank().color}">${rank().name}</div></div>
    <div><div class="k">PvP击杀</div><div class="v">${s.pvpKills||0}</div></div>
  </div>`;

  // 配装
  h+=`<section><div class="stitle">战前配装</div>`;
  // 主武器
  h+=`<div class="row"><span class="meta">主武器：</span>`;
  for(const id of availableWeapons().filter(id=>id!=='pistol')){
    const c=CATALOG[id];
    h+=`<button class="pill ${P.equipped.weapon===id?'on':''}" onclick="Meta.setSlot('weapon','${id}')">${c.name}</button>`;
  }
  h+=`</div>`;
  // 副武器
  h+=`<div class="row"><span class="meta">副武器：</span>`;
  for(const id of availableWeapons()){
    const nm = id==='pistol'?'手枪(标配)':CATALOG[id].name;
    h+=`<button class="pill ${P.equipped.weapon2===id?'on':''}" onclick="Meta.setSlot('weapon2','${id}')">${nm}</button>`;
  }
  h+=`</div>`;
  // 护甲等级
  const owned=[1,2,3,4,5,6].filter(l=>has('armor'+l));
  h+=`<div class="row"><span class="meta">护甲等级：</span>`;
  if(owned.length===0) h+=`<span class="meta">未拥有（去市场购买）</span>`;
  for(const l of owned){ const at=armorTier(l); h+=`<button class="pill ${P.equipped.armorLevel===l?'on':''}" onclick="Meta.setArmor(${l})">${l}级 (甲${at.max}/${Math.round(at.reduce*100)}%减伤)</button>`; }
  h+=`</div>`;
  // 医疗
  const medOk=count('med');
  h+=`<div class="row"><span class="meta">医疗包(${medOk}个)：</span>
    <button onclick="Meta.step('meds',-1)">−</button>
    <span class="pill on">携带 ${P.equipped.meds}</span>
    <button onclick="Meta.step('meds',1)" ${P.equipped.meds>=Math.min(5,medOk)?'disabled':''}>+</button></div>`;
  // 弹药
  const amOk=count('ammo');
  h+=`<div class="row"><span class="meta">弹药箱(${amOk}个)：</span>
    <button onclick="Meta.step('ammo',-1)">−</button>
    <span class="pill on">携带 ${P.equipped.ammo} (+${P.equipped.ammo*60} 备弹)</span>
    <button onclick="Meta.step('ammo',1)" ${P.equipped.ammo>=Math.min(5,amOk)?'disabled':''}>+</button></div>`;
  // 地图
  h+=`<div class="row"><span class="meta">地图：</span>`;
  for(const m of OPS_MAPS){ h+=`<button class="pill ${P.equipped.map===m.id?'on':''}" onclick="Meta.setMap('${m.id}')">${m.name}</button>`; }
  h+=`</div>`;
  // 难度
  h+=`<div class="row"><span class="meta">行动难度：</span>`;
  for(const k in OPS_TIERS){ const t=OPS_TIERS[k]; h+=`<button class="pill ${P.equipped.tier===k?'on':''}" onclick="Meta.setTier('${k}')">${t.name}</button>`; }
  h+=`</div>`;
  // 保险
  const ic=insCost();
  h+=`<div class="row"><span class="meta">装备保险：</span>
    <button class="pill ${P.equipped.insure?'on':''}" onclick="Meta.toggleInsure()">${P.equipped.insure?'已投保':'投保'} ¥${ic}</button>
    <span class="meta">（阵亡时返还全部携带武器与护甲）</span></div>`;
  h+=`<div class="risk">⚠ 本次风险价值：¥${riskValue()}（阵亡将丢失未保险装备，保险项原样返还）</div>`;
  const depTxt = P.equipped.mp ? `▶ 创建/加入房间并部署（${mapName} · ${tierName}）` : `▶ 部署行动（${mapName} · ${tierName}）`;
  h+=`<button class="deploy" onclick="Meta.deploy()">${depTxt}</button>`;
  h+=`</section>`;

  // 联机
  h+=`<section><div class="stitle">联机对战（可选）</div>`;
  h+=`<div class="row"><span class="meta">模式：</span>
    <button class="pill ${P.equipped.mp?'on':''}" onclick="Meta.toggleMp()">${P.equipped.mp?'联机':'单机'}</button>
    <span class="meta">开启后与其他玩家同图搜打撤（PvPvE）</span></div>`;
  if(P.equipped.mp){
    h+=`<div class="row"><span class="meta">代号：</span>
      <input id="mpName" value="${(P.equipped.name||'').replace(/"/g,'&quot;')}" oninput="Meta.setField('name',this.value)" style="background:#0e1720;color:#cfe;border:1px solid #345;border-radius:6px;padding:5px 8px;font-family:inherit;"></div>`;
    h+=`<div class="row"><span class="meta">房间码：</span>
      <input id="mpRoom" value="${(P.equipped.room||'').replace(/"/g,'&quot;')}" oninput="Meta.setField('room',this.value)" style="background:#0e1720;color:#cfe;border:1px solid #345;border-radius:6px;padding:5px 8px;font-family:inherit;width:150px;">
      <button onclick="Meta.genRoom()">随机</button>
      <span class="meta">${mpStatus||''}</span></div>`;
  }
  h+=`</section>`;

  // 市场
  h+=`<section><div class="stitle">黑市 · 购买装备</div>`;
  for(const id in CATALOG){
    const c=CATALOG[id]; if(c.price<=0) continue;
    const own=count(id);
    h+=`<div class="item"><div><span class="nm">${c.name}</span> <span class="meta">[${TYPE_CN[c.type]}] 价值¥${c.value} · 持有${own}</span></div>
      <button class="price" onclick="Meta.buy('${id}')">购买 ¥${c.price}</button></div>`;
  }
  h+=`</section>`;

  // 仓库
  h+=`<section><div class="stitle">仓库 · 出售换取资金</div>`;
  let any=false;
  for(const id in CATALOG){
    const n=count(id); if(n<=0) continue; any=true;
    const c=CATALOG[id];
    h+=`<div class="item"><div><span class="nm">${c.name}</span> <span class="meta">[${TYPE_CN[c.type]}] ×${n} · 单价¥${c.value}</span></div>
      <button onclick="Meta.sellAll('${id}')">${id==='rifle'?'基础武器':'全部出售'} ¥${c.value*n}</button></div>`;
  }
  if(!any) h+=`<div class="meta">仓库空空如也，出击搜刮或前往市场。</div>`;
  h+=`</section>`;

  // 任务
  h+=`<section><div class="stitle">合约 · 任务</div>`;
  for(const q of P.quests){
    const pct=Math.min(100, Math.floor(q.progress/q.goal*100));
    h+=`<div class="item"><div style="flex:1">
      <div class="nm">${q.name} <span class="meta">奖励 ¥${q.reward}</span></div>
      <div class="meta">${q.desc} — 进度 ${Math.min(q.progress,q.goal)}/${q.goal}</div>
      <div style="height:5px;background:#0a1016;border-radius:3px;margin-top:4px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:#5aff8c"></div></div>
      </div>
      <button class="claimbtn" ${q.claimable?'':'disabled'} onclick="Meta.claim('${q.id}')">${q.claimable?'领取 ¥'+q.reward:'未完成'}</button>
    </div>`;
  }
  h+=`</section>`;

  panelEl.innerHTML = h;
}

/* ---------------- 暴露接口 ---------------- */
if(window.__TEST__){
  window.__meta = {
    get money(){return Profile.money;}, get stash(){return Profile.stash;},
    get stats(){return Profile.stats;}, get equipped(){return Profile.equipped;},
    addPvpKill, rank
  };
}

return {
  showBase, hideBase, deploy, onRaidEnd, render,
  setSlot, setArmor, setMap, setTier, setField, toggleMp, genRoom,
  step, buy, sellAll, claim, toggleInsure, insCost,
  addPvpKill, rank,
  hasItem:(id,n)=>has(id,n), itemValue
};

})();
