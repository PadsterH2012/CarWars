import type { ArenaMap } from '@carwars/shared';

// Export helpers for the MapEditorScene. Take an in-progress ArenaMap and
// produce shareable serialisations.

// Pretty-printed JSON dump — 2-space indent, suitable for download + version
// control.
export function mapToJson(map: ArenaMap): string {
  return JSON.stringify(map, null, 2);
}

// TypeScript source ready to paste into server/src/rules/maps/<id>.ts as a
// new seed. Includes the import + export const line. `varName` is the JS
// identifier (usually camelCase of the map id).
export function mapToTsSource(map: ArenaMap, varName: string): string {
  const header = `import type { ArenaMap } from '@carwars/shared';\n\nexport const ${varName}: ArenaMap = `;
  return header + JSON.stringify(map, null, 2) + ';\n';
}

// Trigger a browser download of the JSON dump. Uses the Blob + anchor-click
// pattern which works without any server round-trip.
export function downloadJson(map: ArenaMap, filename: string): void {
  const blob = new Blob([mapToJson(map)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Copy the TS source to the clipboard. Returns a promise that resolves true
// on success. Falls back to a hidden textarea if the async Clipboard API is
// unavailable (e.g. non-secure context).
export async function copyTsSource(map: ArenaMap, varName: string): Promise<boolean> {
  const text = mapToTsSource(map, varName);
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea fallback
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  return ok;
}

// Camel-cased ID → JS identifier (e.g. "my-map" → "myMap")
export function varNameFromId(id: string): string {
  return id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}
