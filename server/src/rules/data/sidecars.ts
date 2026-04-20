// Sidecar — a rigid 3rd-wheel pod that bolts onto a motorcycle. Modelled as
// a single attachment with fixed stats: costs cash, weighs lbs, but grants
// bonus space and load capacity since the pod itself can hold components.
// Only medium and heavy cycles are strong enough to take one per the
// Compendium; light cycles would be destabilised and trikes already have
// three wheels.

export const SIDECAR = {
  cost: 500,            // $ — added to totalCost when hasSidecar is true
  weight: 150,          // lbs — sidecar structure weight, applied to loadWeight
  bonusSpaces: 4,       // spaces — pod has its own storage budget
  bonusLoad: 600,       // lbs — pod can carry an extra 600 lb of components
  // HC penalty could be modelled later; compendium-accurate value is -1 HC.
};

export const SIDECAR_ALLOWED_BODIES: ReadonlySet<string> = new Set(['med_cycle', 'hvy_cycle']);

export function sidecarAllowedFor(bodyType: string | undefined): boolean {
  if (!bodyType) return false;
  return SIDECAR_ALLOWED_BODIES.has(bodyType);
}
