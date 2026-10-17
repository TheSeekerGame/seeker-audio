// Bass in fourteen models, each a different family of bass sound:
//   analog  saw-to-square through a warm resonant ladder filter
//   sub     an 808: sine with a pitch drop, saturation, and a click
//   acid    a 303: resonant ladder, accents, and slides between tied notes
//   reese   three saws, two drifting apart and back, one to each side
//   fm      two-operator FM with a decaying index and a growling feedback
//   wobble  a ladder filter swept by an LFO locked to the song's beat
//   finger  a plucked string with a sine underneath
//   square  a hollow pulse whose width breathes slowly
//   liquid  a soft reese of triangles under a dark, gentle filter
//   scream  a reese driven hard into a resonant band that rides the drift
//   grit    a reese with noise running into its distortion, so it crackles
//   hoover  octave-stacked pulses with fast width modulation and a scoop
//   neuro   FM from a harmonic tone, sine folding, and a comb tuned to the note
//   talk    a buzzy wave through vowel formants that glide on every note
// Pitch is always exact: the 808 drop, the scoops, and acid slides are
// transients that land on the note, and the reese's drift moves around it.
// Every model keeps its sub a clean sine outside the distortion and filters,
// and keeps the low end mono: only harmonics spread across the stereo field.

import { PolyEngine, Voice } from '../poly.js';
import { Env, Noise, OnePole, SVF, DelayLine, clamp, lerp, polyBlep, sin1, softClip, decayCoef } from '../core.js';
import { instrumentDefaults } from '../../../js/instruments.js';
import { StringLoop } from './strings.js';

const LN2 = Math.LN2;
const INV_TAU = 1 / (2 * Math.PI);
// Wobble periods in beats; reese drift rates in Hz (48 × 2^k / 256).
const WOBBLE_BEATS = [2, 1, 0.5, 1 / 3, 0.25];
const REESE_RATES = [0.1875, 0.375, 0.75, 1.5];

// Harmonics the neuro tone can sit on: an octave and a fifth up (6), two
// octaves and a third (5 is its octave below), three octaves and a third
// (10), and three octaves and a fifth (12). Any harmonic of a note is in tune.
const NEURO_HARMONICS = [3, 5, 6, 10, 12];
// Vowel formants (F1, F2, F3 in Hz): u, o, a, e, i; and the glides talk can make.
const VOWELS = [
	[300, 870, 2240],
	[570, 840, 2410],
	[730, 1090, 2440],
	[530, 1840, 2480],
	[270, 2290, 3010],
];
const VOWEL_PATHS = [
	[0, 2],
	[1, 4],
	[2, 3],
	[4, 0],
];
const FORMANT_GAIN = [1, 0.7, 0.3];
const FORMANT_Q = [5, 7, 9];
// Coefficients of swept filters are refreshed every few samples.
const CONTROL = 16;
// Level of the drifting waves against the center one in the reese family.
const DRIFTED = 0.7;

// Output trim per model, measured so every model has the same perceived
// (K-weighted) loudness: switching models changes timbre, not level.
export const LEVEL = { analog: 0.36, sub: 0.3, acid: 0.34, reese: 0.51, fm: 0.19, wobble: 0.36, finger: 0.43, square: 0.38, liquid: 0.64, scream: 0.67, grit: 0.41, hoover: 0.32, neuro: 0.23, talk: 0.61 };

function saw(phase, inc) {
	return 2 * phase - 1 - polyBlep(phase, inc);
}

function tri(phase) {
	return phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
}

function wrap(phase) {
	return phase - Math.floor(phase);
}

// Band-limited pulse of width w as the difference of two saws (no DC offset).
function pulse(phase, inc, w) {
	let p2 = phase - w;
	if (p2 < 0) p2 += 1;
	return saw(phase, inc) - saw(p2, inc);
}

// One-pole coefficient for a cutoff, cheap enough to compute every sample.
function coef(fc, sr) {
	const w = (2 * Math.PI * Math.min(fc, sr * 0.3)) / sr;
	return w / (1 + w);
}

// Four-pole ladder low-pass with saturating feedback: k from 0 to ~3.9 adds resonance.
class Ladder {
	constructor() {
		this.reset();
	}

	reset() {
		this.s1 = this.s2 = this.s3 = this.s4 = 0;
	}

