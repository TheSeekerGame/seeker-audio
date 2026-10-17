// Polyphonic voice management shared by every instrument.
//
// An engine owns a fixed pool of voices. noteOn() takes a gate length in
// samples; the engine releases the voice itself when the gate runs out, at the
// exact sample, so the sequencer never schedules note-offs. A gate of zero
// holds the note until noteOff(key), which live playing uses.

export class Voice {
	constructor() {
		this.active = false;
		this.released = false;
		this.gate = 0;
		this.key = -1;
		this.age = 0;
		this.freq = 0;
	}

	// Approximate current loudness, used to choose which voice to steal.
	level() {
		return 0;
	}

	start() {}

	release() {}

	render() {}
}

export class PolyEngine {
	constructor(sr, ctx, voices, defaults) {
		this.sr = sr;
		this.ctx = ctx;
		this.params = { ...defaults };
		this.voices = voices;
		this.clock = 0;
		// Increments on every parameter change so voices can follow edits mid-note.
		this.version = 0;
		// Samples of post-processing tail after the last voice ends (filters, chorus).
		this.tail = Math.round(sr * 0.1);
		this.idle = 0;
	}

	setParams(params) {
		for (const key in params) this.params[key] = params[key];
		this.version++;
		this.paramsChanged();
	}

	paramsChanged() {}

	allocate(key) {
		let best = null;
		if (key >= 0) {
			for (const v of this.voices) if (v.active && v.key === key) return v;
		}
		for (const v of this.voices) if (!v.active) return v;
		let bestScore = Infinity;
		for (const v of this.voices) {
			// Prefer released, quiet, old voices.
			const score = v.level() * (v.released ? 1 : 4) + v.age * 1e-9;
			if (score < bestScore) {
				bestScore = score;
				best = v;
			}
		}
		return best;
	}

	noteOn(freq, vel, gate, key = -1, row = 0) {
		const v = this.allocate(key);
		if (!v) return;
		v.key = key;
		v.gate = gate;
		v.age = this.clock++;
		v.released = false;
		v.start(freq, vel, row);
		v.active = true;
	}

	noteOff(key) {
		for (const v of this.voices) {
			if (v.active && v.key === key && !v.released) {
				v.released = true;
				v.release();
			}
		}
	}

	allOff() {
		for (const v of this.voices) {
			if (v.active && !v.released) {
				v.released = true;
				v.release();
			}
		}
	}

	get busy() {
		for (const v of this.voices) if (v.active) return true;
		return false;
	}

	process(L, R, start, end) {
		let any = false;
		for (const v of this.voices) {
			if (!v.active) continue;
			any = true;
			let s = start;
			if (!v.released && v.gate > 0) {
				const n = end - start;
				if (v.gate <= n) {
					const mid = start + v.gate;
					if (mid > s) v.render(L, R, s, mid);
					v.gate = 0;
					v.released = true;
					v.release();
					s = mid;
				} else {
					v.gate -= n;
				}
			}
			if (s < end && v.active) v.render(L, R, s, end);
		}
		// Once every voice and its tail has died away, skip post-processing.
		if (any) this.idle = 0;
		else if (this.idle > this.tail) return;
		else this.idle += end - start;
		this.post(L, R, start, end);
	}

	post() {}
}
