/**
 * 极速博弈 3D — 多人房间 WebSocket 服务器
 * 房间管理 + 玩家位置广播 + AI 补位
 */
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const MAX_PLAYERS = 4;  // 每个房间最多4人

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size, players: totalPlayers }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Racing Game WebSocket Server');
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });

// 房间数据结构: Map<roomName, { host, players: Map<ws, {id, name, x, y, angle, speed, color, carType, ready, isAI}>, map, racing }>
const rooms = new Map();
let totalPlayers = 0;
let playerIdCounter = 0;

function genPlayerId() {
  return 'p' + (++playerIdCounter).toString(36) + Math.random().toString(36).slice(2, 5);
}

function getRoomState(roomName) {
  const room = rooms.get(roomName);
  if (!room) return null;
  const players = Array.from(room.players.entries()).map(([ws, p]) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    carType: p.carType,
    ready: p.ready,
    isAI: p.isAI || false,
    isHost: ws === room.host
  }));
  return { room: roomName, players, racing: room.racing || false, map: room.map || 0, maxPlayers: MAX_PLAYERS };
}

function broadcastRoomState(roomName) {
  const state = getRoomState(roomName);
  if (!state) return;
  const msg = JSON.stringify({ type: 'roomState', ...state });
  const room = rooms.get(roomName);
  if (!room) return;
  room.players.forEach((_, ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

function broadcastRoomList() {
  const list = Array.from(rooms.entries()).map(([name, r]) => ({
    name,
    count: r.players.size,
    max: MAX_PLAYERS,
    host: r.host ? (r.host.playerName || 'Host') : '',
    map: r.map || 0,
    racing: r.racing || false
  }));
  const msg = JSON.stringify({ type: 'roomList', rooms: list });
  wss.clients.forEach(ws => {
    if (ws.readyState === 1 && !ws.roomName) {
      ws.send(msg);
    }
  });
}

// 为房间补齐 AI 玩家到 MAX_PLAYERS
function fillAIPlayers(roomName) {
  const room = rooms.get(roomName);
  if (!room) return;
  const realPlayers = Array.from(room.players.values()).filter(p => !p.isAI).length;
  const aiPlayers = Array.from(room.players.values()).filter(p => p.isAI).length;
  const needed = MAX_PLAYERS - realPlayers - aiPlayers;
  
  // 删除多余的 AI（当真实玩家加入时）
  if (needed < 0) {
    const aiEntries = Array.from(room.players.entries()).filter(([ws, p]) => p.isAI);
    for (let i = 0; i < -needed; i++) {
      const [ws, p] = aiEntries[i];
      room.players.delete(ws);
    }
    return;
  }
  
  // 添加 AI 玩家
  const aiNames = ['AI·闪电', 'AI·疾风', 'AI·雷霆', 'AI·幻影'];
  const aiColors = ['#4d9bff', '#9d4dff', '#4dd97a', '#ffb84d'];
  for (let i = 0; i < needed; i++) {
    const existingAI = Array.from(room.players.values()).filter(p => p.isAI).length;
    const aiId = 'ai_' + roomName + '_' + existingAI;
    const aiName = aiNames[existingAI % aiNames.length];
    const aiColor = aiColors[existingAI % aiColors.length];
    
    // 用 null 作为 ws（AI 没有 WebSocket 连接）
    room.players.set({ isAIProxy: true, readyState: 1, send: () => {} }, {
      id: aiId,
      name: aiName,
      color: aiColor,
      carType: existingAI % 3,
      ready: true,
      isAI: true,
      x: 0, y: 0, angle: 0, speed: 0
    });
  }
}

wss.on('connection', (ws) => {
  totalPlayers++;
  ws.playerName = 'Player' + Math.floor(Math.random() * 1000);
  ws.roomName = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.type) {
      case 'createRoom': {
        const name = (msg.roomName || '').trim().slice(0, 20);
        if (!name) { ws.send(JSON.stringify({ type: 'error', msg: '房间名不能为空' })); return; }
        if (rooms.has(name)) { ws.send(JSON.stringify({ type: 'error', msg: '房间名已存在' })); return; }
        if (ws.roomName) leaveRoom(ws);
        
        const playerId = genPlayerId();
        rooms.set(name, {
          host: ws,
          map: msg.map || 0,
          racing: false,
          players: new Map([[ws, {
            id: playerId,
            name: msg.playerName || ws.playerName,
            color: msg.color || '#ff8800',
            carType: msg.carType || 0,
            ready: false,
            isAI: false,
            x: 0, y: 0, angle: 0, speed: 0
          }]])
        });
        ws.roomName = name;
        
        // 自动补 AI 玩家
        fillAIPlayers(name);
        
        ws.send(JSON.stringify({ type: 'roomCreated', room: name, playerId }));
        broadcastRoomState(name);
        broadcastRoomList();
        break;
      }

      case 'searchRooms': {
        const q = (msg.query || '').trim().toLowerCase();
        const list = Array.from(rooms.entries())
          .filter(([name]) => !q || name.toLowerCase().includes(q))
          .map(([name, r]) => ({
            name,
            count: Array.from(r.players.values()).filter(p => !p.isAI).length,
            max: MAX_PLAYERS,
            host: r.host ? (r.host.playerName || 'Host') : '',
            map: r.map || 0,
            racing: r.racing || false
          }));
        ws.send(JSON.stringify({ type: 'searchResults', rooms: list }));
        break;
      }

      case 'joinRoom': {
        const name = (msg.roomName || '').trim();
        const room = rooms.get(name);
        if (!room) { ws.send(JSON.stringify({ type: 'error', msg: '房间不存在' })); return; }
        const realCount = Array.from(room.players.values()).filter(p => !p.isAI).length;
        if (realCount >= MAX_PLAYERS) { ws.send(JSON.stringify({ type: 'error', msg: '房间已满(4人)' })); return; }
        if (room.racing) { ws.send(JSON.stringify({ type: 'error', msg: '比赛进行中，无法加入' })); return; }
        if (ws.roomName) leaveRoom(ws);
        
        const playerId = genPlayerId();
        room.players.set(ws, {
          id: playerId,
          name: msg.playerName || ws.playerName,
          color: msg.color || '#3b82f6',
          carType: msg.carType || 0,
          ready: false,
          isAI: false,
          x: 0, y: 0, angle: 0, speed: 0
        });
        ws.roomName = name;
        
        // 重新补 AI（新玩家加入后可能需要减少 AI）
        fillAIPlayers(name);
        
        ws.send(JSON.stringify({ type: 'roomJoined', room: name, playerId }));
        broadcastRoomState(name);
        broadcastRoomList();
        break;
      }

      case 'leaveRoom': {
        if (ws.roomName) {
          leaveRoom(ws);
          broadcastRoomList();
        }
        break;
      }

      case 'setReady': {
        const room = ws.roomName ? rooms.get(ws.roomName) : null;
        if (!room) return;
        const p = room.players.get(ws);
        if (p) { p.ready = msg.ready; broadcastRoomState(ws.roomName); }
        break;
      }

      case 'setCar': {
        const room = ws.roomName ? rooms.get(ws.roomName) : null;
        if (!room) return;
        const p = room.players.get(ws);
        if (p) { p.carType = msg.carType; p.color = msg.color; broadcastRoomState(ws.roomName); }
        break;
      }

      case 'startRace': {
        const room = ws.roomName ? rooms.get(ws.roomName) : null;
        if (!room || room.host !== ws) return;
        room.racing = true;
        
        // 发送开始比赛消息，包含所有玩家信息（含 AI）
        const state = getRoomState(ws.roomName);
        const startMsg = JSON.stringify({ 
          type: 'raceStart', 
          map: room.map || 0,
          players: state.players
        });
        room.players.forEach((_, client) => {
          if (client.readyState === 1 && !client.isAIProxy) client.send(startMsg);
        });
        broadcastRoomList();
        break;
      }

      case 'position': {
        const room = ws.roomName ? rooms.get(ws.roomName) : null;
        if (!room || !room.racing) return;
        const p = room.players.get(ws);
        if (!p) return;
        p.x = msg.x; p.y = msg.y; p.angle = msg.angle; p.speed = msg.speed;
        
        // 广播给房间内其他真实玩家
        const posMsg = JSON.stringify({
          type: 'position',
          id: p.id,
          name: p.name,
          color: p.color,
          x: p.x, y: p.y, angle: p.angle, speed: p.speed
        });
        room.players.forEach((_, client) => {
          if (client !== ws && client.readyState === 1 && !client.isAIProxy) client.send(posMsg);
        });
        break;
      }

      case 'finishRace': {
        const room = ws.roomName ? rooms.get(ws.roomName) : null;
        if (!room) return;
        const finishMsg = JSON.stringify({
          type: 'playerFinished',
          id: msg.id,
          time: msg.time
        });
        room.players.forEach((_, client) => {
          if (client.readyState === 1 && !client.isAIProxy) client.send(finishMsg);
        });
        break;
      }

      case 'backToRoom': {
        const room = ws.roomName ? rooms.get(ws.roomName) : null;
        if (!room) return;
        if (room.host === ws) {
          room.racing = false;
          broadcastRoomState(ws.roomName);
          broadcastRoomList();
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    totalPlayers--;
    if (ws.roomName) {
      leaveRoom(ws);
      broadcastRoomList();
    }
  });
});

function leaveRoom(ws) {
  const roomName = ws.roomName;
  if (!roomName) return;
  const room = rooms.get(roomName);
  if (!room) { ws.roomName = null; return; }
  
  room.players.delete(ws);
  
  if (room.players.size === 0 || Array.from(room.players.values()).every(p => p.isAI)) {
    // 没有真实玩家了，删除房间
    rooms.delete(roomName);
  } else {
    // 房主离开，选新房主
    if (room.host === ws) {
      const realPlayers = Array.from(room.players.entries()).filter(([ws, p]) => !p.isAI);
      if (realPlayers.length > 0) {
        room.host = realPlayers[0][0];
      }
    }
    // 重新补 AI
    fillAIPlayers(roomName);
    broadcastRoomState(roomName);
  }
  ws.roomName = null;
}

server.listen(PORT, () => {
  console.log(`Racing WebSocket server running on port ${PORT}`);
});