	process(x, g, k) {
		const u = softClip(x - k * this.s4);
		this.s1 += g * (u - this.s1);
		this.s2 += g * (this.s1 - this.s2);
		this.s3 += g * (this.s2 - this.s3);
		this.s4 += g * (this.s3 - this.s4);
		return this.s4;
	}
}

const EXCITE = new Float32Array(4096);

class BassVoice extends Voice {
	constructor(sr, engine, seed) {
		super();
		this.sr = sr;
		this.engine = engine;
		this.env = new Env(sr);
		this.noise = new Noise(seed);
		this.ladder = new Ladder();
		this.ladderR = new Ladder();
		this.tone = new OnePole();
		this.lp = new OnePole();
		// Keeps the low end mono: only the side signal above this passes.
		this.side = new OnePole();
		this.side.setFreq(180, sr);
		this.bandL = new SVF();
		this.bandR = new SVF();
		this.formants = [new SVF(), new SVF(), new SVF()];
		this.combL = null;
		this.combR = null;
		this.control = 0;
		this.morph = 0;
		this.morphRate = 0;
		this.string = null;
		this.model = 'analog';
		this.p1 = 0;
		this.pSub = 0;
		this.pm = 0;
		this.pm2 = 0;
		this.prev = 0;
		this.lfo = 0;
		this.fenv = 0;
		this.fenvMul = 1;
		this.pitchEnv = 0;
		this.pitchMul = 1;
		this.click = 0;
		this.clickMul = 1;
		this.index = 0;
		this.indexMul = 1;
		this.target = 0;
		this.glideCoef = 1;
		this.vel = 0;
		this.accent = 0;
		this.peak = 0;
	}

	level() {
		return Math.max(this.env.value, this.peak) * this.vel;
	}

	start(freq, vel) {
		this.begin(freq, vel, false);
	}

	// A legato note: the pitch slides to the new note without retriggering.
	slide(freq, vel) {
		this.begin(freq, vel, true);
	}

	begin(freq, vel, legato) {
		const p = this.engine.params;
		const sr = this.sr;
		const model = LEVEL[p.model] ? p.model : 'analog';
		const fresh = !this.active || this.model !== model;
		this.model = model;
		this.target = freq;
		this.vel = vel;
		if (legato && !fresh) {
			this.glideCoef = 1 - Math.exp(-3 / (Math.max(p.glide, 0.005) * sr));
			this.fenv = Math.max(this.fenv, 0.35);
			this.accent = model === 'acid' && vel > 0.82 ? 1 : 0;
			return;
		}
		this.glideCoef = 1;
		this.freq = freq;
		if (fresh) {
			this.ladder.reset();
			this.ladderR.reset();
			this.tone.reset();
			this.lp.reset();
			this.side.reset();
			this.bandL.reset();
			this.bandR.reset();
			for (const f of this.formants) f.reset();
			this.combL?.clear();
			this.combR?.clear();
			this.control = 0;
			this.p1 = 0;
			this.pSub = 0;
			this.pm = 0;
			this.pm2 = 0;
			this.prev = 0;
		}
		const decay = p.decay;
		switch (model) {
			case 'sub':
				this.env.set(0.001, decay * 3 + 0.25, 0, 0.12);
				this.pitchEnv = 1;
				this.pitchMul = decayCoef(0.08, sr);
				this.click = p.envelope * vel * 0.35;
				this.clickMul = decayCoef(0.005, sr);
				this.tone.setFreq(clamp(freq * (2 + p.cutoff * 24), 60, sr * 0.4), sr);
				break;
			case 'finger':
				this.env.set(0.002, decay * 3 + 0.3, 0, 0.1);
				this.pluck(freq, vel, p);
				break;
			case 'acid':
				this.env.set(0.002, 0.3, 0.85, 0.03);
				break;
			case 'fm':
				this.env.set(0.0015, decay * 2 + 0.1, 0.55, 0.08);
				this.index = 1;
				this.indexMul = decayCoef(decay * 0.9 + 0.05, sr);
				this.tone.setFreq(clamp(freq * (3 + p.cutoff * 30), 80, sr * 0.4), sr);
				break;
			case 'neuro':
				this.env.set(0.002, decay * 2 + 0.1, lerp(0.9, 0.5, p.envelope), 0.06);
				// A fast pitch drop makes each note start like a kick.
				this.pitchEnv = 1;
				this.pitchMul = decayCoef(0.05, sr);
				this.index = 1;
				this.indexMul = decayCoef(decay * 1.5 + 0.1, sr);
				if (!this.combL) {
					this.combL = new DelayLine(2048);
					this.combR = new DelayLine(2048);
				}
				break;
			case 'hoover':
				this.env.set(0.004, decay, lerp(0.9, 0.5, p.envelope), 0.09);
				// Each note scoops up into its pitch.
				this.pitchEnv = 1;
				this.pitchMul = decayCoef(0.14, sr);
				break;
			case 'talk':
				this.env.set(0.003, decay, 0.8, 0.07);
				this.morph = 0;
				this.morphRate = 1 / ((0.06 + decay * 0.25) * sr);
				break;
			default:
				this.env.set(0.003, decay, lerp(0.85, 0.35, p.envelope), 0.07);
				break;
		}
		this.env.trigger();
		this.fenv = 1;
		this.fenvMul = decayCoef(model === 'acid' ? decay * 1.2 + 0.05 : decay * 1.6, sr);
		this.accent = model === 'acid' && vel > 0.82 ? 1 : 0;
		this.peak = vel;
	}

