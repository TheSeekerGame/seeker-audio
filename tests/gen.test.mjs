// Checks that generated compositions are valid, in tune, in range, and that
// the sequencer plays them at sensible levels. Run with `node tests/gen.test.mjs`.

import { generateComposition, generatePattern, evolvePattern, generateHarmony, STYLE_ORDER } from '../js/generate.js';
import { cleanComposition, changePalette, isDrums, clone } from '../js/state.js';
import { absoluteRatio, isValidRatio, indexFrequency, foldFrequency, isValidTempo, tempoBpm, isHarmonicRate, ECHO_TIMES } from '../js/tuning.js';
import { MOODS } from '../js/moods.js';
import { Rng } from '../js/rng.js';
import { Song } from '../worklet/dsp/song.js';
import { renderSource, SOURCE_IDS } from '../js/audio/sources.js';
import { measureLayer } from '../js/audio/balance.js';
import { instrumentDefaults } from '../js/instruments.js';

let failures = 0;
function check(ok, message) {
	if (!ok) {
		failures++;
		if (failures < 40) console.log(`  FAIL ${message}`);
	}
}

function pitchedFrequencies(comp) {
	const out = [];
	const n = comp.palette.length;
	for (const layer of comp.layers) {
		if (isDrums(layer)) continue;
		for (const note of layer.pattern.notes) {
			const shifts = layer.follow ? comp.harmony : [0];
			for (const shift of shifts) {
				const index = note[1] + shift + layer.octave * n;
				out.push({ layer, index, freq: indexFrequency(comp.palette, index, comp.root) });
			}
		}
	}
	return out;
}

let outOfRange = 0;
let pitchCount = 0;
let low = Infinity;
let high = 0;
const styleCounts = {};
for (let seed = 1; seed <= 400; seed++) {
	const style = STYLE_ORDER[seed % STYLE_ORDER.length];
	const comp = generateComposition(seed * 7919, style);
	styleCounts[comp.style] = (styleCounts[comp.style] || 0) + 1;
	check(isValidTempo(comp.tempo), `seed ${seed}: invalid tempo ${comp.tempo}`);
	check(isHarmonicRate(tempoBpm(comp.tempo) / 60), `seed ${seed}: beat rate is not 48 × X/2^N`);
	check(comp.layers.length >= 2, `seed ${seed}: only ${comp.layers.length} layers`);
	for (const layer of comp.layers) check(layer.pattern.notes.length > 0, `seed ${seed}: empty ${layer.role} pattern`);

	// Cleaning a generated composition changes nothing that matters.
	const cleaned = cleanComposition(clone(comp));
	check(JSON.stringify(cleaned.layers) === JSON.stringify(comp.layers), `seed ${seed}: cleaning altered layers`);

	for (const { layer, index, freq } of pitchedFrequencies(comp)) {
		const [num, den] = absoluteRatio(comp.palette, index, comp.root);
		check(isValidRatio(num, den), `seed ${seed}: ratio ${num}/${den} is not X/2^N`);
		check(Math.abs(48 * (num / den) - freq) < 1e-6, `seed ${seed}: frequency mismatch`);
		// Generated material should rarely need the sequencer's octave fold.
		if (freq < 40 || freq > 4200) outOfRange++;
		const played = foldFrequency(freq);
		check(played >= 30 && played <= 5000 && isValidRatio(...absoluteRatio(comp.palette, index, comp.root)), `seed ${seed}: folded pitch ${played}`);
		pitchCount++;
		low = Math.min(low, freq);
		high = Math.max(high, freq);
	}

	// Regeneration, evolution, harmony, and palette changes stay valid.
	const rng = new Rng(seed);
	for (const layer of comp.layers) {
		layer.pattern = evolvePattern(comp, layer, rng);
		layer.pattern = generatePattern(comp, layer, rng);
		check(layer.pattern.notes.length > 0, `seed ${seed}: regenerated ${layer.role} is empty`);
	}
	comp.harmony = generateHarmony(comp, rng);
	changePalette(comp, MOODS[seed % MOODS.length].harmonics);
	for (const { index } of pitchedFrequencies(comp)) {
		const [num, den] = absoluteRatio(comp.palette, index, comp.root);
		check(isValidRatio(num, den), `seed ${seed}: remapped ratio ${num}/${den} invalid`);
	}
}
console.log(`styles ${JSON.stringify(styleCounts)}; pitch range ${low.toFixed(1)}–${high.toFixed(1)} Hz; outside 40–4200 Hz: ${((100 * outOfRange) / pitchCount).toFixed(2)}%`);
check(outOfRange / pitchCount < 0.01, 'more than 1% of generated pitches need folding');

