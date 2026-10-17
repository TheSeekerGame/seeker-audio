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
