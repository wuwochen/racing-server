/**
 * 极速博弈 3D — 多人房间 WebSocket 服务器
 * 轻量级：房间管理 + 玩家位置广播
 */
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

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

// 房间数据结构: Map<roomName, { host, players: Map<ws, {name, x, y, angle, color, carType, ready}>} >
const rooms = new Map();
let totalPlayers = 0;

function broadcastRoomList() {
  const list = Array.from(rooms.entries()).map(([name, r]) => ({
    name,
    count: r.players.size,
    max: 8,
    host: r.host,
    map: r.map || 0,
    racing: r.racing || false
  }));
  const msg = JSON.stringify({ type: 'roomList', rooms: list });
  // 广播给所有在大厅的连接（没有加入房间的）
  wss.clients.forEach(ws => {
    if (ws.readyState === 1 && !ws.roomName) {
      ws.send(msg);
    }
  });
}

function broadcastRoomState(roomName) {
  const room = rooms.get(roomName);
  if (!room) return;
  const players = Array.from(room.players.entries()).map(([ws, p]) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    carType: p.carType,
    ready: p.ready,
    isHost: ws === room.host
  }));
  const msg = JSON.stringify({ type: 'roomState', room: roomName, players, racing: room.racing || false, map: room.map || 0 });
  room.players.forEach((_, ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
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
        // 离开旧房间
        if (ws.roomName) leaveRoom(ws);
        const playerId = 'p' + Math.random().toString(36).slice(2, 8);
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
            x: 0, y: 0, angle: 0, speed: 0
          }]])
        });
        ws.roomName = name;
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
            count: r.players.size,
            max: 8,
            host: r.host ? r.host.playerName : '',
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
        if (room.players.size >= 8) { ws.send(JSON.stringify({ type: 'error', msg: '房间已满(8人)' })); return; }
        if (room.racing) { ws.send(JSON.stringify({ type: 'error', msg: '比赛进行中，无法加入' })); return; }
        if (ws.roomName) leaveRoom(ws);
        const playerId = 'p' + Math.random().toString(36).slice(2, 8);
        room.players.set(ws, {
          id: playerId,
          name: msg.playerName || ws.playerName,
          color: msg.color || '#3b82f6',
          carType: msg.carType || 0,
          ready: false,
          x: 0, y: 0, angle: 0, speed: 0
        });
        ws.roomName = name;
        ws.send(JSON.stringify({ type: 'roomJoined', room: name, playerId }));
        broadcastRoomState(name);
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
        const msg2 = JSON.stringify({ type: 'raceStart', map: room.map || 0 });
        room.players.forEach((_, client) => {
          if (client.readyState === 1) client.send(msg2);
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
        // 广播给房间内其他玩家
        const posMsg = JSON.stringify({
          type: 'position',
          id: p.id,
          name: p.name,
          color: p.color,
          x: p.x, y: p.y, angle: p.angle, speed: p.speed
        });
        room.players.forEach((_, client) => {
          if (client !== ws && client.readyState === 1) client.send(posMsg);
        });
        break;
      }

      case 'finishRace': {
        const room = ws.roomName ? rooms.get(ws.roomName) : null;
        if (!room) return;
        // 通知房间内所有人某玩家完赛
        const finishMsg = JSON.stringify({
          type: 'playerFinished',
          id: msg.id,
          time: msg.time
        });
        room.players.forEach((_, client) => {
          if (client.readyState === 1) client.send(finishMsg);
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
  if (room.players.size === 0) {
    rooms.delete(roomName);
  } else {
    // 如果房主离开，选新房主
    if (room.host === ws) {
      const newHost = room.players.keys().next().value;
      room.host = newHost;
    }
    broadcastRoomState(roomName);
  }
  ws.roomName = null;
}

server.listen(PORT, () => {
  console.log(`Racing WebSocket server running on port ${PORT}`);
});
