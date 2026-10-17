// Plucked strings (extended Karplus-Strong) with a halo of sympathetic strings
// tuned to the root and its harmonics. A first-order all-pass sets the
// fractional delay so every string lands on its exact Seeker frequency.

import { PolyEngine, Voice } from '../poly.js';
import { Noise, SVF, OnePole, clamp, lerp, panGains } from '../core.js';
import { instrumentDefaults } from '../../../js/instruments.js';
import { rootHz } from '../../../js/tuning.js';

const BUFFER = 4096; // holds one period down to ~12 Hz at 48 kHz
const MASK = BUFFER - 1;

// One string loop: delay line, fractional all-pass, and a linear-phase loss filter.
export class StringLoop {
	constructor() {
		this.buf = new Float32Array(BUFFER);
		this.w = 0;
		this.m = 100;
		this.eta = 0;
		this.apx = 0;
		this.apy = 0;
		this.h1 = 0;
		this.h2 = 0;
		this.c = 0.1;
		this.gain = 0.99;
		this.period = 100;
	}

	tune(freq, sr, brightness, t60) {
		const period = clamp(sr / freq, 4, BUFFER - 8);
		this.period = period;
		const m = Math.floor(period - 1.5);
		const d = period - 1 - m;
		this.m = m;
		this.eta = (1 - d) / (1 + d);
		this.c = lerp(0.24, 0.02, clamp(brightness, 0, 1));
		this.setDecay(freq, sr, t60);
	}

	setDecay(freq, sr, t60) {
		const w = (2 * Math.PI * freq) / sr;
		const filterGain = 1 - 2 * this.c * (1 - Math.cos(w));
		const target = 10 ** (-3 / (Math.max(t60, 0.02) * freq));
		this.gain = Math.min(0.99995, target / Math.max(filterGain, 0.1));
	}

	clear() {
		this.buf.fill(0);
		this.apx = this.apy = this.h1 = this.h2 = 0;
	}

	// Writes an excitation into the samples about to be read, as if it were the previous period.
	excite(signal, length, keep) {
		const m = this.m;
		for (let i = 0; i < m; i++) {
			const idx = (this.w - m + i) & MASK;
			const add = i < length ? signal[i] : 0;
			this.buf[idx] = this.buf[idx] * keep + add;
		}
	}

	tick(input) {
		const buf = this.buf;
		const rd = buf[(this.w - this.m) & MASK];
		const ap = this.eta * rd + this.apx - this.eta * this.apy;
		this.apx = rd;
		this.apy = ap;
		const c = this.c;
		const f = c * ap + (1 - 2 * c) * this.h1 + c * this.h2;
		this.h2 = this.h1;
		this.h1 = ap;
		buf[this.w] = f * this.gain + input;
		this.w = (this.w + 1) & MASK;
		return f;
	}
}

const EXCITE = new Float32Array(BUFFER);

class StringVoice extends Voice {
	constructor(sr, engine, seed) {
		super();
		this.sr = sr;
		this.engine = engine;
		this.noise = new Noise(seed);
		this.loop = new StringLoop();
		this.lp = new OnePole();
		this.peak = 0;
		this.quiet = 0;
		this.pl = 0.7;
		this.pr = 0.7;
	}

	level() {
		return this.peak;
	}

	decayFor(freq) {
		const p = this.engine.params;
		return p.decay * clamp((220 / freq) ** 0.35, 0.35, 1.6);
	}

	start(freq, vel) {
		const p = this.engine.params;
		const sr = this.sr;
		const sameString = this.active && Math.abs(freq - this.freq) < 0.01;
		this.freq = freq;
		const brightness = clamp(p.tone * 0.85 + vel * 0.2, 0, 1);
		this.loop.tune(freq, sr, brightness, this.decayFor(freq));
		if (!sameString) this.loop.clear();

		// Excitation: low-passed noise, combed at the pluck point, normalized.
		const period = Math.round(this.loop.period);
		const length = Math.min(period, BUFFER - 1);
		this.lp.reset();
		this.lp.setFreq(freq * lerp(1.5, 24, brightness), sr);
		for (let i = 0; i < length; i++) EXCITE[i] = this.lp.lp(this.noise.next());
		const pick = Math.max(1, Math.round(length * lerp(0.06, 0.5, p.position)));
		for (let i = length - 1; i >= pick; i--) EXCITE[i] -= EXCITE[i - pick];
		let mean = 0;
		for (let i = 0; i < length; i++) mean += EXCITE[i];
		mean /= length;
		let peak = 1e-9;
		for (let i = 0; i < length; i++) {
			EXCITE[i] -= mean;
			peak = Math.max(peak, Math.abs(EXCITE[i]));
		}
		const amp = (0.55 * vel) / peak;
		for (let i = 0; i < length; i++) EXCITE[i] *= amp;
		this.loop.excite(EXCITE, length, sameString ? 0.4 : 0);

		const pan = clamp(Math.log2(freq / 330) * 0.35, -1, 1) * p.width;
		[this.pl, this.pr] = panGains(pan);
		this.peak = vel;
		this.quiet = 0;
	}

