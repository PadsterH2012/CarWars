import { describe, it, expect } from 'vitest';
import { BODY_TYPES, POWER_PLANTS, SUSPENSIONS, TIRE_TYPES, ARMOR_TYPES, WEAPONS, ARCS } from '../src/ui/DesignerUI';

describe('DesignerUI catalog data', () => {
  it('BODY_TYPES has 12 entries including cycles', () => {
    expect(BODY_TYPES.length).toBe(12);
    const ids = BODY_TYPES.map(b => b.id);
    expect(ids).toContain('mid_sized');
    expect(ids).toContain('light_cycle');
    expect(ids).toContain('van');
  });

  it('WEAPONS has 20 entries and all have id and label', () => {
    expect(WEAPONS.length).toBe(20);
    WEAPONS.forEach(w => {
      expect(w.id).toBeTruthy();
      expect(w.label).toBeTruthy();
    });
  });

  it('ARCS contains all 5 arc types', () => {
    expect(ARCS).toContain('front');
    expect(ARCS).toContain('back');
    expect(ARCS).toContain('left');
    expect(ARCS).toContain('right');
    expect(ARCS).toContain('turret');
  });
});
