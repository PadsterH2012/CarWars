import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import cors from 'cors';

const app = express();
app.use(cors({ origin: 'http://localhost:3000' }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.get('/health', (_req, res) => res.json({ ok: true }));

wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.on('message', (data) => console.log('Message:', data.toString()));
});

server.listen(3001, () => console.log('Server running on :3001'));
