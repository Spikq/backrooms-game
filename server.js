const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const rooms = new Map();

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

function broadcast(room, message, excludeId = null) {
    room.players.forEach((player, id) => {
        if (id !== excludeId && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(message));
        }
    });
}

function broadcastAll(room, message) {
    room.players.forEach((player) => {
        if (player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(message));
        }
    });
}

function createRoom(code) {
    // Генерируем рычаги в рандомных комнатах (индексы 0-19)
    const leverRooms = [];
    while (leverRooms.length < 3) {
        const idx = Math.floor(Math.random() * 20);
        if (!leverRooms.includes(idx)) leverRooms.push(idx);
    }

    return {
        code,
        players: new Map(),
        state: {
            phase: 'explore',   // explore → monster → done
            levers: [false, false, false],
            leverRooms,
            monsterPos: null,
            monsterActive: false,
            garageDoorOpen: false,
            survivedPlayers: [],
            deadPlayers: [],
        },
        monsterInterval: null,
        nextPlayerId: 1,
    };
}

wss.on('connection', (ws) => {
    let playerId = null;
    let roomCode = null;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        // CREATE ROOM
        if (msg.type === 'create_room') {
            let code;
            do { code = generateRoomCode(); } while (rooms.has(code));

            const room = createRoom(code);
            playerId = room.nextPlayerId++;
            roomCode = code;

            room.players.set(playerId, {
                ws,
                id: playerId,
                name: msg.name || `Игрок ${playerId}`,
                pos: { x: 0, y: 1.7, z: 0 },
                rot: 0,
                alive: true,
                escaped: false,
            });

            rooms.set(code, room);

            ws.send(JSON.stringify({
                type: 'room_created',
                roomCode: code,
                playerId,
                leverRooms: room.state.leverRooms,
            }));

            console.log(`Room ${code} created by player ${playerId}`);
        }

        // JOIN ROOM
        else if (msg.type === 'join_room') {
            const code = msg.roomCode?.toUpperCase();
            const room = rooms.get(code);

            if (!room) {
                ws.send(JSON.stringify({ type: 'error', message: 'Комната не найдена' }));
                return;
            }
            if (room.players.size >= 4) {
                ws.send(JSON.stringify({ type: 'error', message: 'Комната полна (макс. 4)' }));
                return;
            }
            if (room.state.phase !== 'explore') {
                ws.send(JSON.stringify({ type: 'error', message: 'Игра уже началась' }));
                return;
            }

            playerId = room.nextPlayerId++;
            roomCode = code;

            room.players.set(playerId, {
                ws,
                id: playerId,
                name: msg.name || `Игрок ${playerId}`,
                pos: { x: 2, y: 1.7, z: 2 },
                rot: 0,
                alive: true,
                escaped: false,
            });

            // Говорим новому игроку его id и состояние
            ws.send(JSON.stringify({
                type: 'room_joined',
                playerId,
                roomCode: code,
                leverRooms: room.state.leverRooms,
                levers: room.state.levers,
                players: [...room.players.entries()].map(([id, p]) => ({
                    id, name: p.name, pos: p.pos, rot: p.rot
                })),
            }));

            // Всем остальным — новый игрок
            broadcast(room, {
                type: 'player_joined',
                player: { id: playerId, name: room.players.get(playerId).name, pos: { x:2,y:1.7,z:2 }, rot: 0 }
            }, playerId);

            console.log(`Player ${playerId} joined room ${code}`);
        }

        // POSITION UPDATE
        else if (msg.type === 'move') {
            const room = rooms.get(roomCode);
            if (!room) return;
            const player = room.players.get(playerId);
            if (!player || !player.alive) return;

            player.pos = msg.pos;
            player.rot = msg.rot;

            broadcast(room, {
                type: 'player_moved',
                id: playerId,
                pos: msg.pos,
                rot: msg.rot,
            }, playerId);
        }

        // PULL LEVER
        else if (msg.type === 'pull_lever') {
            const room = rooms.get(roomCode);
            if (!room || room.state.phase !== 'explore') return;

            const idx = msg.leverIndex;
            if (idx < 0 || idx > 2 || room.state.levers[idx]) return;

            room.state.levers[idx] = true;
            const pulledCount = room.state.levers.filter(Boolean).length;

            broadcastAll(room, {
                type: 'lever_pulled',
                leverIndex: idx,
                pulledCount,
                pulledBy: playerId,
            });

            console.log(`Room ${roomCode}: lever ${idx} pulled (${pulledCount}/3)`);

            // Все 3 рычага — открываем гаражную дверь и спавним монстра
            if (pulledCount === 3) {
                room.state.phase = 'monster';
                room.state.garageDoorOpen = true;

                // Монстр спавнится в конце коридора
                room.state.monsterPos = { x: 0, z: 0 };
                room.state.monsterActive = true;

                broadcastAll(room, { type: 'garage_open' });

                setTimeout(() => {
                    broadcastAll(room, { type: 'monster_spawned' });
                    startMonster(room);
                }, 1500);
            }
        }

        // PLAYER ESCAPED
        else if (msg.type === 'escaped') {
            const room = rooms.get(roomCode);
            if (!room) return;
            const player = room.players.get(playerId);
            if (!player) return;

            player.escaped = true;
            room.state.survivedPlayers.push(playerId);

            broadcastAll(room, {
                type: 'player_escaped',
                id: playerId,
                name: player.name,
            });

            checkRoomEnd(room);
        }

        // PLAYER CAUGHT
        else if (msg.type === 'caught') {
            const room = rooms.get(roomCode);
            if (!room) return;
            const player = room.players.get(playerId);
            if (!player) return;

            player.alive = false;
            player.escaped = false;
            room.state.deadPlayers.push(playerId);

            broadcastAll(room, {
                type: 'player_caught',
                id: playerId,
                name: player.name,
            });

            checkRoomEnd(room);
        }

        // PING
        else if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
        }
    });

    ws.on('close', () => {
        if (!roomCode || !playerId) return;
        const room = rooms.get(roomCode);
        if (!room) return;

        room.players.delete(playerId);
        broadcast(room, { type: 'player_left', id: playerId });

        if (room.players.size === 0) {
            if (room.monsterInterval) clearInterval(room.monsterInterval);
            rooms.delete(roomCode);
            console.log(`Room ${roomCode} deleted (empty)`);
        }
    });
});

