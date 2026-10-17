// Additive synthesis from families of harmonics. Every partial is a
// whole-number harmonic of the note, so the tone stays in the tuning whatever
// family is chosen. Partials alternate across the stereo
// field and drift slowly in level ("shimmer").

import { PolyEngine, Voice } from '../poly.js';
import { Env, clamp, lerp, panGains } from '../core.js';
import { instrumentDefaults } from '../../../js/instruments.js';
import { oddPart } from '../../../js/tuning.js';

const MAX_PARTIALS = 24;

function isPrime(n) {
	if (n < 2) return false;
	for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;
	return true;
}

function isThreeSmooth(n) {
	while (n % 2 === 0) n /= 2;
	while (n % 3 === 0) n /= 3;
	return n === 1;
}

const FIBONACCI = new Set([1, 2, 3, 5, 8, 13, 21, 34, 55, 89]);
const SEEKER_CORES = new Set([1, 3, 7, 9, 19, 21]);

const FAMILY_TESTS = {
	all: () => true,
	odd: (n) => n % 2 === 1,
	seeker: (n) => SEEKER_CORES.has(oddPart(n)),
	primes: (n) => n <= 2 || isPrime(n),
	fifths: (n) => isThreeSmooth(n),
	octaves: (n) => (n & (n - 1)) === 0 || n === 3 || n === 6,
	fibonacci: (n) => FIBONACCI.has(n),
};

export function familyHarmonics(family, count) {
	const test = FAMILY_TESTS[family] || FAMILY_TESTS.all;
	const out = [];
	for (let n = 1; out.length < count && n <= 128; n++) if (test(n)) out.push(n);
	return out;
}

const SCRATCH_ENV = new Float32Array(128);
const SCRATCH_L = new Float32Array(128);
const SCRATCH_R = new Float32Array(128);

class OrganVoice extends Voice {
	constructor(sr, engine, seed) {
		super();
		this.sr = sr;
		this.engine = engine;
		this.env = new Env(sr);
		this.seed = seed;
		this.count = 0;
		this.c = new Float64Array(MAX_PARTIALS);
		this.s = new Float64Array(MAX_PARTIALS);
		this.cw = new Float64Array(MAX_PARTIALS);
		this.sw = new Float64Array(MAX_PARTIALS);
		this.amp = new Float32Array(MAX_PARTIALS);
		this.base = new Float32Array(MAX_PARTIALS);
		this.pl = new Float32Array(MAX_PARTIALS);
		this.pr = new Float32Array(MAX_PARTIALS);
		this.lfo = new Float32Array(MAX_PARTIALS);
		this.lfoInc = new Float32Array(MAX_PARTIALS);
		this.vel = 0;
	}

	level() {
		return this.env.value * this.vel;
	}

	start(freq, vel) {
		const p = this.engine.params;
		const sr = this.sr;
		const wasActive = this.active && !this.released && Math.abs(freq - this.freq) < 0.01;
		this.freq = freq;
		this.vel = vel;
		const harmonics = familyHarmonics(p.family, Math.round(clamp(p.partials, 1, MAX_PARTIALS)));
		const tilt = lerp(1.9, 0.55, p.tone);
		let count = 0;
		let energy = 0;
		let seed = this.seed;
		for (let k = 0; k < harmonics.length; k++) {
			const h = harmonics[k];
			const f = freq * h;
			if (f > sr * 0.42) break;
			const w = (2 * Math.PI * f) / sr;
			// Fade partials approaching the top of the spectrum.
			const edge = clamp((sr * 0.42 - f) / (sr * 0.08), 0, 1);
			const a = h ** -tilt * edge;
			this.base[count] = a;
			energy += a * a;
			this.cw[count] = Math.cos(w);
			this.sw[count] = Math.sin(w);
			if (!wasActive) {
				seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
				const phase = (seed / 4294967296) * 2 * Math.PI;
				this.c[count] = Math.cos(phase);
				this.s[count] = Math.sin(phase);
				this.amp[count] = 0;
				this.lfo[count] = seed / 4294967296;
			}
			// Each partial drifts at its own slow harmonic rate: 48 × (2k + 3) / 4096 Hz.
			this.lfoInc[count] = (48 * (2 * k + 3)) / 4096 / sr;
			const pan = k === 0 ? 0 : (k % 2 ? 1 : -1) * p.width * (0.25 + 0.75 * Math.min(1, k / 6));
			const [gl, gr] = panGains(pan);
			this.pl[count] = gl;
			this.pr[count] = gr;
			count++;
		}
		this.count = count;
		const norm = 0.13 / Math.sqrt(Math.max(energy, 1e-6));
		for (let k = 0; k < count; k++) this.base[k] *= norm;
		this.env.set(p.attack, 0.5, 1, p.release);
		this.env.trigger();
	}

	release() {
		this.env.set(this.engine.params.attack, 0.5, 1, this.engine.params.release);
		this.env.release();
	}

	render(L, R, start, end) {
		const n = end - start;
		const env = this.env;
		const vel = this.vel;
		for (let i = 0; i < n; i++) SCRATCH_ENV[i] = env.next() * vel;
		SCRATCH_L.fill(0, 0, n);
		SCRATCH_R.fill(0, 0, n);
		const motion = this.engine.params.motion * 0.85;
		const inv = 1 / n;
		for (let k = 0; k < this.count; k++) {
			let lfo = this.lfo[k] + this.lfoInc[k] * n;
			if (lfo >= 1) lfo -= 1;
			this.lfo[k] = lfo;
			const wave = Math.sin(2 * Math.PI * lfo);
			const target = this.base[k] * (1 - motion * (0.5 + 0.5 * wave));
			let a = this.amp[k];
			const da = (target - a) * inv;
			let c = this.c[k];
			let s = this.s[k];
			const cw = this.cw[k];
			const sw = this.sw[k];
			const pl = this.pl[k];
			const pr = this.pr[k];
			for (let i = 0; i < n; i++) {
				const c2 = c * cw - s * sw;
				s = s * cw + c * sw;
				c = c2;
				a += da;
				const y = s * a;
				SCRATCH_L[i] += y * pl;
				SCRATCH_R[i] += y * pr;
			}
			// Keep the rotating phasor on the unit circle.
			const mag = 1 / Math.sqrt(c * c + s * s);
			this.c[k] = c * mag;
			this.s[k] = s * mag;
			this.amp[k] = a;
		}
		for (let i = 0; i < n; i++) {
			const e = SCRATCH_ENV[i];
			L[start + i] += SCRATCH_L[i] * e;
			R[start + i] += SCRATCH_R[i] * e;
		}
		if (!env.active) this.active = false;
	}
}

export class OrganEngine extends PolyEngine {
	constructor(sr, ctx) {
		const voices = [];
		super(sr, ctx, voices, instrumentDefaults('organ'));
		for (let i = 0; i < 10; i++) voices.push(new OrganVoice(sr, this, 0x0a6a + i * 7919));
	}
}
