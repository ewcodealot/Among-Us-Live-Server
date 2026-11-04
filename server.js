const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:80", // Replace with your frontend URL
    methods: ["GET", "POST"]
  }
});

// 1. Serve all static files from frontend folder
app.use(express.static(path.join(__dirname, '../Among-Us-Live-Mobile-System')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../Among-Us-Live-Mobile-System', 'index.html'));
});

// 3. Socket.io Real-time Communication
const activeGames = {};

function shuffle(array) {
    return array.sort(() => Math.random() - 0.5);
}

function getConnectedPlayers(game) {
    return game.players.filter(player => player.connected);
}

function getPlayerList(game) {
    return getConnectedPlayers(game).map(({ id, name }) => ({ id, name }));
}

function broadcastGameUpdate(roomCode, message) {
    io.to(roomCode).emit('game:update', { message });
}

io.on('connection', (socket) => {

    // Host creates game
    socket.on('host:create_game', ({ roomCode, config }) => {
        activeGames[roomCode] = {
            hostId: socket.id,
            config: config,
            players: [],
            status: 'lobby'
        };

        socket.join(roomCode);
        socket.emit('game_created_success', { roomCode });
        broadcastGameUpdate(roomCode, 'Game created');
        console.log(`Game created: ${roomCode}`);
    });

    // Player joins game
    socket.on('player:join_game', (data) => {
        const roomCode = typeof data?.roomCode === 'string' ? data.roomCode.trim().toUpperCase() : '';
        const playerName = typeof data?.playerName === 'string' ? data.playerName.trim() : '';

        if (!roomCode || !playerName) {
            socket.emit('error_message', 'Please enter a name and room code!');
            return;
        }

        const game = activeGames[roomCode];

        if (!game) {
            socket.emit('error_message', 'Room code not found!');
            return;
        }

        let player = game.players.find(existingPlayer =>
            existingPlayer.name.toLowerCase() === playerName.toLowerCase()
        );

        if (player?.connected) {
            socket.emit('error_message', 'A player with that name is already connected!');
            return;
        }

        if (!player) {
            player = { name: playerName, role: null, tasks: null };
            game.players.push(player);
        }

        player.id = socket.id;
        player.connected = true;
        socket.join(roomCode);

        // Tell player they joined successfully
        socket.emit('join_success', { roomCode });

        // Send updated player list to EVERYONE in the room (including host)
        io.to(roomCode).emit('update_player_list', getPlayerList(game));
        broadcastGameUpdate(roomCode, `${player.name} joined`);

        if (game.status === 'playing' && player.role && player.tasks) {
            socket.emit('game_started', {
                role: player.role,
                tasks: player.tasks
            });
        }

        console.log(`${player.name} joined room ${roomCode}`);
    });

    socket.on('disconnect', () => {
        for (const code in activeGames) {
            const game = activeGames[code];
            const player = game.players.find(existingPlayer => existingPlayer.id === socket.id);
            if (player) {
                const playerName = player.name;
                player.connected = false;
                player.id = null;
                io.to(code).emit('update_player_list', getPlayerList(game));
                broadcastGameUpdate(code, `${playerName} disconnected`);
                break;
            }
        }
    });

    socket.on('host:start_game', ({ roomCode }) => {
        const game = activeGames[roomCode];
        if (!game) return;

        const players = getConnectedPlayers(game);
        const settings = game.config.gameSettings;
        const allTasks = game.config.tasks;

        // 1. Shuffle players and determine how many impostors to assign
        const shuffledPlayers = shuffle([...players]);
        const impostorCount = Math.max(0, Math.min(settings.impostorCount, shuffledPlayers.length - 1));

        socket.emit('host:started_game', { roomCode });

        // 2. Assign roles and tasks to each player individually
        shuffledPlayers.forEach((player, index) => {
            const isImpostor = index < impostorCount;
            
            let assignedTasks = [];
            // Give each crewmate a randomized subset of 3 tasks from the config file
            assignedTasks = shuffle([...allTasks]).slice(0, 5);

            player.role = isImpostor ? 'Impostor' : 'Crewmate';
            player.tasks = assignedTasks;

            // Send private role and task data directly to that specific player's socket
            io.to(player.id).emit('game_started', {
                role: player.role,
                tasks: assignedTasks
            });
        });

        // 3. Update game status and notify host
        game.status = 'playing';
        io.to(roomCode).emit('host_game_started');
        broadcastGameUpdate(roomCode, 'Game started');
        console.log(`Game started in room ${roomCode} with ${impostorCount} impostors.`);
    });

    socket.on('task:completed', (data) => {
        const taskId = data?.taskId;
        const gameEntry = Object.entries(activeGames).find(([, game]) =>
            game.players.some(player => player.id === socket.id)
        );
        if (!gameEntry) return;
        const [roomCode, game] = gameEntry;

        const player = game.players.find(p => p.id === socket.id);
        if (!player || !Array.isArray(player.tasks)) return;

        const task = player.tasks.find(t => t.id === taskId);
        if (!task || task.completed) return;

        task.completed = true;
        console.log(`${player.name} completed task ${task.title}`);
        broadcastGameUpdate(roomCode, `${player.name} completed ${task.title}`);

        const allTasksCompleted = player.tasks.every(t => t.completed);
        if (allTasksCompleted) {
            io.to(player.id).emit('all_tasks_completed');
        }
    });
});

// 4. Start the server on port 3000
const PORT = 80;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Game server running at http://localhost:${PORT}`);
});