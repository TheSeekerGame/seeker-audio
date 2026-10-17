// The song: up to eight layers, each an instrument playing a looping step
// pattern. The sequencer runs inside the audio callback, so every note starts
// on its exact sample. Pitches come only from the palette, which keeps every
// note a Seeker ratio of 48 Hz.
//
// Drum layers also drive the sidechain, a ninth (mono) output that every layer
// can be carved by. Drums render LOOKAHEAD ahead of the song and are delayed
// back into place, so the song knows every hit before it sounds:
//   ring-mod  the kick's own waveform, delayed into step with it: other layers
//             are cut exactly where the kick has level and pass where it
//             crosses zero, so the two never pile up and nothing pumps.
//   gap       a short silence that opens just before each kick and snare (the
//             drum kit's "sidechain gap"), the look-ahead ducking of neuro.

import { createEngine } from './engines/index.js';
import { Noise, clamp } from './core.js';
import { indexFrequency, foldFrequency, tempoBpm, normalizePalette, DEFAULT_ROOT, DEFAULT_TEMPO } from '../../js/tuning.js';
import { INSTRUMENTS } from '../../js/instruments.js';

export const MAX_LAYERS = 8;
const BEATS_PER_BAR = 4;
const MAX_EVENTS = 128;
const FADE_SECONDS = 0.04;
const LOOKAHEAD = 0.01;
// Rows whose hits open a sidechain gap: kick and snare.
const GAP_ROWS = 2;
// A kick at this level cuts sidechained layers completely.
const SIDECHAIN_FULL = 0.87;

// A fixed delay that returns a drum layer's early render to song time.
class Lookahead {
	constructor(length) {
		this.l = new Float32Array(length);
		this.r = new Float32Array(length);
		this.w = 0;
	}

	process(L, R, n) {
		const bl = this.l;
		const br = this.r;
		const size = bl.length;
		let w = this.w;
		for (let i = 0; i < n; i++) {
			const l = bl[w];
			const r = br[w];
			bl[w] = L[i];
			br[w] = R[i];
			L[i] = l;
			R[i] = r;
			if (++w === size) w = 0;
		}
		this.w = w;
	}

	// Makes the next `length` outputs the given audio, crossfading from what was
	// queued so a still-ringing kit does not click.
	prime(L, R) {
		const size = this.l.length;
		const fade = Math.min(64, size);
		for (let j = 0; j < size; j++) {
			const k = (this.w + j) % size;
			const x = j < fade ? j / fade : 1;
			this.l[k] = this.l[k] * (1 - x) + L[j] * x;
			this.r[k] = this.r[k] * (1 - x) + R[j] * x;
		}
	}
}

class Layer {
	constructor(engineId, engine) {
		this.engineId = engineId;
		this.engine = engine;
		this.drums = !!INSTRUMENTS[engineId]?.drums;
		this.rate = 4;
		this.length = 16;
		this.steps = [];
		this.follow = true;
		this.octave = 0;
		this.gate = 0.9;
		this.active = true;
		this.live = [];
		this.retired = null;
		this.retiredGain = 0;
		// Preallocated event queue: offset, freq, vel, gate, row, key.
		this.evOffset = new Int32Array(MAX_EVENTS);
		this.evFreq = new Float32Array(MAX_EVENTS);
		this.evVel = new Float32Array(MAX_EVENTS);
		this.evGate = new Int32Array(MAX_EVENTS);
		this.evRow = new Int32Array(MAX_EVENTS);
		this.evCount = 0;
		this.peak = 0;
		// Drums: the delay back to song time, and the beat collected up to.
		this.look = null;
		this.until = -Infinity;
	}

	setPattern(pattern) {
		this.rate = pattern?.rate || 4;
		this.length = clamp(Math.round(pattern?.length || 16), 1, 128);
		const steps = Array.from({ length: this.length }, () => []);
		for (const note of pattern?.notes || []) {
			const [step, row, len = 1, vel = 0.8, chance = 1] = note;
			if (step >= 0 && step < this.length) steps[step].push({ row, len, vel, chance });
		}
		this.steps = steps;
	}
}

