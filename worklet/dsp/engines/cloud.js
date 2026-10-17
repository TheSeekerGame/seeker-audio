// Granular clouds. Each held note emits short grains read from a source the
// app synthesizes itself (sung vowels, struck glass, strings, air).
// A grain's playback rate is the note's ratio to the source's root, optionally
// layered a 3/2 or an octave above, so every grain lands on a Seeker pitch.

import { PolyEngine, Voice } from '../poly.js';
import { Env, Noise, clamp } from '../core.js';
import { instrumentDefaults } from '../../../js/instruments.js';

const MAX_GRAINS = 96;
const WINDOW_SIZE = 1024;
// Rising half of a raised-cosine window.
const WINDOW = new Float32Array(WINDOW_SIZE + 1);
for (let i = 0; i <= WINDOW_SIZE; i++) {
	const s = Math.sin((Math.PI * 0.5 * i) / WINDOW_SIZE);
	WINDOW[i] = s * s;
}
const ATTACK = 0.32;

class Grain {
	constructor() {
		this.active = false;
		this.data = null;
		this.pos = 0;
		this.inc = 0;
		this.len = 1;
		this.age = 0;
		this.offset = 0;
		this.gl = 0;
		this.gr = 0;
	}
}

class CloudVoice extends Voice {
	constructor(sr, engine, seed) {
		super();
		this.sr = sr;
		this.engine = engine;
		this.env = new Env(sr);
		this.noise = new Noise(seed);
		this.countdown = 0;
		this.vel = 0;
	}

	level() {
		return this.env.value * this.vel;
	}

	start(freq, vel) {
		const p = this.engine.params;
		this.freq = freq;
		this.vel = vel;
		this.countdown = 0;
		this.env.set(p.attack, 0.5, 1, p.release);
		this.env.trigger();
	}

	release() {
		const p = this.engine.params;
		this.env.set(p.attack, 0.5, 1, p.release);
		this.env.release();
	}

	interval() {
		const p = this.engine.params;
		let rate = p.density;
		if (p.pulse > 0.5) {
			// Lock the grain rate to the note: its frequency divided by a power of two.
			let r = this.freq;
			while (r > p.density * 1.41) r *= 0.5;
			rate = r;
		}
		const jitter = (1 - p.pulse) * 0.9 * this.noise.next();
		return Math.max(1, (this.sr / rate) * (1 + jitter * 0.5));
	}

	render(L, R, start, end) {
		const env = this.env;
		for (let i = start; i < end; i++) {
			const e = env.next();
			if (--this.countdown <= 0) {
				if (env.stage !== 4 || e > 0.02) this.engine.spawn(this, i, e);
				this.countdown += this.interval();
			}
		}
		if (!env.active) this.active = false;
	}
}

export class CloudEngine extends PolyEngine {
	constructor(sr, ctx) {
		const voices = [];
		super(sr, ctx, voices, instrumentDefaults('cloud'));
		for (let i = 0; i < 8; i++) voices.push(new CloudVoice(sr, this, 0xc10d + i * 811));
		this.grains = Array.from({ length: MAX_GRAINS }, () => new Grain());
		this.noise = new Noise(0x6a1e);
		this.flip = false;
		// Grains outlive the note that spawned them.
		this.tail = sr;
	}

	get busy() {
		if (super.busy) return true;
		for (const g of this.grains) if (g.active) return true;
		return false;
	}

	spawn(voice, at, envelope) {
		const p = this.params;
		const source = this.ctx.sources?.get(p.source);
		if (!source) return;
		let grain = null;
		let oldest = -1;
		for (const g of this.grains) {
			if (!g.active) {
				grain = g;
				break;
			}
			const progress = g.age / g.len;
			if (progress > oldest) {
				oldest = progress;
				grain = g;
			}
		}
		const sr = this.sr;
		const data = source.data;
		const length = data.length;
		const h = p.harmonics;
		const roll = this.noise.unit();
		const layer = roll < h * 0.35 ? 2 : roll < h * 0.8 ? 1.5 : 1;
		const reverse = this.noise.unit() < p.reverse;
		const inc = ((voice.freq / source.rootHz) * (source.sr / sr) * layer) * (reverse ? -1 : 1);
		const len = Math.max(16, Math.round(p.size * sr));
		const span = Math.abs(inc) * len + 4;
		if (span >= length) return;
		const center = p.position * length + p.spray * this.noise.next() * length * 0.35;
		let pos = reverse ? clamp(center, span, length - 3) : clamp(center, 2, length - span);
		const overlap = Math.max(1, p.density * p.size);
		const amp = (voice.vel * envelope * 0.42 * source.gain) / Math.sqrt(overlap);
		this.flip = !this.flip;
		const pan = (this.flip ? 1 : -1) * p.width * (0.25 + 0.75 * this.noise.unit());
		const angle = (pan + 1) * Math.PI * 0.25;
		grain.active = true;
		grain.data = data;
		grain.pos = pos;
		grain.inc = inc;
		grain.len = len;
		grain.age = 0;
		grain.offset = at;
		grain.gl = Math.cos(angle) * amp;
		grain.gr = Math.sin(angle) * amp;
	}

	post(L, R, start, end) {
		const scale = WINDOW_SIZE;
		for (const g of this.grains) {
			if (!g.active) continue;
			const data = g.data;
			const from = Math.max(start, g.offset);
			g.offset = 0;
			const len = g.len;
			const attackLen = len * ATTACK;
			const releaseLen = len - attackLen;
			let pos = g.pos;
			let age = g.age;
			const inc = g.inc;
			const gl = g.gl;
			const gr = g.gr;
			for (let i = from; i < end; i++) {
				if (age >= len) {
					g.active = false;
					break;
				}
				const w = age < attackLen ? WINDOW[((age / attackLen) * scale) | 0] : WINDOW[(((len - age) / releaseLen) * scale) | 0];
				const idx = pos | 0;
				const frac = pos - idx;
				const s = data[idx] + (data[idx + 1] - data[idx]) * frac;
				const y = s * w;
				L[i] += y * gl;
				R[i] += y * gr;
				pos += inc;
				age++;
			}
			g.pos = pos;
			g.age = age;
			if (age >= len) g.active = false;
		}
	}
}
