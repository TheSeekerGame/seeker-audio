// Headless checks for the instruments and effects: level, tuning accuracy,
// release, stability, and CPU cost. Run with `node tests/dsp.test.mjs`.
// Set WAV_DIR to also write each instrument's demo as a WAV file.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createEngine } from '../worklet/dsp/engines/index.js';
import { ResonatorFx, ShifterFx, LofiFx, PumpFx, SquashFx, Limiter, Leveler, masterClip, CEILING } from '../worklet/dsp/effects.js';
import { ROW_LOUDNESS } from '../worklet/dsp/engines/drums.js';
import { KWeight } from '../js/audio/loudness.js';
import { renderSource, SOURCE_IDS } from '../js/audio/sources.js';
import { normalizePalette, indexFrequency } from '../js/tuning.js';
import { INSTRUMENTS, INSTRUMENT_ORDER, instrumentDefaults, DRUM_KIT_ROWS } from '../js/instruments.js';

const SR = 48000;
const BLOCK = 128;
const palette = normalizePalette([1, 9, 19, 21, 3, 7]);
const ctx = { palette, root: 2, sources: new Map(), bpm: 90, beat: 0, playing: false };
for (const id of SOURCE_IDS) ctx.sources.set(id, renderSource(id, SR));

let failures = 0;
function check(ok, message) {
	if (!ok) {
		failures++;
		console.log(`  FAIL ${message}`);
	}
}

// Renders `seconds` of audio; `notes` is [{at, freq, vel, gate, row}] in seconds.
function render(engine, notes, seconds) {
	const total = Math.round(seconds * SR);
	const L = new Float32Array(total);
	const R = new Float32Array(total);
	const bl = new Float32Array(BLOCK);
	const br = new Float32Array(BLOCK);
	const pending = notes.map((n) => ({ ...n, sample: Math.round(n.at * SR) })).sort((a, b) => a.sample - b.sample);
	let next = 0;
	for (let pos = 0; pos < total; pos += BLOCK) {
		const n = Math.min(BLOCK, total - pos);
		bl.fill(0);
		br.fill(0);
		let cursor = 0;
		while (next < pending.length && pending[next].sample < pos + n) {
			const note = pending[next++];
			const offset = Math.max(0, note.sample - pos);
			if (offset > cursor) {
				engine.process(bl, br, cursor, offset);
				cursor = offset;
			}
			engine.noteOn(note.freq, note.vel ?? 0.8, Math.round((note.gate ?? 0.5) * SR), -1, note.row ?? 0);
		}
		if (cursor < n) engine.process(bl, br, cursor, n);
		L.set(bl.subarray(0, n), pos);
		R.set(br.subarray(0, n), pos);
	}
	return { L, R };
}

function stats(L, R, from = 0, to = L.length) {
	let peak = 0;
	let sum = 0;
	let nan = false;
	for (let i = from; i < to; i++) {
		const l = L[i];
		const r = R[i];
		if (!Number.isFinite(l) || !Number.isFinite(r)) nan = true;
		peak = Math.max(peak, Math.abs(l), Math.abs(r));
		sum += l * l + r * r;
	}
	return { peak, rms: Math.sqrt(sum / (2 * Math.max(1, to - from))), nan };
}

// Frequency of the strongest spectral component within ±6% of `expected`,
// found by scanning the DFT magnitude in 0.05 Hz steps.
function measurePitch(x, from, length, expected) {
	let best = expected;
	let bestMag = -1;
	const lo = expected * 0.94;
	const hi = expected * 1.06;
	for (let f = lo; f <= hi; f += 0.05) {
		const w = (2 * Math.PI * f) / SR;
		let re = 0;
		let im = 0;
		for (let i = 0; i < length; i++) {
			const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
			const v = x[from + i] * hann;
			re += v * Math.cos(w * i);
			im -= v * Math.sin(w * i);
		}
		const mag = re * re + im * im;
		if (mag > bestMag) {
			bestMag = mag;
			best = f;
		}
	}
	return best;
}

function writeWav(path, L, R) {
	const n = L.length;
	const buf = Buffer.alloc(44 + n * 4);
	buf.write('RIFF', 0);
	buf.writeUInt32LE(36 + n * 4, 4);
	buf.write('WAVEfmt ', 8);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(2, 22);
	buf.writeUInt32LE(SR, 24);
	buf.writeUInt32LE(SR * 4, 28);
	buf.writeUInt16LE(4, 32);
	buf.writeUInt16LE(16, 34);
	buf.write('data', 36);
	buf.writeUInt32LE(n * 4, 40);
	for (let i = 0; i < n; i++) {
		buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4);
		buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4);
	}
	writeFileSync(path, buf);
}

