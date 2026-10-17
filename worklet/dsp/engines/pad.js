// Analog-style pad: two band-limited oscillators a harmonic interval apart,
// a slowly moving low-pass filter, and an ensemble chorus. There is no detune:
// the width comes from the chorus, so every oscillator stays on its ratio.

import { PolyEngine, Voice } from '../poly.js';
import { Env, Noise, SVF, Ensemble, clamp, polyBlep, sin1 } from '../core.js';
import { instrumentDefaults } from '../../../js/instruments.js';

const INTERVALS = { unison: 1, octave: 2, '3/2': 1.5, 3: 3, '7/4': 1.75, '9/4': 2.25 };

function oscillator(phase, inc, shape) {
	// shape 0: triangle, 0.5: saw, 1: square.
	const saw = 2 * phase - 1 - polyBlep(phase, inc);
	if (shape <= 0.5) {
		const tri = 1 - 4 * Math.abs(phase - 0.5);
		const t = shape * 2;
		return tri * (1 - t) + saw * t;
	}
	let p2 = phase + 0.5;
	if (p2 >= 1) p2 -= 1;
	const saw2 = 2 * p2 - 1 - polyBlep(p2, inc);
	const square = (saw - saw2) * 0.5;
	const t = (shape - 0.5) * 2;
	return saw * (1 - t) + square * t;
}

class PadVoice extends Voice {
	constructor(sr, engine, seed) {
		super();
		this.sr = sr;
		this.engine = engine;
		this.env = new Env(sr);
		this.noise = new Noise(seed);
		this.filter = new SVF();
		this.p1 = 0;
		this.p2 = 0;
		this.lfo = (seed % 997) / 997;
		this.vel = 0;
		this.pan = 0;
	}

	level() {
		return this.env.value * this.vel;
	}

	start(freq, vel) {
		const p = this.engine.params;
		this.freq = freq;
		this.vel = vel;
		this.inc1 = freq / this.sr;
		this.ratio = INTERVALS[p.interval] || 1;
		this.inc2 = Math.min(0.45, this.inc1 * this.ratio);
		if (!this.active) {
			this.p1 = this.noise.unit();
			this.p2 = this.noise.unit();
			this.filter.reset();
		}
		this.pan = this.noise.next() * 0.35;
		this.env.set(p.attack, 1.2, 0.85, p.release);
		this.env.trigger();
	}

	release() {
		const p = this.engine.params;
		this.env.set(p.attack, 1.2, 0.85, p.release);
		this.env.release();
	}

	render(L, R, start, end) {
		const p = this.engine.params;
		const sr = this.sr;
		const n = end - start;
		// Filter movement at 48/256 Hz, per voice phase.
		this.lfo += (0.1875 * n) / sr;
		if (this.lfo >= 1) this.lfo -= 1;
		const env = this.env;
		const base = 120 * 2 ** (p.cutoff * 6.5);
		const track = (this.freq / 220) ** 0.5;
		const sweep = 2 ** (p.motion * 1.4 * sin1(this.lfo) + env.value * 0.6);
		const cutoff = clamp(base * track * sweep, 60, sr * 0.42);
		this.filter.set(cutoff, 0.6 + p.resonance * 2.6, sr);
		const shape = p.shape;
		const mix2 = this.ratio === 1 ? 0 : 0.45;
		const level = this.vel * 0.16 * (1 - p.resonance * 0.3);
		const gl = 0.7071 * (1 - this.pan);
		const gr = 0.7071 * (1 + this.pan);
		const inc1 = this.inc1;
		const inc2 = this.inc2;
		let p1 = this.p1;
		let p2 = this.p2;
		for (let i = start; i < end; i++) {
			const s = oscillator(p1, inc1, shape) + (mix2 ? oscillator(p2, inc2, shape) * mix2 : 0);
			p1 += inc1;
			if (p1 >= 1) p1 -= 1;
			p2 += inc2;
			if (p2 >= 1) p2 -= 1;
			const y = this.filter.lp(s) * env.next() * level;
			L[i] += y * gl;
			R[i] += y * gr;
		}
		this.p1 = p1;
		this.p2 = p2;
		if (!env.active) this.active = false;
	}
}

export class PadEngine extends PolyEngine {
	constructor(sr, ctx) {
		const voices = [];
		super(sr, ctx, voices, instrumentDefaults('pad'));
		for (let i = 0; i < 10; i++) voices.push(new PadVoice(sr, this, 0x9ad1 + i * 3571));
		this.ensemble = new Ensemble(sr);
	}

	post(L, R, start, end) {
		this.ensemble.mix = this.params.ensemble;
		this.ensemble.depth = 0.3 + this.params.motion * 0.6;
		this.ensemble.process(L, R, start, end);
	}
}
