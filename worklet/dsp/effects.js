// Effects that need custom DSP: the tuned resonator, the rhythmic harmonic
// shifter, lo-fi, pump, squash, and the master leveler and limiter. Effects
// read the shared tuning and transport from `ctx`.

import { Noise, SVF, OnePole, DelayLine, clamp, lerp, panGains, sin1, softClip } from './core.js';
import { indexValue, oddPart, rootHz } from '../../js/tuning.js';
import { effectDefaults } from '../../js/instruments.js';

// The song renders before any effect in the same audio block and leaves
// ctx.beat at the block's end; this is the beat at the block's first sample.
function blockStartBeat(ctx, n, samplesPerBeat) {
	return Math.max(0, ctx.beat - n / samplesPerBeat);
}

// --- Resonator ---------------------------------------------------------------

const RES_COUNT = 6;
const RES_MODES = 6;
const LOOP_SIZE = 4096;
const LOOP_MASK = LOOP_SIZE - 1;

// Palette degrees ordered by harmonic simplicity: the root first, then the
// degrees whose harmonics are smallest.
function simpleDegrees(palette) {
	return palette
		.map((h, degree) => ({ degree, weight: degree === 0 ? 0 : oddPart(h) }))
		.sort((a, b) => a.weight - b.weight)
		.map((d) => d.degree);
}

export class ResonatorFx {
	constructor(sr, ctx) {
		this.sr = sr;
		this.ctx = ctx;
		this.params = effectDefaults('resonator');
		const size = RES_COUNT * RES_MODES;
		this.a1 = new Float32Array(size);
		this.a2 = new Float32Array(size);
		this.g = new Float32Array(size);
		this.y1 = new Float32Array(size);
		this.y2 = new Float32Array(size);
		this.loops = Array.from({ length: RES_COUNT }, () => ({
			buf: new Float32Array(LOOP_SIZE),
			w: 0,
			m: 100,
			eta: 0,
			apx: 0,
			apy: 0,
			lp: 0,
			gain: 0.99,
		}));
		this.pans = Array.from({ length: RES_COUNT }, (_, i) => panGains((i % 2 ? 0.6 : -0.6) * (0.4 + (i / RES_COUNT) * 0.6)));
		this.freqs = new Float32Array(RES_COUNT);
		this.inFilter = new SVF();
		this.inHp = new OnePole();
		this.mono = new Float32Array(128);
		this.wetL = new Float32Array(128);
		this.wetR = new Float32Array(128);
		this.signature = '';
		this.energy = 0;
		this.mix = this.params.mix;
		this.level = 0;
		this.levelAttack = 1 - Math.exp(-1 / (0.004 * sr));
		this.levelRelease = 1 - Math.exp(-1 / (0.25 * sr));
	}

	setParams(params) {
		Object.assign(this.params, params);
	}

