import { WebSocket } from 'ws';
import type { ServerMessage } from '@carwars/shared';
import { createTurnEngine, TurnEngine } from '../rules/engine';
import { computeAiInput } from '../ai/driver';

const TICK_MS = 100;

export class ZoneRunner {
  private engine: TurnEngine;
  private clients = new Set<WebSocket>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private humanInputThisTick = new Set<string>();
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

  shutdown(): void {
    this.stop();
    this.clients.clear();
  }

  queueInput(vehicleId: string, input: { speed: number; steer: number; fireWeapon: string | null }): void {
    this.humanInputThisTick.add(vehicleId);
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
    // Run AI only for vehicles with no human input this tick
    const state = this.engine.getState();
    state.vehicles.forEach(vehicle => {
      if (!this.humanInputThisTick.has(vehicle.id)) {
        const enemies = state.vehicles.filter(v => v.playerId !== vehicle.playerId);
        const aiInput = computeAiInput(vehicle, enemies, 3);
        this.engine.queueInput(vehicle.id, aiInput);
      }
    });
    this.humanInputThisTick.clear();

    const newState = this.engine.resolveTick();
    const msg: ServerMessage = { type: 'zone_state', state: newState };
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
