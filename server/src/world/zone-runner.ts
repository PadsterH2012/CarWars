import { WebSocket } from 'ws';
import type { ServerMessage } from '@carwars/shared';
import { createTurnEngine, TurnEngine } from '../rules/engine';
import { computeAiInput } from '../ai/driver';

const TICK_MS = 100;

export interface ZoneRunnerOptions {
  onEnd?: (winnerId: string | null) => void;
}

export class ZoneRunner {
  private engine: TurnEngine;
  private clients = new Set<WebSocket>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private humanInputThisTick = new Set<string>();
  private ended = false;
  // Vehicle IDs owned by human clients — never receive AI input unless autopilot is on
  private humanVehicles = new Set<string>();
  // Vehicles where the human has opted into AI autopilot
  private autopilotVehicles = new Set<string>();

  hasEnded(): boolean { return this.ended; }
  readonly zoneId: string;
  private onEnd?: (winnerId: string | null) => void;

  constructor(zoneId: string, zoneType: import('@carwars/shared').ZoneType = 'arena', options: ZoneRunnerOptions = {}) {
    this.zoneId = zoneId;
    this.onEnd = options.onEnd;
    this.engine = createTurnEngine({ id: zoneId, type: zoneType, tick: 0, vehicles: [], hazardObjects: [] });
  }

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    if (!this.interval) this.start();
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

  registerHumanVehicle(vehicleId: string): void {
    this.humanVehicles.add(vehicleId);
  }

  setAutopilot(vehicleId: string, enabled: boolean): void {
    if (enabled) this.autopilotVehicles.add(vehicleId);
    else this.autopilotVehicles.delete(vehicleId);
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

  private checkEndCondition(state: import('@carwars/shared').ZoneState): void {
    if (this.ended) return;
    if (state.type !== 'arena') return;

    const allVehicles = state.vehicles;
    const alive = allVehicles.filter(v => !v.stats.damageState.destroyed);

    // Need at least 2 vehicles to have been added and at least one destroyed
    if (allVehicles.length < 2) return;
    if (alive.length === allVehicles.length) return;

    // Group surviving vehicles by playerId
    const survivorsByPlayer = new Map<string, string[]>();
    alive.forEach(v => {
      if (!survivorsByPlayer.has(v.playerId)) survivorsByPlayer.set(v.playerId, []);
      survivorsByPlayer.get(v.playerId)!.push(v.id);
    });

    if (survivorsByPlayer.size > 1) return; // battle still ongoing

    this.ended = true;
    const winnerPlayerId = survivorsByPlayer.size === 1 ? [...survivorsByPlayer.keys()][0] : null;
    // AI win counts as null (no human prize)
    const humanWinnerId = winnerPlayerId === 'ai-team' ? null : winnerPlayerId;

    const endMsg: ServerMessage = {
      type: 'zone_end',
      winnerId: humanWinnerId,
      reason: winnerPlayerId === null
        ? 'all_destroyed'
        : winnerPlayerId === 'ai-team'
        ? 'ai_victory'
        : 'last_standing',
    };
    const data = JSON.stringify(endMsg);
    this.clients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    this.onEnd?.(humanWinnerId);
    this.stop();
  }

  private tick(): void {
    const state = this.engine.getState();
    state.vehicles.forEach(vehicle => {
      const isHuman = this.humanVehicles.has(vehicle.id);
      const hasAutopilot = this.autopilotVehicles.has(vehicle.id);
      const needsAi = !isHuman || hasAutopilot;
      if (needsAi && !this.humanInputThisTick.has(vehicle.id)) {
        const enemies = state.vehicles.filter(v => v.playerId !== vehicle.playerId);
        const aiInput = computeAiInput(vehicle, enemies, 3);
        this.engine.queueInput(vehicle.id, aiInput);
      }
    });
    this.humanInputThisTick.clear();

    const newState = this.engine.resolveTick();
    this.checkEndCondition(newState);

    const msg: ServerMessage = { type: 'zone_state', state: newState };
    const data = JSON.stringify(msg);
    this.clients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      } else {
        this.clients.delete(ws);
      }
    });
    if (this.clients.size === 0) this.stop();
  }
}
