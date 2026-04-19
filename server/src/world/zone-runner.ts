import { WebSocket } from 'ws';
import type { ServerMessage, ArenaMap, SquadOrder, RivalInfo } from '@carwars/shared';
import { createTurnEngine, TurnEngine } from '../rules/engine';
import { computeAiInput } from '../ai/driver';
import { getMap } from '../rules/maps';
import { totalSalvageFor } from '../rules/salvage';

const TICK_MS = 100;

export interface ZoneRunnerOptions {
  onEnd?: (winnerId: string | null, salvage: number, ctx: { reason: string; rival: RivalInfo | null }) => Promise<{ prize: number; jobPayout: number; salvage: number; wages: number; maintenance: number; rivalQuote?: string }>;
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
  private vehicleSkills = new Map<string, number>(); // vehicleId → driver skill
  private squadOrders = new Map<string, SquadOrder>(); // vehicleId → current order (commander mode)
  private pausedBy: WebSocket | null = null;   // the client that initiated the pause; only they can unpause
  private rival: RivalInfo | null = null;      // rival gang for this match, if set by handler
  private map: ArenaMap;

  hasEnded(): boolean { return this.ended; }
  readonly zoneId: string;
  private onEnd?: (winnerId: string | null, salvage: number, ctx: { reason: string; rival: RivalInfo | null }) => Promise<{ prize: number; jobPayout: number; salvage: number; wages: number; maintenance: number; rivalQuote?: string }>;

