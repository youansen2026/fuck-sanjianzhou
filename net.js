'use strict';
/* ============================================================
   联机客户端（公共 MQTT over WebSocket 中转 —— 无需自建后端）
   - 纯静态站点可用：房间 = MQTT 主题，公共 broker 仅做消息路由
   - 房主(首个进入者)发布 retained 配置(config)，其余客户端读取并同步地图/难度
   - 在线状态用 retained presence 实现"无服务器"的玩家发现
   - 击杀计分榜由各客户端根据 kill 消息本地维护
   - 依赖浏览器全局 window.mqtt（mqtt.min.js）
   ============================================================ */
window.Net = (function(){
  let client=null, myId=null, room=null, connected=false, hooks={};
  let onErr=null, optsRef=null;
  let gotConfig=null, finalized=false, hostTimer=null, presenceTimer=null, sweepTimer=null, lobbyTouchTimer=null, amHost=false;
  let peersSeen={};        // id -> {name,color,last}
  let scoreMap={};         // id -> {name,kills}
  const palette=['#39b6ff','#ff7a5a','#9effa0','#ffd86b','#c08bff','#ff6b9a','#5ad1ff','#ff9ad1'];

  function colorFor(id){ let h=0; for(let i=0;i<id.length;i++) h=(h*31+id.charCodeAt(i))>>>0; return palette[h%palette.length]; }
  function sanitize(s){ return (s||'').toString().replace(/[^A-Za-z0-9_\-]/g,'_').slice(0,32) || 'R'; }
  function topicBase(){ return 'delta/'+room; }
  function topic(){ return topicBase()+'/'+Array.prototype.slice.call(arguments).join('/'); }

  // 默认公共 broker（wss 优先，纯静态 https 站点也能用）；可被 window.__NET_BROKERS__ 覆盖
  const BROKERS = (window.__NET_BROKERS__ && window.__NET_BROKERS__.length) ? window.__NET_BROKERS__
    : ['wss://broker.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081/mqtt'];

  function scoreList(){
    const list=[];
    for(const id in scoreMap){ const s=scoreMap[id]; list.push({id, name:s.name||id, kills:s.kills||0}); }
    list.sort((a,b)=>b.kills-a.kills);
    return list;
  }
  function bumpScore(id, name){
    const s=scoreMap[id]||{name:name||id, kills:0};
    s.name=name||s.name; s.kills=(s.kills||0)+1; scoreMap[id]=s;
    if(hooks.onScore) hooks.onScore(scoreList());
  }
  function ensureClientId(){ if(!myId) myId='P'+Math.random().toString(36).slice(2,8); }
  // 房主广播到公共大厅的信息（含实时在线人数）
  function hostInfo(){ return {name:optsRef&&optsRef.name, map:optsRef&&optsRef.map, tier:optsRef&&optsRef.tier, host:optsRef&&optsRef.name, count:Object.keys(peersSeen).length+1}; }
  function publish(t, msg, retain){
    if(client && connected){ try{ client.publish(t, msg, {qos:0, retain:!!retain}); }catch(e){} }
  }
  function cleanupTimers(){
    if(hostTimer){ clearTimeout(hostTimer); hostTimer=null; }
    if(presenceTimer){ clearInterval(presenceTimer); presenceTimer=null; }
    if(sweepTimer){ clearInterval(sweepTimer); sweepTimer=null; }
  }

  function finalize(){
    if(finalized) return; finalized=true;
    if(hostTimer){ clearTimeout(hostTimer); hostTimer=null; }
    const cfg = gotConfig || { map: optsRef.map, tier: optsRef.tier, name: optsRef.name };
    // 房主发布权威配置（retained），后续加入者直接读取
    if(optsRef.host && !gotConfig){
      publish(topic('config'), JSON.stringify({map:optsRef.map, tier:optsRef.tier, name:optsRef.name}), true);
      amHost = true;
      Lobby.advertise(room, hostInfo());
      if(lobbyTouchTimer) clearInterval(lobbyTouchTimer);
      lobbyTouchTimer = setInterval(()=>Lobby.advertise(room, hostInfo()), 5000);
    }
    // 自己的在线状态（retained），并定期心跳
    const me = JSON.stringify({name:optsRef.name, color:colorFor(myId)});
    publish(topic('presence', myId), me, true);
    scoreMap[myId] = scoreMap[myId] || {name:optsRef.name, kills:0};
    presenceTimer = setInterval(()=>{ publish(topic('presence', myId), me, true); }, 3000);
    sweepTimer = setInterval(sweepPeers, 3000);
    // 通知上层开局（带上已发现的 peers）
    const peers=[];
    for(const id in peersSeen){ if(id!==myId) peers.push({id, name:peersSeen[id].name||id}); }
    if(optsRef.onReady) optsRef.onReady({id:myId, room, config:cfg, peers, color:colorFor(myId)});
  }

  function sweepPeers(){
    const now=Date.now();
    for(const id in peersSeen){
      if(now-(peersSeen[id].last||0) > 9000){
        delete peersSeen[id];
        if(hooks.onPeerLeft) hooks.onPeerLeft(id);
      }
    }
  }

  function handleMessage(t, payload){
    if(!room || t.indexOf(topicBase()+'/')!==0) return;
    const seg = t.slice(topicBase().length+1).split('/'); // [type, id?]
    const type = seg[0], id = seg[1];
    let data=null;
    try{ const s = payload && payload.toString ? payload.toString() : ''; if(s) data=JSON.parse(s); }catch(e){ data=null; }
    if(type==='config'){
      if(data && !finalized) gotConfig = {map:data.map, tier:data.tier, name:data.name};
    } else if(type==='presence'){
      if(!id || id===myId) return;
      if(!data){ if(peersSeen[id]) delete peersSeen[id]; if(hooks.onPeerLeft) hooks.onPeerLeft(id); if(amHost) Lobby.advertise(room, hostInfo()); return; }
      const isNew = !peersSeen[id];
      peersSeen[id] = {name:data.name||id, color:data.color||colorFor(id), last:Date.now()};
      if(!scoreMap[id]) scoreMap[id]={name:data.name||id, kills:0};
      else scoreMap[id].name = data.name||scoreMap[id].name;
      if(isNew && hooks.onPeerJoin) hooks.onPeerJoin(id, data.name, data.color||colorFor(id));
      if(amHost) Lobby.advertise(room, hostInfo());
    } else if(type==='state'){
      if(!id||id===myId||!data) return;
      if(hooks.onPeerState) hooks.onPeerState(Object.assign({id}, data));
    } else if(type==='fire'){
      if(!id||id===myId||!data) return;
      if(hooks.onPeerFire) hooks.onPeerFire(Object.assign({id}, data));
    } else if(type==='dead'){
      if(!id||id===myId) return;
      const killer = data && data.killer || null;
      if(hooks.onPeerDead) hooks.onPeerDead(id, killer);
    } else if(type==='extract'){
      if(!id||id===myId) return;
      if(hooks.onPeerExtract) hooks.onPeerExtract(id);
    } else if(type==='kill'){
      if(!id||id===myId) return;
      const name = (data&&data.name) || (peersSeen[id]&&peersSeen[id].name) || id;
      bumpScore(id, name);
    } else if(type==='leave'){
      if(!id||id===myId) return;
      if(peersSeen[id]) delete peersSeen[id];
      if(hooks.onPeerLeft) hooks.onPeerLeft(id);
    } else if(type==='start'){
      if(!data || (data.from && data.from===myId)) return; // 忽略自己回显
      if(hooks.onStart) hooks.onStart(data);
    } else if(type==='roomopen'){
      if(!data) return;
      if(hooks.onRoomOpen) hooks.onRoomOpen(data.idx|0);
    }
  }

  function connect(opts){
    optsRef = opts || {};
    if(!window.mqtt){ if(optsRef.onError) optsRef.onError(); return; }
    ensureClientId();
    room = sanitize(optsRef.room || ('R'+Math.floor(Math.random()*900000+100000)));
    connected=false; gotConfig=null; finalized=false; scoreMap={}; peersSeen={};
    onErr = optsRef.onError || null;
    const brokers = (optsRef.brokers && optsRef.brokers.length) ? optsRef.brokers : BROKERS;
    let bi=0, done=false;
    function fail(){ if(done) return; done=true; cleanupTimers(); try{ if(client) client.end(true); }catch(e){} client=null; if(onErr) onErr(); }
    function nextBroker(){
      if(bi>=brokers.length){ fail(); return; }
      const url = brokers[bi++];
      let c;
      try{
        c = window.mqtt.connect(url, {
          clientId: 'delta_'+myId+'_'+Math.random().toString(36).slice(2,6),
          clean:true, keepalive:30, reconnectPeriod:0, connectTimeout:4000,
          will: { topic: topic('leave', myId), payload:'', qos:0, retain:false }
        });
      }catch(e){ nextBroker(); return; }
      client=c; let ever=false;
      c.on('connect', ()=>{
        ever=true; connected=true;
        c.subscribe(topic('#'), {}, (err)=>{
          if(err){ if(!ever) nextBroker(); return; }
          hostTimer = setTimeout(finalize, 500);
        });
        if(optsRef.onStatus) optsRef.onStatus('已接入中转 '+url);
      });
      c.on('message', (t,p)=>handleMessage(t,p));
      c.on('error', ()=>{ if(!ever) nextBroker(); });
      c.on('close', ()=>{ connected=false; if(!ever) nextBroker(); });
    }
    nextBroker();
    setTimeout(()=>{ if(!connected) fail(); }, 7000);
  }

  function sendState(p){ publish(topic('state', myId), JSON.stringify({x:p.x,y:p.y,angle:p.angle,hp:p.hp,armor:Math.ceil(p.armor),cur:p.cur,wname:p.wname,name:p.name})); }
  function sendFire(f){ publish(topic('fire', myId), JSON.stringify({x:f.x,y:f.y,angle:f.angle,pellets:f.pellets,speed:f.speed,range:f.range,dmg:f.dmg,color:f.color,name:f.name})); }
  function sendDead(killer){ publish(topic('dead', myId), JSON.stringify({killer:killer||null})); }
  function sendExtract(){ publish(topic('extract', myId), ''); }
  function sendKill(name){ bumpScore(myId, name||(optsRef&&optsRef.name)||myId); publish(topic('kill', myId), JSON.stringify({name:name||(optsRef&&optsRef.name)||myId})); }
  // 房主开始游戏：广播 start（含地图/难度/seed），并本地触发 onStart
  function startRoom(cfg){
    if(!amHost) return;
    const shared={map:cfg.map, tier:cfg.tier, name:cfg.name, seed:cfg.seed, from:myId};
    publish(topic('start'), JSON.stringify(shared), false);
    if(hooks.onStart) hooks.onStart(shared);
  }
  // 同步：某容器被开启（含上锁密室），通知其他客户端
  function sendRoomOpen(idx){ publish(topic('roomopen'), JSON.stringify({idx:idx|0}), false); }
  // 房主中途修改地图/难度后重新发布权威配置
  function setConfig(map,tier){
    if(!amHost) return;
    optsRef.map=map; optsRef.tier=tier;
    publish(topic('config'), JSON.stringify({map,tier,name:optsRef.name}), true);
    Lobby.advertise(room, hostInfo());
  }
  function getPeers(){ const arr=[]; for(const id in peersSeen){ arr.push({id, name:peersSeen[id].name||id, color:peersSeen[id].color||colorFor(id)}); } return arr; }
  function disconnect(){
    if(client){
      try{ publish(topic('presence', myId), '', true); }catch(e){}
      try{ publish(topic('leave', myId), '', false); }catch(e){}
      try{ client.end(true); }catch(e){}
    }
    if(lobbyTouchTimer){ clearInterval(lobbyTouchTimer); lobbyTouchTimer=null; }
    if(amHost){ try{ Lobby.retract(room); }catch(e){} amHost=false; }
    cleanupTimers();
    client=null; connected=false; myId=null; room=null;
  }

  // ---- 房间大厅：独立轻量 MQTT 连接，订阅 delta/lobby/# 实现"无服务器"大厅 ----
  const Lobby = (function(){
    let lc=null, open=false, onList=null, room2info={}, ttlTimer=null, pending=null;
    const TTL=15000;
    const LBASE='delta/lobby';
    function brokers(){ return (window.__NET_BROKERS__ && window.__NET_BROKERS__.length) ? window.__NET_BROKERS__ : BROKERS; }
    function listNow(){
      const arr=[], now=Date.now();
      for(const r in room2info){ const it=room2info[r]; if(now-(it.ts||0)<=TTL) arr.push(it); }
      arr.sort((a,b)=>(b.ts||0)-(a.ts||0)); return arr;
    }
    function emit(){ if(onList) onList(listNow()); }
    function doAdv(room, info){
      if(!lc){ pending={room,info}; return; }
      try{ lc.publish(LBASE+'/'+sanitize(room), JSON.stringify(Object.assign({ts:Date.now()}, info)), {qos:0, retain:true}); }catch(e){}
    }
    function start(urlList, idx, done){
      if(idx>=urlList.length){ if(done) done(); if(onList) onList([]); return; }
      const url=urlList[idx]; let c;
      try{ c=window.mqtt.connect(url,{clientId:'delta_lobby_'+Math.random().toString(36).slice(2,8),clean:true,keepalive:30,reconnectPeriod:0,connectTimeout:4000}); }
      catch(e){ start(urlList, idx+1, done); return; }
      lc=c; let ever=false;
      c.on('connect',()=>{ ever=true; open=true; c.subscribe(LBASE+'/#',{},(err)=>{ if(err&&!ever) start(urlList, idx+1, done); }); if(pending) doAdv(pending.room, pending.info); emit(); });
      c.on('message',(t,p)=>{
        const room=t.slice(LBASE.length+1).split('/')[0];
        const s=p&&p.toString?p.toString():'';
        if(!s){ delete room2info[room]; }
        else { try{ const d=JSON.parse(s); room2info[room]=Object.assign({room}, d); }catch(e){ delete room2info[room]; } }
        emit();
      });
      c.on('error',()=>{ if(!ever) start(urlList, idx+1, done); });
      c.on('close',()=>{ if(!ever) start(urlList, idx+1, done); });
    }
    return {
      open(cb){
        if(!window.mqtt){ if(cb) cb([]); return; }
        onList=cb; room2info={}; pending=null;
        start(brokers(), 0, ()=>{ open=false; });
        if(ttlTimer) clearInterval(ttlTimer);
        ttlTimer=setInterval(()=>{ const now=Date.now(); let ch=false; for(const r in room2info){ if(now-(room2info[r].ts||0)>TTL){ delete room2info[r]; ch=true; } } if(ch) emit(); }, 3000);
      },
      advertise(room, info){ doAdv(room, info); },
      retract(room){ if(!lc) return; try{ lc.publish(LBASE+'/'+sanitize(room), '', {qos:0, retain:true}); }catch(e){} },
      close(){ if(ttlTimer){ clearInterval(ttlTimer); ttlTimer=null; } if(lc) try{ lc.end(true); }catch(e){} lc=null; open=false; room2info={}; pending=null; },
      get isOpen(){ return open; }
    };
  })();

  return {
    connect, disconnect, sendState, sendFire, sendDead, sendExtract, sendKill, sendRoomOpen,
    startRoom, setConfig, getPeers, amHost:()=>amHost,
    Lobby,
    isConnected:()=>connected,
    get myId(){ return myId; },
    setHooks(h){ hooks=h; }
  };
})();
