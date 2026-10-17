// Share links reproduce songs exactly and stay short; older links still open.
// Run with `node tests/share.test.mjs`.
import { generateComposition, STYLE_ORDER } from '../js/generate.js';
import { cleanComposition, clone } from '../js/state.js';
import { encode, encodeFull, encodeStored, decode, pack, payloadFromLocation } from '../js/share.js';
import { INSTRUMENTS, INSTRUMENT_ORDER, EFFECTS, EFFECT_ORDER } from '../js/instruments.js';
import { ROLES } from '../js/state.js';
import { Rng } from '../js/rng.js';

let failures = 0;
function check(ok, message) {
	if (!ok) {
		failures++;
		if (failures < 8) console.log(`  FAIL ${message}`);
	}
}

// Compares songs, ignoring layer ids (fresh on every load) and the outdated flag.
const strip = (c) => JSON.stringify({ ...c, outdated: undefined, layers: c.layers.map((l) => ({ ...l, id: '' })) });

// Small, realistic edits: a knob, a note, the tempo, a mute.
function tweak(comp, rng) {
	const c = clone(comp);
	const layer = rng.pick(c.layers);
	const knob = rng.pick(INSTRUMENTS[layer.engine].params.filter((q) => q.type !== 'choice'));
	layer.params[knob.id] = knob.min + (knob.max - knob.min) * rng.next();
	if (layer.pattern.notes.length) layer.pattern.notes[0][3] = 0.4;
	layer.mute = !layer.mute;
	c.tempo = [11, 8];
	return cleanComposition(c);
}

const sizes = { seed: [], edited: [], full: [] };
for (let seed = 1; seed <= 150; seed++) {
	const style = seed % 4 === 0 ? null : STYLE_ORDER[seed % STYLE_ORDER.length];
	const comp = generateComposition(seed * 104729, style);

	// An untouched surprise song travels as its seed.
	const short = await encode(comp);
	check(short.startsWith('g'), `seed ${seed}: expected a seed link, got ${short.slice(0, 12)}`);
	const back = await decode(short);
	check(strip(back) === strip(comp), `seed ${seed}: seed link does not reproduce the song`);
	check(!back.outdated, `seed ${seed}: fresh seed link marked outdated`);
	sizes.seed.push(short.length);

	// Edits travel as a patch on top of the seed.
	const edited = tweak(comp, new Rng(seed));
	const patched = await encode(edited);
	const editedBack = await decode(patched);
	check(strip(editedBack) === strip(edited), `seed ${seed}: edited song does not round-trip`);
	sizes.edited.push(patched.length);

	// The full form reproduces any song, with or without an origin.
	const full = await encodeFull({ ...edited, origin: null });
	check(strip(await decode(full)) === strip({ ...edited, origin: null }), `seed ${seed}: full link does not round-trip`);
	sizes.full.push(full.length);

	// Stored songs keep their origin, so they can still be shared short.
	const stored = await decode(await encodeStored(edited));
	check(JSON.stringify(stored.origin) === JSON.stringify(edited.origin), `seed ${seed}: stored song lost its origin`);
}
const avg = (list) => Math.round(list.reduce((a, b) => a + b, 0) / list.length);
console.log(`seed links ${avg(sizes.seed)} chars (max ${Math.max(...sizes.seed)}); edited ${avg(sizes.edited)} (max ${Math.max(...sizes.edited)}); full ${avg(sizes.full)} (max ${Math.max(...sizes.full)})`);
check(Math.max(...sizes.seed) <= 24, 'seed links should stay under 25 characters');

// A link whose fingerprint no longer matches (an older generator) still opens, marked outdated.
{
	const comp = generateComposition(42, 'house');
	const link = await encode(comp);
	const parts = link.split('.');
	parts[3] = parts[3] === '0000' ? '0001' : '0000';
	const old = await decode(parts.join('.'));
	check(old.outdated === true && old.layers.length === comp.layers.length, 'outdated seed link should open and be flagged');
}

// Songs open from the query, where links put them, and from the fragment, where earlier links did.
for (const loc of [{ search: '?s=g2.8.39u.afkl', hash: '' }, { search: '', hash: '#s=g2.8.39u.afkl' }, { search: '?ref=x&s=g2.8.39u.afkl', hash: '' }]) {
	check(payloadFromLocation(loc) === 'g2.8.39u.afkl', `song not found in ${loc.search}${loc.hash}`);
}
check(payloadFromLocation({ search: '', hash: '' }) === null, 'an address without a song should give none');

// Links in the first full format still open.
{
	const comp = generateComposition(7, 'lofi');
	const pct = (x) => Math.round(x * 100);
	const roles = Object.keys(ROLES);
	const v1 = [1, comp.name, STYLE_ORDER.indexOf(comp.style), comp.palette, comp.root, comp.tempo, pct(comp.swing), comp.harmony, [pct(comp.space.size), pct(comp.space.tone)], [comp.echo.time, pct(comp.echo.feedback), pct(comp.echo.tone)], pct(comp.master.volume),
		comp.layers.map((l) => [INSTRUMENT_ORDER.indexOf(l.engine), roles.indexOf(l.role), l.color, (l.follow ? 1 : 0) | (l.mute ? 2 : 0) | (l.solo ? 4 : 0), l.octave, pct(l.gate), pct(l.volume), pct(l.pan), pct(l.space), pct(l.echo),
			INSTRUMENTS[l.engine].params.map((d) => (d.type === 'choice' ? d.options.indexOf(l.params[d.id]) : l.params[d.id])),
			[l.pattern.rate, l.pattern.length, l.pattern.notes.flatMap((n) => [n[0], n[1], n[2], pct(n[3]), pct(n[4])])],
			l.fx.map((f) => [EFFECT_ORDER.indexOf(f.type), f.on ? 1 : 0, EFFECTS[f.type].params.map((d) => (d.type === 'choice' ? d.options.indexOf(f.params[d.id]) : f.params[d.id]))])])];
	const text = 'j' + Buffer.from(JSON.stringify(v1)).toString('base64url');
	const back = await decode(text);
	// The first format had no sidechain, so its layers open uncarved.
	const uncarved = { ...comp, origin: null, layers: comp.layers.map((l) => ({ ...l, sidechain: 0 })) };
	check(strip({ ...back, origin: null }) === strip(uncarved), 'format 1 link does not open as the same song');
}
void pack;

console.log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);
