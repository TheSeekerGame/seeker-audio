// Electric piano: two-operator FM with a decaying index, plus a short tine
// ping on the seventh harmonic. The modulator always sits on a harmonic of the
// note, so the spectrum stays harmonic.

import { PolyEngine, Voice } from '../poly.js';
import { sin1, clamp, lerp, panGains, decayCoef } from '../core.js';
import { instrumentDefaults } from '../../../js/instruments.js';

const RATIOS = { '1/2': 0.5, 1: 1, 2: 2, 3: 3, 4: 4, 7: 7 };
const INV_TAU = 1 / (2 * Math.PI);

class KeysVoice extends Voice {
	constructor(sr, engine) {
		super();
		this.sr = sr;
		this.engine = engine;
		this.pc = 0;
		this.pm = 0;
		this.pt = 0;
		this.prev = 0;
		this.amp = 0;
		this.ampMul = 1;
		this.attack = 0;
		this.attackInc = 0;
		this.index = 0;
		this.indexMul = 1;
		this.ping = 0;
		this.pingMul = 1;
		this.pl = 0.7;
		this.pr = 0.7;
	}

	level() {
		return this.amp;
	}

	start(freq, vel) {
		const p = this.engine.params;
		const sr = this.sr;
		this.freq = freq;
		this.ratio = RATIOS[p.ratio] || 1;
		this.incC = freq / sr;
		this.incM = (freq * this.ratio) / sr;
		this.incT = (freq * 7) / sr;
		this.pc = 0;
		this.pm = 0;
		this.pt = 0;
		this.prev = 0;
		const t60 = p.decay * clamp((220 / freq) ** 0.45, 0.35, 2);
		this.ampMul = decayCoef(t60, sr);
		this.amp = vel * 0.36;
		this.attack = 0;
		this.attackInc = 1 / Math.max(1, sr * 0.0015);
		const color = p.color * (0.55 + 0.45 * vel);
		// Keep sidebands below Nyquist on high notes.
		const headroom = clamp((sr * 0.45 - freq * this.ratio * 4) / (sr * 0.25), 0, 1);
		this.index = (0.25 + 5.5 * color * color) * headroom * headroom;
		this.indexFloor = this.index * 0.12;
		this.indexMul = decayCoef(lerp(0.25, 1.2, 1 - p.color) * Math.min(1, t60), sr);
		this.feedback = p.bell * 0.6;
		const pingOk = freq * 7 < sr * 0.42;
		this.ping = pingOk ? p.bell * vel * 0.22 : 0;
		this.pingMul = decayCoef(0.09, sr);
		const pan = clamp(Math.log2(freq / 330) * 0.4, -1, 1) * p.width;
		[this.pl, this.pr] = panGains(pan);
	}

	release() {
		const p = this.engine.params;
		this.ampMul = Math.min(this.ampMul, decayCoef(lerp(0.12, 1.8, p.sustain), this.sr));
	}

	render(L, R, start, end) {
		let { pc, pm, pt, prev, amp, attack, index, ping } = this;
		const { incC, incM, incT, ampMul, attackInc, indexMul, pingMul, indexFloor, feedback, pl, pr } = this;
		const fb = feedback * INV_TAU;
		for (let i = start; i < end; i++) {
			let mp = pm + prev * fb;
			mp -= Math.floor(mp);
			const mod = sin1(mp);
			prev = mod;
			let phase = pc + (index + indexFloor) * mod * INV_TAU;
			phase -= Math.floor(phase);
			let y = sin1(phase) * amp;
			if (ping > 1e-6) {
				y += sin1(pt) * ping;
				ping *= pingMul;
			}
			if (attack < 1) {
				attack += attackInc;
				y *= attack < 1 ? attack : 1;
			}
			L[i] += y * pl;
			R[i] += y * pr;
			pc += incC;
			if (pc >= 1) pc -= 1;
			pm += incM;
			if (pm >= 1) pm -= 1;
			pt += incT;
			if (pt >= 1) pt -= 1;
			amp *= ampMul;
			index *= indexMul;
		}
		this.pc = pc;
		this.pm = pm;
		this.pt = pt;
		this.prev = prev;
		this.amp = amp;
		this.attack = attack;
		this.index = index;
		this.ping = ping;
		if (amp < 1e-5) this.active = false;
	}
}

export class KeysEngine extends PolyEngine {
	constructor(sr, ctx) {
		const voices = [];
		super(sr, ctx, voices, instrumentDefaults('keys'));
		for (let i = 0; i < 12; i++) voices.push(new KeysVoice(sr, this));
		this.lfo = 0;
	}

	// Suitcase-style auto-pan at 4.5 Hz (48 × 3/32).
	post(L, R, start, end) {
		const depth = this.params.motion * 0.85;
		if (depth < 0.01) return;
		const inc = 4.5 / this.sr;
		let phase = this.lfo;
		for (let i = start; i < end; i++) {
			const s = sin1(phase);
			const gl = 1 - depth * (0.5 + 0.5 * s);
			const gr = 1 - depth * (0.5 - 0.5 * s);
			const l = L[i];
			const r = R[i];
			L[i] = l * gl + r * (1 - gr) * 0.3;
			R[i] = r * gr + l * (1 - gl) * 0.3;
			phase += inc;
			if (phase >= 1) phase -= 1;
		}
		this.lfo = phase;
	}
}
