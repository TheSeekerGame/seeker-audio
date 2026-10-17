// Formant voices. A band-limited sawtooth, flattened by pre-emphasis, passes
// through four vowel formants; an ensemble chorus widens the section. Formants
// are filters, not pitches, so the sung note stays exactly on its ratio.

import { PolyEngine, Voice } from '../poly.js';
import { Env, Noise, SVF, OnePole, Ensemble, clamp, lerp, polyBlep, panGains, sin1 } from '../core.js';
import { instrumentDefaults } from '../../../js/instruments.js';

// Alto formants for u, o, a, e, i: frequency (Hz), level (dB), bandwidth (Hz).
const VOWELS = [
	{ f: [325, 700, 2530, 3500], db: [0, -12, -30, -40], bw: [50, 60, 170, 180] },
	{ f: [450, 800, 2830, 3500], db: [0, -9, -16, -28], bw: [70, 80, 100, 130] },
	{ f: [800, 1150, 2800, 3500], db: [0, -4, -20, -36], bw: [80, 90, 120, 130] },
	{ f: [400, 1600, 2700, 3300], db: [0, -24, -30, -35], bw: [60, 80, 120, 150] },
	{ f: [350, 1700, 2700, 3700], db: [0, -20, -30, -36], bw: [50, 100, 120, 150] },
];

function vowelAt(position, out) {
	const x = clamp(position, 0, 1) * (VOWELS.length - 1);
	const i = Math.min(VOWELS.length - 2, Math.floor(x));
	const t = x - i;
	const a = VOWELS[i];
	const b = VOWELS[i + 1];
	for (let k = 0; k < 4; k++) {
		out.f[k] = lerp(a.f[k], b.f[k], t);
		out.g[k] = 10 ** (lerp(a.db[k], b.db[k], t) / 20);
		out.bw[k] = lerp(a.bw[k], b.bw[k], t);
	}
	return out;
}

const SHAPE = { f: new Float32Array(4), g: new Float32Array(4), bw: new Float32Array(4) };

class ChoirVoice extends Voice {
	constructor(sr, engine, seed) {
		super();
		this.sr = sr;
		this.engine = engine;
		this.env = new Env(sr);
		this.noise = new Noise(seed);
		this.formants = [new SVF(), new SVF(), new SVF(), new SVF()];
		this.breathTone = new OnePole();
		this.breathTone.setFreq(2600, sr);
		this.outTone = new OnePole();
		this.outTone.setFreq(6500, sr);
		this.gains = new Float32Array(4);
		this.phase = 0;
		this.inc = 0;
		this.x1 = 0;
		this.vel = 0;
		this.drift = (seed % 1000) / 1000;
		this.vowelOffset = 0;
		this.pl = 0.7;
		this.pr = 0.7;
	}

	level() {
		return this.env.value * this.vel;
	}

	start(freq, vel, row) {
		const p = this.engine.params;
		const sr = this.sr;
		this.freq = freq;
		this.inc = freq / sr;
		this.vel = vel;
		if (!this.active) {
			this.phase = this.noise.unit();
			for (const f of this.formants) f.reset();
			this.x1 = 0;
		}
		this.vowelOffset = this.noise.next() * 0.06;
		// A sawtooth's harmonic near a formant scales with the note, so divide it back out.
		this.level0 = (sr / (2 * Math.PI * freq)) * 0.034;
		const pan = this.noise.next() * 0.6 * p.ensemble;
		[this.pl, this.pr] = panGains(pan);
		this.env.set(p.attack, 0.3, 1, p.release);
		this.env.trigger();
		this.updateFormants();
	}

	release() {
		const p = this.engine.params;
		this.env.set(p.attack, 0.3, 1, p.release);
		this.env.release();
	}

	updateFormants() {
		const p = this.engine.params;
		this.drift += 0.0027;
		if (this.drift >= 1) this.drift -= 1;
		const wobble = sin1(this.drift);
		const vowel = vowelAt(p.vowel + this.vowelOffset + wobble * 0.03, SHAPE);
		const scale = lerp(1.25, 0.78, p.size) * (1 + wobble * 0.012);
		for (let k = 0; k < 4; k++) {
			const f = Math.min(vowel.f[k] * scale, this.sr * 0.45);
			const q = f / vowel.bw[k];
			this.formants[k].set(f, q, this.sr);
			this.gains[k] = vowel.g[k];
		}
	}

	render(L, R, start, end) {
		this.updateFormants();
		const env = this.env;
		const [f0, f1, f2, f3] = this.formants;
		const g0 = this.gains[0];
		const g1 = this.gains[1];
		const g2 = this.gains[2];
		const g3 = this.gains[3];
		const breath = this.engine.params.breath * 0.5;
		const voiced = 1 - this.engine.params.breath * 0.5;
		const level = this.level0 * this.vel;
		const inc = this.inc;
		let phase = this.phase;
		let x1 = this.x1;
		for (let i = start; i < end; i++) {
			let saw = 2 * phase - 1 - polyBlep(phase, inc);
			phase += inc;
			if (phase >= 1) phase -= 1;
			// Mild pre-emphasis keeps a voice-like downward tilt.
			const pre = saw - 0.5 * x1;
			x1 = saw;
			const e = env.next();
			const src = (pre * voiced + this.breathTone.lp(this.noise.next()) * breath) * e;
			const y = this.outTone.lp(f0.bpNorm(src) * g0 + f1.bpNorm(src) * g1 + f2.bpNorm(src) * g2 + f3.bpNorm(src) * g3) * level;
			L[i] += y * this.pl;
			R[i] += y * this.pr;
		}
		this.phase = phase;
		this.x1 = x1;
		if (!env.active) {
			this.active = false;
			for (const f of this.formants) f.reset();
		}
	}
}

export class ChoirEngine extends PolyEngine {
	constructor(sr, ctx) {
		const voices = [];
		super(sr, ctx, voices, instrumentDefaults('choir'));
		for (let i = 0; i < 10; i++) voices.push(new ChoirVoice(sr, this, 0xc401 + i * 6151));
		this.ensemble = new Ensemble(sr);
	}

	post(L, R, start, end) {
		this.ensemble.mix = this.params.ensemble;
		this.ensemble.depth = 0.4 + this.params.ensemble * 0.4;
		this.ensemble.process(L, R, start, end);
	}
}
