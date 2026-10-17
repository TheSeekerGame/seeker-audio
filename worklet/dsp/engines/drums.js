// A synthesized drum machine with nine kits. Each kit gives every row a voice
// recipe: a kick (sine with a two-stage pitch glide, click, knock, and optional
// techno rumble), a snare (tuned body, noise that can wait a few milliseconds
// so the hit and the rattle stay distinct, wire ring, crack), claps, snaps and
// rims, metallic hats, toms and congas, FM metal, cowbell, ride and crash
// cymbals, and shakers. Pitched parts sit on palette harmonics of 48 Hz;
// noise and metal are unpitched, which the tuning leaves free.
//
// The kick also writes its instantaneous level into ctx.sidechain, which the
// song uses to carve other layers out sample by sample.

import { PolyEngine, Voice } from '../poly.js';
import { Noise, SVF, OnePole, clamp, lerp, panGains, sin1, softClip, decayCoef } from '../core.js';
import { instrumentDefaults } from '../../../js/instruments.js';
import { indexValue } from '../../../js/tuning.js';

export const KICK = 0;
export const CLOSED_HAT = 3;
export const OPEN_HAT = 4;

// Hi-hat and cymbal partials (TR-808 square oscillators), deliberately inharmonic.
const METAL_FREQS = [205.3, 304.4, 369.6, 522.7, 540, 800];
const ROW_PAN = [0, 0.05, 0.12, 0.35, 0.25, -0.3, 0.3, -0.4];

const kick = (o) => ({ type: 'kick', mult: 1, drop: 3, dropTime: 0.06, zap: 0, decay: [0.25, 0.6], click: 0.4, clickHp: 2500, knock: 0.1, drive: 0.6, skin: 0, rumble: 0, level: 1, ...o });
const snare = (o) => ({ type: 'snare', mult: 4, r2: 1.5, body: 0.5, bodyDecay: 0.12, buzz: 0, noise: 0.8, noiseDelay: 0, hp: 2000, bp: 6000, q: 0.9, noiseDecay: [0.12, 0.3], attack: 0, ring: 0, crack: 0.25, clapLayer: 0, fm: 0, drive: 0.3, level: 0.85, ...o });
const clap = (o) => ({ type: 'clap', kind: 'clap', bursts: 3, spacing: 0.009, center: 1300, q: 1.4, tail: [0.12, 0.3], mult: 16, level: 0.8, ...o });
const hat = (o) => ({ type: 'hat', metal: 0.5, scale: 1.2, bp: 10000, hp: 7500, closed: [0.03, 0.08], open: [0.25, 0.6], level: 0.42, ...o });
const tom = (o) => ({ type: 'tom', mult: 3, drop: 0.25, dropTime: 0.15, decay: [0.25, 0.8], r2: 1.5, a2: 0.3, click: 0.1, level: 0.75, ...o });
const metal = (o) => ({ type: 'metal', mult: 6, ratio: 1.414, index: 3, decay: [0.2, 0.6], level: 0.5, ...o });
const cymbal = (o) => ({ type: 'cymbal', scale: 2.2, bp: 8000, hp: 5500, decay: [0.6, 1.4], noise: 0.4, bell: 0.2, level: 0.32, ...o });
const shaker = (o) => ({ type: 'shaker', hp: 6500, attack: 0.008, decay: [0.05, 0.15], level: 0.42, ...o });