	retune() {
		const { palette, root } = this.ctx;
		const p = this.params;
		const signature = `${palette.join(',')}|${root}|${p.mode}|${p.decay}|${p.color}|${p.chord}`;
		if (signature === this.signature) return;
		this.signature = signature;
		const sr = this.sr;
		const n = palette.length;
		const order = simpleDegrees(palette);
		const k = Math.min(order.length, 2 + Math.round(p.chord * 3));
		const base = rootHz(root);
		for (let i = 0; i < RES_COUNT; i++) {
			const degree = order[i % k];
			const octave = Math.floor((i * 3) / RES_COUNT) - 1;
			this.freqs[i] = base * indexValue(palette, degree + octave * n);
		}
		const tilt = lerp(1.6, 0.4, p.color);
		for (let i = 0; i < RES_COUNT; i++) {
			const f0 = this.freqs[i];
			let energy = 0;
			for (let m = 0; m < RES_MODES; m++) {
				const idx = i * RES_MODES + m;
				const f = f0 * (m + 1);
				if (f > sr * 0.45) {
					this.g[idx] = 0;
					this.a1[idx] = 0;
					this.a2[idx] = 0;
					continue;
				}
				const t60 = Math.max(0.05, p.decay * (1 / (m + 1)) ** (0.8 - p.color * 0.5));
				const r = Math.exp(-6.907755 / (t60 * sr));
				const w = (2 * Math.PI * f) / sr;
				const amp = (m + 1) ** -tilt;
				this.a1[idx] = 2 * r * Math.cos(w);
				this.a2[idx] = r * r;
				// Between impulse normalization (rings loudly on transients) and
				// resonance normalization (never builds up on sustained tones).
				this.g[idx] = amp * (1 - r) ** 0.62 * Math.sin(w);
				energy += amp * amp;
			}
			const norm = 2.2 / Math.sqrt(Math.max(energy, 1e-6));
			for (let m = 0; m < RES_MODES; m++) this.g[i * RES_MODES + m] *= norm;
			// Karplus-Strong loop for the strings body.
			const loop = this.loops[i];
			const period = clamp(sr / f0, 4, LOOP_SIZE - 8);
			loop.m = Math.floor(period - 1.5);
			const d = period - 1 - loop.m;
			loop.eta = (1 - d) / (1 + d);
			loop.damp = lerp(0.55, 0.05, p.color);
			loop.gain = Math.min(0.9995, 10 ** (-3 / (Math.max(p.decay, 0.05) * f0)));
		}
		this.inFilter.set(lerp(1500, 9000, p.color), 0.5, sr);
		this.inHp.setFreq(60, sr);
	}

	process(inL, inR, outL, outR, n) {
		const p = this.params;
		this.retune();
		let inPeak = 0;
		const mono = this.mono;
		for (let i = 0; i < n; i++) {
			const x = (inL[i] + inR[i]) * 0.5;
			mono[i] = this.inHp.hp(this.inFilter.lp(x));
			const a = x < 0 ? -x : x;
			if (a > inPeak) inPeak = a;
		}
		const wetL = this.wetL;
		const wetR = this.wetR;
		wetL.fill(0, 0, n);
		wetR.fill(0, 0, n);
		if (inPeak > 1e-7 || this.energy > 1e-7) {
			let energy = 0;
			if (p.mode === 'strings') energy = this.processStrings(n);
			else energy = this.processModal(n);
			this.energy = energy;
		}
		// Level the wet signal: sustained tones on a resonator's own pitch would
		// otherwise build up far louder than the input.
		const target = p.mix;
		const attack = this.levelAttack;
		const release = this.levelRelease;
		let level = this.level;
		for (let i = 0; i < n; i++) {
			const a = Math.max(Math.abs(wetL[i]), Math.abs(wetR[i]));
			level += (a - level) * (a > level ? attack : release);
			const gain = level > 0.35 ? 0.35 / level : 1;
			this.mix += (target - this.mix) * 0.002;
			const dry = 1 - this.mix;
			const wet = this.mix * gain;
			outL[i] = inL[i] * dry + softClip(wetL[i] * wet * 1.2) * 0.85;
			outR[i] = inR[i] * dry + softClip(wetR[i] * wet * 1.2) * 0.85;
		}
		this.level = level;
	}

	processModal(n) {
		const mono = this.mono;
		let energy = 0;
		for (let r = 0; r < RES_COUNT; r++) {
			const [gl, gr] = this.pans[r];
			for (let m = 0; m < RES_MODES; m++) {
				const idx = r * RES_MODES + m;
				const g = this.g[idx];
				if (!g) continue;
				const a1 = this.a1[idx];
				const a2 = this.a2[idx];
				let y1 = this.y1[idx];
				let y2 = this.y2[idx];
				for (let i = 0; i < n; i++) {
					const y = a1 * y1 - a2 * y2 + g * mono[i];
					y2 = y1;
					y1 = y;
					this.wetL[i] += y * gl;
					this.wetR[i] += y * gr;
				}
				if (Math.abs(y1) < 1e-12) y1 = 0;
				if (Math.abs(y2) < 1e-12) y2 = 0;
				this.y1[idx] = y1;
				this.y2[idx] = y2;
				energy += Math.abs(y1) + Math.abs(y2);
			}
		}
		return energy;
	}

