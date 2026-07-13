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
  let gotConfig=null, finalized=false, hostTimer=null, presenceTimer=null, sweepTimer=null;
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
    if(!gotConfig){ publish(topic('config'), JSON.stringify({map:optsRef.map, tier:optsRef.tier, name:optsRef.name}), true); }
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
      if(!data){ if(peersSeen[id]) delete peersSeen[id]; if(hooks.onPeerLeft) hooks.onPeerLeft(id); return; }
      const isNew = !peersSeen[id];
      peersSeen[id] = {name:data.name||id, color:data.color||colorFor(id), last:Date.now()};
      if(!scoreMap[id]) scoreMap[id]={name:data.name||id, kills:0};
      else scoreMap[id].name = data.name||scoreMap[id].name;
      if(isNew && hooks.onPeerJoin) hooks.onPeerJoin(id, data.name, data.color||colorFor(id));
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
  function disconnect(){
    if(client){
      try{ publish(topic('presence', myId), '', true); }catch(e){}
      try{ publish(topic('leave', myId), '', false); }catch(e){}
      try{ client.end(true); }catch(e){}
    }
    cleanupTimers();
    client=null; connected=false; myId=null; room=null;
  }

  return {
    connect, disconnect, sendState, sendFire, sendDead, sendExtract, sendKill,
    isConnected:()=>connected,
    get myId(){ return myId; },
    setHooks(h){ hooks=h; }
  };
})();
