// Modal synthesis: a mallet excites a bank of two-pole resonators. Materials
// define partial ratios; the Seeker bell's partials are themselves Seeker
// ratios, so its whole spectrum is in tune.

import { PolyEngine, Voice } from '../poly.js';
import { Noise, clamp, lerp, panGains } from '../core.js';
import { instrumentDefaults } from '../../../js/instruments.js';

const MAX_MODES = 10;

const MATERIALS = {
	wood: { ratios: [1, 4, 10, 16, 3], amps: [1, 0.5, 0.2, 0.06, 0.05], decays: [1, 0.35, 0.14, 0.06, 0.3], scale: 0.35, level: 1.3 },
	metal: { ratios: [1, 4, 10, 2, 7], amps: [1, 0.32, 0.12, 0.05, 0.04], decays: [1, 0.5, 0.25, 0.7, 0.3], scale: 1, level: 1.2 },
	glass: { ratios: [1, 2.756, 5.404, 8.933, 13.34], amps: [1, 0.45, 0.3, 0.16, 0.08], decays: [1, 0.6, 0.4, 0.28, 0.18], scale: 0.8, level: 1.1 },
	bell: {
		ratios: [0.5, 1, 19 / 16, 3 / 2, 2, 21 / 8, 3, 4, 6],
		amps: [0.4, 1, 0.5, 0.3, 0.6, 0.25, 0.2, 0.14, 0.07],
		decays: [1.6, 1, 0.75, 0.6, 0.55, 0.4, 0.35, 0.25, 0.15],
		scale: 1.2,
		level: 1,
	},
	string: { ratios: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], amps: [1, 0.5, 0.33, 0.25, 0.2, 0.17, 0.14, 0.12, 0.11, 0.1], decays: [1, 0.8, 0.66, 0.56, 0.48, 0.42, 0.37, 0.33, 0.3, 0.27], scale: 0.9, level: 1.1, positional: true },
	bowl: { ratios: [1, 1.0035, 2.71, 2.722, 5.1, 8.3], amps: [0.7, 0.7, 0.45, 0.45, 0.25, 0.12], decays: [1, 1, 0.7, 0.7, 0.45, 0.3], scale: 1.6, level: 1 },
};

// Shared scratch buffer for one block of mallet excitation.
const EXCITE = new Float32Array(128);

class BellVoice extends Voice {
	constructor(sr, engine, seed) {
		super();
		this.sr = sr;
		this.engine = engine;
		this.noise = new Noise(seed);
		this.count = 0;
		this.a1 = new Float32Array(MAX_MODES);
		this.a2 = new Float32Array(MAX_MODES);
		this.g = new Float32Array(MAX_MODES);
		this.y1 = new Float32Array(MAX_MODES);
		this.y2 = new Float32Array(MAX_MODES);
		this.pl = new Float32Array(MAX_MODES);
		this.pr = new Float32Array(MAX_MODES);
		this.cosw = new Float32Array(MAX_MODES);
		this.t60 = new Float32Array(MAX_MODES);
		this.pulsePos = 0;
		this.pulseLen = 0;
		this.pulseAmp = 0;
		this.clickLen = 0;
		this.clickAmp = 0;
		this.energy = 0;
	}

	level() {
		return this.energy;
	}