	processStrings(n) {
		const mono = this.mono;
		let energy = 0;
		for (let r = 0; r < RES_COUNT; r++) {
			const loop = this.loops[r];
			const [gl, gr] = this.pans[r];
			const buf = loop.buf;
			const { m, eta, gain, damp } = loop;
			let { w, apx, apy, lp } = loop;
			for (let i = 0; i < n; i++) {
				const rd = buf[(w - m) & LOOP_MASK];
				const ap = eta * rd + apx - eta * apy;
				apx = rd;
				apy = ap;
				lp += (ap - lp) * (1 - damp);
				buf[w] = lp * gain + mono[i] * 0.08;
				w = (w + 1) & LOOP_MASK;
				this.wetL[i] += ap * gl;
				this.wetR[i] += ap * gr;
				energy += ap < 0 ? -ap : ap;
			}
			loop.w = w;
			loop.apx = apx;
			loop.apy = apy;
			loop.lp = Math.abs(lp) < 1e-12 ? 0 : lp;
		}
		return energy / n;
	}
}

// --- Shifter -----------------------------------------------------------------

const LENGTH_BEATS = { '1/16': 0.25, '1/8': 0.5, '1/8t': 1 / 3, '1/4': 1, '1/2': 2 };

// Records one slice of the beat while replaying the previous slice at a
// palette ratio. Slices swap exactly on the beat grid.
export class ShifterFx {
	constructor(sr, ctx) {
		this.sr = sr;
		this.ctx = ctx;
		this.params = effectDefaults('shifter');
		const max = Math.ceil(sr * 2.4);
		this.max = max;
		this.bufs = [
			[new Float32Array(max), new Float32Array(max)],
			[new Float32Array(max), new Float32Array(max)],
		];
		this.rec = 0;
		this.recPos = 0;
		this.playLen = 0;
		this.playPos = 0;
		this.dir = 1;
		this.playing = false;
		this.slice = -1;
		this.flip = 1;
		this.freeBeat = 0;
		this.fbL = 0;
		this.fbR = 0;
		this.fbFilterL = new OnePole();
		this.fbFilterR = new OnePole();
		this.fbFilterL.setFreq(5000, sr);
		this.fbFilterR.setFreq(5000, sr);
		this.mix = this.params.mix;
		this.pan = [0.7071, 0.7071];
	}

	setParams(params) {
		Object.assign(this.params, params);
	}

	swap() {
		const played = this.rec;
		this.rec = 1 - this.rec;
		this.playBuf = this.bufs[played];
		this.playLen = this.recPos;
		this.recPos = 0;
		this.playPos = 0;
		this.dir = 1;
		this.playing = this.playLen > 64;
		this.flip = -this.flip;
		this.pan = panGains(this.flip * this.params.spread);
	}

