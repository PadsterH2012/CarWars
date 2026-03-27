import { WebSocket } from 'ws';
import type { ServerMessage } from '@carwars/shared';
import { createTurnEngine, TurnEngine } from '../rules/engine';

const TICK_MS = 100;

export class ZoneRunner {
  private engine: TurnEngine;
  private clients = new Set<WebSocket>();
  private interval: ReturnType<typeof setInterval> | null = null;
  readonly zoneId: string;

  constructor(zoneId: string, zoneType: import('@carwars/shared').ZoneType = 'arena') {
    this.zoneId = zoneId;
    this.engine = createTurnEngine({ id: zoneId, type: zoneType, tick: 0, vehicles: [] });
  }

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    if (!this.interval) this.start();
    // Send current state immediately on join
    const msg: ServerMessage = { type: 'zone_state', state: this.engine.getState() };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  removeClient(ws: WebSocket): void {
    this.clients.delete(ws);
    if (this.clients.size === 0) this.stop();
  }

  isEmpty(): boolean {
    return this.clients.size === 0;
  }

  queueInput(vehicleId: string, input: { speed: number; steer: number; fireWeapon: string | null }): void {
    this.engine.queueInput(vehicleId, input);
  }

  getEngine(): TurnEngine {
    return this.engine;
  }

  private start(): void {
    this.interval = setInterval(() => this.tick(), TICK_MS);
  }

  private stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private tick(): void {
    const state = this.engine.resolveTick();
    const msg: ServerMessage = { type: 'zone_state', state };
    const data = JSON.stringify(msg);
    this.clients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      } else {
        // Clean up stale connections
        this.clients.delete(ws);
      }
    });
    if (this.clients.size === 0) this.stop();
  }
}