export class Song {
	constructor(sr, shared = {}) {
		this.sr = sr;
		this.ctx = shared;
		this.ctx.palette = normalizePalette([1, 9, 19, 21, 3, 7]);
		this.ctx.root = DEFAULT_ROOT;
		this.ctx.bpm = tempoBpm(DEFAULT_TEMPO);
		this.ctx.beat = 0;
		this.ctx.playing = false;
		this.ctx.sources = this.ctx.sources || new Map();
		this.layers = new Array(MAX_LAYERS).fill(null);
		this.harmony = [0];
		this.swing = 0;
		this.noise = new Noise(0x5eed);
		// Notes started since the interface last asked, for the visuals.
		this.notes = [];
		this.levels = new Float32Array(MAX_LAYERS);
		this.fadeStep = 1 / (FADE_SECONDS * sr);
		// Sidechain: the kick waveform drum voices write per block, its delay
		// into song time, and pending gaps in absolute output samples.
		this.lookahead = Math.max(1, Math.round(LOOKAHEAD * sr));
		this.sidechain = new Float32Array(Math.max(128, this.lookahead));
		this.ctx.sidechain = this.sidechain;
		this.scLine = new Lookahead(this.lookahead);
		this.gaps = [];
		this.gapEnv = 0;
		this.gapTarget = new Float32Array(128);
		this.gapAttack = 1 - Math.exp(-1 / (0.0004 * sr));
		this.gapRelease = 1 - Math.exp(-1 / (0.0015 * sr));
		this.clock = 0;
		this.gapBase = 0;
		this.preroll = false;
		this.preL = new Float32Array(this.lookahead);
		this.preR = new Float32Array(this.lookahead);
	}

	// --- Messages from the interface --------------------------------------------

	handle(msg) {
		switch (msg.type) {
			case 'tuning':
				this.ctx.palette = normalizePalette(msg.palette);
				this.ctx.root = msg.root;
				break;
			case 'tempo':
				this.ctx.bpm = tempoBpm(msg.tempo);
				this.swing = clamp(msg.swing || 0, 0, 0.75);
				break;
			case 'harmony':
				this.harmony = msg.shifts?.length ? msg.shifts.slice() : [0];
				break;
			case 'layer':
				this.setLayer(msg.index, msg.layer);
				break;
			case 'params':
				this.layers[msg.index]?.engine.setParams(msg.params);
				break;
			case 'pattern':
				this.layers[msg.index]?.setPattern(msg.pattern);
				break;
			case 'flags': {
				const layer = this.layers[msg.index];
				if (layer) this.applyFlags(layer, msg);
				break;
			}
			case 'remove':
				this.removeLayer(msg.index);
				break;
			case 'play':
				this.ctx.beat = 0;
				this.ctx.playing = true;
				this.preroll = true;
				break;
			case 'stop':
				this.stop();
				break;
			case 'live':
				this.layers[msg.index]?.live.push(msg);
				break;
			case 'source':
				this.ctx.sources.set(msg.id, { data: msg.data, rootHz: msg.rootHz, sr: msg.sr, gain: msg.gain || 1 });
				break;
			default:
				break;
		}
	}

	applyFlags(layer, spec) {
		if ('follow' in spec) layer.follow = !!spec.follow;
		if ('octave' in spec) layer.octave = Math.round(spec.octave || 0);
		if ('gate' in spec) layer.gate = clamp(spec.gate ?? 0.9, 0.05, 1);
		if ('active' in spec) {
			layer.active = !!spec.active;
			if (!layer.active) layer.engine.allOff();
		}
	}

	setLayer(index, spec) {
		if (index < 0 || index >= MAX_LAYERS) return;
		let layer = this.layers[index];
		if (!layer || layer.engineId !== spec.engine) {
			const engine = createEngine(spec.engine, this.sr, this.ctx);
			const next = new Layer(spec.engine, engine);
			if (layer) {
				// Let the old instrument fade out rather than cut off.
				layer.engine.allOff();
				next.retired = layer.engine;
				next.retiredGain = 1;
			}
			layer = next;
			if (layer.drums) layer.look = new Lookahead(this.lookahead);
			this.layers[index] = layer;
		}
		layer.engine.setParams(spec.params || {});
		layer.setPattern(spec.pattern);
		this.applyFlags(layer, spec);
	}

	removeLayer(index) {
		const layer = this.layers[index];
		if (!layer) return;
		layer.engine.allOff();
		layer.active = false;
		layer.steps = [];
		layer.removing = true;
	}

	stop() {
		this.ctx.playing = false;
		this.ctx.beat = 0;
		for (const layer of this.layers) layer?.engine.allOff();
	}

	// --- Audio -------------------------------------------------------------------

	frequencyFor(layer, row, bar) {
		const ctx = this.ctx;
		const n = ctx.palette.length;
		const shift = layer.follow ? this.harmony[((bar % this.harmony.length) + this.harmony.length) % this.harmony.length] : 0;
		return foldFrequency(indexFrequency(ctx.palette, row + shift + layer.octave * n, ctx.root));
	}

