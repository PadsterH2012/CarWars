import type { ClientMessage, ServerMessage } from '@carwars/shared';

type MessageHandler = (msg: ServerMessage) => void;

export class Connection {
  private ws: WebSocket;
  private handlers: MessageHandler[] = [];
  private openCallbacks: (() => void)[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (evt) => {
      try {
        const msg: ServerMessage = JSON.parse(evt.data as string);
        this.handlers.forEach(h => h(msg));
      } catch {
        console.error('Failed to parse server message');
      }
    };
    this.ws.onopen = () => {
      this.openCallbacks.forEach(cb => cb());
      this.openCallbacks = [];
    };
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  send(msg: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onOpen(cb: () => void): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      cb();
    } else {
      this.openCallbacks.push(cb);
    }
  }
}