  constructor(
    zoneId: string,
    zoneType: import('@carwars/shared').ZoneType = 'arena',
    options: ZoneRunnerOptions = {},
    mapId = 'open'
  ) {
    this.zoneId = zoneId;
    this.onEnd = options.onEnd;
    this.map = getMap(mapId);
    this.engine = createTurnEngine(
      { id: zoneId, type: zoneType, tick: 0, vehicles: [], hazardObjects: [] },
      this.map
    );
  }

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    if (!this.interval) this.start();
    const state = this.engine.getState();
    // Include map metadata only in the initial join message — not broadcast every tick
    const initialState = {
      ...state,
      mapId: this.map.id,
      mapWidth: this.map.width,
      mapHeight: this.map.height,
      walls: this.map.walls,
    };
    const msg: ServerMessage = { type: 'zone_state', state: initialState };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      if (this.rival) {
        const r: ServerMessage = { type: 'rival_info', rival: this.rival };
        ws.send(JSON.stringify(r));
      }
    }
  }

  getMap(): ArenaMap { return this.map; }

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

  setVehicleSkill(vehicleId: string, skill: number): void {
    this.vehicleSkills.set(vehicleId, skill);
  }

  getDriverSkill(vehicleId: string): number {
    return this.vehicleSkills.get(vehicleId) ?? 3;
  }

  queueInput(vehicleId: string, input: { speed: number; steer: number; fireWeapon: string | null }): void {
    this.humanInputThisTick.add(vehicleId);
    this.engine.queueInput(vehicleId, input);
  }

  // Commander-mode pause control — while paused, the tick loop still fires but returns
  // early without advancing engine state. Input messages are ignored during pause.
  pause(ws: WebSocket): void {
    if (!this.pausedBy) this.pausedBy = ws;
  }
  unpause(ws: WebSocket): void {
    if (this.pausedBy === ws) this.pausedBy = null;
  }
  isPaused(): boolean {
    return this.pausedBy !== null;
  }

  setSquadOrder(vehicleId: string, order: SquadOrder): void {
    if (order.type === 'clear') this.squadOrders.delete(vehicleId);
    else this.squadOrders.set(vehicleId, order);
  }

  setRival(rival: RivalInfo | null): void {
    this.rival = rival;
  }
  getRival(): RivalInfo | null {
    return this.rival;
  }

  getSquadOrder(vehicleId: string): SquadOrder | undefined {
    return this.squadOrders.get(vehicleId);
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

  private async checkEndCondition(state: import('@carwars/shared').ZoneState): Promise<void> {
    if (this.ended) return;
    if (state.type !== 'arena') return;

    // After Phase 2 wreckage refactor, destroyed vehicles move from state.vehicles
    // to state.wreckage — so the total-ever-present count is the sum of both.
    const alive = state.vehicles;
    const wreckCount = state.wreckage?.length ?? 0;
    const everPresent = alive.length + wreckCount;

    // Need at least 2 vehicles to have been spawned AND at least one destroyed
    if (everPresent < 2) return;
    if (wreckCount === 0) return;

    // Group surviving vehicles by playerId
    const survivorsByPlayer = new Map<string, string[]>();
    alive.forEach(v => {
      if (!survivorsByPlayer.has(v.playerId)) survivorsByPlayer.set(v.playerId, []);
      survivorsByPlayer.get(v.playerId)!.push(v.id);
    });

    if (survivorsByPlayer.size > 1) return; // battle still ongoing

    this.ended = true;
    this.stop();
    const winnerPlayerId = survivorsByPlayer.size === 1 ? [...survivorsByPlayer.keys()][0] : null;
    // AI win counts as null (no human prize)
    const humanWinnerId = winnerPlayerId === 'ai-team' ? null : winnerPlayerId;

    // Salvage: winner recovers a fraction of each losing-team wreck's build cost
    // scaled by intactness, state, and damage cause. Computed from state.wreckage
    // so it reflects every AI car the player destroyed during the match.
    const grossSalvage = totalSalvageFor(state.wreckage ?? [], humanWinnerId);

    // Call onEnd — it credits the prize + salvage and returns the final amounts.
    // onEnd may also include a rivalQuote (from the rival's boast_lines or
    // defeat_lines depending on outcome) so the client can render flavour text.
    const reason = winnerPlayerId === null ? 'all_destroyed'
                  : winnerPlayerId === 'ai-team' ? 'ai_victory'
                  : 'last_standing';
    const outcome = (await this.onEnd?.(humanWinnerId, grossSalvage, { reason, rival: this.rival }))
      ?? { prize: 0, jobPayout: 0, salvage: 0, wages: 0, maintenance: 0 };

    const endMsg: ServerMessage = {
      type: 'zone_end',
      winnerId: humanWinnerId,
      reason,
      prize: outcome.prize,
      jobPayout: outcome.jobPayout,
      salvage: outcome.salvage,
      wages: outcome.wages,
      maintenance: outcome.maintenance,
      rival: this.rival ?? undefined,
      rivalQuote: outcome.rivalQuote,
    };
    const data = JSON.stringify(endMsg);
    this.clients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });
  }

  private tick(): void {
    // Commander-mode pause: tick loop runs but engine doesn't advance, so the
    // player can issue orders with the world frozen.
    if (this.pausedBy) {
      this.humanInputThisTick.clear();
      return;
    }

    const state = this.engine.getState();
    state.vehicles.forEach(vehicle => {
      if (vehicle.stats.damageState.destroyed) return;
      const isHuman = this.humanVehicles.has(vehicle.id);
      const hasAutopilot = this.autopilotVehicles.has(vehicle.id);
      const needsAi = !isHuman || hasAutopilot;
      if (needsAi && !this.humanInputThisTick.has(vehicle.id)) {
        const enemies = state.vehicles.filter(v => v.playerId !== vehicle.playerId);
        const skill = this.vehicleSkills.get(vehicle.id) ?? 3;
        const order = this.squadOrders.get(vehicle.id);
        const aiInput = computeAiInput(vehicle, enemies, skill, this.map, order, state.vehicles);
        this.engine.queueInput(vehicle.id, aiInput);
      }
    });
    this.humanInputThisTick.clear();

    const newState = this.engine.resolveTick();

    // Vehicle state summary every 10 ticks
    if (newState.tick % 10 === 0) {
      newState.vehicles.forEach(v => {
        const ds = v.stats.damageState;
        if (ds.destroyed) return;
        const armorTotal = Object.values(ds.armor).reduce((s, n) => s + (n ?? 0), 0);
        const flags = [
          ds.engineDamaged ? 'ENGINE' : '',
          ds.onFire ? 'FIRE' : '',
          ds.tiresBlown.length ? `TIRES:${ds.tiresBlown.length}` : '',
        ].filter(Boolean).join(' ');
        console.log(
          `[t${newState.tick}] STATE ${v.id.padEnd(10)} ` +
          `pos=(${v.position.x.toFixed(1)},${v.position.y.toFixed(1)}) ` +
          `facing=${v.facing.toFixed(0)}° spd=${v.speed} armor=${armorTotal}` +
          (flags ? ` [${flags}]` : '')
        );
      });
    }

    this.checkEndCondition(newState).catch(console.error);

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
