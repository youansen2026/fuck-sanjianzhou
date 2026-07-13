'use strict';
/* ============================================================
   联机中继服务器 (Node + ws)
   - 房间(room)内广播消息：state / fire / dead / extract
   - 房间由首位玩家 create 时建立，携带地图与难度配置
   - 后续玩家 join 同一 room 即可进入同图同难度
   运行：node server.js   （默认端口 8125）
   ============================================================ */
const WebSocket = require('ws');
const PORT = process.env.PORT || 8125;
const wss = new WebSocket.Server({ port: PORT });
const rooms = {}; // room -> { config, clients: { id: ws }, score: { id: {name, kills} } }

function colorFor(id){
  const palette=['#39b6ff','#ff7a5a','#9effa0','#ffd86b','#c08bff','#ff6b9a','#5ad1ff','#ff9ad1'];
  let h=0; for(let i=0;i<id.length;i++) h=(h*31+id.charCodeAt(i))>>>0; return palette[h%palette.length];
}
function joinRoom(ws, room, name){
  ws.room = room;
  ws._name = name;
  const r = rooms[room];
  r.clients[ws.id] = ws;
  const peers=[];
  for(const id in r.clients){ if(id!==ws.id) peers.push({id, name:r.clients[id]._name}); }
  ws.send(JSON.stringify({type:'welcome', id:ws.id, room, config:r.config, peers}));
  for(const id in r.clients){
    if(id!==ws.id) r.clients[id].send(JSON.stringify({type:'peerJoin', id:ws.id, name}));
  }
  // 把当前计分榜发给新加入者
  ws.send(JSON.stringify({type:'score', list:scoreList(r)}));
}
function scoreList(r){
  const list=[];
  for(const id in r.score){ const s=r.score[id]; list.push({id, name:s.name, kills:s.kills}); }
  list.sort((a,b)=>b.kills-a.kills);
  return list;
}
function broadcastScore(r){
  const list=scoreList(r);
  const msg=JSON.stringify({type:'score', list});
  for(const id in r.clients){ r.clients[id].send(msg); }
}
function relay(ws, m){
  const r = rooms[ws.room];
  if(!r) return;
  for(const id in r.clients){ if(id!==ws.id) r.clients[id].send(JSON.stringify(m)); }
}
function leaveRoom(ws){
  const r = rooms[ws.room];
  if(r){
    delete r.clients[ws.id];
    delete r.score[ws.id];
    for(const id in r.clients){ r.clients[id].send(JSON.stringify({type:'peerLeft', id:ws.id})); }
    if(Object.keys(r.clients).length===0) delete rooms[ws.room];
  }
  ws.room = null;
}

let nextId = 1;
wss.on('connection', ws=>{
  ws.id = 'P'+(nextId++);
  ws.room = null;
  ws.on('message', (msg)=>{
    let m; try{ m = JSON.parse(msg); }catch(e){ return; }
    if(m.type==='create'){
      const room = m.room || ('R'+Math.floor(Math.random()*1e6));
      rooms[room] = rooms[room] || { config:{map:m.map, tier:m.tier, name:m.name}, clients:{}, score:{} };
      joinRoom(ws, room, m.name);
    } else if(m.type==='join'){
      if(!rooms[m.room]){ ws.send(JSON.stringify({type:'error', msg:'房间不存在'})); return; }
      joinRoom(ws, m.room, m.name);
    } else if(m.type==='state' || m.type==='fire' || m.type==='dead' || m.type==='extract'){
      relay(ws, m);
    } else if(m.type==='kill'){
      const r = rooms[ws.room]; if(!r) return;
      const s = r.score[ws.id] || {name:m.name||ws._name||ws.id, kills:0};
      s.name = m.name||s.name; s.kills++;
      r.score[ws.id] = s;
      broadcastScore(r);
    } else if(m.type==='leave'){
      leaveRoom(ws);
    }
  });
  ws.on('close', ()=> leaveRoom(ws));
  ws.on('error', ()=>{});
});

console.log('[联机服务器] 已启动 ws://0.0.0.0:'+PORT);