	pluck(freq, vel, p) {
		const sr = this.sr;
		if (!this.string) this.string = new StringLoop();
		const brightness = clamp(0.02 + p.cutoff * 0.35 + p.envelope * 0.2 * vel, 0, 1);
		this.string.tune(freq, sr, brightness, p.decay * 4 + 0.6);
		// Low strings keep their highs for long; a tone control rounds them like fingers do.
		this.tone.reset();
		this.tone.setFreq(clamp(freq * (3 + p.cutoff * 14 + p.envelope * 6 * vel), 120, sr * 0.4), sr);
		this.string.clear();
		const length = Math.min(Math.round(this.string.period), EXCITE.length - 1);
		this.lp.reset();
		this.lp.setFreq(freq * lerp(1.2, 9, brightness), sr);
		for (let i = 0; i < length; i++) EXCITE[i] = this.lp.lp(this.noise.next());
		const pick = Math.max(1, Math.round(length * lerp(0.08, 0.4, p.character)));
		for (let i = length - 1; i >= pick; i--) EXCITE[i] -= EXCITE[i - pick];
		let mean = 0;
		for (let i = 0; i < length; i++) mean += EXCITE[i];
		mean /= length;
		let peak = 1e-9;
		for (let i = 0; i < length; i++) {
			EXCITE[i] -= mean;
			peak = Math.max(peak, Math.abs(EXCITE[i]));
		}
		for (let i = 0; i < length; i++) EXCITE[i] *= vel / peak;
		this.string.excite(EXCITE, length, 0);
	}

	release() {
		this.env.release();
		if (this.model === 'finger' && this.string) this.string.setDecay(this.freq, this.sr, 0.12);
	}

	// Moves the pitch toward the target during a slide.
	stepGlide() {
		const d = this.target - this.freq;
		if (d === 0) return;
		this.freq = Math.abs(d) < 1e-3 ? this.target : this.freq + d * this.glideCoef;
	}

	render(L, R, start, end) {
		switch (this.model) {
			case 'sub':
				this.renderSub(L, R, start, end);
				break;
			case 'reese':
				this.renderReese(L, R, start, end);
				break;
			case 'fm':
				this.renderFm(L, R, start, end);
				break;
			case 'wobble':
				this.renderWobble(L, R, start, end);
				break;
			case 'finger':
				this.renderFinger(L, R, start, end);
				break;
			case 'liquid':
			case 'grit':
				this.renderReese(L, R, start, end);
				break;
			case 'scream':
				this.renderScream(L, R, start, end);
				break;
			case 'hoover':
				this.renderHoover(L, R, start, end);
				break;
			case 'neuro':
				this.renderNeuro(L, R, start, end);
				break;
			case 'talk':
				this.renderTalk(L, R, start, end);
				break;
			default:
				this.renderFiltered(L, R, start, end, this.model);
				break;
		}
		if (this.model === 'finger') {
			if (!this.env.active && this.peak < 3e-5) this.active = false;
		} else if (!this.env.active) {
			this.active = false;
		}
	}

