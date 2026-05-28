// Ad-hoc capacity validator for vehicles dumped as `name<TAB>json_loadout`
// lines on stdin or a path arg. Usage:
//   tsx scripts/check-vehicles.ts /tmp/loadouts.tsv
import * as fs from 'fs';
import { computeCapacity, isInvalid } from '../src/rules/capacity';

const path = process.argv[2];
if (!path) { console.error('usage: tsx scripts/check-vehicles.ts <file.tsv>'); process.exit(1); }

// ssh+psql output may have mangled the tab into a literal "\t" — handle both
const raw = fs.readFileSync(path, 'utf8');
const lines = raw.split('\n').filter(Boolean);
for (const line of lines) {
  let tab = line.indexOf('\t');
  if (tab === -1) tab = line.indexOf('\\t');
  const name = line.slice(0, tab);
  const jsonStart = line.indexOf('{', tab);
  const loadout = JSON.parse(line.slice(jsonStart));
  const cap = computeCapacity(loadout);
  const bad = isInvalid(cap);
  const pctS = ((cap.spacesUsed / Math.max(1, cap.spacesMax)) * 100).toFixed(0);
  const pctW = ((cap.loadWeight / Math.max(1, cap.loadMax)) * 100).toFixed(0);
  console.log('\n▸ ' + name);
  console.log('    body:   ' + loadout.bodyType + (loadout.hasSidecar ? ' + sidecar' : ''));
  console.log('    spaces: ' + cap.spacesUsed + ' / ' + cap.spacesMax + ' (' + pctS + '%)');
  console.log('    load:   ' + cap.loadWeight + ' / ' + cap.loadMax + ' lbs (' + pctW + '%)');
  console.log('    status: ' + (bad ? 'FAIL' : 'ok'));
  if (cap.errors.length) console.log('    errors: ' + cap.errors.join('; '));
}
