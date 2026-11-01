const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 1. Serve all static files from your current directory (or a specific frontend folder)
// This tells Express to serve index.html, style.css, and your folders (Host, Player, Setup, System)
app.use(express.static(path.join(__dirname, '../Among-Us-Live-Mobile-System')));
// 2. Optional: Explicit route for the root URL to ensure index.html loads
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../Among-Us-Live-Mobile-System', 'index.html'));
});

// 3. Socket.io Real-time Communication
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Listen for custom game events from players or hosts
    socket.on('player_action', (data) => {
        console.log('Received action:', data);
        // Broadcast updates to everyone else or handle game logic here
        io.emit('game_update', data);
    });

    socket.on('disconnect', () => {
        console.log('A user disconnected:', socket.id);
    });
});

// 4. Start the server on port 3000
const PORT = 80;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Game server running at http://localhost:${PORT}`);
});