	// Analog, acid, and square share one path: oscillator, ladder, drive.
	renderFiltered(L, R, start, end, model) {
		const p = this.engine.params;
		const sr = this.sr;
		const acid = model === 'acid';
		const square = model === 'square';
		const character = p.character;
		const k = acid ? clamp(1.4 + character * 2.3 + this.accent * 0.3, 0, 3.85) : square ? 0.5 : 0.4 + character * 1.4;
		const m0 = acid ? 0.6 + p.cutoff * 8 : 1.2 + p.cutoff * 15;
		const envAmt = acid ? p.envelope * 24 + this.accent * 12 : p.envelope * (square ? 8 : 14) * (0.4 + this.vel * 0.6);
		const drive = acid ? 1 + p.drive * 8 : 1 + p.drive * 4;
		const makeup = 1 / (1 + p.drive * (acid ? 2.4 : 1.5));
		const comp = 1 + k * (acid ? 0.5 : 0.8);
		const sub = acid ? 0 : p.sub * 0.6;
		const level = this.vel * LEVEL[model];
		const env = this.env;
		const pwmInc = 0.375 / sr;
		for (let i = start; i < end; i++) {
			this.stepGlide();
			const inc = this.freq / sr;
			let osc;
			if (square) {
				this.lfo += pwmInc;
				if (this.lfo >= 1) this.lfo -= 1;
				const width = 0.5 - character * 0.38 * (0.5 + 0.5 * sin1(this.lfo));
				osc = pulse(this.p1, inc, width) * 0.55;
			} else if (acid) {
				osc = saw(this.p1, inc);
			} else {
				osc = saw(this.p1, inc) * (1 - character) + pulse(this.p1, inc, 0.5) * 0.6 * character;
			}
			this.p1 += inc;
			if (this.p1 >= 1) this.p1 -= 1;
			const fe = this.fenv;
			this.fenv *= this.fenvMul;
			const g = coef(this.freq * m0 * (1 + envAmt * fe * fe), sr);
			let y = this.ladder.process(osc * (acid ? 0.7 : 0.8 * drive), g, k) * comp;
			if (sub) {
				y += sin1(this.pSub) * sub;
				this.pSub += this.freq < 70 ? inc : inc * 0.5;
				if (this.pSub >= 1) this.pSub -= 1;
			}
			y = softClip(acid ? y * drive : y) * makeup * env.next() * level;
			L[i] += y;
			R[i] += y;
		}
	}

	renderSub(L, R, start, end) {
		const p = this.engine.params;
		const sr = this.sr;
		const drop = p.character;
		const body = p.sub * 0.35;
		const drive = 1 + p.drive * 6;
		const makeup = 1 / (1 + p.drive * 2.2);
		const level = this.vel * LEVEL.sub;
		const env = this.env;
		for (let i = start; i < end; i++) {
			this.stepGlide();
			const f = this.freq * (1 + drop * this.pitchEnv);
			this.pitchEnv *= this.pitchMul;
			this.p1 += f / sr;
			if (this.p1 >= 1) this.p1 -= 1;
			let p2 = this.p1 * 2;
			if (p2 >= 1) p2 -= 1;
			let y = this.tone.lp(softClip((sin1(this.p1) + sin1(p2) * body) * drive) * makeup);
			if (this.click > 1e-5) {
				y += this.noise.next() * this.click;
				this.click *= this.clickMul;
			}
			y *= env.next() * level;
			L[i] += y;
			R[i] += y;
		}
	}

	// Writes one sample with the low end kept mono: the side signal is
	// high-passed, so only harmonics spread out. The sub joins in the middle.
	stereo(L, R, i, l, r, center) {
		const side = this.side.hp((l - r) * 0.5);
		const mid = (l + r) * 0.5 + center;
		L[i] += mid + side;
		R[i] += mid - side;
	}

	// The clean sine sub, an octave down for notes above 90 Hz.
	subTone(inc) {
		const y = sin1(this.pSub);
		this.pSub += this.freq < 90 ? inc : inc * 0.5;
		if (this.pSub >= 1) this.pSub -= 1;
		return y;
	}

	// The reese drift: the outer saws' phase offset follows a triangle, so each
	// is detuned by `detune` (a frequency ratio) one way, then the other, and
	// the average pitch stays exact. The triangle runs at the note's frequency
	// over 512, so the beating speeds up with pitch, as real detuning does.
	drift(inc, detune) {
		this.lfo += inc / 512;
		if (this.lfo >= 1) this.lfo -= 1;
		return 128 * detune * (1 - 4 * Math.abs(this.lfo - 0.5));
	}