// Echo times and effect rates are harmonic rates at every tempo.
for (const tempo of [[1, 5], [3, 6], [7, 7]]) {
	const beatHz = tempoBpm(tempo) / 60;
	for (const e of ECHO_TIMES) check(isHarmonicRate(beatHz / e.beats), `echo ${e.label} at ${tempoBpm(tempo)} BPM is not harmonic`);
}

// Play whole songs through the sequencer and instruments.
const SR = 48000;
const sources = new Map();
for (const id of SOURCE_IDS) sources.set(id, renderSource(id, SR));
for (const [k, style] of STYLE_ORDER.entries()) {
	const comp = generateComposition(1000 + k, style);
	const shared = { sources };
	const song = new Song(SR, shared);
	song.handle({ type: 'tuning', palette: comp.palette, root: comp.root });
	song.handle({ type: 'tempo', tempo: comp.tempo, swing: comp.swing });
	song.handle({ type: 'harmony', shifts: comp.harmony });
	comp.layers.forEach((layer, index) => song.handle({ type: 'layer', index, layer: { ...layer, active: true } }));
	song.handle({ type: 'play' });
	const outputs = Array.from({ length: 8 }, () => [new Float32Array(128), new Float32Array(128)]);
	const seconds = 12;
	let peak = 0;
	let sum = 0;
	let count = 0;
	let notes = 0;
	const t0 = performance.now();
	for (let b = 0; b < (seconds * SR) / 128; b++) {
		song.render(outputs, 128);
		notes += song.takeNotes().length;
		for (let i = 0; i < 128; i++) {
			let l = 0;
			let r = 0;
			comp.layers.forEach((layer, index) => {
				const g = layer.volume * layer.volume;
				l += outputs[index][0][i] * g;
				r += outputs[index][1][i] * g;
			});
			if (!Number.isFinite(l) || !Number.isFinite(r)) check(false, `${style}: non-finite mix`);
			peak = Math.max(peak, Math.abs(l), Math.abs(r));
			sum += l * l + r * r;
			count += 2;
		}
	}
	const cpu = seconds / ((performance.now() - t0) / 1000);
	const rms = Math.sqrt(sum / count);
	check(notes > 4, `${style}: only ${notes} notes in ${seconds}s`);
	check(rms > 0.01 && peak < 2.5, `${style}: level rms ${rms.toFixed(3)} peak ${peak.toFixed(3)}`);
	console.log(`${style.padEnd(10)} ${comp.name.padEnd(18)} ${comp.layers.map((l) => `${l.role}:${l.engine}`).join(' ')}  notes ${notes} rms ${rms.toFixed(3)} peak ${peak.toFixed(2)} cpu ${cpu.toFixed(0)}x`);
}