const KITS = {
	soft: {
		rows: [
			kick({ drop: 1, dropTime: 0.09, decay: [0.3, 0.75], click: 0.15, clickHp: 1500, knock: 0.08, drive: 0.35 }),
			snare({ body: 0.4, bodyDecay: 0.12, noise: 0.6, hp: 1500, bp: 4000, q: 0.8, noiseDecay: [0.15, 0.4], attack: 0.003, crack: 0.15 }),
			clap({ kind: 'snap', center: 2400, q: 2.5, tail: [0.04, 0.08], level: 0.75 }),
			hat({ metal: 0.2, scale: 1, bp: 9500, hp: 6500, closed: [0.04, 0.1], open: [0.3, 0.7] }),
			null,
			tom({ mult: 3 }),
			tom({ mult: 14, drop: 0.04, dropTime: 0.03, decay: [0.05, 0.15], r2: 2.5, a2: 0.45, click: 0.2, level: 0.55 }),
			shaker({ attack: 0.012, decay: [0.06, 0.18] }),
		],
	},
	tight: {
		rows: [
			kick({ drop: 4, dropTime: 0.07, zap: 4, decay: [0.2, 0.6], click: 0.5, clickHp: 3000, knock: 0.12, drive: 0.6 }),
			snare({ noiseDelay: 0.003 }),
			clap({}),
			hat({}),
			null,
			tom({ mult: 3 }),
			tom({ mult: 14, drop: 0.05, dropTime: 0.03, decay: [0.06, 0.2], r2: 2.5, a2: 0.5, click: 0.25, level: 0.55 }),
			shaker({}),
		],
	},
	lofi: {
		post: { lp: 9500, grit: 0.5 },
		rows: [
			kick({ drop: 1.5, dropTime: 0.07, decay: [0.25, 0.55], click: 0.06, clickHp: 1800, knock: 0.12, drive: 0.9 }),
			snare({ body: 0.55, bodyDecay: 0.14, noise: 0.65, hp: 1400, bp: 3500, q: 0.8, noiseDecay: [0.14, 0.32], crack: 0.1 }),
			clap({ kind: 'rim', mult: 16, tail: [0.03, 0.05], level: 0.7 }),
			hat({ metal: 0.3, scale: 1, bp: 8000, hp: 5500, closed: [0.04, 0.09], open: [0.25, 0.5] }),
			null,
			tom({ mult: 3 }),
			tom({ mult: 14, drop: 0.05, dropTime: 0.03, decay: [0.06, 0.18], r2: 2.5, a2: 0.45, click: 0.2, level: 0.55 }),
			shaker({ hp: 5000 }),
		],
	},
	metal: {
		post: { grit: 0.2 },
		rows: [
			kick({ drop: 3, dropTime: 0.06, zap: 6, decay: [0.2, 0.5], click: 0.45, knock: 0.22, drive: 1 }),
			snare({ body: 0.4, buzz: 0.6, noise: 0.7, fm: 0.45, crack: 0.3 }),
			clap({ bursts: 4, center: 1600, q: 2 }),
			hat({ metal: 1, scale: 1.5, bp: 9000, hp: 7000, closed: [0.04, 0.1], open: [0.3, 0.9] }),
			null,
			metal({ mult: 6, ratio: 1.414, index: 3, decay: [0.2, 0.6] }),
			metal({ mult: 16, ratio: 2.76, index: 2, decay: [0.1, 0.4], level: 0.42 }),
			shaker({}),
		],
	},
	// A 909-style house kit.
	club: {
		rows: [
			kick({ drop: 5, dropTime: 0.05, zap: 5, decay: [0.25, 0.7], click: 0.6, clickHp: 2500, knock: 0.12, drive: 0.75 }),
			snare({ r2: 1.75, body: 0.45, bodyDecay: 0.1, buzz: 0.3, noise: 0.9, hp: 2500, bp: 7000, q: 0.7, noiseDecay: [0.12, 0.3], crack: 0.25 }),
			clap({ bursts: 4, spacing: 0.008, center: 1100, q: 1.2, tail: [0.15, 0.35] }),
			hat({ metal: 0.45, scale: 1.6, bp: 11000, hp: 8000, closed: [0.03, 0.07], open: [0.2, 0.45] }),
			null,
			tom({ mult: 6, drop: 0.12, dropTime: 0.05, decay: [0.12, 0.3], r2: 1.5, a2: 0.2, click: 0.3, level: 0.6 }),
			clap({ kind: 'rim', mult: 16, tail: [0.025, 0.04], level: 0.65 }),
			shaker({ hp: 7000, decay: [0.05, 0.14] }),
		],
	},
	// Jungle and breakbeat: an acoustic kit with a ringing snare, ride, and crash.
	break: {
		post: { grit: 0.25 },
		rows: [
			kick({ mult: 1.25, drop: 0.8, dropTime: 0.05, zap: 2, decay: [0.15, 0.35], click: 0.4, clickHp: 2500, knock: 0.15, drive: 0.55, skin: 0.2 }),
			snare({ body: 0.5, bodyDecay: 0.12, noise: 0.75, noiseDelay: 0.003, hp: 1800, bp: 5000, q: 1.2, noiseDecay: [0.18, 0.4], ring: 0.35, crack: 0.35 }),
			clap({ kind: 'rim', mult: 12, tail: [0.03, 0.05], level: 0.7 }),
			hat({ metal: 0.35, scale: 1.1, bp: 8500, hp: 6000, closed: [0.05, 0.1], open: [0.35, 0.7] }),
			null,
			tom({ mult: 2, drop: 0.2, decay: [0.25, 0.6], click: 0.15 }),
			cymbal({ scale: 2.2, bp: 7500, hp: 5000, decay: [0.6, 1.4], bell: 0.25 }),
			cymbal({ scale: 2.6, bp: 6500, hp: 4000, decay: [1, 2.2], noise: 0.7, bell: 0, level: 0.38 }),
		],
	},
	808: {
		rows: [
			kick({ drop: 0.6, dropTime: 0.08, decay: [0.5, 1.6], click: 0.06, knock: 0.04, drive: 0.4 }),
			snare({ r2: 2, body: 0.6, bodyDecay: 0.16, noise: 0.55, hp: 4000, bp: 8000, q: 0.8, noiseDecay: [0.08, 0.2], crack: 0.1 }),
			clap({ bursts: 4, spacing: 0.01, center: 1000, q: 1.3, tail: [0.2, 0.45] }),
			hat({ metal: 0.85, scale: 1, bp: 9000, hp: 7000, closed: [0.03, 0.09], open: [0.25, 0.7] }),
			null,
			tom({ mult: 2, drop: 0.15, dropTime: 0.12, decay: [0.3, 0.9], r2: 1, a2: 0, click: 0.03 }),
			{ type: 'cowbell', mult: 10, decay: [0.2, 0.5], level: 0.42 },
			shaker({ hp: 8000, attack: 0.004, decay: [0.03, 0.07] }),
		],
	},
	// Drum & bass: a short punchy kick and a big cracking snare with a clap on top.
	dnb: {
		rows: [
			kick({ drop: 4, dropTime: 0.045, zap: 8, decay: [0.16, 0.32], click: 0.75, clickHp: 3500, knock: 0.25, drive: 0.85 }),
			snare({ body: 0.55, bodyDecay: 0.09, buzz: 0.5, noise: 1, noiseDelay: 0.008, hp: 2500, bp: 6000, q: 0.9, noiseDecay: [0.14, 0.28], crack: 0.5, clapLayer: 0.35, drive: 0.5 }),
			clap({ spacing: 0.006, center: 1500, q: 1.5, tail: [0.1, 0.22] }),
			hat({ metal: 0.4, scale: 1.5, bp: 11000, hp: 8500, closed: [0.02, 0.06], open: [0.15, 0.35] }),
			null,
			tom({ mult: 8, drop: 0.1, dropTime: 0.03, decay: [0.06, 0.16], r2: 2.5, a2: 0.4, click: 0.4, level: 0.5 }),
			cymbal({ scale: 2.4, bp: 9000, hp: 6500, decay: [0.5, 1], bell: 0.3 }),
			shaker({ hp: 7500, decay: [0.04, 0.1] }),
		],
	},
	// Techno: a 909 kick with a distorted, low-passed rumble tail.
	techno: {
		rows: [
			kick({ drop: 5, dropTime: 0.05, zap: 6, decay: [0.3, 0.7], click: 0.5, knock: 0.1, drive: 0.9, rumble: 0.5 }),
			snare({ r2: 1.75, buzz: 0.4, noise: 0.75, noiseDelay: 0.005, hp: 2000, bp: 5500, noiseDecay: [0.12, 0.28] }),
			clap({ bursts: 4, center: 1200, q: 1.5, tail: [0.2, 0.5] }),
			hat({ metal: 0.6, scale: 1.4, bp: 10500, hp: 8000, closed: [0.03, 0.08], open: [0.25, 0.6] }),
			null,
			metal({ mult: 8, ratio: 1.414, index: 2, decay: [0.08, 0.25], level: 0.45 }),
			cymbal({ scale: 2.3, bp: 9000, hp: 6500, decay: [0.7, 1.3], bell: 0.2 }),
			shaker({}),
		],
	},
};

