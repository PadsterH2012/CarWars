import { describe, it, expect } from 'vitest';
import { BinaryHeap } from '../src/ai/heap';

describe('BinaryHeap', () => {
  it('pops items in priority order (min-heap)', () => {
    const h = new BinaryHeap<string>();
    h.push('a', 3);
    h.push('b', 1);
    h.push('c', 2);
    expect(h.pop()?.item).toBe('b');
    expect(h.pop()?.item).toBe('c');
    expect(h.pop()?.item).toBe('a');
    expect(h.pop()).toBeNull();
  });

  it('reports size correctly', () => {
    const h = new BinaryHeap<number>();
    expect(h.size).toBe(0);
    h.push(1, 1);
    h.push(2, 2);
    expect(h.size).toBe(2);
    h.pop();
    expect(h.size).toBe(1);
  });

  it('handles duplicate priorities stably enough (both returned)', () => {
    const h = new BinaryHeap<string>();
    h.push('x', 5);
    h.push('y', 5);
    const a = h.pop();
    const b = h.pop();
    expect([a?.item, b?.item].sort()).toEqual(['x', 'y']);
  });

  it('maintains min-heap property after many random pushes', () => {
    const h = new BinaryHeap<number>();
    const values: number[] = [];
    for (let i = 0; i < 200; i++) {
      const v = Math.floor(Math.random() * 1000);
      values.push(v);
      h.push(v, v);
    }
    values.sort((a, b) => a - b);
    for (const expected of values) {
      expect(h.pop()?.item).toBe(expected);
    }
  });
});