	// Reese, liquid, and grit: a center saw and two quieter drifting ones, one per side,
	// through a ladder per side. Liquid rounds the waves into triangles under a
	// darker, gentler filter; grit runs noise into a hard drive before the filter.
	renderReese(L, R, start, end) {
		const p = this.engine.params;
		const sr = this.sr;
		const liquid = this.model === 'liquid';
		const grit = this.model === 'grit';
		const detune = liquid ? 0.002 + p.character * 0.008 : 0.004 + p.character * 0.018;
		const m0 = liquid ? 1 + p.cutoff * 6 : 1.5 + p.cutoff * 12;
		const envAmt = p.envelope * (liquid ? 3 : 6);
		const k = liquid ? 0.3 : 0.7;
		const comp = 1 + k * 0.8;
		const drive = 1 + p.drive * (grit ? 10 : 4);
		const makeup = 1 / (1 + p.drive * (grit ? 3 : 1.5));
		const noise = grit ? 0.3 + p.character * 0.6 : 0;
		const sub = p.sub * 0.7;
		const level = this.vel * LEVEL[this.model];
		const env = this.env;
		for (let i = start; i < end; i++) {
			this.stepGlide();
			const inc = this.freq / sr;
			const off = this.drift(inc, detune);
			const pa = wrap(this.p1 + off);
			const pb = wrap(this.p1 - off);
			let l;
			let r;
			// The center wave leads each side, so every channel's pitch is the note's.
			if (liquid) {
				const c = tri(this.p1);
				l = (c + tri(pa) * DRIFTED) * 0.6;
				r = (c + tri(pb) * DRIFTED) * 0.6;
			} else {
				const c = saw(this.p1, inc) + saw(wrap(this.p1 * 2), inc * 2) * 0.2;
				l = (c + saw(pa, inc) * DRIFTED) * 0.55;
				r = (c + saw(pb, inc) * DRIFTED) * 0.55;
			}
			this.p1 += inc;
			if (this.p1 >= 1) this.p1 -= 1;
			if (grit) {
				// Noise that follows the wave's own level, clipped with it.
				const n = this.noise.next() * noise;
				l = softClip((l + n * (l < 0 ? -l : l)) * drive);
				r = softClip((r + n * (r < 0 ? -r : r)) * drive);
			} else {
				l *= drive;
				r *= drive;
			}
			const fe = this.fenv;
			this.fenv *= this.fenvMul;
			const g = coef(this.freq * m0 * (1 + envAmt * fe * fe), sr);
			const yl = this.ladder.process(l * 0.8, g, k) * comp;
			const yr = this.ladderR.process(r * 0.8, g, k) * comp;
			const a = env.next() * level;
			const m = grit ? makeup * 1.6 : makeup;
			this.stereo(L, R, i, softClip(yl) * m * a, softClip(yr) * m * a, this.subTone(inc) * sub * a);
		}
	}

	// Scream: a reese driven hard into a resonant band-pass per side, tuned a
	// little apart; the band rides the drift and opens with each note.
	renderScream(L, R, start, end) {
		const p = this.engine.params;
		const sr = this.sr;
		const pre = 2 + p.drive * 10;
		const q = 2 + p.character * 10;
		const m0 = 3 + p.cutoff * 20;
		const envAmt = p.envelope * 4;
		const sub = p.sub * 0.7;
		const level = this.vel * LEVEL.scream;
		const env = this.env;
		for (let i = start; i < end; i++) {
			this.stepGlide();
			const inc = this.freq / sr;
			const off = this.drift(inc, 0.012);
			const c = saw(this.p1, inc);
			const l = softClip((c + saw(wrap(this.p1 + off), inc) * DRIFTED) * 0.55 * pre);
			const r = softClip((c + saw(wrap(this.p1 - off), inc) * DRIFTED) * 0.55 * pre);
			this.p1 += inc;
			if (this.p1 >= 1) this.p1 -= 1;
			const fe = this.fenv;
			this.fenv *= this.fenvMul;
			if (this.control-- <= 0) {
				this.control = CONTROL;
				// The band follows the drift's direction, so the scream moves with the beating.
				const fc = this.freq * m0 * (1 + envAmt * fe * fe) * (1 + off * 0.12);
				this.bandL.set(clamp(fc * 1.06, 80, sr * 0.45), q, sr);
				this.bandR.set(clamp(fc / 1.06, 80, sr * 0.45), q, sr);
			}
			const yl = softClip((this.bandL.bpNorm(l) + l * 0.12) * 1.4);
			const yr = softClip((this.bandR.bpNorm(r) + r * 0.12) * 1.4);
			const a = env.next() * level;
			this.stereo(L, R, i, yl * a, yr * a, this.subTone(inc) * sub * a);
		}
	}