// Per-row gain for each kit, measured through the drum bus (tests/dsp.test.mjs
// checks it) so each row's momentary loudness sits at its target relative to
// the kick: snare level with it, clap 2.5 dB under, hats 8 to 9 dB under, and so on.
export const ROW_LOUDNESS = { kick: 0, snare: -0.5, clap: -2.5, snap: -4, rim: -5, hat: -9, 'open hat': -8, tom: -3, block: -6, shaker: -10, metal: -6, anvil: -7, conga: -5, ride: -10, crash: -6, cowbell: -6, maracas: -10, perc: -6 };
export const ROW_TRIM = {
	"808": [1,  1.1,  3.49,  4.02,  2.01,  0.69,  2.8,  0.83],
	soft: [1,  1.02,  3.73,  2.17,  1.08,  0.64,  0.99,  0.47],
	tight: [1,  0.97,  3.51,  3.77,  1.8,  0.75,  1.01,  0.63],
	lofi: [1,  1.33,  2.18,  3.82,  1.88,  0.61,  0.87,  1.13],
	metal: [1,  0.82,  3.89,  4.42,  2.19,  0.74,  0.78,  0.58],
	club: [1,  0.85,  3.76,  3.95,  1.96,  0.96,  3.18,  0.66],
	break: [1,  0.7,  2.02,  2.05,  1.05,  0.67,  0.97,  0.96],
	dnb: [1,  0.67,  3.34,  3.97,  1.98,  1.18,  1.28,  0.65],
	techno: [1,  1.07,  3.97,  4.47,  2.12,  1.36,  1.46,  0.65],
};

// The open hat (row 4) shares the closed hat's recipe.
for (const kit of Object.values(KITS)) kit.rows[OPEN_HAT] = kit.rows[CLOSED_HAT];

class DrumVoice extends Voice {
	constructor(sr, engine, seed) {
		super();
		this.sr = sr;
		this.engine = engine;
		this.noise = new Noise(seed);
		this.f1 = new SVF();
		this.f2 = new SVF();
		this.f3 = new SVF();
		this.f4 = new SVF();
		this.hp = new OnePole();
		this.lp = new OnePole();
		this.lp2 = new OnePole();
		this.metalPhase = new Float32Array(6);
		this.metalInc = new Float32Array(6);
		this.recipe = null;
		this.row = 0;
		this.amp = 0;
	}

	level() {
		return this.amp;
	}

