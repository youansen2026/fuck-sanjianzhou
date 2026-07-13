'use strict';
/* ============================================================
   联机客户端（WebSocket 中继）
   - 连接 server.js，加入房间，转发自身状态/开火/死亡
   - 非权威模型：每个客户端本地模拟，服务器仅做房间内广播
   - 容错：连接失败/超时则降级为单机（由 meta.deploy 处理）
   ============================================================ */
window.Net = (function(){
  let ws=null, myId=null, room=null, connected=false, hooks={};
  let onErr=null;
  const palette=['#39b6ff','#ff7a5a','#9effa0','#ffd86b','#c08bff','#ff6b9a','#5ad1ff','#ff9ad1'];
  function colorFor(id){ let h=0; for(let i=0;i<id.length;i++) h=(h*31+id.charCodeAt(i))>>>0; return palette[h%palette.length]; }
  function send(obj){ if(ws && connected){ try{ ws.send(JSON.stringify(obj)); }catch(e){} } }

  function connect(opts){
    opts = opts || {};
    const proto = location.protocol==='https:' ? 'wss' : 'ws';
    const url = proto + '://' + location.hostname + ':8125';
    try{ ws = new WebSocket(url); }
    catch(e){ if(opts.onError) opts.onError(); return; }
    connected=false;
    onErr = opts.onError || null;
    const timer = setTimeout(()=>{ if(!connected && opts.onError){ opts.onError(); } }, 3000);

    ws.onopen = ()=>{
      connected=true; clearTimeout(timer);
      ws.send(JSON.stringify({type:'create', room:opts.room, name:opts.name, map:opts.map, tier:opts.tier}));
    };
    ws.onmessage = (ev)=>{
      let m; try{ m=JSON.parse(ev.data); }catch(e){ return; }
      if(m.type==='welcome'){
        myId=m.id; room=m.room;
        if(opts.onReady) opts.onReady({id:myId, room:m.room, config:m.config, peers:m.peers, color:colorFor(myId)});
        if(opts.onStatus) opts.onStatus('已接入房间 '+m.room);
      } else if(m.type==='error'){
        if(opts.onStatus) opts.onStatus(m.msg);
        if(onErr) onErr();
      } else if(m.type==='peerJoin'){ if(hooks.onPeerJoin) hooks.onPeerJoin(m.id, m.name, colorFor(m.id)); }
      else if(m.type==='peerLeft'){ if(hooks.onPeerLeft) hooks.onPeerLeft(m.id); }
      else if(m.type==='state'){ if(hooks.onPeerState) hooks.onPeerState(m); }
      else if(m.type==='fire'){ if(hooks.onPeerFire) hooks.onPeerFire(m); }
      else if(m.type==='dead'){ if(hooks.onPeerDead) hooks.onPeerDead(m.id, m.killer); }
      else if(m.type==='extract'){ if(hooks.onPeerExtract) hooks.onPeerExtract(m.id); }
      else if(m.type==='score'){ if(hooks.onScore) hooks.onScore(m.list); }
    };
    ws.onclose = ()=>{ connected=false; };
    ws.onerror = ()=>{ connected=false; if(onErr) onErr(); };
  }

  function sendState(p){ send({type:'state', id:myId, x:p.x,y:p.y,angle:p.angle,hp:p.hp,armor:p.armor,cur:p.cur,wname:p.wname,name:p.name}); }
  function sendFire(f){ send({type:'fire', id:myId, x:f.x,y:f.y,angle:f.angle,pellets:f.pellets,speed:f.speed,range:f.range,dmg:f.dmg,color:f.color,name:f.name}); }
  function sendDead(killer){ send({type:'dead', id:myId, killer:killer||null}); }
  function sendExtract(){ send({type:'extract', id:myId}); }
  function sendKill(name){ send({type:'kill', id:myId, name:name||''}); }
  function disconnect(){ if(ws){ try{ ws.send(JSON.stringify({type:'leave'})); }catch(e){} try{ ws.close(); }catch(e){} } ws=null; connected=false; myId=null; room=null; }

  return {
    connect, disconnect, sendState, sendFire, sendDead, sendExtract, sendKill,
    isConnected:()=>connected,
    get myId(){ return myId; },
    setHooks(h){ hooks=h; }
  };
})();
