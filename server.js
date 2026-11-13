const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const {
    isValidPlayerColor,
    randomPlayerColor
} = require(path.join(__dirname, '../Among-Us-Live-Mobile-System/System/player-colors.js'));

const frontendPath = path.join(__dirname, '../Among-Us-Live-Mobile-System');
const defaultConfig = require(path.join(frontendPath, 'System', 'defaultconfig.json'));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:80", // Replace with your frontend URL
    methods: ["GET", "POST"]
  }
});

// 1. Serve all static files from frontend folder
app.use(express.static(frontendPath));
app.get('/', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
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
    return getConnectedPlayers(game).map(({ id, name, color }) => ({ id, name, color }));
}

function getGamePlayerState(game, viewer) {
    return game.players.map(({ id, name, color, dead, connected }) => ({
        id: id ?? null,
        name,
        color,
        dead: dead === true,
        connected: connected === true,
        canBeKilled: viewer.role === 'Impostor' &&
            game.players.find(player => player.id === id)?.role === 'Crewmate' &&
            dead !== true
    }));
}

function sendPlayerState(game, viewer) {
    io.to(viewer.id).emit('players:state', {
        playerId: viewer.id,
        players: getGamePlayerState(game, viewer)
    });
}

function sendPlayerStates(game) {
    getConnectedPlayers(game).forEach(player => sendPlayerState(game, player));
}

function getVotingResults(game) {
    const players = game.players.map(player => ({
        name: player.name,
        votes: game.votes.filter(vote => vote.targetName === player.name).length
    }));
    const skipVotes = game.votes.filter(vote => vote.targetName === null).length;
    const maxVotes = Math.max(0, ...players.map(player => player.votes));
    const tiedPlayers = players.filter(player => maxVotes > 0 && player.votes === maxVotes);
    const skipTied = maxVotes > 0 && skipVotes === maxVotes;
    const tied = tiedPlayers.length > 1 || (tiedPlayers.length === 1 && skipTied);
    const eliminated = !tied && tiedPlayers.length === 1 && tiedPlayers[0].votes > skipVotes
        ? game.players.find(player => player.name === tiedPlayers[0].name)
        : null;

    return {
        players: players.map(player => ({
            ...player,
            tied: tied && player.votes === maxVotes
        })),
        skipVotes,
        maxVotes,
        skipTied,
        tied,
        eliminatedName: eliminated?.name ?? null
    };
}

function reportDeathsAtMeeting(game) {
    if (game.pendingDeaths.length === 0) return;

    io.to(game.hostId).emit('game:update', {
        message: `Died before the meeting: ${game.pendingDeaths.join(', ')}`
    });
    game.pendingDeaths = [];
}

function broadcastGameUpdate(roomCode, message) {
    io.to(roomCode).emit('game:update', { message });
}

function isValidGameConfig(config) {
    return config &&
        typeof config === 'object' &&
        config.gameSettings &&
        Number.isInteger(config.gameSettings.impostorCount) &&
        config.gameSettings.impostorCount >= 0 &&
        Array.isArray(config.tasks) &&
        config.tasks.every(task =>
            task && typeof task.id === 'string' &&
            typeof task.title === 'string' &&
            typeof task.description === 'string' &&
            typeof task.hint === 'string'
        ) &&
        Array.isArray(config.sabotages) &&
        config.sabotages.every(sabotage =>
            sabotage && typeof sabotage.id === 'string' &&
            typeof sabotage.title === 'string' &&
            typeof sabotage.description === 'string'
        );
}

