// The composition model: what a song is, how it is validated, and how it
// changes palette. Everything the audio needs is derived from this object, and
// a share link is this object, compressed.

import {
	normalizePalette,
	remapIndex,
	isValidTempo,
	DEFAULT_TEMPO,
	DEFAULT_ROOT,
	ROOT_OCTAVES,
	STEP_RATES,
	ECHO_TIMES,
} from './tuning.js';
import { MOODS, DEFAULT_MOOD, moodById } from './moods.js';
import { INSTRUMENTS, EFFECTS, instrumentDefaults, effectDefaults, snapParam, DRUM_ROWS } from './instruments.js';

export const VERSION = 1;
export const MAX_LAYERS = 8;
export const MAX_STEPS = 64;
export const MAX_FX = 4;
export const MAX_BARS = 8;

// Category colors, used to tell layers apart.
export const LAYER_COLORS = ['#78b6e6', '#e0a24a', '#e469a4', '#6ea34f', '#1fb39f', '#8a8ff0', '#cd5354', '#c8b04a'];

export const ROLES = {
	melody: { name: 'melody', octave: 0, rows: [0, 2] },
	chords: { name: 'chords', octave: 0, rows: [-1, 2] },
	arp: { name: 'arpeggio', octave: 0, rows: [0, 2] },
	bass: { name: 'bass', octave: -2, rows: [0, 2] },
	drone: { name: 'drone', octave: -1, rows: [0, 2] },
	texture: { name: 'texture', octave: 0, rows: [0, 2] },
	drums: { name: 'drums', octave: 0, rows: [0, 1] },
};

let idCounter = 1;
export function newId() {
	return `l${Date.now().toString(36)}${(idCounter++).toString(36)}`;
}

export function newLayer(engine = 'bells', role = 'melody', color = 0) {
	return {
		id: newId(),
		role,
		color,
		engine,
		params: instrumentDefaults(engine),
		pattern: { rate: 4, length: 16, notes: [] },
		follow: role !== 'drone' && role !== 'drums',
		octave: ROLES[role]?.octave ?? 0,
		gate: 0.85,
		volume: 0.75,
		pan: 0,
		space: 0.3,
		echo: 0,
		// How deeply the drums' kick (and sidechain gaps) carve this layer.
		sidechain: 0,
		mute: false,
		solo: false,
		fx: [],
	};
}

export function newComposition() {
	const mood = moodById(DEFAULT_MOOD);
	return {
		v: VERSION,
		name: 'untitled',
		mood: mood.id,
		palette: normalizePalette(mood.harmonics),
		root: DEFAULT_ROOT,
		tempo: DEFAULT_TEMPO.slice(),
		swing: 0,
		harmony: [0],
		layers: [],
		space: { size: 0.55, tone: 0.5 },
		echo: { time: 2, feedback: 0.35, tone: 0.45 },
		master: { volume: 0.85 },
	};
}

export function isDrums(layer) {
	return !!INSTRUMENTS[layer.engine]?.drums;
}

function num(value, min, max, fallback) {
	const x = Number(value);
	if (!Number.isFinite(x)) return fallback;
	return Math.min(max, Math.max(min, x));
}

// A number rounded to hundredths, the precision of mix and send values.
function pct(value, min, max, fallback) {
	return Math.round(num(value, min, max, fallback) * 100) / 100;
}

function cleanParams(defs, raw) {
	const out = {};
	for (const param of defs) {
		const value = raw?.[param.id];
		if (param.type === 'choice') out[param.id] = param.options.includes(value) ? value : param.default;
		// The knob grid is the canonical precision, so links round-trip exactly.
		else out[param.id] = snapParam(param, num(value, param.min, param.max, param.default));
	}
	return out;
}

export function cleanPattern(raw, drums) {
	const rate = STEP_RATES.includes(raw?.rate) ? raw.rate : 4;
	const length = Math.round(num(raw?.length, 1, MAX_STEPS, 16));
	const notes = [];
	const seen = new Set();
	for (const n of Array.isArray(raw?.notes) ? raw.notes : []) {
		if (!Array.isArray(n)) continue;
		const step = Math.round(num(n[0], 0, length - 1, -1));
		const row = Math.round(num(n[1], drums ? 0 : -48, drums ? DRUM_ROWS.length - 1 : 48, NaN));
		if (step < 0 || !Number.isFinite(row)) continue;
		const key = `${step}:${row}`;
		if (seen.has(key)) continue;
		seen.add(key);
		notes.push([
			step,
			row,
			Math.round(num(n[2], 1, length, 1)),
			// Loudness and chance in steps of 5%.
			Math.round(num(n[3], 0.05, 1, 0.8) * 20) / 20,
			Math.round(num(n[4], 0.05, 1, 1) * 20) / 20,
		]);
	}
	notes.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	return { rate, length, notes };
}

