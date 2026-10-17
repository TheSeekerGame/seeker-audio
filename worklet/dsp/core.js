// Shared DSP building blocks. Everything here is plain JavaScript with no
// browser globals, so the same code runs in the audio worklet, on the main
// thread (to synthesize grain sources), and in Node tests.

export const TAU = Math.PI * 2;

export const SINE_SIZE = 4096;
export const SINE = new Float32Array(SINE_SIZE + 1);
for (let i = 0; i <= SINE_SIZE; i++) SINE[i] = Math.sin((TAU * i) / SINE_SIZE);

// Sine of a phase measured in cycles, phase in [0, 1).
export function sin1(phase) {
	const x = phase * SINE_SIZE;
	const i = x | 0;
	const f = x - i;
	return SINE[i] + (SINE[i + 1] - SINE[i]) * f;
}

export function clamp(x, lo, hi) {
	return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a, b, t) {
	return a + (b - a) * t;
}

// Smooth saturation that stays within ±1 and is nearly linear for small input.
export function softClip(x) {
	if (x > 3) return 1;
	if (x < -3) return -1;
	const x2 = x * x;
	return (x * (27 + x2)) / (27 + 9 * x2);
}

// Per-sample coefficient that moves a one-pole filter ~99% of the way in `seconds`.
export function timeCoef(seconds, sr) {
	return 1 - Math.exp(-4.6 / (Math.max(seconds, 0.0002) * sr));
}

// Multiplier per sample that decays by 60 dB over `seconds`.
export function decayCoef(seconds, sr) {
	return Math.exp(-6.907755 / (Math.max(seconds, 0.001) * sr));
}

// White noise from a 32-bit xorshift.
export class Noise {
	constructor(seed = 0x9e3779b9) {
		this.s = seed >>> 0 || 1;
	}

	next() {
		let s = this.s;
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		this.s = s >>> 0;
		return (this.s / 2147483648) - 1;
	}

	unit() {
		return (this.next() + 1) * 0.5;
	}
}

// ADSR envelope with exponential segments.
export class Env {
	constructor(sr) {
		this.sr = sr;
		this.stage = 0; // 0 idle, 1 attack, 2 decay, 3 sustain, 4 release
		this.value = 0;
		this.set(0.005, 0.2, 1, 0.2);
	}

	set(attack, decay, sustain, release) {
		// The attack aims past 1 so it rises steadily rather than slowing near the top.
		this.attackCoef = 1 - Math.exp(-1.466 / (Math.max(attack, 0.0005) * this.sr));
		this.decayCoef = timeCoef(decay, this.sr);
		this.sustain = sustain;
		this.releaseCoef = timeCoef(release, this.sr);
	}

	trigger() {
		this.stage = 1;
	}

	release() {
		if (this.stage !== 0) this.stage = 4;
	}

	get active() {
		return this.stage !== 0;
	}

	next() {
		switch (this.stage) {
			case 1:
				this.value += (1.3 - this.value) * this.attackCoef;
				if (this.value >= 1) {
					this.value = 1;
					this.stage = this.sustain >= 1 ? 3 : 2;
				}
				break;
			case 2:
				this.value += (this.sustain - this.value) * this.decayCoef;
				if (Math.abs(this.value - this.sustain) < 1e-4) {
					this.value = this.sustain;
					this.stage = this.sustain <= 0 ? 0 : 3;
				}
				break;
			case 4:
				this.value -= this.value * this.releaseCoef;
				if (this.value < 1e-5) {
					this.value = 0;
					this.stage = 0;
				}
				break;
			default:
				break;
		}
		return this.value;
	}
}

// Topology-preserving state-variable filter (Cytomic). Call set() at control
// rate, then lp(), bp(), or hp() per sample.
export class SVF {
	constructor() {
		this.ic1 = 0;
		this.ic2 = 0;
		this.a1 = 0;
		this.a2 = 0;
		this.a3 = 0;
		this.k = 1;
	}

	set(freq, q, sr) {
		const g = Math.tan((Math.PI * clamp(freq, 10, sr * 0.48)) / sr);
		this.k = 1 / Math.max(q, 0.05);
		this.a1 = 1 / (1 + g * (g + this.k));
		this.a2 = g * this.a1;
		this.a3 = g * this.a2;
	}

	reset() {
		this.ic1 = 0;
		this.ic2 = 0;
	}

	lp(x) {
		const v3 = x - this.ic2;
		const v1 = this.a1 * this.ic1 + this.a2 * v3;
		const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
		this.ic1 = 2 * v1 - this.ic1;
		this.ic2 = 2 * v2 - this.ic2;
		return v2;
	}

	bp(x) {
		const v3 = x - this.ic2;
		const v1 = this.a1 * this.ic1 + this.a2 * v3;
		const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
		this.ic1 = 2 * v1 - this.ic1;
		this.ic2 = 2 * v2 - this.ic2;
		return v1;
	}

	hp(x) {
		const v3 = x - this.ic2;
		const v1 = this.a1 * this.ic1 + this.a2 * v3;
		const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
		this.ic1 = 2 * v1 - this.ic1;
		this.ic2 = 2 * v2 - this.ic2;
		return x - this.k * v1 - v2;
	}