	release() {
		const p = this.engine.params;
		const t = lerp(0.12, this.decayFor(this.freq), p.sustain * p.sustain);
		this.loop.setDecay(this.freq, this.sr, t);
	}

	render(L, R, start, end) {
		const loop = this.loop;
		const out = this.engine.mono;
		let peak = 0;
		for (let i = start; i < end; i++) {
			const y = loop.tick(0);
			out[i] += y;
			L[i] += y * this.pl;
			R[i] += y * this.pr;
			const a = y < 0 ? -y : y;
			if (a > peak) peak = a;
		}
		this.peak = peak;
		if (peak < 3e-5) {
			if (++this.quiet > 4) this.active = false;
		} else {
			this.quiet = 0;
		}
	}
}

// Ratios of the sympathetic strings relative to the root.
const SYMPATHETIC = [0.5, 1, 1.5, 2];

export class StringsEngine extends PolyEngine {
	constructor(sr, ctx) {
		const voices = [];
		super(sr, ctx, voices, instrumentDefaults('strings'));
		for (let i = 0; i < 12; i++) voices.push(new StringVoice(sr, this, 0x51a7 + i * 131));
		this.mono = new Float32Array(128);
		this.sympathetic = SYMPATHETIC.map(() => new StringLoop());
		this.sympPan = SYMPATHETIC.map((_, i) => panGains((i % 2 ? 0.7 : -0.7) * (0.5 + i * 0.15)));
		this.bodyLow = [new SVF(), new SVF()];
		this.bodyHigh = [new SVF(), new SVF()];
		for (const f of this.bodyLow) f.set(190, 1.6, sr);
		for (const f of this.bodyHigh) f.set(520, 1.8, sr);
		this.tunedRoot = -1;
		this.sympEnergy = 0;
		// The sympathetic strings ring on after the last pluck.
		this.tail = sr * 8;
	}

	tuneSympathetic() {
		const root = this.ctx.root;
		if (root === this.tunedRoot) return;
		this.tunedRoot = root;
		const base = rootHz(root);
		this.sympathetic.forEach((s, i) => {
			s.clear();
			s.tune(base * SYMPATHETIC[i], this.sr, 0.45, 7);
		});
	}

	process(L, R, start, end) {
		this.mono.fill(0, start, end);
		super.process(L, R, start, end);
	}

	post(L, R, start, end) {
		const p = this.params;
		this.tuneSympathetic();
		const sympathy = p.sympathy;
		if (sympathy > 0.001 && (this.busy || this.sympEnergy > 1e-5)) {
			const drive = sympathy * 0.012;
			const level = 0.5 + sympathy;
			let energy = 0;
			for (let s = 0; s < this.sympathetic.length; s++) {
				const loop = this.sympathetic[s];
				const [gl, gr] = this.sympPan[s];
				for (let i = start; i < end; i++) {
					const y = loop.tick(this.mono[i] * drive) * level;
					L[i] += y * gl;
					R[i] += y * gr;
					energy += y < 0 ? -y : y;
				}
			}
			this.sympEnergy = energy / Math.max(1, end - start);
		}
		const body = p.body;
		if (body > 0.001) {
			const [ll, rl] = this.bodyLow;
			const [lh, rh] = this.bodyHigh;
			const a = body * 0.9;
			const b = body * 0.5;
			for (let i = start; i < end; i++) {
				L[i] += ll.bp(L[i]) * a + lh.bp(L[i]) * b;
				R[i] += rl.bp(R[i]) * a + rh.bp(R[i]) * b;
			}
		}
	}
}