	// Collects the pattern notes that start within [startBeat, endBeat), placed
	// relative to originBeat, the beat at the block's first sample.
	collect(layer, startBeat, endBeat, originBeat, samplesPerBeat, n) {
		layer.evCount = 0;
		if (!layer.active || !layer.steps.length) return;
		const rate = layer.rate;
		const swingable = rate === 2 || rate === 4 || rate === 8;
		const swingBeats = swingable ? (this.swing * 0.5) / rate : 0;
		const stepSamples = samplesPerBeat / rate;
		const first = Math.max(0, Math.floor(startBeat * rate) - 1);
		const last = Math.ceil(endBeat * rate);
		for (let k = first; k <= last; k++) {
			const t = k / rate + (k % 2 === 1 ? swingBeats : 0);
			if (t < startBeat || t >= endBeat) continue;
			const notes = layer.steps[k % layer.length];
			if (!notes.length) continue;
			const offset = clamp(Math.floor((t - originBeat) * samplesPerBeat), 0, n - 1);
			const bar = Math.floor(t / BEATS_PER_BAR);
			for (const note of notes) {
				if (note.chance < 1 && this.noise.unit() >= note.chance) continue;
				if (layer.evCount >= MAX_EVENTS) return;
				const freq = layer.drums ? 0 : this.frequencyFor(layer, note.row, bar);
				const e = layer.evCount++;
				layer.evOffset[e] = offset;
				layer.evFreq[e] = freq;
				layer.evVel[e] = clamp(note.vel * (1 + this.noise.next() * 0.05), 0.02, 1);
				layer.evGate[e] = Math.max(1, Math.round((note.len - 1 + layer.gate) * stepSamples));
				layer.evRow[e] = note.row;
			}
		}
	}

	pushNote(index, layer, row, freq, vel, offset) {
		if (this.notes.length < 256) this.notes.push({ layer: index, row, freq, vel, offset });
	}

	// Renders one block into outputs[i] = [L, R] for each layer, and the
	// sidechain into outputs[MAX_LAYERS].
	render(outputs, n) {
		const ctx = this.ctx;
		const samplesPerBeat = (60 / ctx.bpm) * this.sr;
		const startBeat = ctx.beat;
		const endBeat = startBeat + n / samplesPerBeat;
		const lead = this.lookahead / samplesPerBeat;
		this.sidechain.fill(0, 0, n);
		if (this.preroll) this.prerollDrums(samplesPerBeat);
		for (let i = 0; i < MAX_LAYERS; i++) {
			const out = outputs[i];
			if (!out) continue;
			out[0].fill(0);
			if (out[1]) out[1].fill(0);
		}
		// Drums first, so the sidechain holds this block's kicks before the rest render.
		for (const drums of [true, false]) {
			for (let i = 0; i < MAX_LAYERS; i++) {
				const layer = this.layers[i];
				const out = outputs[i];
				if (!layer || !out || layer.drums !== drums) continue;
				const L = out[0];
				const R = out[1] || out[0];
				if (!ctx.playing) layer.evCount = 0;
				else if (drums) {
					// Picks up exactly where the last block stopped, even across a tempo change.
					const from = Number.isFinite(layer.until) ? clamp(layer.until, startBeat, endBeat + lead) : startBeat + lead;
					this.collect(layer, from, endBeat + lead, startBeat + lead, samplesPerBeat, n);
					layer.until = endBeat + lead;
				} else this.collect(layer, startBeat, endBeat, startBeat, samplesPerBeat, n);
				this.gapBase = this.clock + this.lookahead;
				this.renderLayer(i, layer, L, R, n);
				if (layer.look) layer.look.process(L, R, n);
				if (layer.removing && !layer.engine.busy && !layer.retired) this.layers[i] = null;
			}
		}
		this.renderSidechain(outputs[MAX_LAYERS]?.[0], n);
		this.clock += n;
		if (ctx.playing) ctx.beat = endBeat;
	}

	// On play, renders the drums' first LOOKAHEAD straight into their delays, so
	// the first hit lands on the downbeat.
	prerollDrums(samplesPerBeat) {
		this.preroll = false;
		const size = this.lookahead;
		const lead = size / samplesPerBeat;
		const sc = this.sidechain;
		sc.fill(0, 0, size);
		this.gapBase = this.clock;
		for (let i = 0; i < MAX_LAYERS; i++) {
			const layer = this.layers[i];
			if (!layer?.look) continue;
			this.preL.fill(0);
			this.preR.fill(0);
			this.collect(layer, 0, lead, 0, samplesPerBeat, size);
			layer.until = lead;
			this.renderLayer(i, layer, this.preL, this.preR, size);
			layer.look.prime(this.preL, this.preR);
		}
		this.scLine.prime(sc, sc);
		sc.fill(0, 0, size);
	}

