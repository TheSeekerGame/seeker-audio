// Built-in sources for the cloud instrument. They are synthesized from the
// app's own instruments at startup, so a shared link reproduces them exactly.
// Each source is a single note at 192 Hz (48 × 4); grains replay it at Seeker
// ratios of that root.

import { createEngine } from '../../worklet/dsp/engines/index.js';

export const SOURCE_ROOT_HZ = 192;
export const SOURCE_IDS = ['choir', 'glass', 'strings', 'air'];
const SECONDS = 4;
const BLOCK = 128;

function renderWith(engineId, sr, params, script) {
	const ctx = { palette: [1], root: 2, sources: new Map(), bpm: 90, beat: 0, playing: false };
	const engine = createEngine(engineId, sr, ctx);
	engine.setParams(params);
	const total = Math.round(SECONDS * sr);
	const L = new Float32Array(BLOCK);
	const R = new Float32Array(BLOCK);
	const data = new Float32Array(total);
	for (let pos = 0; pos < total; pos += BLOCK) {
		const n = Math.min(BLOCK, total - pos);
		script(engine, pos / sr, pos);
		L.fill(0);
		R.fill(0);
		engine.process(L, R, 0, n);
		for (let i = 0; i < n; i++) data[pos + i] = (L[i] + R[i]) * 0.5;
	}
	return data;
}

// Low-passes a source at 6 kHz (two poles), so grains replayed several times
// faster still stay below Nyquist.
function soften(data, sr) {
	const a = 1 - Math.exp((-2 * Math.PI * 6000) / sr);
	let z1 = 0;
	let z2 = 0;
	for (let i = 0; i < data.length; i++) {
		z1 += (data[i] - z1) * a;
		z2 += (z1 - z2) * a;
		data[i] = z2;
	}
}

function finish(data, sr) {
	soften(data, sr);
	let peak = 1e-9;
	for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
	const gain = 0.9 / peak;
	const fade = Math.round(sr * 0.02);
	for (let i = 0; i < data.length; i++) {
		let g = gain;
		if (i < fade) g *= i / fade;
		if (i > data.length - fade) g *= (data.length - i) / fade;
		data[i] *= g;
	}
	return data;
}

const RECIPES = {
	// One long sung note whose vowel moves u → i across the source, so the
	// position control chooses the vowel.
	choir(sr) {
		let started = false;
		return renderWith('choir', sr, { vowel: 0, size: 0.5, breath: 0.2, ensemble: 0.7, attack: 0.15, release: 0.5 }, (engine, t) => {
			if (!started) {
				engine.noteOn(SOURCE_ROOT_HZ, 0.9, 0, 1);
				started = true;
			}
			engine.setParams({ vowel: Math.min(1, t / (SECONDS * 0.95)) });
		});
	},
	// Glass struck repeatedly, softer to harder across the source.
	glass(sr) {
		let next = 0;
		return renderWith('bells', sr, { material: 'glass', tone: 0.6, decay: 3, hardness: 0.3, position: 0.3, width: 0 }, (engine, t) => {
			if (t >= next) {
				engine.setParams({ hardness: 0.2 + (t / SECONDS) * 0.7 });
				engine.noteOn(SOURCE_ROOT_HZ, 0.85, Math.round(sr * 0.4), -1);
				next += 0.5;
			}
		});
	},
	strings(sr) {
		let next = 0;
		return renderWith('strings', sr, { tone: 0.55, decay: 4, position: 0.2, sympathy: 0.6, body: 0.4, width: 0 }, (engine, t) => {
			if (t >= next) {
				engine.setParams({ position: 0.1 + (t / SECONDS) * 0.35 });
				engine.noteOn(SOURCE_ROOT_HZ, 0.8, Math.round(sr * 0.5), -1);
				next += 0.62;
			}
		});
	},
	// Breath moving from airy to pure.
	air(sr) {
		let started = false;
		return renderWith('wind', sr, { purity: 0.2, harmonics: 0.5, noise: 0.6, tone: 0.5, attack: 0.3, release: 0.5, width: 0 }, (engine, t) => {
			if (!started) {
				engine.noteOn(SOURCE_ROOT_HZ, 0.9, 0, 1);
				started = true;
			}
			engine.setParams({ purity: 0.15 + (t / SECONDS) * 0.8 });
		});
	},
};

export function renderSource(id, sr) {
	const recipe = RECIPES[id];
	if (!recipe) return null;
	return { id, data: finish(recipe(sr), sr), rootHz: SOURCE_ROOT_HZ, sr, gain: 1 };
}