	start(freq, vel, row) {
		const engine = this.engine;
		const p = engine.params;
		const kit = KITS[p.style] || KITS.soft;
		const r = kit.rows[row] || kit.rows[0];
		const sr = this.sr;
		const base = engine.kickHz();
		const tone = 0.75 + p.tone * 0.5; // scales filter frequencies
		const bright = (0.6 + p.tone * 0.8) * (0.8 + vel * 0.4); // scales clicks and transients
		this.recipe = r;
		this.row = row;
		this.vel = vel;
		this.trim = (ROW_TRIM[p.style] || ROW_TRIM.soft)[row];
		this.f1.reset();
		this.f2.reset();
		this.f3.reset();
		this.f4.reset();
		this.hp.reset();
		this.lp.reset();
		this.lp2.reset();
		this.t = 0;
		[this.pl, this.pr] = panGains(ROW_PAN[row] * p.width);
		const length = (range) => lerp(range[0], range[1], p.decay);
		switch (r.type) {
			case 'kick': {
				this.fEnd = base * r.mult;
				this.fStart = this.fEnd * (1 + r.drop * (0.6 + p.punch * 0.8));
				this.pitch = 1;
				this.pitchMul = decayCoef(r.dropTime, sr);
				// A second, much faster pitch stage gives the attack its zap.
				this.zap = r.zap * (0.5 + p.punch);
				this.zapMul = decayCoef(0.006, sr);
				this.phase = 0;
				this.knockPhase = 0;
				this.amp = vel;
				this.ampMul = decayCoef(length(r.decay), sr);
				this.click = vel * r.click * bright * 0.6;
				this.clickMul = decayCoef(0.004, sr);
				this.hp.setFreq(r.clickHp * tone, sr);
				this.knock = vel * r.knock;
				this.knockMul = decayCoef(0.04, sr);
				this.skin = vel * r.skin;
				this.skinMul = decayCoef(0.03, sr);
				this.lp.setFreq(500, sr);
				this.drive = 1 + r.drive * (0.6 + p.punch);
				this.rumble = 0;
				this.rumbleTarget = r.rumble ? vel * r.rumble * (0.5 + p.decay) : 0;
				this.rumbleDelay = Math.round(sr * 0.02);
				this.rumbleRise = 1 - Math.exp(-1 / (0.04 * sr));
				this.rumbleMul = decayCoef(lerp(0.5, 1.2, p.decay), sr);
				if (this.rumbleTarget) {
					this.lp.setFreq(160, sr);
					this.lp2.setFreq(160, sr);
				}
				break;
			}
			case 'snare': {
				let body = base * r.mult;
				if (body > 320) body *= 0.5;
				this.inc1 = body / sr;
				this.inc2 = (body * r.r2) / sr;
				this.phase = 0;
				this.phase2 = 0;
				this.pitch = 1;
				this.pitchMul = decayCoef(0.03, sr);
				this.body = vel * r.body;
				this.bodyMul = decayCoef(r.bodyDecay * (0.7 + p.decay * 0.6), sr);
				this.buzz = 1 + r.buzz * 5;
				this.buzzNorm = 1 / softClip(this.buzz);
				// The noise can wait until the body's hit has passed, then swells in.
				this.noiseWait = Math.round(r.noiseDelay * sr);
				const rise = r.noiseDelay ? Math.max(r.attack, 0.002) : r.attack;
				this.attack = rise ? 1 / Math.max(1, rise * sr) : 1;
				this.rise = rise ? 0 : 1;
				this.amp = vel * r.noise;
				this.ampMul = decayCoef(length(r.noiseDecay), sr);
				this.f1.set(clamp(r.hp * tone, 200, sr * 0.45), 0.7, sr);
				this.f2.set(clamp(r.bp * tone, 300, sr * 0.45), r.q, sr);
				this.ring = vel * r.ring;
				this.ringMul = decayCoef(length(r.noiseDecay) * 1.6, sr);
				if (r.ring) this.f3.set(clamp(4500 * tone, 1000, sr * 0.45), 4, sr);
				this.crack = vel * r.crack * bright;
				this.crackMul = decayCoef(0.006, sr);
				this.hp.setFreq(3000, sr);
				this.clapLayer = vel * r.clapLayer;
				this.clapStart = this.clapLayer;
				this.clapBurst = r.clapLayer ? 1 : 0;
				this.clapNext = Math.round(sr * 0.007);
				this.burstMul = decayCoef(0.025, sr);
				if (r.clapLayer) this.f4.set(clamp(1500 * tone, 400, sr * 0.45), 1.5, sr);
				this.fm = vel * r.fm;
				this.fmMul = decayCoef(0.3 + p.decay * 0.3, sr);
				this.fmPhase = 0;
				this.fmModPhase = 0;
				this.drive = 1 + r.drive;
				break;
			}
			case 'clap': {
				this.amp = vel;
				this.kind = r.kind;
				if (r.kind === 'clap') {
					this.burst = 1;
					this.bursts = r.bursts - 1;
					this.spacing = Math.round(sr * r.spacing);
					this.nextBurst = this.spacing;
					this.burstMul = decayCoef(0.012, sr);
					this.tail = 0;
					this.tailMul = decayCoef(length(r.tail), sr);
					this.f1.set(clamp(r.center * tone, 400, sr * 0.45), r.q, sr);
				} else if (r.kind === 'snap') {
					this.ampMul = decayCoef(length(r.tail), sr);
					this.f1.set(clamp(r.center * tone, 400, sr * 0.45), r.q, sr);
				} else {
					// Rim: two short tuned tones and a click.
					const f = Math.min(base * r.mult, sr * 0.2);
					this.inc1 = f / sr;
					this.inc2 = (f * 1.5) / sr;
					this.phase = 0;
					this.phase2 = 0;
					this.ampMul = decayCoef(length(r.tail), sr);
					this.f1.set(clamp(1800 * tone, 400, sr * 0.45), 2, sr);
				}
				break;
			}
			case 'hat': {
				const open = row === OPEN_HAT;
				if (!open) engine.chokeOpenHats(this);
				this.amp = vel;
				this.ampMul = decayCoef(length(open ? r.open : r.closed), sr);
				this.metal = r.metal;
				for (let k = 0; k < 6; k++) {
					this.metalPhase[k] = this.noise.unit();
					this.metalInc[k] = (METAL_FREQS[k] * r.scale) / sr;
				}
				this.f1.set(clamp(r.bp * tone, 2000, sr * 0.45), 1.1, sr);
				this.hp.setFreq(clamp(r.hp * tone, 1000, sr * 0.45), sr);
				this.spark = vel * bright * 0.5;
				this.sparkMul = decayCoef(0.004, sr);
				break;
			}
			case 'tom': {
				this.fEnd = base * r.mult;
				this.pitch = 1;
				this.pitchMul = decayCoef(r.dropTime, sr);
				this.drop = r.drop;
				this.ratio2 = r.r2;
				this.phase = 0;
				this.phase2 = 0;
				this.amp = vel;
				const t60 = length(r.decay);
				this.ampMul = decayCoef(t60, sr);
				this.amp2 = vel * r.a2;
				this.amp2Mul = decayCoef(t60 * 0.5, sr);
				this.click = vel * r.click * bright;
				this.clickMul = decayCoef(0.005, sr);
				break;
			}
			case 'metal': {
				this.fEnd = Math.min(base * r.mult, sr * 0.2);
				this.phase = 0;
				this.fmModPhase = 0;
				this.ratio2 = r.ratio;
				this.index = r.index * (0.6 + p.punch * 0.8);
				this.indexMul = decayCoef(length(r.decay) * 0.5, sr);
				this.amp = vel;
				this.ampMul = decayCoef(length(r.decay), sr);
				break;
			}
			case 'cowbell': {
				const f = base * r.mult;
				this.inc1 = f / sr;
				this.inc2 = (f * 1.5) / sr;
				this.phase = 0;
				this.phase2 = 0;
				this.amp = vel;
				this.ampMul = decayCoef(0.06, sr);
				this.amp2 = vel * 0.35;
				this.amp2Mul = decayCoef(length(r.decay), sr);
				this.f1.set(clamp(f * 2.5, 500, sr * 0.45), 2.5, sr);
				break;
			}
			case 'cymbal': {
				this.amp = vel;
				this.ampMul = decayCoef(length(r.decay), sr);
				this.metal = 1 - r.noise;
				for (let k = 0; k < 6; k++) {
					this.metalPhase[k] = this.noise.unit();
					this.metalInc[k] = (METAL_FREQS[k] * r.scale) / sr;
				}
				this.f1.set(clamp(r.bp * tone, 2000, sr * 0.45), 0.9, sr);
				this.hp.setFreq(clamp(r.hp * tone, 1000, sr * 0.45), sr);
				const bellF = base * 24;
				this.bell = bellF * 1.5 < sr * 0.45 ? vel * r.bell : 0;
				this.inc1 = bellF / sr;
				this.inc2 = (bellF * 1.5) / sr;
				this.phase = 0;
				this.phase2 = 0;
				this.bellMul = decayCoef(0.8, sr);
				this.spark = vel * bright * 0.4;
				this.sparkMul = decayCoef(0.005, sr);
				break;
			}
			default: {
				// Shaker
				this.amp = 0;
				this.peak = vel;
				this.rise = 1 / Math.max(1, sr * r.attack);
				this.rising = true;
				this.ampMul = decayCoef(length(r.decay), sr);
				this.f1.set(clamp(r.hp * tone, 1000, sr * 0.45), 0.8, sr);
				break;
			}
		}
	}