	process(inL, inR, outL, outR, n) {
		const p = this.params;
		const ctx = this.ctx;
		const sr = this.sr;
		const lengthBeats = LENGTH_BEATS[p.length] || 0.5;
		const samplesPerBeat = (60 / ctx.bpm) * sr;
		const ratio = indexValue(ctx.palette, Math.round(p.shift));
		const startBeat = ctx.playing ? blockStartBeat(ctx, n, samplesPerBeat) : this.freeBeat;
		this.freeBeat = startBeat + n / samplesPerBeat;
		const feedback = p.feedback;
		const recL = this.bufs[this.rec][0];
		const recR = this.bufs[this.rec][1];
		let rl = recL;
		let rr = recR;
		for (let i = 0; i < n; i++) {
			const beat = startBeat + i / samplesPerBeat;
			const slice = Math.floor(beat / lengthBeats);
			if (slice !== this.slice) {
				this.slice = slice;
				this.swap();
				rl = this.bufs[this.rec][0];
				rr = this.bufs[this.rec][1];
			}
			let wl = 0;
			let wr = 0;
			if (this.playing) {
				const len = this.playLen;
				const pos = this.playPos;
				const idx = pos | 0;
				const frac = pos - idx;
				const next = Math.min(idx + 1, len - 1);
				const bl = this.playBuf[0];
				const br = this.playBuf[1];
				const fade = Math.max(48, len * 0.03);
				const env = Math.min(1, pos / fade, (len - pos) / fade);
				wl = (bl[idx] + (bl[next] - bl[idx]) * frac) * env;
				wr = (br[idx] + (br[next] - br[idx]) * frac) * env;
				this.playPos += ratio * this.dir;
				if (this.playPos >= len - 1 || this.playPos < 0) {
					if (p.mode === 'once') {
						this.playing = false;
					} else if (p.mode === 'bounce') {
						this.dir = -this.dir;
						this.playPos = clamp(this.playPos, 0, len - 1.001);
						this.flip = -this.flip;
						this.pan = panGains(this.flip * p.spread);
					} else {
						this.playPos -= (len - 1) * Math.sign(this.dir);
						this.flip = -this.flip;
						this.pan = panGains(this.flip * p.spread);
					}
				}
			}
			this.fbL = this.fbFilterL.lp(wl);
			this.fbR = this.fbFilterR.lp(wr);
			if (this.recPos < this.max) {
				rl[this.recPos] = inL[i] + this.fbL * feedback;
				rr[this.recPos] = inR[i] + this.fbR * feedback;
				this.recPos++;
			}
			this.mix += (p.mix - this.mix) * 0.002;
			const [gl, gr] = this.pan;
			const mono = (wl + wr) * 0.5;
			const wetL = lerp(wl, mono * gl * 1.4142, p.spread);
			const wetR = lerp(wr, mono * gr * 1.4142, p.spread);
			outL[i] = inL[i] * (1 - this.mix) + wetL * this.mix;
			outR[i] = inR[i] * (1 - this.mix) + wetR * this.mix;
		}
	}
}

// --- Lo-fi -------------------------------------------------------------------

export class LofiFx {
	constructor(sr, ctx) {
		this.sr = sr;
		this.ctx = ctx;
		this.params = effectDefaults('lofi');
		this.dl = new DelayLine(Math.ceil(sr * 0.03));
		this.dr = new DelayLine(Math.ceil(sr * 0.03));
		this.noise = new Noise(0x10f1);
		this.lpL = new SVF();
		this.lpR = new SVF();
		this.hpL = new OnePole();
		this.hpR = new OnePole();
		this.crackle = new OnePole();
		this.wow = 0;
		this.flutter = 0;
		this.holdL = 0;
		this.holdR = 0;
		this.holdCount = 0;
		this.tone = -1;
	}

	setParams(params) {
		Object.assign(this.params, params);
	}

	process(inL, inR, outL, outR, n) {
		const p = this.params;
		const sr = this.sr;
		if (p.tone !== this.tone) {
			this.tone = p.tone;
			const cutoff = lerp(2200, 14000, p.tone);
			this.lpL.set(cutoff, 0.6, sr);
			this.lpR.set(cutoff, 0.6, sr);
			this.hpL.setFreq(70, sr);
			this.hpR.setFreq(70, sr);
			this.crackle.setFreq(3000, sr);
		}
		const bits = lerp(15, 5, p.crush);
		const steps = 2 ** bits;
		const hold = p.crush > 0.66 ? 4 : p.crush > 0.33 ? 2 : 1;
		const depth = p.wobble * 0.0022 * sr;
		const base = 0.004 * sr + depth;
		const wowInc = 0.5625 / sr; // 48 × 3/256 Hz
		const flutterInc = 6.75 / sr; // 48 × 9/64 Hz
		const crackleChance = p.dust * p.dust * 0.0009;
		const hiss = p.dust * 0.006;
		const mix = p.mix;
		for (let i = 0; i < n; i++) {
			this.dl.write(inL[i]);
			this.dr.write(inR[i]);
			this.wow += wowInc;
			if (this.wow >= 1) this.wow -= 1;
			this.flutter += flutterInc;
			if (this.flutter >= 1) this.flutter -= 1;
			const mod = sin1(this.wow) * 0.85 + sin1(this.flutter) * 0.15;
			const delay = base + depth * mod;
			let l = this.dl.read(delay);
			let r = this.dr.read(delay);
			if (++this.holdCount >= hold) {
				this.holdCount = 0;
				this.holdL = Math.round(l * steps) / steps;
				this.holdR = Math.round(r * steps) / steps;
			}
			l = this.holdL;
			r = this.holdR;
			let dust = this.noise.next() * hiss;
			if (this.noise.unit() < crackleChance) dust += this.noise.next() * p.dust * 0.5;
			dust = this.crackle.hp(dust);
			l = this.hpL.hp(this.lpL.lp(l)) + dust;
			r = this.hpR.hp(this.lpR.lp(r)) + dust;
			l = softClip(l * 1.1);
			r = softClip(r * 1.1);
			outL[i] = inL[i] * (1 - mix) + l * mix;
			outR[i] = inR[i] * (1 - mix) + r * mix;
		}
	}
}