	// Hoover: a pulse and its octave, with a drifting copy of the pulse on each
	// side, over a saw an octave down; fast width modulation and a scoop into
	// each note.
	renderHoover(L, R, start, end) {
		const p = this.engine.params;
		const sr = this.sr;
		const pwmInc = 6 / sr;
		const depth = 0.1 + p.character * 0.3;
		const scoop = 0.04 + p.envelope * 0.2;
		const m0 = 2 + p.cutoff * 14;
		const k = 0.5;
		const comp = 1 + k * 0.8;
		const drive = 1 + p.drive * 4;
		const makeup = 1 / (1 + p.drive * 1.5);
		const sub = p.sub * 0.7;
		const level = this.vel * LEVEL.hoover;
		const env = this.env;
		// The octave-down saw that gives the hoover its weight, once it is above the sub.
		const weight = this.freq > 90 ? 0.5 : 0;
		this.lp.setFreq(this.freq * 3, sr);
		for (let i = start; i < end; i++) {
			this.stepGlide();
			const bend = 1 - scoop * this.pitchEnv;
			this.pitchEnv *= this.pitchMul;
			const inc = (this.freq * bend) / sr;
			this.pm += pwmInc;
			if (this.pm >= 1) this.pm -= 1;
			const w = 0.5 - depth * (0.5 + 0.5 * sin1(this.pm));
			const off = this.drift(inc, 0.01);
			const c = pulse(this.p1, inc, w) * 0.4 + pulse(wrap(this.p1 * 2), inc * 2, w) * 0.25;
			const l = c + pulse(wrap(this.p1 + off), inc, w) * 0.4 * DRIFTED;
			const r = c + pulse(wrap(this.p1 - off), inc, w) * 0.4 * DRIFTED;
			this.p1 += inc;
			if (this.p1 >= 1) this.p1 -= 1;
			const fe = this.fenv;
			this.fenv *= this.fenvMul;
			const g = coef(this.freq * m0 * (1 + 4 * fe * fe), sr);
			const yl = this.ladder.process(l * drive, g, k) * comp;
			const yr = this.ladderR.process(r * drive, g, k) * comp;
			const down = weight ? this.lp.lp(saw(this.pm2, inc * 0.5)) * weight : 0;
			this.pm2 += inc * 0.5;
			if (this.pm2 >= 1) this.pm2 -= 1;
			const a = env.next() * level;
			this.stereo(L, R, i, softClip(yl) * makeup * a, softClip(yr) * makeup * a, (down + this.subTone(inc) * sub) * a);
		}
	}

