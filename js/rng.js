// Small seeded random number generator (sfc32). Shared by the interface and the
// audio worklet so generated material is reproducible from a seed.

function splitmix(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x9e3779b9) >>> 0;
		let z = s;
		z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
		z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
		return (z ^ (z >>> 16)) >>> 0;
	};
}

export function randomSeed() {
	if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
		return crypto.getRandomValues(new Uint32Array(1))[0];
	}
	return (Math.random() * 2 ** 32) >>> 0;
}

export class Rng {
	constructor(seed = randomSeed()) {
		const init = splitmix(seed);
		this.a = init();
		this.b = init();
		this.c = init();
		this.d = init();
		for (let i = 0; i < 12; i++) this.next();
	}

	// Uniform in [0, 1).
	next() {
		this.a >>>= 0;
		this.b >>>= 0;
		this.c >>>= 0;
		this.d >>>= 0;
		let t = (this.a + this.b) | 0;
		this.a = this.b ^ (this.b >>> 9);
		this.b = (this.c + (this.c << 3)) | 0;
		this.c = (this.c << 21) | (this.c >>> 11);
		this.d = (this.d + 1) | 0;
		t = (t + this.d) | 0;
		this.c = (this.c + t) | 0;
		return (t >>> 0) / 4294967296;
	}

	range(lo, hi) {
		return lo + (hi - lo) * this.next();
	}

	// Integer in [lo, hi], inclusive.
	int(lo, hi) {
		return lo + Math.floor(this.next() * (hi - lo + 1));
	}

	chance(p) {
		return this.next() < p;
	}

	pick(list) {
		return list[Math.floor(this.next() * list.length)];
	}

	// Picks from [[value, weight], ...].
	weighted(entries) {
		let total = 0;
		for (const [, w] of entries) total += w;
		let r = this.next() * total;
		for (const [value, w] of entries) {
			r -= w;
			if (r <= 0) return value;
		}
		return entries[entries.length - 1][0];
	}

	// Approximately normal, mean 0, deviation 1.
	gauss() {
		return (this.next() + this.next() + this.next() + this.next() - 2) * 1.7320508;
	}

	shuffle(list) {
		const out = list.slice();
		for (let i = out.length - 1; i > 0; i--) {
			const j = Math.floor(this.next() * (i + 1));
			[out[i], out[j]] = [out[j], out[i]];
		}
		return out;
	}
}