// --- Pump ------------------------------------------------------------------------

const PUMP_BEATS = { '1/2': 2, '1/4': 1, '1/8': 0.5 };

// Sidechain-style ducking locked to the song's beat: the level drops at each
// beat (or half or double beat) and recovers exponentially. With the transport
// stopped the signal passes untouched.
export class PumpFx {
	constructor(sr, ctx) {
		this.sr = sr;
		this.ctx = ctx;
		this.params = effectDefaults('pump');
		this.gain = 1;
		this.smooth = 1 - Math.exp(-1 / (0.0015 * sr));
	}

	setParams(params) {
		Object.assign(this.params, params);
	}

	process(inL, inR, outL, outR, n) {
		const p = this.params;
		const ctx = this.ctx;
		const samplesPerBeat = (60 / ctx.bpm) * this.sr;
		const period = PUMP_BEATS[p.rate] || 1;
		const depth = p.depth;
		// Recovery time constant as a fraction of the period.
		const tau = lerp(0.06, 0.32, p.release);
		const start = blockStartBeat(ctx, n, samplesPerBeat);
		let gain = this.gain;
		for (let i = 0; i < n; i++) {
			let target = 1;
			if (ctx.playing) {
				let phase = (start + i / samplesPerBeat) / period;
				phase -= Math.floor(phase);
				target = 1 - depth * Math.exp(-phase / tau);
			}
			// A short slew keeps the drop at each beat from clicking.
			gain += (target - gain) * this.smooth;
			outL[i] = inL[i] * gain;
			outR[i] = inR[i] * gain;
		}
		this.gain = gain;
	}
}

// --- Squash --------------------------------------------------------------------
//
// Three-band upward and downward compression, the multiband trick of neuro and
// dubstep production: each band is pulled toward its own level, so quiet grit
// and fizz come up while peaks come down. The bands split at 120 Hz and 2.5 kHz
// with complementary filters, so untouched they add back to the input exactly.

const SQUASH_SPLITS = [120, 2500];
const SQUASH_TARGET = [0.15, 0.1, 0.06];
// Below this fraction of its target a band is left alone, so silence stays silent.
const SQUASH_FLOOR = 0.004;
const SQUASH_DOWN = 0.6;
const SQUASH_TRIM = 0.7;

export class SquashFx {
	constructor(sr) {
		this.sr = sr;
		this.params = effectDefaults('squash');
		this.split = [0, 1].map(() => SQUASH_SPLITS.map((f) => {
			const lp = new OnePole();
			lp.setFreq(f, sr);
			return lp;
		}));
		this.env = new Float32Array(3);
		this.gain = new Float32Array(3).fill(1);
		this.bandL = new Float32Array(3);
		this.bandR = new Float32Array(3);
		this.time = -1;
		this.count = 0;
	}

	setParams(params) {
		Object.assign(this.params, params);
	}

	// Splits one channel into low, mid, and high bands.
	bands(x, [lo, mid], out) {
		const low = lo.lp(x);
		const rest = x - low;
		const m = mid.lp(rest);
		out[0] = low;
		out[1] = m;
		out[2] = rest - m;
	}

