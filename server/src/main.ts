import http from 'http';
import { createApp } from './app';
import { attachWss } from './ws/handler';

const app = createApp();
const server = http.createServer(app);
attachWss(server);

server.listen(3001, '0.0.0.0', () => console.log('Server running on 0.0.0.0:3001'));