	// Opens a gap in the sidechained layers around a kick or snare that sounds
	// `offset` samples after gapBase.
	addGap(offset, vel, amount) {
		const onset = this.gapBase + offset;
		const start = onset - Math.round(amount * this.lookahead);
		const end = onset + Math.round((0.002 + amount * 0.004) * this.sr);
		const depth = Math.min(1, vel * 1.2);
		const last = this.gaps[this.gaps.length - 1];
		if (last && start <= last.end && start >= last.start) {
			last.end = Math.max(last.end, end);
			last.depth = Math.max(last.depth, depth);
		} else if (this.gaps.length < 32) {
			this.gaps.push({ start, end, depth });
		}
	}

	// The sidechain signal, 0 (pass) to 1 (cut): the kick's waveform, delayed
	// into song time, or an open gap, whichever is deeper.
	renderSidechain(out, n) {
		const sc = this.sidechain;
		const line = this.scLine;
		// The delay line works in place, so the delayed kick replaces this block's.
		line.process(sc, sc, n);
		const target = this.gapTarget;
		target.fill(0, 0, n);
		const clock = this.clock;
		for (let g = this.gaps.length - 1; g >= 0; g--) {
			const gap = this.gaps[g];
			const a = Math.max(0, gap.start - clock);
			const b = Math.min(n, gap.end - clock);
			for (let i = a; i < b; i++) if (gap.depth > target[i]) target[i] = gap.depth;
			if (gap.end <= clock + n) this.gaps.splice(g, 1);
		}
		let env = this.gapEnv;
		const attack = this.gapAttack;
		const release = this.gapRelease;
		for (let i = 0; i < n; i++) {
			const t = target[i];
			env += (t - env) * (t > env ? attack : release);
			const ring = sc[i] / SIDECHAIN_FULL;
			const v = ring > 1 ? 1 : ring;
			if (out) out[i] = env > v ? env : v;
		}
		this.gapEnv = env < 1e-6 ? 0 : env;
	}

	renderLayer(index, layer, L, R, n) {
		const engine = layer.engine;
		const gap = layer.drums && layer.active ? engine.params.gap || 0 : 0;
		for (const msg of layer.live) {
			if (msg.on) {
				const freq = layer.drums ? 0 : foldFrequency(indexFrequency(this.ctx.palette, msg.row + layer.octave * this.ctx.palette.length, this.ctx.root));
				engine.noteOn(freq, msg.vel ?? 0.8, msg.gate || 0, msg.key, msg.row);
				if (gap && msg.row < GAP_ROWS) this.addGap(0, msg.vel ?? 0.8, gap);
				this.pushNote(index, layer, msg.row, freq, msg.vel ?? 0.8, 0);
			} else {
				engine.noteOff(msg.key);
			}
		}
		layer.live.length = 0;

		let pos = 0;
		for (let e = 0; e < layer.evCount; e++) {
			const offset = layer.evOffset[e];
			if (offset > pos) {
				engine.process(L, R, pos, offset);
				pos = offset;
			}
			engine.noteOn(layer.evFreq[e], layer.evVel[e], layer.evGate[e], -1, layer.evRow[e]);
			if (gap && layer.evRow[e] < GAP_ROWS) this.addGap(offset, layer.evVel[e], gap);
			this.pushNote(index, layer, layer.evRow[e], layer.evFreq[e], layer.evVel[e], offset);
		}
		if (pos < n) engine.process(L, R, pos, n);

		if (layer.retired) {
			if (!this.scratch || this.scratch[0].length < n) this.scratch = [new Float32Array(n), new Float32Array(n)];
			const [sl, sr] = this.scratch;
			sl.fill(0);
			sr.fill(0);
			layer.retired.process(sl, sr, 0, n);
			let g = layer.retiredGain;
			for (let i = 0; i < n; i++) {
				L[i] += sl[i] * g;
				R[i] += sr[i] * g;
				g = Math.max(0, g - this.fadeStep);
			}
			layer.retiredGain = g;
			if (g <= 0) layer.retired = null;
		}

		let peak = 0;
		for (let i = 0; i < n; i++) {
			const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
			if (a > peak) peak = a;
		}
		if (peak > this.levels[index]) this.levels[index] = peak;
	}

	takeNotes() {
		const notes = this.notes;
		this.notes = [];
		return notes;
	}

	takeLevels() {
		const out = Array.from(this.levels);
		this.levels.fill(0);
		return out;
	}
}