	release() {}

	render(L, R, start, end) {
		switch (this.recipe.type) {
			case 'kick':
				return this.renderKick(L, R, start, end);
			case 'snare':
				return this.renderSnare(L, R, start, end);
			case 'clap':
				return this.renderClap(L, R, start, end);
			case 'hat':
				return this.renderMetallic(L, R, start, end, false);
			case 'cymbal':
				return this.renderMetallic(L, R, start, end, true);
			case 'tom':
				return this.renderTom(L, R, start, end);
			case 'metal':
				return this.renderMetal(L, R, start, end);
			case 'cowbell':
				return this.renderCowbell(L, R, start, end);
			default:
				return this.renderShaker(L, R, start, end);
		}
	}

	out(L, R, i, y) {
		const t = y * this.trim;
		L[i] += t * this.pl;
		R[i] += t * this.pr;
	}

	renderKick(L, R, start, end) {
		const sr = this.sr;
		const r = this.recipe;
		const sc = this.engine.ctx.sidechain;
		const level = r.level * 0.78;
		const drive = this.drive;
		const norm = 1 / softClip(drive);
		for (let i = start; i < end; i++) {
			const f = this.fEnd * (1 + this.zap) + (this.fStart - this.fEnd) * this.pitch;
			this.pitch *= this.pitchMul;
			this.zap *= this.zapMul;
			this.phase += f / sr;
			if (this.phase >= 1) this.phase -= 1;
			const s = sin1(this.phase);
			const a = this.amp;
			this.amp *= this.ampMul;
			// The kick's own waveform, for ring-mod sidechaining.
			if (sc) {
				const v = (s < 0 ? -s : s) * a;
				if (v > sc[i]) sc[i] = v;
			}
			let y = softClip(s * a * drive) * norm;
			if (this.knock > 1e-5) {
				this.knockPhase += (f * 4) / sr;
				if (this.knockPhase >= 1) this.knockPhase -= 1;
				y += sin1(this.knockPhase) * this.knock;
				this.knock *= this.knockMul;
			}
			if (this.click > 1e-5) {
				y += this.hp.hp(this.noise.next()) * this.click;
				this.click *= this.clickMul;
			}
			if (this.skin > 1e-5) {
				y += this.lp.lp(this.noise.next()) * this.skin * 3;
				this.skin *= this.skinMul;
			}
			if (this.rumbleTarget) {
				if (this.t >= this.rumbleDelay) {
					if (this.rumbleTarget > 0 && this.rumble < this.rumbleTarget * 0.98) this.rumble += (this.rumbleTarget - this.rumble) * this.rumbleRise;
					else {
						this.rumbleTarget = -1;
					}
				}
				if (this.rumbleTarget < 0) this.rumble *= this.rumbleMul;
				// Low-passed noise and the kick's tone, distorted, carved by the kick itself.
				const rum = softClip((this.lp2.lp(this.lp.lp(this.noise.next())) * 14 + s * 0.6) * 2.5) * this.rumble * (1 - Math.min(1, Math.abs(s) * a));
				y += rum * 0.6;
			}
			this.t++;
			this.out(L, R, i, y * level);
		}
		if (this.amp < 1e-4 && this.rumble < 1e-4 && this.rumbleTarget <= 0) this.active = false;
	}