const wavDir = process.env.WAV_DIR;
if (wavDir) mkdirSync(wavDir, { recursive: true });

// Pitch whose fundamental is not its strongest low partial is skipped.
const PITCH_CHECK = { bells: false, drums: false, cloud: false };

console.log('instrument   peak1  peakChord  rms    tail   cpu(x realtime)  pitch');
for (const id of INSTRUMENT_ORDER) {
	const engine = createEngine(id, SR, ctx);
	const drums = !!INSTRUMENTS[id].drums;
	const root = indexFrequency(palette, 0, 2); // 192 Hz
	const chord = [0, 2, 4, 6].map((i) => indexFrequency(palette, i, 2));

	// One note.
	const single = drums
		? render(engine, [0, 1, 2, 3, 4, 5, 6, 7].map((row, k) => ({ at: k * 0.3, row, freq: 0, gate: 0.2 })), 3.2)
		: render(engine, [{ at: 0, freq: root, gate: 1 }], 4);
	const s1 = stats(single.L, single.R);
	check(!s1.nan, `${id}: non-finite output`);
	check(s1.peak > 0.05, `${id}: too quiet (${s1.peak.toFixed(3)})`);
	check(s1.peak < 0.9, `${id}: single note too loud (${s1.peak.toFixed(3)})`);

	// Engine finishes its voices after release.
	const tail = stats(single.L, single.R, single.L.length - 2400);
	check(tail.peak < 0.01, `${id}: still sounding at the end (${tail.peak.toFixed(4)})`);

	let pitchNote = '';
	if (!drums && PITCH_CHECK[id] !== false) {
		const mono = single.L.map((v, i) => v + single.R[i]);
		const measured = measurePitch(mono, Math.round(0.25 * SR), Math.round(0.5 * SR), root);
		const error = Math.abs(measured - root);
		pitchNote = `${measured.toFixed(2)} Hz`;
		// Noise-excited wind wanders within its narrow resonance; tones must be exact.
		const tolerance = id === 'wind' ? 1.2 : 0.35;
		check(error < tolerance, `${id}: pitch ${measured.toFixed(2)} Hz, expected ${root} Hz`);
	}

	// A chord of four notes, measuring CPU.
	const engine2 = createEngine(id, SR, ctx);
	const notes = drums
		? Array.from({ length: 64 }, (_, k) => ({ at: k * 0.125, row: k % 8, freq: 0, gate: 0.1 }))
		: chord.flatMap((freq, k) => [{ at: k * 0.01, freq, gate: 3 }, { at: 4 + k * 0.01, freq: freq * 0.5, gate: 3 }]);
	const t0 = performance.now();
	const chordOut = render(engine2, notes, 8);
	const elapsed = (performance.now() - t0) / 1000;
	const s2 = stats(chordOut.L, chordOut.R);
	check(!s2.nan, `${id}: non-finite chord output`);
	check(s2.peak < 1.2, `${id}: chord too loud (${s2.peak.toFixed(3)})`);
	const speed = 8 / elapsed;

	console.log(
		`${id.padEnd(12)} ${s1.peak.toFixed(3)}  ${s2.peak.toFixed(3)}      ${s2.rms.toFixed(3)}  ${tail.peak.toFixed(4)}  ${speed.toFixed(0).padStart(6)}x          ${pitchNote}`,
	);
	if (wavDir) writeWav(join(wavDir, `${id}.wav`), chordOut.L, chordOut.R);
}

// Every material, family, and choice option renders cleanly.
console.log('\noptions');
for (const id of INSTRUMENT_ORDER) {
	for (const param of INSTRUMENTS[id].params) {
		if (param.type !== 'choice') continue;
		for (const option of param.options) {
			const engine = createEngine(id, SR, ctx);
			engine.setParams({ ...instrumentDefaults(id), [param.id]: option });
			const out = render(engine, [{ at: 0, freq: 192, gate: 0.6, row: 0 }, { at: 0.02, freq: 288, gate: 0.6, row: 3 }], 1.5);
			const s = stats(out.L, out.R);
			check(!s.nan && s.peak > 0.02 && s.peak < 1, `${id} ${param.id}=${option}: peak ${s.peak.toFixed(3)}`);
		}
	}
}