function cleanLayer(raw, index) {
	const engine = INSTRUMENTS[raw?.engine] ? raw.engine : 'bells';
	const role = ROLES[raw?.role] ? raw.role : INSTRUMENTS[engine].drums ? 'drums' : 'melody';
	const drums = !!INSTRUMENTS[engine].drums;
	const fx = [];
	for (const f of Array.isArray(raw?.fx) ? raw.fx : []) {
		if (!EFFECTS[f?.type] || fx.length >= MAX_FX) continue;
		fx.push({ type: f.type, on: f.on !== false, params: cleanParams(EFFECTS[f.type].params, f.params) });
	}
	return {
		id: typeof raw?.id === 'string' ? raw.id : newId(),
		role,
		color: Math.round(num(raw?.color, 0, LAYER_COLORS.length - 1, index % LAYER_COLORS.length)),
		engine,
		params: cleanParams(INSTRUMENTS[engine].params, raw?.params),
		pattern: cleanPattern(raw?.pattern, drums),
		follow: drums ? false : raw?.follow !== false,
		octave: Math.round(num(raw?.octave, -3, 3, 0)),
		gate: pct(raw?.gate, 0.05, 1, 0.85),
		volume: pct(raw?.volume, 0, 1, 0.75),
		pan: pct(raw?.pan, -1, 1, 0),
		space: pct(raw?.space, 0, 1, 0.3),
		echo: pct(raw?.echo, 0, 1, 0),
		sidechain: pct(raw?.sidechain, 0, 1, 0),
		mute: !!raw?.mute,
		solo: !!raw?.solo,
		fx,
	};
}

// Validates any object claiming to be a composition, so links and saved files
// can never smuggle in a pitch outside the tuning.
export function cleanComposition(raw) {
	const base = newComposition();
	if (!raw || typeof raw !== 'object') return base;
	const palette = normalizePalette(Array.isArray(raw.palette) ? raw.palette.map(Number) : moodById(raw.mood)?.harmonics || base.palette);
	const n = palette.length;
	const harmony = (Array.isArray(raw.harmony) ? raw.harmony : [0])
		.slice(0, MAX_BARS)
		.map((s) => Math.round(num(s, -2 * n, 2 * n, 0)));
	return {
		v: VERSION,
		name: typeof raw.name === 'string' ? raw.name.slice(0, 60) : base.name,
		style: typeof raw.style === 'string' ? raw.style.slice(0, 16) : null,
		origin: cleanOrigin(raw.origin),
		mood: moodFor(palette)?.id || null,
		palette,
		root: ROOT_OCTAVES.includes(raw.root) ? raw.root : DEFAULT_ROOT,
		tempo: isValidTempo(raw.tempo) ? raw.tempo.slice() : DEFAULT_TEMPO.slice(),
		swing: Math.round(num(raw.swing, 0, 0.6, 0) * 100) / 100,
		harmony: harmony.length ? harmony : [0],
		layers: (Array.isArray(raw.layers) ? raw.layers : []).slice(0, MAX_LAYERS).map(cleanLayer),
		space: { size: pct(raw.space?.size, 0, 1, 0.55), tone: pct(raw.space?.tone, 0, 1, 0.5) },
		echo: {
			time: Math.round(num(raw.echo?.time, 0, ECHO_TIMES.length - 1, 2)),
			feedback: pct(raw.echo?.feedback, 0, 0.85, 0.35),
			tone: pct(raw.echo?.tone, 0, 1, 0.45),
		},
		master: { volume: pct(raw.master?.volume, 0, 1, 0.85) },
	};
}

// Where a generated song came from: generator version, seed, and the style
// asked for (null for "any"). Short share links rebuild the song from it.
function cleanOrigin(origin) {
	if (!origin || typeof origin !== 'object') return null;
	const { v, seed, style } = origin;
	if (!Number.isInteger(v) || v < 1 || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return null;
	if (style !== null && typeof style !== 'string') return null;
	return { v, seed, style: style ? style.slice(0, 16) : null };
}

export function samePalette(a, b) {
	return a.length === b.length && a.every((h, i) => h === b[i]);
}

export function moodFor(palette) {
	return MOODS.find((m) => samePalette(normalizePalette(m.harmonics), palette)) || null;
}

// Moves every pitched note, harmony step, and shift to the nearest pitch of
// the new palette, so the music keeps its shape.
export function changePalette(comp, harmonics) {
	const from = comp.palette;
	const to = normalizePalette(harmonics);
	if (samePalette(from, to)) return comp;
	for (const layer of comp.layers) {
		if (isDrums(layer)) continue;
		const seen = new Set();
		layer.pattern.notes = layer.pattern.notes
			.map((n) => [n[0], remapIndex(from, to, n[1]), n[2], n[3], n[4]])
			.filter((n) => {
				const key = `${n[0]}:${n[1]}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
		for (const fx of layer.fx) {
			if (fx.type === 'shifter') fx.params.shift = Math.max(-12, Math.min(12, remapIndex(from, to, fx.params.shift)));
		}
	}
	comp.harmony = comp.harmony.map((s) => remapIndex(from, to, s));
	comp.palette = to;
	comp.mood = moodFor(to)?.id || null;
	return comp;
}

export function newEffect(type) {
	return { type, on: true, params: effectDefaults(type) };
}

// Layers that should currently be heard, honoring mute and solo.
export function audibleLayers(comp) {
	const solo = comp.layers.some((l) => l.solo);
	return comp.layers.map((l) => (solo ? l.solo : !l.mute));
}

export function clone(value) {
	return JSON.parse(JSON.stringify(value));
}