io.on('connection', (socket) => {

    // Host creates game
    socket.on('host:create_game', (data = {}) => {
        const roomCode = typeof data.roomCode === 'string' ? data.roomCode.trim().toUpperCase() : '';
        const config = data.config ?? defaultConfig;

        if (!roomCode) {
            socket.emit('error_message', 'Please enter a room code.');
            return;
        }
        if (activeGames[roomCode]) {
            socket.emit('error_message', 'That room code is already in use.');
            return;
        }
        if (!isValidGameConfig(config)) {
            socket.emit('error_message', 'Invalid game configuration. Check the settings, tasks, and sabotages.');
            return;
        }

        activeGames[roomCode] = {
            hostId: socket.id,
            config,
            players: [],
            status: 'lobby',
            meetingActive: false,
            votingActive: false,
            resultsActive: false,
            votes: [],
            voteResults: null,
            resultsStartedAt: 0,
            resultsReadyAt: 0,
            ejectedPlayer: null,
            meetingType: null,
            meetingReporter: null,
            meetingBodyName: null,
            taskTotal: 0,
            tasksDone: 0,
            pendingDeaths: [],
            activeSabotage: null
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
        const requestedColor = isValidPlayerColor(data?.playerColor) ? data.playerColor : null;

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
            player = {
                name: playerName,
                color: requestedColor || randomPlayerColor(),
                role: null,
                tasks: null,
                dead: false
            };
            game.players.push(player);
        } else if (!isValidPlayerColor(player.color)) {
            player.color = requestedColor || randomPlayerColor();
        }

        player.id = socket.id;
        player.connected = true;
        player.dead = player.dead === true;
        socket.join(roomCode);

        // Tell player they joined successfully
        socket.emit('join_success', { roomCode, color: player.color, status: game.status });

        // Send updated player list to EVERYONE in the room (including host)
        io.to(roomCode).emit('update_player_list', getPlayerList(game));
        broadcastGameUpdate(roomCode, `${player.name} joined`);
        if (game.status === 'playing' && player.role && player.tasks) {
            socket.emit('game_started', {
                role: player.role,
                team: player.team,
                tasks: player.tasks,
                sabotages: game.config.sabotages
            });
            sendPlayerState(game, player);
            if (player.votedOut) {
                socket.emit('player:voted_out', { role: player.team });
            }
        }
        socket.emit('meeting:state', {
            active: game.meetingActive,
            phase: game.meetingActive
                ? 'meeting'
                : game.votingActive
                    ? 'voting'
                    : game.resultsActive
                        ? 'results'
                        : 'none',
            type: game.meetingType,
            reporterName: game.meetingReporter,
            bodyName: game.meetingBodyName
        });
        if (game.votingActive) {
            const playerVote = game.votes.find(vote => vote.voterName === player.name);
            socket.emit('player:vote_status', {
                hasVoted: Boolean(playerVote),
                votedFor: playerVote
                    ? playerVote.targetName === null
                        ? 'skip'
                        : game.players.find(target => target.name === playerVote.targetName)?.id ?? null
                    : null
            });
        } else if (game.resultsActive && game.voteResults) {
            socket.emit('voting:results', {
                ...game.voteResults,
                revealElapsedMs: Date.now() - game.resultsStartedAt
            });
        }

        console.log(`${player.name} joined room ${roomCode}`);
    });

    socket.on('player:update_color', (data) => {
        const color = data?.color;
        if (!isValidPlayerColor(color)) {
            socket.emit('error_message', 'Please select a valid, darker player color.');
            return;
        }

        const gameEntry = Object.entries(activeGames).find(([, game]) =>
            game.players.some(player => player.id === socket.id)
        );
        if (!gameEntry) return;

        const [roomCode, game] = gameEntry;
        const player = game.players.find(existingPlayer => existingPlayer.id === socket.id);
        if (!player || game.status !== 'lobby') return;

        player.color = color;
        io.to(roomCode).emit('update_player_list', getPlayerList(game));
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
        if (!game || game.hostId !== socket.id || game.status !== 'lobby') return;

        const players = getConnectedPlayers(game);
        const settings = game.config.gameSettings;
        const allTasks = game.config.tasks;

        game.taskTotal = 0;
        game.tasksDone = 0;
        game.meetingActive = false;
        game.votingActive = false;
        game.resultsActive = false;
        game.votes = [];
        game.voteResults = null;
        game.resultsStartedAt = 0;
        game.resultsReadyAt = 0;
        game.ejectedPlayer = null;
        game.meetingType = null;
        game.meetingReporter = null;
        game.meetingBodyName = null;
        game.pendingDeaths = [];
        game.activeSabotage = null;

        // 1. Shuffle players and determine how many impostors to assign
        const shuffledPlayers = shuffle([...players]);
        const impostorCount = Math.max(0, Math.min(settings.impostorCount, shuffledPlayers.length - 1));

        socket.emit('host:started_game', { roomCode });

        // 2. Assign roles and tasks to each player individually
        shuffledPlayers.forEach((player, index) => {
            const isImpostor = index < impostorCount;
            
            const assignedTasks = shuffle(allTasks.map(task => ({ ...task, completed: false }))).slice(0, 5);

            player.role = isImpostor ? 'Impostor' : 'Crewmate';
            player.team = player.role;
            player.tasks = assignedTasks;
            player.dead = false;
            player.votedOut = false;
            player.bodyReported = false;
            if (!isImpostor) {
                game.taskTotal += assignedTasks.length;
            }

            // Send private role and task data directly to that specific player's socket
            io.to(player.id).emit('game_started', {
                role: player.role,
                team: player.team,
                tasks: assignedTasks,
                sabotages: game.config.sabotages
            });
        });

        // 3. Update game status and notify host
        game.status = 'playing';
        sendPlayerStates(game);
        io.to(roomCode).emit('host_game_started');
        io.to(roomCode).emit('meeting:state', { active: false, phase: 'none' });
        io.to(roomCode).emit('sabotage:state', { active: false });
        broadcastGameUpdate(roomCode, 'Game started');
        console.log(`Game started in room ${roomCode} with ${impostorCount} impostors.`);
    });

    socket.on('player:emergency_meeting', () => {
        const gameEntry = Object.entries(activeGames).find(([, game]) =>
            game.players.some(player => player.id === socket.id)
        );
        if (!gameEntry) return;

        const [roomCode, game] = gameEntry;
        const player = game.players.find(existingPlayer => existingPlayer.id === socket.id);
        if (!player || player.dead) return;
        if (game.status !== 'playing' || game.meetingActive || game.votingActive || game.resultsActive) return;

        game.meetingActive = true;
        game.votingActive = false;
        game.resultsActive = false;
        game.votes = [];
        game.voteResults = null;
        game.resultsStartedAt = 0;
        game.resultsReadyAt = 0;
        game.ejectedPlayer = null;
        game.meetingType = 'emergency';
        game.meetingReporter = null;
        game.meetingBodyName = null;
        io.to(roomCode).emit('meeting:state', {
            active: true,
            phase: 'meeting',
            type: game.meetingType
        });
        sendPlayerStates(game);
        broadcastGameUpdate(roomCode, 'Emergency meeting called');
        reportDeathsAtMeeting(game);
    });

    socket.on('host:meeting_toggle', ({ roomCode }) => {
        const game = activeGames[roomCode];
        if (!game || game.hostId !== socket.id || game.status !== 'playing') return;

        if (game.meetingActive) {
            game.meetingActive = false;
            game.votingActive = true;
            game.votes = [];
            game.voteResults = null;
            game.resultsStartedAt = 0;
            game.resultsReadyAt = 0;
            game.ejectedPlayer = null;
        } else if (game.votingActive) {
            game.votingActive = false;
            game.resultsActive = true;
            game.resultsStartedAt = Date.now();
            game.voteResults = {
                ...getVotingResults(game),
                revealElapsedMs: 0,
                revealIntervalMs: 2000
            };
            game.ejectedPlayer = game.voteResults.eliminatedName
                ? game.players.find(player => player.name === game.voteResults.eliminatedName)
                : null;
            if (game.ejectedPlayer) {
                game.ejectedPlayer.dead = true;
                game.ejectedPlayer.role = 'Dead';
            }
            game.resultsReadyAt = game.resultsStartedAt +
                Math.max(0, game.voteResults.players.length) * game.voteResults.revealIntervalMs;
        } else if (game.resultsActive) {
            if (Date.now() < game.resultsReadyAt) return;

            const ejectedPlayer = game.ejectedPlayer;
            const ejectedRole = ejectedPlayer?.team;
            if (ejectedPlayer) ejectedPlayer.votedOut = true;
            game.resultsActive = false;
            game.voteResults = null;
            game.resultsStartedAt = 0;
            game.resultsReadyAt = 0;
            game.ejectedPlayer = null;
            game.meetingType = null;
            game.meetingReporter = null;
            game.meetingBodyName = null;
            if (ejectedPlayer?.connected && ejectedRole) {
                io.to(ejectedPlayer.id).emit('player:voted_out', { role: ejectedRole });
            }
        } else {
            game.meetingActive = true;
            game.votingActive = false;
            game.resultsActive = false;
            game.votes = [];
            game.voteResults = null;
            game.resultsStartedAt = 0;
            game.resultsReadyAt = 0;
            game.ejectedPlayer = null;
            game.meetingType = 'emergency';
            game.meetingReporter = null;
            game.meetingBodyName = null;
        }
        io.to(roomCode).emit('meeting:state', {
            active: game.meetingActive,
            phase: game.meetingActive
                ? 'meeting'
                : game.votingActive
                    ? 'voting'
                    : game.resultsActive
                        ? 'results'
                        : 'none',
            type: game.meetingType
        });
        if (game.meetingActive) {
            sendPlayerStates(game);
            reportDeathsAtMeeting(game);
        } else if (game.resultsActive) {
            sendPlayerStates(game);
            io.to(roomCode).emit('voting:results', {
                ...game.voteResults,
                revealElapsedMs: 0
            });
        } else if (!game.votingActive) {
            sendPlayerStates(game);
        }
        const updateMessage = game.meetingActive
            ? 'Emergency meeting called by host'
            : game.votingActive
                ? 'Voting started'
                : game.resultsActive
                    ? 'Voting ended; results are being revealed'
                    : 'Voting results cleared';
        broadcastGameUpdate(roomCode, updateMessage);
    });

    socket.on('player:cast_vote', ({ targetId, skip } = {}) => {
        const game = Object.values(activeGames).find(candidate =>
            candidate.players.some(player => player.id === socket.id)
        );
        if (!game) {
            socket.emit('player:vote_result', {
                success: false,
                message: 'You are not in an active game.'
            });
            return;
        }

        const voter = game.players.find(player => player.id === socket.id);
        if (game.status !== 'playing' || !game.votingActive || !voter || voter.dead) {
            socket.emit('player:vote_result', {
                success: false,
                message: 'You cannot vote right now.'
            });
            return;
        }

        if (game.votes.some(vote => vote.voterName === voter.name)) {
            socket.emit('player:vote_result', {
                success: false,
                message: 'You have already voted.'
            });
            return;
        }

        let targetName = null;
        if (skip !== true) {
            const target = game.players.find(player =>
                player.id === targetId && player.connected && !player.dead
            );
            if (!target || target === voter) {
                socket.emit('player:vote_result', {
                    success: false,
                    message: 'That player is not available to vote for.'
                });
                return;
            }
            targetName = target.name;
        }

        game.votes.push({ voterName: voter.name, targetName });
        const votedFor = targetName === null
            ? 'skip'
            : game.players.find(player => player.name === targetName).id;
        socket.emit('player:vote_result', { success: true, votedFor });
        socket.emit('player:vote_status', { hasVoted: true, votedFor });
    });

    socket.on('host:complete_sabotage', ({ roomCode } = {}) => {
        const game = activeGames[roomCode];
        if (!game || game.hostId !== socket.id || game.status !== 'playing' || !game.activeSabotage) return;

        const { title } = game.activeSabotage;
        game.activeSabotage = null;
        io.to(roomCode).emit('sabotage:completed', { title });
        io.to(roomCode).emit('sabotage:state', { active: false });
        broadcastGameUpdate(roomCode, `Sabotage completed: ${title}`);
    });

    socket.on('player:report_body', ({ targetName } = {}) => {
        const gameEntry = Object.entries(activeGames).find(([, game]) =>
            game.players.some(player => player.id === socket.id)
        );
        if (!gameEntry) {
            socket.emit('player:report_result', {
                success: false,
                message: 'You are not in an active game.'
            });
            return;
        }

        const [roomCode, game] = gameEntry;
        const reporter = game.players.find(existingPlayer => existingPlayer.id === socket.id);
        const target = typeof targetName === 'string'
            ? game.players.find(existingPlayer =>
                existingPlayer.name.toLowerCase() === targetName.trim().toLowerCase()
            )
            : null;

        if (game.status !== 'playing' || game.meetingActive || game.votingActive || game.resultsActive ||
            !reporter || reporter.dead) {
            socket.emit('player:report_result', {
                success: false,
                message: 'You cannot report a body right now.'
            });
            return;
        }

        if (!target || target === reporter) {
            socket.emit('player:report_result', {
                success: false,
                message: 'That player is not available to report.'
            });
            return;
        }

        if (!target.dead) {
            socket.emit('player:report_result', {
                success: false,
                message: 'That player is not dead.'
            });
            return;
        }

        if (target.bodyReported) {
            socket.emit('player:report_result', {
                success: false,
                message: 'That body has already been reported.'
            });
            return;
        }

        target.bodyReported = true;
        game.meetingActive = true;
        game.votingActive = false;
        game.resultsActive = false;
        game.votes = [];
        game.voteResults = null;
        game.resultsStartedAt = 0;
        game.resultsReadyAt = 0;
        game.ejectedPlayer = null;
        game.meetingType = 'body_found';
        game.meetingReporter = reporter.name;
        game.meetingBodyName = target.name;
        io.to(roomCode).emit('meeting:state', {
            active: true,
            phase: 'meeting',
            type: game.meetingType,
            reporterName: reporter.name,
            bodyName: target.name
        });
        sendPlayerStates(game);
        broadcastGameUpdate(roomCode, `${reporter.name} found ${target.name}'s body`);
        reportDeathsAtMeeting(game);
        socket.emit('player:report_result', { success: true });
    });

    socket.on('player:kill_player', ({ targetId } = {}) => {
        const gameEntry = Object.entries(activeGames).find(([, game]) =>
            game.players.some(player => player.id === socket.id)
        );
        if (!gameEntry) {
            socket.emit('player:kill_result', {
                success: false,
                message: 'You are not in an active game.'
            });
            return;
        }

        const [, game] = gameEntry;
        const player = game.players.find(existingPlayer => existingPlayer.id === socket.id);
        const target = game.players.find(existingPlayer => existingPlayer.id === targetId);

        if (game.status !== 'playing' || game.meetingActive || game.votingActive || game.resultsActive ||
            !player || player.role !== 'Impostor' || player.dead) {
            socket.emit('player:kill_result', {
                success: false,
                message: 'You cannot kill a player right now.'
            });
            return;
        }

        if (!target || target === player || !target.connected ||
            target.dead || target.role !== 'Crewmate') {
            socket.emit('player:kill_result', {
                success: false,
                message: 'That player is not available to kill.'
            });
            return;
        }

        target.dead = true;
        target.role = 'Dead';
        game.pendingDeaths.push(target.name);
        io.to(target.id).emit('player:died', { team: target.team });
        socket.emit('player:kill_result', { success: true });
    });

    socket.on('player:sabotage', ({ sabotageId } = {}) => {
        const gameEntry = Object.entries(activeGames).find(([, game]) =>
            game.players.some(player => player.id === socket.id)
        );
        if (!gameEntry) {
            socket.emit('player:sabotage_result', {
                success: false,
                message: 'You are not in an active game.'
            });
            return;
        }

        const [roomCode, game] = gameEntry;
        const player = game.players.find(existingPlayer => existingPlayer.id === socket.id);
        const sabotage = game.config.sabotages.find(item => item.id === sabotageId);

        if (game.status !== 'playing' || game.meetingActive || game.votingActive || game.resultsActive ||
            !player || player.team !== 'Impostor') {
            socket.emit('player:sabotage_result', {
                success: false,
                message: 'You cannot trigger a sabotage right now.'
            });
            return;
        }

        if (!sabotage) {
            socket.emit('player:sabotage_result', {
                success: false,
                message: 'That sabotage is not available.'
            });
            return;
        }

        if (game.activeSabotage) {
            socket.emit('player:sabotage_result', {
                success: false,
                message: 'A sabotage is already active.'
            });
            return;
        }

        game.activeSabotage = sabotage;
        io.to(roomCode).emit('sabotage:started', {
            title: sabotage.title,
            description: sabotage.description
        });
        io.to(roomCode).emit('sabotage:state', { active: true, title: sabotage.title });
        broadcastGameUpdate(roomCode, `Sabotage triggered: ${sabotage.title}`);
        socket.emit('player:sabotage_result', { success: true });
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
        if (player.team === 'Crewmate' || player.role === 'Crewmate') {
            game.tasksDone++;
        }
        console.log(`${player.name} completed task ${task.title}`);
        broadcastGameUpdate(roomCode, `${player.name} completed ${task.title}`);

        const allTasksCompleted = player.tasks.every(t => t.completed);
        if (allTasksCompleted) {
            io.to(player.id).emit('all_tasks_completed');
            broadcastGameUpdate(roomCode, `${player.name} completed all tasks`);
        }

        if (player.role === 'Crewmate' && game.taskTotal > 0 && game.tasksDone >= game.taskTotal) {
            io.to(roomCode).emit('crewmate_win');
            broadcastGameUpdate(roomCode, `The Crewmates have won! All tasks have been completed.`);
            endGame(roomCode);
        }
    });
});

function endGame(roomCode) {
    console.log(`Game ended in room ${roomCode}`);
}



// 4. Start the server on port 3000
const PORT = 80;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Game server running at http://localhost:${PORT}`);
});