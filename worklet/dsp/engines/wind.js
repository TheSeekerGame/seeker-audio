// Wind: noise excites narrow resonances on the note and its second and third
// harmonics, with a wide band of air on top.

import { PolyEngine, Voice } from '../poly.js';
import { Env, Noise, SVF, OnePole, clamp, lerp, panGains } from '../core.js';
import { instrumentDefaults } from '../../../js/instruments.js';

class WindVoice extends Voice {
	constructor(sr, engine, seed) {
		super();
		this.sr = sr;
		this.engine = engine;
		this.env = new Env(sr);
		this.noise = new Noise(seed);
		// Two band-pass stages per partial: steep skirts keep the tone free of hiss.
		this.res = [new SVF(), new SVF(), new SVF()];
		this.res2 = [new SVF(), new SVF(), new SVF()];
		this.air = new SVF();
		this.flutter = new OnePole();
		this.gains = new Float32Array(3);
		this.vel = 0;
		this.pl = 0.7;
		this.pr = 0.7;
	}

	level() {
		return this.env.value * this.vel;
	}

	start(freq, vel) {
		const p = this.engine.params;
		this.freq = freq;
		this.vel = vel;
		this.configure();
		this.version = this.engine.version;
		this.flutter.setFreq(6, this.sr);
		const pan = this.noise.next() * p.width * 0.7;
		[this.pl, this.pr] = panGains(pan);
		this.env.set(p.attack, 0.4, 0.9, p.release);
		this.env.trigger();
	}

	// Follows parameter changes while the note sounds.
	configure() {
		const p = this.engine.params;
		const sr = this.sr;
		const freq = this.freq;
		const q = lerp(8, 90, p.purity);
		const partialGains = [1, p.harmonics * 0.55, p.harmonics * 0.3];
		for (let k = 0; k < 3; k++) {
			const f = freq * (k + 1);
			if (f > sr * 0.42) {
				this.gains[k] = 0;
				continue;
			}
			this.res[k].set(f, q, sr);
			this.res2[k].set(f, q, sr);
			// Normalize the narrow band's noise power so purity changes timbre, not level.
			this.gains[k] = partialGains[k] * Math.sqrt((q * sr) / (2 * f)) * 0.075;
		}
		this.air.set(clamp(freq * lerp(2, 8, p.tone), 200, sr * 0.4), 0.8, sr);
	}

	release() {
		const p = this.engine.params;
		this.env.set(p.attack, 0.4, 0.9, p.release);
		this.env.release();
	}

	render(L, R, start, end) {
		const p = this.engine.params;
		if (this.engine.version !== this.version) {
			this.version = this.engine.version;
			this.configure();
		}
		const env = this.env;
		const [r0, r1, r2] = this.res;
		const [s0, s1, s2] = this.res2;
		const g0 = this.gains[0];
		const g1 = this.gains[1];
		const g2 = this.gains[2];
		const air = p.noise * 0.022 * (0.4 + p.tone);
		const level = this.vel * 1.5;
		for (let i = start; i < end; i++) {
			const x = this.noise.next();
			const wobble = 1 + this.flutter.lp(this.noise.next()) * 2.5;
			let y = s0.bpNorm(r0.bpNorm(x)) * g0;
			if (g1) y += s1.bpNorm(r1.bpNorm(x)) * g1;
			if (g2) y += s2.bpNorm(r2.bpNorm(x)) * g2;
			y += this.air.bp(x) * air;
			y *= env.next() * level * wobble;
			L[i] += y * this.pl;
			R[i] += y * this.pr;
		}
		if (!env.active) {
			this.active = false;
			for (const f of this.res) f.reset();
			for (const f of this.res2) f.reset();
			this.air.reset();
		}
	}
}

export class WindEngine extends PolyEngine {
	constructor(sr, ctx) {
		const voices = [];
		super(sr, ctx, voices, instrumentDefaults('wind'));
		for (let i = 0; i < 10; i++) voices.push(new WindVoice(sr, this, 0x3a1d + i * 4093));
	}
}