	process(inL, inR, outL, outR, n) {
		const p = this.params;
		const sr = this.sr;
		if (p.time !== this.time) {
			this.time = p.time;
			this.attack = 1 - Math.exp(-1 / (lerp(0.0005, 0.01, p.time) * sr));
			this.release = 1 - Math.exp(-1 / (lerp(0.004, 0.12, p.time) * sr));
		}
		const up = p.upward * 0.8;
		const maxUp = 1 + p.upward * 15;
		const depth = p.depth;
		const { env, gain, bandL, bandR } = this;
		for (let i = 0; i < n; i++) {
			const xl = inL[i];
			const xr = inR[i];
			this.bands(xl, this.split[0], bandL);
			this.bands(xr, this.split[1], bandR);
			// Gains follow the envelopes every few samples, which is plenty at these
			// speeds, except that a sample louder than its envelope (a hit after
			// quiet) takes effect at once, so upward gain never spikes a transient.
			const update = ++this.count >= 4;
			if (update) this.count = 0;
			let yl = 0;
			let yr = 0;
			for (let b = 0; b < 3; b++) {
				const l = bandL[b];
				const r = bandR[b];
				const a = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
				const rising = a > env[b];
				env[b] += (a - env[b]) * (rising ? this.attack : this.release);
				if (update || rising) {
					const target = SQUASH_TARGET[b];
					const e = rising ? a : env[b];
					if (e > target) gain[b] = (target / e) ** SQUASH_DOWN;
					else if (e > target * SQUASH_FLOOR) gain[b] = Math.min(maxUp, (target / e) ** up);
					else gain[b] = 1;
				}
				yl += l * gain[b];
				yr += r * gain[b];
			}
			outL[i] = xl + (yl * SQUASH_TRIM - xl) * depth;
			outR[i] = xr + (yr * SQUASH_TRIM - xr) * depth;
		}
	}
}

export const WORKLET_EFFECTS = { resonator: ResonatorFx, shifter: ShifterFx, lofi: LofiFx, pump: PumpFx, squash: SquashFx };

// --- Master ---------------------------------------------------------------------
//
// The output always peaks at -0.3 dBFS. The leveler slowly brings the song's
// recent peaks to that ceiling and then a few dB past it (the song's
// loudness setting); the soft clipper rounds those peaks off and the
// look-ahead limiter catches what is left. Quiet passages come up slowly,
// sudden loud ones are pulled down within about ten milliseconds, and
// silence holds the gain.

export const CEILING = 0.966;
// How far past the ceiling peaks are pushed at full loudness, in dB.
const MAX_DRIVE_DB = 3;
const MAX_GAIN = 16;
// The song's peak level is the highest peak of the last few seconds.
const PEAK_HOP = 4096;
const PEAK_HOPS = 48;

export class Leveler {
	constructor(sr) {
		this.sr = sr;
		this.gain = 0;
		this.heard = 0;
		this.hops = new Float32Array(PEAK_HOPS);
		this.hop = 0;
		this.hopPeak = 0;
		this.hopFill = 0;
		this.setLoudness(0.85);
	}

	// Loudness from 0 (peaks just reach the ceiling) to 1 (pushed MAX_DRIVE_DB past it).
	setLoudness(value) {
		this.drive = 10 ** ((clamp(value, 0, 1) * MAX_DRIVE_DB) / 20);
	}

	process(L, R, n) {
		let blockPeak = 0;
		for (let i = 0; i < n; i++) {
			const a = Math.max(L[i] < 0 ? -L[i] : L[i], R[i] < 0 ? -R[i] : R[i]);
			if (a > blockPeak) blockPeak = a;
		}
		const start = this.gain;
		let end = start;
		// Silence holds everything, so a pause does not wind the gain up.
		if (blockPeak > 1e-4) {
			if (blockPeak > this.hopPeak) this.hopPeak = blockPeak;
			this.hopFill += n;
			if (this.hopFill >= PEAK_HOP) {
				this.hops[this.hop] = this.hopPeak;
				this.hop = (this.hop + 1) % PEAK_HOPS;
				this.hopPeak = 0;
				this.hopFill = 0;
			}
			let peak = this.hopPeak;
			for (let k = 0; k < PEAK_HOPS; k++) if (this.hops[k] > peak) peak = this.hops[k];
			const desired = Math.min(MAX_GAIN, (CEILING * this.drive) / peak);
			// The first sound starts at no more than unity, and the gain settles
			// quickly for the first two seconds, then follows the song slowly.
			const from = start === 0 ? Math.min(desired, 1) : start;
			const settling = this.heard < 2 * this.sr;
			this.heard += n;
			const time = desired < from ? 0.01 : settling ? 0.3 : 1.5;
			end = from + (desired - from) * (1 - Math.exp(-n / (time * this.sr)));
		}
		const step = (end - start) / n;
		let g = start;
		for (let i = 0; i < n; i++) {
			g += step;
			L[i] *= g;
			R[i] *= g;
		}
		this.gain = end;
	}
}

