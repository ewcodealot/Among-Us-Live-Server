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

// 1. Serve all static files from your current directory (or a specific frontend folder)
// This tells Express to serve index.html, style.css, and your folders (Host, Player, Setup, System)
app.use(express.static(path.join(__dirname, '../Among-Us-Live-Mobile-System')));
// 2. Optional: Explicit route for the root URL to ensure index.html loads
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../Among-Us-Live-Mobile-System', 'index.html'));
});

// 3. Socket.io Real-time Communication
const activeGames = {};

function shuffle(array) {
    return array.sort(() => Math.random() - 0.5);
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
        console.log(`Game created: ${roomCode}`);
    });

    // Player joins game
    socket.on('player:join_game', ({ roomCode, playerName }) => {
        const game = activeGames[roomCode];

        if (!game) {
            socket.emit('error_message', 'Room code not found!');
            return;
        }

        // Add player to memory
        const newPlayer = { id: socket.id, name: playerName };
        game.players.push(newPlayer);
        socket.join(roomCode);

        // Tell player they joined successfully
        socket.emit('join_success', { roomCode });

        // Send updated player list to EVERYONE in the room (including host)
        io.to(roomCode).emit('update_player_list', game.players);
        console.log(`${playerName} joined room ${roomCode}`);
    });

    socket.on('disconnect', () => {
        // Simple cleanup: remove players from active rooms on disconnect
        for (const code in activeGames) {
            const game = activeGames[code];
            const index = game.players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                game.players.splice(index, 1);
                io.to(code).emit('update_player_list', game.players);
                break;
            }
        }
    });

    socket.on('host:start_game', ({ roomCode }) => {
        const game = activeGames[roomCode];
        if (!game) return;

        const players = game.players;
        const settings = game.config.gameSettings;
        const allTasks = game.config.tasks;

        // 1. Shuffle players and determine how many impostors to assign
        const shuffledPlayers = shuffle([...players]);
        const impostorCount = Math.min(settings.impostorCount, shuffledPlayers.length - 1);

        // 2. Assign roles and tasks to each player individually
        shuffledPlayers.forEach((player, index) => {
            const isImpostor = index < impostorCount;
            
            let assignedTasks = [];
            if (!isImpostor) {
                // Give each crewmate a randomized subset of 3 tasks from the config file
                assignedTasks = shuffle([...allTasks]).slice(0, 3);
            }

            // Send private role and task data directly to that specific player's socket
            io.to(player.id).emit('game_started', {
                role: isImpostor ? 'Impostor' : 'Crewmate',
                tasks: assignedTasks
            });
        });

        // 3. Update game status and notify host
        game.status = 'playing';
        io.to(roomCode).emit('host_game_started');
        console.log(`Game started in room ${roomCode} with ${impostorCount} impostors.`);
    });
});

// 4. Start the server on port 3000
const PORT = 80;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Game server running at http://localhost:${PORT}`);
});