// Stem export pieces that run without a browser: the ZIP container (checked
// with the system unzip) and the length of one full song cycle.
// Run with `node tests/stems.test.mjs`.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zip } from '../js/audio/zip.js';
import { cycleBars } from '../js/audio/stems.js';
import { newComposition, newLayer } from '../js/state.js';

let failures = 0;
function check(ok, message) {
	if (!ok) {
		failures++;
		console.log(`  FAIL ${message}`);
	}
}

// The archive lists, tests, and extracts byte for byte.
const dir = mkdtempSync(join(tmpdir(), 'seeker-zip-'));
const big = new Uint8Array(200000).map((_, i) => (i * 31) & 0xff);
const blob = zip([
	{ name: '01 bells (melody).wav', data: big },
	{ name: 'about these stems.txt', data: new TextEncoder().encode('tempo: 90 BPM\n') },
]);
const path = join(dir, 'stems.zip');
writeFileSync(path, Buffer.from(await blob.arrayBuffer()));
try {
	const listing = execFileSync('unzip', ['-t', path], { encoding: 'utf8' });
	check(/No errors detected/.test(listing), `unzip -t: ${listing}`);
	execFileSync('unzip', ['-q', '-o', path, '-d', dir]);
	check(Buffer.compare(readFileSync(join(dir, '01 bells (melody).wav')), Buffer.from(big)) === 0, 'extracted stem differs');
	check(readFileSync(join(dir, 'about these stems.txt'), 'utf8') === 'tempo: 90 BPM\n', 'extracted text differs');
} catch (error) {
	check(false, `unzip failed: ${error.message}`);
}

// One cycle is where the harmony and every pattern line up again.
const comp = newComposition();
comp.harmony = [0, 1, 2, 3];
const a = newLayer('bells', 'melody');
a.pattern = { rate: 4, length: 16, notes: [] }; // one bar
const b = newLayer('strings', 'arp');
b.pattern = { rate: 4, length: 12, notes: [] }; // three beats
comp.layers = [a, b];
check(cycleBars(comp) === 12, `4-bar harmony with a 3-beat arp: ${cycleBars(comp)} bars, expected 12`);
b.pattern = { rate: 3, length: 12, notes: [] }; // one bar of triplets
check(cycleBars(comp) === 4, `aligned patterns: ${cycleBars(comp)} bars, expected 4`);
b.pattern = { rate: 6, length: 23, notes: [] };
check(cycleBars(comp) === 64, `very long polymeter caps at 64 bars, got ${cycleBars(comp)}`);

console.log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);