// Extremes of every continuous parameter stay bounded and audible.
console.log('extremes');
for (const id of INSTRUMENT_ORDER) {
	for (const param of INSTRUMENTS[id].params) {
		if (param.type === 'choice') continue;
		for (const value of [param.min, param.max]) {
			const engine = createEngine(id, SR, ctx);
			engine.setParams({ ...instrumentDefaults(id), [param.id]: value });
			const freqs = [48, 192, 1536];
			const out = render(engine, freqs.map((freq, k) => ({ at: k * 0.4, freq, gate: 0.3, row: k })), 1.6);
			const s = stats(out.L, out.R);
			check(!s.nan && s.peak < 1.2, `${id} ${param.id}=${value}: peak ${s.peak.toFixed(3)} nan=${s.nan}`);
		}
	}
}

// Every bass model, under random settings anywhere in range, stays finite,
// audible, bounded, and on pitch; glide lands exactly on the next note.
// Every instrument renders any range it is given: the drums' pre-roll asks for
// a whole look-ahead at once, and odd sizes happen around note starts.
console.log('render ranges');
{
	const SIZES = [480, 37, 200, 128, 1, 300];
	for (const id of INSTRUMENT_ORDER) {
		const engine = createEngine(id, SR, { ...ctx, sidechain: new Float32Array(512) });
		const drums = !!INSTRUMENTS[id].drums;
		const L = new Float32Array(512);
		const R = new Float32Array(512);
		let bad = 0;
		for (let k = 0; k < 400; k++) {
			if (k % 20 === 0) for (let row = 0; row < 3; row++) engine.noteOn(drums ? 0 : indexFrequency(palette, row * 2, 2), 0.9, SR / 4, -1, drums ? (row + k) % 8 : row);
			const size = SIZES[k % SIZES.length];
			L.fill(0);
			R.fill(0);
			engine.process(L, R, 0, size);
			for (let i = 0; i < size; i++) if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) bad++;
		}
		check(bad === 0, `${id}: ${bad} invalid samples when rendered in uneven ranges`);
	}
	console.log('  every instrument renders uneven ranges cleanly');
}

console.log('bass models');
{
	const models = INSTRUMENTS.bass.params.find((q) => q.id === 'model').options;
	let seed = 7;
	const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
	for (const model of models) {
		let worst = 0;
		let quietest = Infinity;
		for (let trial = 0; trial < 12; trial++) {
			const engine = createEngine('bass', SR, { ...ctx, bpm: 128, playing: false });
			const params = { model };
			for (const q of INSTRUMENTS.bass.params) if (q.type !== 'choice') params[q.id] = trial < 2 ? (trial ? q.max : q.min) : q.min + (q.max - q.min) * rand();
			engine.setParams(params);
			const notes = [41, 48, 72, 96, 144].map((freq, k) => ({ at: k * 0.3, freq, gate: 0.25, vel: k === 2 ? 1 : 0.7 }));
			const out = render(engine, notes, 2.2);
			const s = stats(out.L, out.R);
			check(!s.nan, `bass ${model}: non-finite output`);
			worst = Math.max(worst, s.peak);
			quietest = Math.min(quietest, s.rms);
		}
		check(worst < 1, `bass ${model}: peak ${worst.toFixed(3)}`);
		check(quietest > 0.004, `bass ${model}: nearly silent (rms ${quietest.toFixed(4)})`);
		const engine = createEngine('bass', SR, ctx);
		engine.setParams({ ...instrumentDefaults('bass'), model, decay: 1.5 });
		const held = render(engine, [{ at: 0, freq: 96, gate: 1.5 }], 1.6);
		const mono = held.L.map((v, i) => v + held.R[i]);
		const measured = measurePitch(mono, Math.round(0.3 * SR), Math.round(0.8 * SR), 96);
		check(Math.abs(measured - 96) < 0.35, `bass ${model}: pitch ${measured.toFixed(2)} Hz, expected 96`);
		console.log(`  ${model.padEnd(7)} worst peak ${worst.toFixed(3)}  quietest rms ${quietest.toFixed(4)}  pitch ${measured.toFixed(2)} Hz`);
	}
	// Glide: two overlapping notes slide from the first pitch to the second.
	const engine = createEngine('bass', SR, ctx);
	engine.setParams({ ...instrumentDefaults('bass'), model: 'acid', glide: 0.06, decay: 1 });
	const slid = render(engine, [{ at: 0, freq: 72, gate: 0.6 }, { at: 0.4, freq: 96, gate: 0.6 }], 1.1);
	const mono = slid.L.map((v, i) => v + slid.R[i]);
	const after = measurePitch(mono, Math.round(0.6 * SR), Math.round(0.4 * SR), 96);
	check(Math.abs(after - 96) < 0.4, `bass glide lands at ${after.toFixed(2)} Hz, expected 96`);
	check(engine.voices.filter((v) => v.active).length <= 1, 'bass glide should reuse one voice');
}

