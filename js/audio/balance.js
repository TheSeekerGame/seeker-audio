// Automatic balance. Each layer's own loudness is measured offline (its
// instrument and pattern alone, before effects and fader) and the layer gets
// the gain that brings it to its role's level: drums and bass up front,
// chords, drones, and textures behind. The fader works from there. Trims are a
// pure function of the song, so a shared link and its stems sound the same
// everywhere, and they are never stored.
//
// The measuring runs in a worker so editing never stutters; results are cached
// by sound, so changing one layer re-measures only that layer.

import { Song } from '../../worklet/dsp/song.js';
import { GatedLoudness } from './loudness.js';
import { tempoBpm } from '../tuning.js';

const SR = 48000;
const BLOCK = 128;
const MIN_SECONDS = 4;
const MAX_SECONDS = 8;
const MAX_BOOST_DB = 12;
const MAX_CUT_DB = 15;
const DEBOUNCE_MS = 250;

// Gated K-weighted loudness each role is brought to, in dB.
export const ROLE_LOUDNESS = { drums: -18, bass: -19, melody: -21, arp: -22.5, chords: -23, drone: -25, texture: -26 };

// Each instrument's typical loudness (the median over generated songs), used
// until a new layer's own measurement arrives a moment later.
const TYPICAL_LOUDNESS = { bells: -25, strings: -21, keys: -18, organ: -23, choir: -23, pad: -23, bass: -22, wind: -28, drums: -17, cloud: -28 };

// Per style, how far a role sits from that: club styles push the groove, the
// slow ones bring their beds forward.
const STYLE_OFFSET = {
	ambient: { drums: -3, chords: 2, drone: 3, texture: 3 },
	cinematic: { drums: -1, chords: 1, drone: 2, texture: 1 },
	lofi: { chords: 1 },
	chime: { melody: 1, arp: 1 },
	techno: { drums: 1, bass: 0.5, chords: -1, texture: -1 },
	house: { drums: 1, bass: 0.5 },
	dnb: { drums: 1, bass: 0.5, chords: -1 },
	breakbeat: { drums: 1, bass: 0.5 },
	breakcore: { drums: 1.5, bass: 0.5, chords: -1 },
};

// What a layer's measurement depends on, and nothing else.
export function measureSpec(comp, layer) {
	return {
		palette: comp.palette,
		root: comp.root,
		tempo: comp.tempo,
		swing: comp.swing,
		harmony: comp.harmony,
		layer: { engine: layer.engine, params: layer.params, pattern: layer.pattern, follow: layer.follow, octave: layer.octave, gate: layer.gate },
	};
}

// Plays one layer alone through the song and returns its gated loudness in dB.
export function measureLayer(spec, sources = new Map()) {
	const song = new Song(SR, { sources });
	song.handle({ type: 'tuning', palette: spec.palette, root: spec.root });
	song.handle({ type: 'tempo', tempo: spec.tempo, swing: spec.swing });
	song.handle({ type: 'harmony', shifts: spec.harmony });
	song.handle({ type: 'layer', index: 0, layer: { ...spec.layer, active: true } });
	song.handle({ type: 'play' });
	const { rate, length } = spec.layer.pattern;
	const cycle = ((length / rate) * 60) / tempoBpm(spec.tempo);
	const seconds = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, cycle * 2));
	const L = new Float32Array(BLOCK);
	const R = new Float32Array(BLOCK);
	const outputs = [[L, R]];
	const meter = new GatedLoudness(SR);
	for (let pos = 0; pos < seconds * SR; pos += BLOCK) {
		song.render(outputs, BLOCK);
		meter.add(L, R, BLOCK);
	}
	return meter.db;
}

// The gain that brings a measured layer to its role's level.
export function trimFor(comp, layer, db) {
	if (!(db > -100)) return 1;
	const target = (ROLE_LOUDNESS[layer.role] ?? -21) + (STYLE_OFFSET[comp.style]?.[layer.role] || 0);
	const delta = Math.max(-MAX_CUT_DB, Math.min(MAX_BOOST_DB, target - db));
	return 10 ** (delta / 20);
}

// Keeps per-layer trims (by layer id) current for the song being edited.
// While a layer is being re-measured it keeps its last trim, so turning a knob
// never makes it jump; a new layer starts from its instrument's typical level.
export class Balancer {
	constructor(onChange) {
		this.onChange = onChange;
		this.cache = new Map();
		this.pending = new Map();
		this.trims = {};
		this.comp = null;
		this.timer = null;
		this.worker = null;
		this.nextId = 1;
		try {
			this.worker = new Worker(new URL('./balance-worker.js', import.meta.url), { type: 'module' });
			this.worker.onmessage = (event) => this.received(event.data);
			this.worker.onerror = () => (this.worker = null);
		} catch {
			this.worker = null;
		}
	}

	// The trims for a song, from whatever has been measured so far.
	trimsFor(comp) {
		const trims = {};
		for (const layer of comp.layers) {
			const db = this.cache.get(JSON.stringify(measureSpec(comp, layer)));
			if (db !== undefined) trims[layer.id] = trimFor(comp, layer, db);
			else trims[layer.id] = this.trims[layer.id] ?? trimFor(comp, layer, TYPICAL_LOUDNESS[layer.engine] ?? -22);
		}
		return trims;
	}

	// Edits are measured once they settle; a new layer is measured at once.
	update(comp) {
		this.comp = comp;
		clearTimeout(this.timer);
		const fresh = comp.layers.some((l) => this.trims[l.id] === undefined);
		this.timer = setTimeout(() => this.measure(), fresh ? 0 : DEBOUNCE_MS);
		// New layers sound right away at their provisional level.
		if (fresh) this.publish();
	}

	measure() {
		const comp = this.comp;
		for (const layer of comp.layers) {
			const spec = measureSpec(comp, layer);
			const key = JSON.stringify(spec);
			if (this.cache.has(key) || [...this.pending.values()].includes(key)) continue;
			const cloud = layer.engine === 'cloud';
			if (this.worker) {
				const id = this.nextId++;
				this.pending.set(id, key);
				this.worker.postMessage({ id, spec, cloud });
			} else {
				// Without workers, measure between frames on this thread.
				setTimeout(() => this.store(key, measureLayer(spec)), 0);
			}
		}
		this.publish();
	}

	received({ id, db }) {
		const key = this.pending.get(id);
		this.pending.delete(id);
		if (key) this.store(key, db);
	}

	store(key, db) {
		this.cache.set(key, db);
		if (this.cache.size > 400) this.cache.delete(this.cache.keys().next().value);
		this.publish();
	}

	publish() {
		if (!this.comp) return;
		const trims = this.trimsFor(this.comp);
		if (JSON.stringify(trims) === JSON.stringify(this.trims)) return;
		this.trims = trims;
		this.onChange(trims);
	}

	// Measures a whole song now (for stem export), reusing what is cached.
	async complete(comp) {
		for (const layer of comp.layers) {
			const spec = measureSpec(comp, layer);
			const key = JSON.stringify(spec);
			if (!this.cache.has(key)) this.cache.set(key, measureLayer(spec, await cloudSources(layer)));
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		return this.trimsFor(comp);
	}
}

// Grain sources only when a cloud layer needs them; they take a moment to make.
let sourcesPromise = null;
async function cloudSources(layer) {
	if (layer.engine !== 'cloud') return new Map();
	sourcesPromise ||= import('./sources.js').then(({ renderSource, SOURCE_IDS }) => new Map(SOURCE_IDS.map((id) => [id, renderSource(id, SR)])));
	return sourcesPromise;
}