// The sidechain: drums land on the downbeat although they render ahead; the
// ring-mod follows the kick's waveform in phase, cutting at its peaks and
// passing at its zero crossings; and a gap opens before the snare.
{
	const song = new Song(SR, { sources: new Map() });
	song.handle({ type: 'tempo', tempo: [1, 5], swing: 0 });
	const notes = [[0, 0, 1, 1, 1], [4, 1, 1, 1, 1]];
	song.handle({ type: 'layer', index: 0, layer: { engine: 'drums', params: { ...instrumentDefaults('drums'), style: 'dnb', gap: 0.8 }, pattern: { rate: 4, length: 8, notes }, active: true } });
	song.handle({ type: 'play' });
	const outputs = [...Array.from({ length: 8 }, () => [new Float32Array(128), new Float32Array(128)]), [new Float32Array(128)]];
	const total = SR;
	const drum = new Float32Array(total);
	const sc = new Float32Array(total);
	for (let pos = 0; pos < total; pos += 128) {
		song.render(outputs, 128);
		drum.set(outputs[0][0], pos);
		sc.set(outputs[8][0], pos);
	}
	const first = drum.findIndex((x) => Math.abs(x) > 1e-4);
	check(first >= 0 && first < 4, `drums should start on the downbeat, started at sample ${first}`);
	// In step: where the kick crosses zero the cut is shallow, where it peaks it is deep.
	let atZero = 0;
	let zeros = 0;
	let atPeak = 0;
	let tops = 0;
	for (let i = Math.round(0.012 * SR); i < 0.08 * SR; i++) {
		if ((drum[i - 1] < 0) !== (drum[i] < 0)) {
			atZero += sc[i];
			zeros++;
		}
		const a = Math.abs(drum[i]);
		if (a > Math.abs(drum[i - 1]) && a >= Math.abs(drum[i + 1])) {
			atPeak += sc[i];
			tops++;
		}
	}
	const inStep = atZero / zeros / (atPeak / tops);
	check(inStep < 0.25, `ring-mod should follow the kick's cycles: cut at zero crossings is ${inStep.toFixed(2)} of the cut at peaks`);
	let peaks = 0;
	let troughs = 0;
	for (let i = 2; i < 0.06 * SR; i++) {
		if (sc[i - 1] > sc[i - 2] && sc[i - 1] >= sc[i] && sc[i - 1] > 0.8) peaks++;
		if (sc[i - 1] < sc[i - 2] && sc[i - 1] <= sc[i] && sc[i - 1] < 0.1) troughs++;
	}
	check(peaks >= 3 && troughs >= 3, `ring-mod should cut and pass with the kick's cycles (${peaks} cuts, ${troughs} passes)`);
	const snare = (60 / tempoBpm([1, 5])) * SR;
	const mean = (a, b) => sc.subarray(a, b).reduce((x, y) => x + y, 0) / (b - a);
	const before = mean(snare - 0.02 * SR, snare - 0.012 * SR);
	const gap = mean(snare - 0.007 * SR, snare - 0.001 * SR);
	check(before < 0.05 && gap > 0.9, `snare gap: ${before.toFixed(2)} before, ${gap.toFixed(2)} inside`);
	console.log(`sidechain: drums at sample ${first}, zero-crossing cut ${inStep.toFixed(2)} of peak cut, ${peaks} cuts / ${troughs} passes, gap ${gap.toFixed(2)}`);
}

// A restart (✦ surprise while playing) plays from the first beat at once, and
// the old song's ringing notes fade within the restart fade instead of
// carrying on into the new start.
{
	const song = new Song(SR, { sources: new Map() });
	song.handle({ type: 'tempo', tempo: [1, 5], swing: 0 });
	const pad = { engine: 'pad', params: { ...instrumentDefaults('pad'), release: 5 }, follow: false, octave: 0, gate: 1, active: true };
	song.handle({ type: 'layer', index: 0, layer: { ...pad, pattern: { rate: 1, length: 4, notes: [[0, 0, 4, 0.8, 1]] } } });
	song.handle({ type: 'play' });
	const outputs = [...Array.from({ length: 8 }, () => [new Float32Array(128), new Float32Array(128)]), [new Float32Array(128)]];
	const run = (seconds, each) => {
		for (let pos = 0; pos < seconds * SR; pos += 128) {
			song.render(outputs, 128);
			each?.(pos);
		}
	};
	let before = 0;
	run(2.5, (pos) => {
		if (pos < 2.3 * SR) return;
		for (let i = 0; i < 128; i++) before = Math.max(before, Math.abs(outputs[0][0][i]));
	});
	check(before > 0.01, 'the old song should be sounding before the restart');
	// The new song is silent until its third beat, so anything heard before then is the old one.
	song.handle({ type: 'pattern', index: 0, pattern: { rate: 1, length: 4, notes: [[2, 0, 1, 0.8, 1]] } });
	song.handle({ type: 'restart' });
	let tail = 0;
	run(0.5, (pos) => {
		if (pos < 0.06 * SR) return;
		for (let i = 0; i < 128; i++) tail = Math.max(tail, Math.abs(outputs[0][0][i]), Math.abs(outputs[0][1][i]));
	});
	check(tail < 1e-4, `the old song still sounds after a restart (${tail.toExponential(1)})`);
	const beat = song.ctx.beat;
	check(Math.abs(beat - (0.5 * tempoBpm([1, 5])) / 60) < 0.01, `restart should start the song from its first beat, not ${beat.toFixed(3)}`);
	song.takeNotes();
	song.handle({ type: 'pattern', index: 0, pattern: { rate: 1, length: 4, notes: [[0, 0, 1, 0.8, 1]] } });
	song.handle({ type: 'restart' });
	song.render(outputs, 128);
	const first = song.takeNotes();
	check(first.length === 1 && first[0].offset === 0, 'a restarted song should play its first beat at once');
	console.log(`restart: old song at ${before.toFixed(3)} before, ${tail.toExponential(1)} 60 ms after; first beat at once`);
}

