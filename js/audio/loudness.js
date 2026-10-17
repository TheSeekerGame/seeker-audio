// Perceived loudness, after the K-weighting used by broadcast loudness meters
// (ITU-R BS.1770): low bass counts for little and the presence range for a
// little more, so a 48 Hz kick and a bright snare are judged as ears judge them.
// Plain JavaScript, shared by the interface, the mixer, and the tests.

export class KWeight {
	constructor(sr) {
		// Two one-pole high-passes near 38 Hz, and a +4 dB shelf above ~1.5 kHz.
		this.a38 = 1 - Math.exp((-2 * Math.PI * 38) / sr);
		this.a1500 = 1 - Math.exp((-2 * Math.PI * 1500) / sr);
		this.z1 = 0;
		this.z2 = 0;
		this.z3 = 0;
	}

	process(x) {
		this.z1 += (x - this.z1) * this.a38;
		const h1 = x - this.z1;
		this.z2 += (h1 - this.z2) * this.a38;
		const h2 = h1 - this.z2;
		this.z3 += (h2 - this.z3) * this.a1500;
		return h2 + 0.585 * (h2 - this.z3);
	}
}

// Accumulates K-weighted mean square over stereo blocks.
export class LoudnessMeter {
	constructor(sr) {
		this.l = new KWeight(sr);
		this.r = new KWeight(sr);
		this.sum = 0;
		this.count = 0;
	}

	add(L, R, n = L.length) {
		for (let i = 0; i < n; i++) {
			const l = this.l.process(L[i]);
			const r = this.r.process(R[i]);
			this.sum += l * l + r * r;
		}
		this.count += n;
	}

	// Loudness in dB relative to full scale (about LUFS + 0.7 for a stereo signal).
	get db() {
		return this.count ? 10 * Math.log10(this.sum / this.count + 1e-12) : -120;
	}
}

// Gated loudness, after BS.1770: the mean over 400 ms blocks taken every
// 100 ms, leaving out silence and blocks more than 10 dB under the rest, so a
// sparse melody is judged by its notes rather than the rests between them.
export class GatedLoudness {
	constructor(sr) {
		this.l = new KWeight(sr);
		this.r = new KWeight(sr);
		this.hop = Math.round(sr * 0.1);
		this.acc = 0;
		this.count = 0;
		this.hops = [];
	}

	add(L, R, n = L.length) {
		for (let i = 0; i < n; i++) {
			const l = this.l.process(L[i]);
			const r = this.r.process(R[i]);
			this.acc += l * l + r * r;
			if (++this.count === this.hop) {
				this.hops.push(this.acc / this.hop);
				this.acc = 0;
				this.count = 0;
			}
		}
	}

	get db() {
		const blocks = [];
		for (let j = 3; j < this.hops.length; j++) {
			const ms = (this.hops[j - 3] + this.hops[j - 2] + this.hops[j - 1] + this.hops[j]) / 4;
			if (ms > 1e-7) blocks.push(ms);
		}
		if (!blocks.length) return -120;
		const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;
		const gate = mean(blocks) * 0.1;
		return 10 * Math.log10(mean(blocks.filter((ms) => ms >= gate)));
	}
}