	renderSnare(L, R, start, end) {
		const sr = this.sr;
		const level = this.recipe.level * 0.8;
		const drive = this.drive;
		const norm = 1 / softClip(drive);
		for (let i = start; i < end; i++) {
			const bend = 1 + 0.08 * this.pitch;
			this.pitch *= this.pitchMul;
			const b = sin1(this.phase) + sin1(this.phase2) * 0.5;
			let y = (this.buzz > 1 ? softClip(b * this.buzz) * this.buzzNorm : b) * this.body;
			this.phase += this.inc1 * bend;
			if (this.phase >= 1) this.phase -= 1;
			this.phase2 += this.inc2 * bend;
			if (this.phase2 >= 1) this.phase2 -= 1;
			this.body *= this.bodyMul;
			const n = this.noise.next();
			const noise = this.f1.hp(n) * 0.6 + this.f2.bpNorm(n) * 0.7;
			if (this.t >= this.noiseWait) {
				if (this.rise < 1) this.rise = Math.min(1, this.rise + this.attack);
				y += noise * this.amp * this.rise;
				this.amp *= this.ampMul;
			}
			if (this.ring > 1e-5) {
				y += this.f3.bpNorm(n) * this.ring;
				this.ring *= this.ringMul;
			}
			if (this.crack > 1e-5) {
				y += this.hp.hp(n) * this.crack;
				this.crack *= this.crackMul;
			}
			// A clap on top of the snare: two quick bursts of band-passed noise.
			if (this.clapLayer > 1e-5) {
				if (this.clapBurst === 1 && this.t === this.clapNext) {
					this.clapLayer = this.clapStart;
					this.clapBurst = 0;
				}
				y += this.f4.bpNorm(n) * this.clapLayer;
				this.clapLayer *= this.burstMul;
			}
			if (this.fm > 1e-5) {
				this.fmModPhase += this.inc1 * 2.828;
				if (this.fmModPhase >= 1) this.fmModPhase -= 1;
				let cp = this.fmPhase + sin1(this.fmModPhase) * 0.4;
				cp -= Math.floor(cp);
				y += sin1(cp) * this.fm;
				this.fmPhase += this.inc1 * 2;
				if (this.fmPhase >= 1) this.fmPhase -= 1;
				this.fm *= this.fmMul;
			}
			this.t++;
			this.out(L, R, i, softClip(y * drive) * norm * level);
		}
		if (this.amp < 1e-4 && this.body < 1e-4 && this.ring < 1e-4 && this.fm < 1e-4) this.active = false;
	}