// Switching styles over and over (as ✦ surprise does) at both phone sample
// rates never makes an invalid sample, so the instruments' safety net, which
// drops a broken block and renews the instrument, never has to act.
for (const rate of [44100, 48000]) {
	const song = new Song(rate, { sources });
	let renewed = 0;
	const renew = song.renew.bind(song);
	song.renew = (layer) => {
		renewed++;
		renew(layer);
	};
	const outputs = [...Array.from({ length: 8 }, () => [new Float32Array(128), new Float32Array(128)]), [new Float32Array(128)]];
	const rng = new Rng(11);
	let bad = 0;
	song.handle({ type: 'play' });
	for (let t = 0; t < 150; t++) {
		const comp = generateComposition(rng.int(0, 1e9), STYLE_ORDER[rng.int(0, STYLE_ORDER.length - 1)]);
		song.handle({ type: 'tuning', palette: comp.palette, root: comp.root });
		song.handle({ type: 'tempo', tempo: comp.tempo, swing: comp.swing });
		song.handle({ type: 'harmony', shifts: comp.harmony });
		for (let i = 0; i < 8; i++) {
			const l = comp.layers[i];
			song.handle(l ? { type: 'layer', index: i, layer: { ...l, active: true } } : { type: 'remove', index: i });
		}
		song.handle({ type: 'restart' });
		for (let b = Math.round((rng.range(0.05, 1) * rate) / 128); b > 0; b--) {
			song.render(outputs, 128);
			for (const out of outputs) for (const ch of out) for (let i = 0; i < 128; i++) if (!Number.isFinite(ch[i])) bad++;
		}
	}
	check(bad === 0 && renewed === 0, `${rate} Hz style switches: ${bad} invalid samples, ${renewed} renewed instruments`);
	console.log(`style switches at ${rate} Hz: clean`);
}

// A broken instrument never reaches the mix: its block is dropped and the
// instrument starts afresh with the same settings.
{
	const song = new Song(SR, { sources: new Map() });
	song.handle({ type: 'layer', index: 0, layer: { engine: 'keys', params: instrumentDefaults('keys'), pattern: { rate: 4, length: 4, notes: [[0, 0, 1, 0.8, 1]] }, active: true } });
	song.handle({ type: 'play' });
	const outputs = [...Array.from({ length: 8 }, () => [new Float32Array(128), new Float32Array(128)]), [new Float32Array(128)]];
	const broken = song.layers[0].engine;
	broken.process = (L, R, start, end) => L.fill(NaN, start, end);
	song.render(outputs, 128);
	const dropped = outputs[0][0].every((x) => x === 0);
	song.render(outputs, 128);
	check(dropped && song.layers[0].engine !== broken && outputs[0][0].every(Number.isFinite), 'a broken instrument should be dropped and renewed');
	check(song.layers[0].engine.params.decay === broken.params.decay, 'a renewed instrument should keep its settings');
}

// The balance judges a sparse part by its notes: the same phrase heard once in
// four bars measures within 1.5 dB of it played every bar.
{
	const spec = (pattern) => ({ palette: [1, 9, 19, 21, 3, 7], root: 2, tempo: [1, 5], swing: 0, harmony: [0], layer: { engine: 'keys', params: instrumentDefaults('keys'), pattern, follow: true, octave: 0, gate: 0.85 } });
	const phrase = [[0, 0, 2, 0.8, 1], [4, 2, 2, 0.8, 1], [8, 4, 2, 0.8, 1], [12, 3, 2, 0.8, 1]];
	const dense = measureLayer(spec({ rate: 4, length: 16, notes: phrase }));
	const sparse = measureLayer(spec({ rate: 4, length: 64, notes: phrase }));
	check(Math.abs(dense - sparse) < 1.5, `sparse phrase measured ${(sparse - dense).toFixed(1)} dB from the dense one`);
	check(measureLayer(spec({ rate: 4, length: 16, notes: phrase })) === dense, 'balance measurement should be deterministic');
	console.log(`balance: dense ${dense.toFixed(1)} dB, sparse ${sparse.toFixed(1)} dB`);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