	start(freq, vel) {
		const p = this.engine.params;
		const sr = this.sr;
		const mat = MATERIALS[p.material] || MATERIALS.bell;
		const retune = Math.abs(freq - this.freq) > 0.01 || !this.active;
		this.freq = freq;
		const tilt = lerp(-1.3, 0.25, p.tone);
		const posRatio = lerp(0.08, 0.5, p.position);
		const damp = 0.5 + p.damping * 1.6;
		const width = p.width;

		let count = 0;
		let energy = 0;
		for (let m = 0; m < mat.ratios.length && count < MAX_MODES; m++) {
			const f = freq * mat.ratios[m];
			if (f > sr * 0.45 || f < 20) continue;
			let amp = mat.amps[m] * Math.max(mat.ratios[m], 1) ** tilt;
			const k = m + 1;
			const shape = Math.abs(Math.sin(Math.PI * k * posRatio));
			amp *= mat.positional ? shape : 0.4 + 0.6 * shape;
			const w = (2 * Math.PI * f) / sr;
			const t60 = Math.max(0.03, p.decay * mat.scale * mat.decays[m] ** damp * clamp((220 / freq) ** 0.25, 0.6, 1.6));
			const r = Math.exp(-6.907755 / (t60 * sr));
			this.cosw[count] = Math.cos(w);
			this.t60[count] = t60;
			this.a1[count] = 2 * r * Math.cos(w);
			this.a2[count] = r * r;
			this.g[count] = Math.sin(w) * amp;
			const pan = (m % 2 === 0 ? -1 : 1) * width * 0.55 * Math.min(1, m / 2);
			const [gl, gr] = panGains(pan);
			this.pl[count] = gl;
			this.pr[count] = gr;
			if (retune) {
				this.y1[count] = 0;
				this.y2[count] = 0;
			}
			energy += amp * amp;
			count++;
		}
		this.count = count;
		const norm = (mat.level * 0.32) / Math.sqrt(Math.max(energy, 1e-6));
		for (let m = 0; m < count; m++) this.g[m] *= norm;

		// A half-sine mallet pulse of unit area. Its width scales with the period,
		// so a soft mallet rounds off upper partials on every note.
		const hardness = clamp(p.hardness * 0.8 + vel * 0.25, 0, 1);
		const periods = lerp(0.9, 0.06, hardness);
		this.pulseLen = Math.round(clamp((periods * sr) / freq, 2, sr * 0.012));
		this.pulsePos = 0;
		this.pulseAmp = (vel * Math.PI) / (2 * this.pulseLen);
		this.clickLen = Math.round(sr * 0.0008);
		this.clickAmp = vel * hardness * hardness * 0.08;
		this.energy = 1;
	}

	release() {
		const p = this.engine.params;
		if (p.sustain >= 0.99) return;
		const sr = this.sr;
		const choke = lerp(0.06, 1, p.sustain * p.sustain);
		for (let m = 0; m < this.count; m++) {
			const t60 = Math.max(0.03, this.t60[m] * choke);
			const r = Math.exp(-6.907755 / (t60 * sr));
			this.a1[m] = 2 * r * this.cosw[m];
			this.a2[m] = r * r;
		}
	}

	render(L, R, start, end) {
		const n = end - start;
		const exc = EXCITE;
		let exciting = false;
		for (let i = 0; i < n; i++) {
			let x = 0;
			if (this.pulsePos < this.pulseLen) {
				x = this.pulseAmp * Math.sin((Math.PI * (this.pulsePos + 0.5)) / this.pulseLen);
				exciting = true;
			}
			if (this.pulsePos < this.clickLen) x += this.noise.next() * this.clickAmp;
			this.pulsePos++;
			exc[i] = x;
		}

		let energy = 0;
		for (let m = 0; m < this.count; m++) {
			const a1 = this.a1[m];
			const a2 = this.a2[m];
			const g = this.g[m];
			const pl = this.pl[m];
			const pr = this.pr[m];
			let y1 = this.y1[m];
			let y2 = this.y2[m];
			if (exciting) {
				for (let i = 0; i < n; i++) {
					const y = a1 * y1 - a2 * y2 + g * exc[i];
					y2 = y1;
					y1 = y;
					L[start + i] += y * pl;
					R[start + i] += y * pr;
				}
			} else {
				for (let i = 0; i < n; i++) {
					const y = a1 * y1 - a2 * y2;
					y2 = y1;
					y1 = y;
					L[start + i] += y * pl;
					R[start + i] += y * pr;
				}
			}
			this.y1[m] = y1;
			this.y2[m] = y2;
			energy += Math.abs(y1) + Math.abs(y2);
		}
		this.energy = energy;
		if (!exciting && energy < 2e-5) {
			this.active = false;
			for (let m = 0; m < this.count; m++) {
				this.y1[m] = 0;
				this.y2[m] = 0;
			}
		}
	}
}

export class BellsEngine extends PolyEngine {
	constructor(sr, ctx) {
		const voices = [];
		super(sr, ctx, voices, instrumentDefaults('bells'));
		for (let i = 0; i < 14; i++) voices.push(new BellVoice(sr, this, 0x1234 + i * 977));
	}
}