// Rounds off peaks above about -4.4 dBFS, smoothly reaching full scale at
// +5 dB, so the limiter after it has little left to do.
const CLIP_KNEE = 0.6;

export function masterClip(L, R, n) {
	const span = 1 - CLIP_KNEE;
	for (let i = 0; i < n; i++) {
		for (const buf of [L, R]) {
			const x = buf[i];
			const a = x < 0 ? -x : x;
			if (a > CLIP_KNEE) {
				const y = CLIP_KNEE + span * softClip((a - CLIP_KNEE) / span);
				buf[i] = x < 0 ? -y : y;
			}
		}
	}
}

// --- Master limiter ------------------------------------------------------------

// Look-ahead peak limiter: the gain is the sliding minimum of the required
// gain, smoothed by a moving average over the same window, applied to audio
// delayed by that window. The output never exceeds the ceiling.
export class Limiter {
	constructor(sr, ceiling = CEILING) {
		this.sr = sr;
		this.ceiling = ceiling;
		const look = Math.max(16, Math.round(sr * 0.003));
		this.look = look;
		this.delayL = new Float32Array(look);
		this.delayR = new Float32Array(look);
		this.pos = 0;
		// Monotonic deque for the sliding minimum over look + 1 samples, so every
		// gain averaged for a delayed sample has already seen that sample's peak.
		this.qv = new Float32Array(look + 2);
		this.qt = new Float64Array(look + 2);
		this.head = 0;
		this.tail = 0;
		this.t = 0;
		this.release = 1 - Math.exp(-1 / (0.12 * sr));
		this.smooth = 1;
		this.avgBuf = new Float32Array(look).fill(1);
		this.avgSum = look;
		this.avgPos = 0;
		this.reduction = 1;
	}

	process(L, R, n) {
		const look = this.look;
		const size = look + 2;
		let minGain = 1;
		for (let i = 0; i < n; i++) {
			const l = L[i];
			const r = R[i];
			const peak = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
			const need = peak > this.ceiling ? this.ceiling / peak : 1;
			const t = this.t++;
			// Push into the deque, dropping larger values from the back.
			while (this.tail !== this.head) {
				const back = (this.tail - 1 + size) % size;
				if (this.qv[back] >= need) this.tail = back;
				else break;
			}
			this.qv[this.tail] = need;
			this.qt[this.tail] = t + look + 1;
			this.tail = (this.tail + 1) % size;
			while (this.qt[this.head] <= t) this.head = (this.head + 1) % size;
			const windowMin = this.qv[this.head];
			if (windowMin < this.smooth) this.smooth = windowMin;
			else this.smooth += (windowMin - this.smooth) * this.release;
			this.avgSum += this.smooth - this.avgBuf[this.avgPos];
			this.avgBuf[this.avgPos] = this.smooth;
			this.avgPos = (this.avgPos + 1) % look;
			const gain = Math.min(1, this.avgSum / look);
			const dl = this.delayL[this.pos];
			const dr = this.delayR[this.pos];
			this.delayL[this.pos] = l;
			this.delayR[this.pos] = r;
			this.pos = (this.pos + 1) % look;
			L[i] = clamp(dl * gain, -this.ceiling, this.ceiling);
			R[i] = clamp(dr * gain, -this.ceiling, this.ceiling);
			if (gain < minGain) minGain = gain;
		}
		this.reduction = minGain;
	}
}