	notch(x) {
		const v3 = x - this.ic2;
		const v1 = this.a1 * this.ic1 + this.a2 * v3;
		const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
		this.ic1 = 2 * v1 - this.ic1;
		this.ic2 = 2 * v2 - this.ic2;
		return x - this.k * v1;
	}

	// Band pass normalized to unity gain at its center.
	bpNorm(x) {
		return this.bp(x) * this.k;
	}

	snap() {
		if (Math.abs(this.ic1) < 1e-12) this.ic1 = 0;
		if (Math.abs(this.ic2) < 1e-12) this.ic2 = 0;
	}
}

export class OnePole {
	constructor() {
		this.z = 0;
		this.a = 1;
	}

	setFreq(freq, sr) {
		this.a = 1 - Math.exp((-TAU * clamp(freq, 1, sr * 0.49)) / sr);
	}

	lp(x) {
		this.z += (x - this.z) * this.a;
		return this.z;
	}

	hp(x) {
		this.z += (x - this.z) * this.a;
		return x - this.z;
	}

	reset() {
		this.z = 0;
	}
}

export class DCBlock {
	constructor() {
		this.x1 = 0;
		this.y1 = 0;
	}

	process(x) {
		const y = x - this.x1 + 0.995 * this.y1;
		this.x1 = x;
		this.y1 = y;
		return y;
	}
}

// PolyBLEP correction for a discontinuity at phase 0 with step dt.
export function polyBlep(t, dt) {
	if (t < dt) {
		t /= dt;
		return t + t - t * t - 1;
	}
	if (t > 1 - dt) {
		t = (t - 1) / dt;
		return t * t + t + t + 1;
	}
	return 0;
}

// Fractional delay line with linear and cubic reads.
export class DelayLine {
	constructor(size) {
		this.size = 1;
		while (this.size < size + 4) this.size *= 2;
		this.mask = this.size - 1;
		this.buf = new Float32Array(this.size);
		this.w = 0;
	}

	write(x) {
		this.buf[this.w] = x;
		this.w = (this.w + 1) & this.mask;
	}

	// Sample written `delay` samples before the latest one (delay 0 is the latest).
	read(delay) {
		const q = this.w - 1 - delay;
		const i = Math.floor(q);
		const f = q - i;
		const a = this.buf[i & this.mask];
		const b = this.buf[(i + 1) & this.mask];
		return a + (b - a) * f;
	}

	// Cubic read; delay must be at least 1.
	readCubic(delay) {
		const p = this.w - 1 - delay;
		const i = Math.floor(p);
		const f = p - i;
		const m = this.mask;
		const y0 = this.buf[(i - 1) & m];
		const y1 = this.buf[i & m];
		const y2 = this.buf[(i + 1) & m];
		const y3 = this.buf[(i + 2) & m];
		const c1 = 0.5 * (y2 - y0);
		const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
		const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
		return ((c3 * f + c2) * f + c1) * f + y1;
	}

	clear() {
		this.buf.fill(0);
	}
}

// Stereo ensemble: three modulated delay taps per side add width and motion.
// Its modulation rates are harmonic rates of 48 Hz.
export class Ensemble {
	constructor(sr) {
		this.sr = sr;
		this.dl = new DelayLine(Math.ceil(sr * 0.05));
		this.dr = new DelayLine(Math.ceil(sr * 0.05));
		this.phase = [0, 0.33, 0.66];
		this.rates = [0.375, 0.5625, 0.84375]; // 48 × 1/128, 3/256, 9/512
		this.mix = 0;
		this.depth = 0.5;
	}

	process(L, R, start, end) {
		if (this.mix <= 0.001) {
			for (let i = start; i < end; i++) {
				this.dl.write(L[i]);
				this.dr.write(R[i]);
			}
			return;
		}
		const sr = this.sr;
		const base = 0.011 * sr;
		const depth = (0.0015 + this.depth * 0.0035) * sr;
		const inc0 = this.rates[0] / sr;
		const inc1 = this.rates[1] / sr;
		const inc2 = this.rates[2] / sr;
		let p0 = this.phase[0];
		let p1 = this.phase[1];
		let p2 = this.phase[2];
		const wet = this.mix * 0.42;
		const dry = 1 - this.mix * 0.35;
		for (let i = start; i < end; i++) {
			const l = L[i];
			const r = R[i];
			this.dl.write(l);
			this.dr.write(r);
			const m0 = sin1(p0);
			const m1 = sin1(p1);
			const m2 = sin1(p2);
			const tl = this.dl.read(base + depth * m0) + this.dl.read(base + depth * m1) * 0.7 - this.dr.read(base + depth * m2) * 0.4;
			const tr = this.dr.read(base - depth * m0) + this.dr.read(base + depth * m2) * 0.7 - this.dl.read(base - depth * m1) * 0.4;
			L[i] = l * dry + tl * wet;
			R[i] = r * dry + tr * wet;
			p0 += inc0;
			if (p0 >= 1) p0 -= 1;
			p1 += inc1;
			if (p1 >= 1) p1 -= 1;
			p2 += inc2;
			if (p2 >= 1) p2 -= 1;
		}
		this.phase[0] = p0;
		this.phase[1] = p1;
		this.phase[2] = p2;
	}
}

// Equal-power pan gains for pan in [-1, 1].
export function panGains(pan) {
	const angle = (clamp(pan, -1, 1) + 1) * Math.PI * 0.25;
	return [Math.cos(angle), Math.sin(angle)];
}