	// Neuro: a sine-and-triangle carrier frequency-modulated by a tone on one
	// of the note's harmonics (which also sounds), sine-folded, then through a
	// feedback comb whose peaks sit on the note's harmonics and slide with the
	// bar. Each note starts with a kick-like pitch drop; the sub stays outside.
	renderNeuro(L, R, start, end) {
		const p = this.engine.params;
		const ctx = this.engine.ctx;
		const sr = this.sr;
		const h = NEURO_HARMONICS[Math.round(p.character * (NEURO_HARMONICS.length - 1))];
		const fold = 1 + p.drive * 5;
		const bite = 0.6 + p.envelope * 2.4;
		const kick = 0.5 + p.envelope * 2.5;
		const m = 1 + p.cutoff * 6;
		const fb = 0.62;
		const samplesPerBeat = (60 / (ctx.bpm || 90)) * sr;
		const locked = !!ctx.playing;
		const sub = p.sub * 0.7;
		const level = this.vel * LEVEL.neuro;
		const env = this.env;
		for (let i = start; i < end; i++) {
			this.stepGlide();
			const f = this.freq * (1 + kick * this.pitchEnv);
			this.pitchEnv *= this.pitchMul;
			const inc = f / sr;
			this.pm += inc * h;
			if (this.pm >= 1) this.pm -= 1;
			const tone = tri(this.pm);
			const index = bite * (0.4 + this.index);
			this.index *= this.indexMul;
			const carrier = sin1(wrap(this.p1 + index * tone * INV_TAU)) * 0.7 + tri(this.p1) * 0.3;
			this.p1 += inc;
			if (this.p1 >= 1) this.p1 -= 1;
			const x = carrier + tone * 0.3 + this.noise.next() * 0.03;
			const folded = sin1(wrap(x * fold * 0.25));
			// The comb's position sweeps over two beats, locked to the song while it plays.
			let sweep;
			if (locked) sweep = sin1(wrap((ctx.beat + i / samplesPerBeat) / 2));
			else {
				this.lfo += 1 / (2 * samplesPerBeat);
				if (this.lfo >= 1) this.lfo -= 1;
				sweep = sin1(this.lfo);
			}
			const delay = clamp(sr / (this.freq * m * (1 + 0.15 * sweep)), 2, 2000);
			const yl = folded + fb * this.combL.read(delay - 1);
			const yr = folded + fb * this.combR.read(delay * 1.04 - 1);
			this.combL.write(yl);
			this.combR.write(yr);
			const a = env.next() * level;
			const subInc = (this.freq * (1 + kick * 0.5 * this.pitchEnv)) / sr;
			this.stereo(L, R, i, softClip(yl * (1 - fb) * 1.6) * a, softClip(yr * (1 - fb) * 1.6) * a, this.subTone(subInc) * sub * a);
		}
	}

	// Talk: a buzzy saw and pulse through three vowel formants that glide from
	// one vowel to another on every note ("wow", "yoi"); character picks the
	// glide, pluck how far it goes, brightness scales the mouth.
	renderTalk(L, R, start, end) {
		const p = this.engine.params;
		const sr = this.sr;
		const [from, to] = VOWEL_PATHS[Math.round(p.character * (VOWEL_PATHS.length - 1))];
		const reach = 0.3 + p.envelope * 0.7;
		const scale = 0.75 + p.cutoff * 0.6;
		const drive = 1 + p.drive * 4;
		const makeup = 1 / (1 + p.drive * 1.2);
		const sub = p.sub * 0.7;
		const level = this.vel * LEVEL.talk;
		const env = this.env;
		const [fa, fb] = [VOWELS[from], VOWELS[to]];
		for (let i = start; i < end; i++) {
			this.stepGlide();
			const inc = this.freq / sr;
			if (this.control-- <= 0) {
				this.control = CONTROL;
				// Ease from one vowel to the other.
				const t = this.morph * this.morph * (3 - 2 * this.morph) * reach;
				for (let k = 0; k < 3; k++) this.formants[k].set(clamp(lerp(fa[k], fb[k], t) * scale, 80, sr * 0.45), FORMANT_Q[k], sr);
			}
			if (this.morph < 1) this.morph = Math.min(1, this.morph + this.morphRate);
			const src = softClip((saw(this.p1, inc) * 0.6 + pulse(this.p1, inc, 0.3) * 0.4) * drive);
			this.p1 += inc;
			if (this.p1 >= 1) this.p1 -= 1;
			let y = 0;
			for (let k = 0; k < 3; k++) y += this.formants[k].bpNorm(src) * FORMANT_GAIN[k];
			const a = env.next() * level;
			const voice = softClip(y * 1.2) * makeup * a;
			this.stereo(L, R, i, voice, voice, this.subTone(inc) * sub * a);
		}
	}

	renderFm(L, R, start, end) {
		const p = this.engine.params;
		const sr = this.sr;
		const ratio = p.character < 0.34 ? 1 : p.character < 0.67 ? 2 : 3;
		const bite = 0.4 + p.envelope * 5;
		const fb = p.drive * 0.9 * INV_TAU;
		const sub = p.sub * 0.6;
		const level = this.vel * LEVEL.fm;
		const env = this.env;
		for (let i = start; i < end; i++) {
			this.stepGlide();
			const inc = this.freq / sr;
			let mp = this.pm + this.prev * fb;
			mp -= Math.floor(mp);
			const mod = sin1(mp);
			this.prev = mod;
			const index = bite * this.index + 0.3;
			this.index *= this.indexMul;
			let cp = this.p1 + index * mod * INV_TAU;
			cp -= Math.floor(cp);
			let y = this.tone.lp(sin1(cp)) + sin1(this.pSub) * sub;
			this.p1 += inc;
			if (this.p1 >= 1) this.p1 -= 1;
			this.pm += inc * ratio;
			if (this.pm >= 1) this.pm -= 1;
			this.pSub += this.freq < 70 ? inc : inc * 0.5;
			if (this.pSub >= 1) this.pSub -= 1;
			y = softClip(y * 1.2) * env.next() * level;
			L[i] += y;
			R[i] += y;
		}
	}

