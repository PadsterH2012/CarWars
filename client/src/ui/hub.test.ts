// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

// Phaser tries to use Canvas at module-load time which jsdom doesn't support.
// Mock the entire module before importing hub.ts.
vi.mock('phaser', () => ({
  default: {
    Scenes: { Events: { SHUTDOWN: 'shutdown' } },
  },
}));

import { esc, renderInto, buildSidebarHTML } from './hub';

describe('esc', () => {
  it('escapes HTML special characters', () => {
    expect(esc('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });
  it('escapes ampersands', () => {
    expect(esc('a & b')).toBe('a &amp; b');
  });
  it('converts non-strings to string', () => {
    expect(esc(42)).toBe('42');
    expect(esc(null)).toBe('null');
  });
});

describe('renderInto', () => {
  it('clears existing content before rendering', () => {
    const el = document.createElement('div');
    el.textContent = 'old content';
    renderInto(el, '<span>new</span>');
    expect(el.querySelector('span')?.textContent).toBe('new');
    expect(el.childNodes.length).toBe(1);
  });
  it('renders multiple elements', () => {
    const el = document.createElement('div');
    renderInto(el, '<p>a</p><p>b</p>');
    expect(el.querySelectorAll('p').length).toBe(2);
  });
});

describe('buildSidebarHTML', () => {
  it('marks the correct nav item as active', () => {
    const html = buildSidebarHTML({
      gangName: 'Test Gang', gangColor: 0xff4444,
      treasury: 1000, reputation: 5, division: 1, influence: 0,
      reportsBadge: 0, activityBadge: 0, activeNav: 'garage', token: 'tok',
    });
    // Should have an active class on the garage link
    expect(html).toMatch(/nav-item[^>]*active[^>]*data-nav="garage"/);
  });
  it('includes gang name escaped in output', () => {
    const html = buildSidebarHTML({
      gangName: '<Evil> Gang', gangColor: 0x00ff88,
      treasury: 5000, reputation: 10, division: 2, influence: 100,
      reportsBadge: 3, activityBadge: 0, activeNav: 'shop', token: 'tok',
    });
    expect(html).toContain('&lt;Evil&gt; Gang');
    expect(html).toContain('$5,000');
  });
  it('shows badge when reportsBadge > 0', () => {
    const html = buildSidebarHTML({
      gangName: 'X', gangColor: 0, treasury: 0, reputation: 0, division: 1,
      influence: 0, reportsBadge: 3, activityBadge: 0, activeNav: 'garage', token: 'tok',
    });
    expect(html).toContain('nav-badge');
  });
  it('omits influence row when influence is 0', () => {
    const html = buildSidebarHTML({
      gangName: 'X', gangColor: 0, treasury: 0, reputation: 0, division: 1,
      influence: 0, reportsBadge: 0, activityBadge: 0, activeNav: 'garage', token: 'tok',
    });
    expect(html).not.toContain('Influence');
  });
});