// Effects: process noise bursts and a tone; output stays finite and bounded.
// Every kit keeps its balance through the drum bus: each row's loudest 50 ms
// (K-weighted) sits within 2 dB of its target relative to the kick.
console.log('drum kits');
{
	const kitCtx = { ...ctx, sidechain: new Float32Array(BLOCK) };
	const momentary = (kit, row) => {
		const engine = createEngine('drums', SR, kitCtx);
		engine.setParams({ ...instrumentDefaults('drums'), style: kit });
		const kl = new KWeight(SR);
		const kr = new KWeight(SR);
		const win = Math.round(0.05 * SR);
		const sq = new Float32Array(Math.round(0.6 * SR));
		const L = new Float32Array(BLOCK);
		const R = new Float32Array(BLOCK);
		let n = 0;
		while (n < sq.length) {
			L.fill(0);
			R.fill(0);
			if (n === 0) engine.noteOn(0, 0.9, 1000, -1, row);
			engine.process(L, R, 0, BLOCK);
			for (let i = 0; i < BLOCK && n < sq.length; i++) {
				const l = kl.process(L[i]);
				const r = kr.process(R[i]);
				sq[n++] = l * l + r * r;
			}
		}
		let best = 0;
		let acc = 0;
		for (let i = 0; i < n; i++) {
			acc += sq[i];
			if (i >= win) acc -= sq[i - win];
			best = Math.max(best, acc / win);
		}
		return 10 * Math.log10(best + 1e-12);
	};
	for (const [kit, rows] of Object.entries(DRUM_KIT_ROWS)) {
		const kick = momentary(kit, 0);
		let worst = 0;
		rows.forEach((name, row) => {
			const off = momentary(kit, row) - kick - (ROW_LOUDNESS[name] ?? -6);
			if (Math.abs(off) > Math.abs(worst)) worst = off;
			check(Math.abs(off) <= 2, `${kit} ${name} is ${off.toFixed(1)} dB from its level`);
		});
		console.log(`  ${kit.padEnd(7)} worst row ${worst >= 0 ? '+' : ''}${worst.toFixed(1)} dB`);
	}
}

console.log('effects');
const effectCtx = { ...ctx, bpm: 90, beat: 0, playing: false };
for (const [name, Fx, params] of [
	['resonator modal', ResonatorFx, { mode: 'modal', decay: 4 }],
	['resonator strings', ResonatorFx, { mode: 'strings', decay: 4 }],
	['shifter', ShifterFx, { shift: 6, mode: 'loop', feedback: 0.9 }],
	['shifter bounce', ShifterFx, { shift: -6, mode: 'bounce', feedback: 0.5 }],
	['lofi', LofiFx, { crush: 1, wobble: 1, dust: 1 }],
	['squash', SquashFx, { depth: 1, upward: 1, time: 0 }],
]) {
	const fx = new Fx(SR, effectCtx);
	fx.setParams(params);
	const total = SR * 4;
	const outL = new Float32Array(total);
	const outR = new Float32Array(total);
	const inL = new Float32Array(BLOCK);
	const inR = new Float32Array(BLOCK);
	const oL = new Float32Array(BLOCK);
	const oR = new Float32Array(BLOCK);
	let seed = 1;
	const t0 = performance.now();
	for (let pos = 0; pos < total; pos += BLOCK) {
		for (let i = 0; i < BLOCK; i++) {
			const t = (pos + i) / SR;
			seed = (seed * 1103515245 + 12345) >>> 0;
			const burst = t % 0.5 < 0.02 ? (seed / 2 ** 31 - 1) * 0.5 : 0;
			const tone = Math.sin(2 * Math.PI * 192 * t) * 0.2 * (t < 2 ? 1 : 0);
			inL[i] = inR[i] = burst + tone;
		}
		fx.process(inL, inR, oL, oR, BLOCK);
		outL.set(oL, pos);
		outR.set(oR, pos);
	}
	const elapsed = (performance.now() - t0) / 1000;
	const s = stats(outL, outR);
	check(!s.nan && s.peak < 1.5 && s.peak > 0.01, `${name}: peak ${s.peak.toFixed(3)} nan=${s.nan}`);
	console.log(`  ${name.padEnd(18)} peak ${s.peak.toFixed(3)} rms ${s.rms.toFixed(3)} cpu ${(4 / elapsed).toFixed(0)}x`);
}