	renderClap(L, R, start, end) {
		const level = this.recipe.level * 0.9;
		if (this.kind === 'clap') {
			for (let i = start; i < end; i++) {
				this.t++;
				if (this.bursts > 0 && this.t >= this.nextBurst) {
					this.burst = 1;
					this.bursts--;
					this.nextBurst += this.spacing;
					if (this.bursts === 0) this.tail = 0.85;
				}
				const env = this.burst + this.tail;
				this.burst *= this.burstMul;
				this.tail *= this.tailMul;
				this.out(L, R, i, this.f1.bpNorm(this.noise.next()) * env * this.amp * level);
			}
			if (this.bursts === 0 && this.tail < 1e-4) this.active = false;
		} else if (this.kind === 'snap') {
			for (let i = start; i < end; i++) {
				this.out(L, R, i, this.f1.bpNorm(this.noise.next()) * this.amp * level * 1.3);
				this.amp *= this.ampMul;
			}
			if (this.amp < 1e-4) this.active = false;
		} else {
			for (let i = start; i < end; i++) {
				const y = (sin1(this.phase) * 0.6 + sin1(this.phase2) * 0.4 + this.f1.bpNorm(this.noise.next()) * 0.6) * this.amp;
				this.phase += this.inc1;
				if (this.phase >= 1) this.phase -= 1;
				this.phase2 += this.inc2;
				if (this.phase2 >= 1) this.phase2 -= 1;
				this.amp *= this.ampMul;
				this.out(L, R, i, y * level);
			}
			if (this.amp < 1e-4) this.active = false;
		}
	}

	// Hats and cymbals: six square oscillators and noise, band-passed and high-passed.
	renderMetallic(L, R, start, end, cymbal) {
		const level = this.recipe.level;
		const metal = this.metal;
		const inc = this.metalInc;
		const ph = this.metalPhase;
		for (let i = start; i < end; i++) {
			let sq = 0;
			for (let k = 0; k < 6; k++) {
				ph[k] += inc[k];
				if (ph[k] >= 1) ph[k] -= 1;
				sq += ph[k] < 0.5 ? 1 : -1;
			}
			const n = this.noise.next();
			const x = sq * 0.2 * metal + n * (1 - metal * 0.6);
			let y = this.hp.hp(this.f1.bpNorm(x) + x * 0.25) * this.amp;
			this.amp *= this.ampMul;
			if (this.spark > 1e-5) {
				y += n * this.spark * 0.5;
				this.spark *= this.sparkMul;
			}
			if (cymbal && this.bell > 1e-5) {
				y += (sin1(this.phase) + sin1(this.phase2) * 0.6) * this.bell * 0.25;
				this.phase += this.inc1;
				if (this.phase >= 1) this.phase -= 1;
				this.phase2 += this.inc2;
				if (this.phase2 >= 1) this.phase2 -= 1;
				this.bell *= this.bellMul;
			}
			this.out(L, R, i, y * level);
		}
		if (this.amp < 1e-4) this.active = false;
	}

	renderTom(L, R, start, end) {
		const sr = this.sr;
		const level = this.recipe.level * 0.8;
		for (let i = start; i < end; i++) {
			const f = this.fEnd * (1 + this.drop * this.pitch);
			this.pitch *= this.pitchMul;
			this.phase += f / sr;
			if (this.phase >= 1) this.phase -= 1;
			let y = sin1(this.phase) * this.amp;
			if (this.amp2 > 1e-5) {
				this.phase2 += (f * this.ratio2) / sr;
				if (this.phase2 >= 1) this.phase2 -= 1;
				y += sin1(this.phase2) * this.amp2;
				this.amp2 *= this.amp2Mul;
			}
			this.amp *= this.ampMul;
			if (this.click > 1e-5) {
				y += this.noise.next() * this.click;
				this.click *= this.clickMul;
			}
			this.out(L, R, i, softClip(y * 1.2) * level);
		}
		if (this.amp < 1e-4) this.active = false;
	}

	// Two-operator FM with an inharmonic ratio: anvils, bells, and metal plates.
	renderMetal(L, R, start, end) {
		const sr = this.sr;
		const level = this.recipe.level * 0.8;
		const inc = this.fEnd / sr;
		const modInc = inc * this.ratio2;
		for (let i = start; i < end; i++) {
			this.fmModPhase += modInc;
			if (this.fmModPhase >= 1) this.fmModPhase -= 1;
			let cp = this.phase + (sin1(this.fmModPhase) * this.index) / (2 * Math.PI);
			cp -= Math.floor(cp);
			const y = sin1(cp) * this.amp;
			this.phase += inc;
			if (this.phase >= 1) this.phase -= 1;
			this.index *= this.indexMul;
			this.amp *= this.ampMul;
			this.out(L, R, i, y * level);
		}
		if (this.amp < 1e-4) this.active = false;
	}

