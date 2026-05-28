import { Router } from 'express';
import { MAPS } from '../rules/maps';

// Read-only catalogue of arena maps. Powers the client's map-viewer scene
// and any future tooling (editor, balance dashboard, heatmap overlays).
// Static data — no auth required.
export const mapsRouter = Router();

// Summary list — id + display-friendly label + headline stats
mapsRouter.get('/', (_req, res) => {
  const summary = Object.entries(MAPS).map(([id, m]) => ({
    id,
    width: m.width,
    height: m.height,
    wallCount: m.walls.length,
    spawnCount: m.spawnPoints.length,
    palette: m.palette,
  }));
  res.json(summary);
});

// Full map data — everything needed to render
mapsRouter.get('/:id', (req, res) => {
  const map = MAPS[req.params.id];
  if (!map) return res.status(404).json({ error: 'Map not found' });
  return res.json(map);
});