// The pump ducks right after each beat and has recovered by the next one.
{
	const pumpCtx = { ...ctx, bpm: 120, beat: 0, playing: true };
	const pump = new PumpFx(SR, pumpCtx);
	pump.setParams({ rate: '1/4', depth: 0.8, release: 0.3 });
	const samplesPerBeat = (60 / 120) * SR;
	const ones = new Float32Array(BLOCK).fill(1);
	const oL = new Float32Array(BLOCK);
	const oR = new Float32Array(BLOCK);
	const gains = [];
	for (let pos = 0; pos < samplesPerBeat * 4; pos += BLOCK) {
		// As in the worklet, the song has already advanced the beat to the block's end.
		pumpCtx.beat = (pos + BLOCK) / samplesPerBeat;
		pump.process(ones, ones, oL, oR, BLOCK);
		for (let i = 0; i < BLOCK; i++) gains.push(oL[i]);
	}
	for (const beat of [1, 2, 3]) {
		const at = Math.round(beat * samplesPerBeat);
		const dip = Math.min(...gains.slice(at, at + Math.round(SR * 0.02)));
		const before = gains[at - 1];
		check(dip < 0.3, `pump: beat ${beat} dips only to ${dip.toFixed(3)}`);
		check(before > 0.9, `pump: not recovered before beat ${beat} (${before.toFixed(3)})`);
		const dipAt = gains.slice(at - 200, at + 1000).indexOf(dip) - 200;
		check(dipAt >= 0 && dipAt < SR * 0.012, `pump: beat ${beat} dip lands ${dipAt} samples from the beat`);
	}
	console.log(`  pump               dip ${Math.min(...gains).toFixed(3)} on each beat`);
}

// Limiter never exceeds its ceiling.
{
	const limiter = new Limiter(SR);
	let over = 0;
	for (let b = 0; b < 400; b++) {
		const L = new Float32Array(BLOCK);
		const R = new Float32Array(BLOCK);
		for (let i = 0; i < BLOCK; i++) {
			const t = (b * BLOCK + i) / SR;
			L[i] = Math.sin(2 * Math.PI * 100 * t) * (1 + 2 * Math.sin(t * 7) ** 2);
			R[i] = -L[i] * 0.9;
		}
		limiter.process(L, R, BLOCK);
		for (let i = 0; i < BLOCK; i++) over = Math.max(over, Math.abs(L[i]), Math.abs(R[i]));
	}
	check(over <= CEILING + 1e-4, `limiter exceeded ceiling: ${over}`);
	console.log(`  limiter max ${over.toFixed(4)}`);
}

// The master chain normalizes: whether the mix arrives far too hot or far too
// quiet, the output never passes the ceiling and its peaks settle right at it.
{
	for (const level of [6, 0.1]) {
		const leveler = new Leveler(SR);
		const limiter = new Limiter(SR);
		let over = 0;
		let late = 0;
		const blocks = Math.round((8 * SR) / BLOCK);
		for (let b = 0; b < blocks; b++) {
			const L = new Float32Array(BLOCK);
			const R = new Float32Array(BLOCK);
			for (let i = 0; i < BLOCK; i++) {
				const t = (b * BLOCK + i) / SR;
				// A decaying hit every half second over a steady tone.
				const hit = Math.exp(-(t % 0.5) * 30) * Math.sin(2 * Math.PI * 60 * t);
				L[i] = (hit + Math.sin(2 * Math.PI * 300 * t) * 0.2) * level;
				R[i] = L[i] * 0.8;
			}
			leveler.process(L, R, BLOCK);
			masterClip(L, R, BLOCK);
			limiter.process(L, R, BLOCK);
			for (let i = 0; i < BLOCK; i++) {
				const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
				over = Math.max(over, a);
				if (b * BLOCK > 4 * SR) late = Math.max(late, a);
			}
		}
		check(over <= CEILING + 1e-4, `master exceeded the ceiling: ${over}`);
		check(late > CEILING * 0.97, `master at input level ${level} settled at ${late.toFixed(3)}, not the ceiling`);
		console.log(`  master from ${level}x: peak ${(20 * Math.log10(over)).toFixed(2)} dBFS, settled ${(20 * Math.log10(late)).toFixed(2)} dBFS`);
	}
}

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