	renderWobble(L, R, start, end) {
		const p = this.engine.params;
		const ctx = this.engine.ctx;
		const sr = this.sr;
		const period = WOBBLE_BEATS[Math.round(p.character * (WOBBLE_BEATS.length - 1))];
		const samplesPerBeat = (60 / (ctx.bpm || 90)) * sr;
		const locked = !!ctx.playing;
		const depth = (1.5 + p.envelope * 4.5) * LN2;
		const m0 = 0.8 + p.cutoff * 5;
		const k = 2.6;
		const drive = 1 + p.drive * 6;
		const makeup = 1 / (1 + p.drive * 2.4);
		const sub = p.sub * 0.6;
		const level = this.vel * LEVEL.wobble;
		const env = this.env;
		const freeInc = 1 / (period * samplesPerBeat);
		for (let i = start; i < end; i++) {
			this.stepGlide();
			const inc = this.freq / sr;
			// Locked to the song's beat while it plays; free-running for live notes.
			let phase;
			if (locked) {
				phase = (ctx.beat + i / samplesPerBeat) / period;
				phase -= Math.floor(phase);
			} else {
				this.lfo += freeInc;
				if (this.lfo >= 1) this.lfo -= 1;
				phase = this.lfo;
			}
			let w = phase + 0.75;
			if (w >= 1) w -= 1;
			const sweep = 0.5 + 0.5 * sin1(w);
			let p2 = this.p1 * 2;
			if (p2 >= 1) p2 -= 1;
			const osc = saw(this.p1, inc) + saw(p2, inc * 2) * 0.5;
			this.p1 += inc;
			if (this.p1 >= 1) this.p1 -= 1;
			const g = coef(this.freq * m0 * Math.exp(depth * sweep), sr);
			let y = softClip(this.ladder.process(osc * 0.6, g, k) * (1 + k * 0.6) * drive) * makeup;
			y += sin1(this.pSub) * sub;
			this.pSub += this.freq < 70 ? inc : inc * 0.5;
			if (this.pSub >= 1) this.pSub -= 1;
			y *= env.next() * level;
			L[i] += y;
			R[i] += y;
		}
	}

	renderFinger(L, R, start, end) {
		const p = this.engine.params;
		const string = this.string;
		const drive = 1 + p.drive * 3;
		const makeup = 1 / (1 + p.drive);
		const sub = p.sub * 0.35;
		const level = this.vel * LEVEL.finger;
		const env = this.env;
		const inc = this.freq / this.sr;
		let peak = 0;
		for (let i = start; i < end; i++) {
			const s = string.tick(0);
			const a = s < 0 ? -s : s;
			if (a > peak) peak = a;
			let y = softClip(this.tone.lp(s) * drive) * makeup + sin1(this.pSub) * sub * env.next();
			this.pSub += inc;
			if (this.pSub >= 1) this.pSub -= 1;
			y *= level;
			L[i] += y;
			R[i] += y;
		}
		this.peak = peak;
	}
}

export class BassEngine extends PolyEngine {
	constructor(sr, ctx) {
		const voices = [];
		super(sr, ctx, voices, instrumentDefaults('bass'));
		for (let i = 0; i < 6; i++) voices.push(new BassVoice(sr, this, 0xba55 + i * 389));
	}

	// With glide on, a note that starts while another is held slides from it.
	noteOn(freq, vel, gate, key = -1, row = 0) {
		const p = this.params;
		if (p.glide > 0.001 && p.model !== 'finger') {
			let held = null;
			for (const v of this.voices) if (v.active && !v.released && (!held || v.age > held.age)) held = v;
			if (held) {
				held.key = key;
				held.gate = gate;
				held.age = this.clock++;
				held.slide(freq, vel);
				return;
			}
		}
		super.noteOn(freq, vel, gate, key, row);
	}
}
