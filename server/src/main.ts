import express from 'express';
import cors from 'cors';
import http from 'http';
import { attachWss } from './ws/handler';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
attachWss(server);

server.listen(3001, () => console.log('Server running on :3001'));