	renderCowbell(L, R, start, end) {
		const level = this.recipe.level;
		for (let i = start; i < end; i++) {
			const sq = (this.phase < 0.5 ? 1 : -1) + (this.phase2 < 0.5 ? 1 : -1);
			this.phase += this.inc1;
			if (this.phase >= 1) this.phase -= 1;
			this.phase2 += this.inc2;
			if (this.phase2 >= 1) this.phase2 -= 1;
			const env = this.amp + this.amp2;
			this.amp *= this.ampMul;
			this.amp2 *= this.amp2Mul;
			this.out(L, R, i, this.f1.bpNorm(sq * 0.5) * env * level);
		}
		if (this.amp + this.amp2 < 1e-4) this.active = false;
	}

	renderShaker(L, R, start, end) {
		const level = this.recipe.level;
		for (let i = start; i < end; i++) {
			if (this.rising) {
				this.amp += this.peak * this.rise;
				if (this.amp >= this.peak) this.rising = false;
			} else {
				this.amp *= this.ampMul;
			}
			this.out(L, R, i, this.f1.hp(this.noise.next()) * this.amp * level);
		}
		if (!this.rising && this.amp < 1e-4) this.active = false;
	}
}

export class DrumsEngine extends PolyEngine {
	constructor(sr, ctx) {
		const voices = [];
		super(sr, ctx, voices, instrumentDefaults('drums'));
		for (let i = 0; i < 16; i++) voices.push(new DrumVoice(sr, this, 0xd2a3 + i * 2741));
		this.lp = [new SVF(), new SVF()];
		this.cutoff = 0;
		// Drum bus state: compressor envelope, and the air shelf's low-passes.
		this.env = 0;
		this.airL = new OnePole();
		this.airR = new OnePole();
		this.airL.setFreq(7000, sr);
		this.airR.setFreq(7000, sr);
		this.attack = 1 - Math.exp(-1 / (0.003 * sr));
		this.releaseCoef = 1 - Math.exp(-1 / (0.08 * sr));
		// A short tail so the bus keeps running while hits ring out.
		this.tail = Math.round(sr * 0.3);
	}

	// Kick pitch: the chosen palette degree within the octave above 48 Hz.
	kickHz() {
		const palette = this.ctx.palette || [1];
		const degree = Math.round(clamp(this.params.tune, 0, 5)) % palette.length;
		return 48 * indexValue(palette, degree);
	}

	bus(L, R, start, end) {
		const punch = this.params.punch;
		const threshold = 0.3;
		const ratio = 1.5 + punch * 2;
		const makeup = 1 + punch * 0.4;
		const drive = 1.2 + punch * 1.2;
		const clipNorm = 1 / drive;
		let env = this.env;
		for (let i = start; i < end; i++) {
			const l = L[i];
			const r = R[i];
			const a = Math.max(l < 0 ? -l : l, r < 0 ? -r : r);
			env += (a - env) * (a > env ? this.attack : this.releaseCoef);
			const gain = env > threshold ? (threshold * (env / threshold) ** (1 / ratio)) / env : 1;
			const g = gain * makeup * drive;
			// About +2 dB of air above 7 kHz.
			const al = l + (l - this.airL.lp(l)) * 0.26;
			const ar = r + (r - this.airR.lp(r)) * 0.26;
			L[i] = softClip(al * g) * clipNorm;
			R[i] = softClip(ar * g) * clipNorm;
		}
		this.env = env < 1e-9 ? 0 : env;
	}

	chokeOpenHats(except) {
		for (const v of this.voices) {
			if (v !== except && v.active && v.row === OPEN_HAT) v.ampMul = Math.min(v.ampMul, decayCoef(0.03, this.sr));
		}
	}

	// The drum bus: a fast compressor lifts the body and tails, a shelf adds a
	// little air, and a soft clipper shaves the sharpest transients, so hits
	// sound full rather than thin and spiky (and the kick's harmonics reach small
	// speakers). Punch sets how hard it works: at the default it takes about 3 dB
	// off the kit's peak-to-loudness ratio. Only the lo-fi, metal, and break kits
	// then color the whole kit.
	post(L, R, start, end) {
		this.bus(L, R, start, end);
		const post = (KITS[this.params.style] || KITS.soft).post;
		if (!post) return;
		if (post.lp) {
			const cutoff = post.lp * (0.7 + this.params.tone * 0.6);
			if (cutoff !== this.cutoff) {
				this.cutoff = cutoff;
				for (const f of this.lp) f.set(cutoff, 0.6, this.sr);
			}
		}
		const [fl, fr] = this.lp;
		const grit = post.grit || 0;
		const lp = !!post.lp;
		for (let i = start; i < end; i++) {
			let l = lp ? fl.lp(L[i]) : L[i];
			let r = lp ? fr.lp(R[i]) : R[i];
			if (grit) {
				l = softClip(l * (1 + grit * 2)) / (1 + grit * 0.5);
				r = softClip(r * (1 + grit * 2)) / (1 + grit * 0.5);
			}
			L[i] = l;
			R[i] = r;
		}
	}
}