function startMonster(room) {
    // Каждые 100мс двигаем монстра к ближайшему живому игроку
    room.monsterInterval = setInterval(() => {
        if (!room.state.monsterActive) { clearInterval(room.monsterInterval); return; }

        let closestDist = Infinity;
        let closestPlayer = null;

        room.players.forEach(player => {
            if (!player.alive || player.escaped) return;
            const dx = player.pos.x - room.state.monsterPos.x;
            const dz = player.pos.z - room.state.monsterPos.z;
            const dist = Math.sqrt(dx*dx + dz*dz);
            if (dist < closestDist) { closestDist = dist; closestPlayer = player; }
        });

        if (!closestPlayer) { clearInterval(room.monsterInterval); return; }

        const speed = 0.5; // метров за тик (100мс = 5 м/с)
        const dx = closestPlayer.pos.x - room.state.monsterPos.x;
        const dz = closestPlayer.pos.z - room.state.monsterPos.z;
        const dist = Math.sqrt(dx*dx + dz*dz);

        if (dist > 0.1) {
            room.state.monsterPos.x += (dx / dist) * speed;
            room.state.monsterPos.z += (dz / dist) * speed;
        }

        broadcastAll(room, {
            type: 'monster_pos',
            pos: room.state.monsterPos,
        });

    }, 100);
}

function checkRoomEnd(room) {
    const allPlayers = [...room.players.values()];
    const allDone = allPlayers.every(p => p.escaped || !p.alive);
    if (!allDone) return;

    room.state.monsterActive = false;
    if (room.monsterInterval) clearInterval(room.monsterInterval);

    broadcastAll(room, {
        type: 'game_over',
        survived: room.state.survivedPlayers,
        dead: room.state.deadPlayers,
    });

    // Чистим комнату через 30 сек
    setTimeout(() => {
        rooms.delete(room.code);
        console.log(`Room ${room.code} cleaned up`);
    }, 30000);
}

console.log(`Backrooms server running on port ${PORT}`);
