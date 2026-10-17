// Generators that make random material pleasant by construction.
//
// A seed and a style reproduce a song exactly, which is what short share links
// rely on. Any change that alters what generateComposition returns for a seed
// must increment GENERATOR_VERSION; links from older versions then still open
// (as the closest song this version makes) and say so.
//
// Harmony is judged by harmonic complexity: an interval a/b (in lowest terms)
// costs log2 of the odd parts of a × b, so 3/2 is simple and 19/14 is not.
// Chords gather the simplest relations in the palette; progressions shift the
// chord through the palette, keeping the shifts that stay consonant; melodies
// are short motifs that walk by step and land on chord tones; rhythms come
// from Euclidean distributions and style templates.

import { Rng, randomSeed } from './rng.js';
import { MOODS, moodById } from './moods.js';
import { normalizePalette, indexRatio, indexValue, oddPart, nearestTempo, cents } from './tuning.js';
import { INSTRUMENTS, EFFECTS, effectDefaults } from './instruments.js';
import { newComposition, newLayer, newEffect, cleanPattern, cleanComposition, LAYER_COLORS, MAX_LAYERS, isDrums } from './state.js';
import { indexFrequency } from './tuning.js';

// --- Harmony -------------------------------------------------------------------

function gcd(a, b) {
	while (b) [a, b] = [b, a % b];
	return a;
}

export function intervalComplexity(palette, i, j) {
	const [n1, d1] = indexRatio(palette, i);
	const [n2, d2] = indexRatio(palette, j);
	let a = n2 * d1;
	let b = d2 * n1;
	const g = gcd(a, b);
	a /= g;
	b /= g;
	return Math.log2(oddPart(a) * oddPart(b));
}

function centsBetween(palette, i, j) {
	return Math.abs(cents(indexValue(palette, j) / indexValue(palette, i)));
}

export function chordScore(palette, rows) {
	let total = 0;
	let pairs = 0;
	for (let a = 0; a < rows.length; a++) {
		for (let b = a + 1; b < rows.length; b++) {
			total += intervalComplexity(palette, rows[a], rows[b]);
			pairs++;
		}
	}
	return pairs ? total / pairs : 0;
}

// A consonant chord on `root`: the root plus the palette tones that relate to it
// most simply, voiced so no two tones sit closer than a whole tone.
export function buildChord(palette, root, size, rng) {
	const n = palette.length;
	const candidates = [];
	for (let i = root + 1; i < root + n; i++) {
		candidates.push({ i, c: intervalComplexity(palette, root, i) + rng.next() * 0.9 });
	}
	candidates.sort((a, b) => a.c - b.c);
	const rows = [root];
	for (const { i } of candidates) {
		if (rows.length >= size) break;
		rows.push(i);
	}
	rows.sort((a, b) => a - b);
	// Open up close intervals by moving the upper tone an octave higher.
	for (let k = 1; k < rows.length; k++) {
		if (centsBetween(palette, rows[k - 1], rows[k]) < 190) rows[k] += n;
	}
	return rows.sort((a, b) => a - b);
}

// Degree shifts per bar. Every option is scored by how consonant the chord
// stays after shifting, so progressions avoid harsh moves.
export function chooseProgression(palette, chord, bars, rng) {
	if (bars <= 1) return [0];
	const n = palette.length;
	const options = [];
	for (let s = -(n - 1); s <= n - 1; s++) {
		if (s === 0) continue;
		const score = chordScore(palette, chord.map((r) => r + s)) + Math.abs(s) * 0.12;
		options.push([s, Math.exp(-score * 1.1)]);
	}
	options.sort((a, b) => b[1] - a[1]);
	const top = options.slice(0, 5);
	const a = rng.weighted(top);
	const rest = top.filter(([s]) => s !== a);
	const b = rest.length ? rng.weighted(rest) : a;
	if (bars === 2) return [0, a];
	const shapes = [
		[0, 0, a, b],
		[0, a, 0, b],
		[0, a, b, a],
		[0, a, b, 0],
		[0, 0, a, a],
	];
	const shape = rng.pick(shapes);
	if (bars === 8) return [...shape, ...shape.map((s, i) => (i === 3 ? (rest[1]?.[0] ?? s) : s))];
	return shape;
}

// --- Rhythm --------------------------------------------------------------------

export function euclid(hits, steps, rotate = 0) {
	const out = new Array(steps).fill(false);
	if (hits <= 0) return out;
	for (let i = 0; i < steps; i++) {
		out[(i + rotate) % steps] = Math.floor((i * hits) / steps) !== Math.floor(((i - 1) * hits) / steps) || i === 0;
	}
	return out;
}

// One-bar rhythm cells in eighth notes.
const MELODY_CELLS = [
	[1, 0, 1, 0, 1, 0, 0, 0],
	[1, 0, 0, 1, 0, 0, 1, 0],
	[1, 0, 1, 1, 0, 0, 1, 0],
	[1, 0, 0, 0, 1, 0, 1, 1],
	[1, 0, 0, 1, 0, 1, 0, 0],
	[1, 1, 0, 1, 0, 0, 0, 0],
	[0, 0, 1, 0, 1, 0, 1, 0],
	[1, 0, 0, 0, 0, 0, 1, 0],
	[1, 0, 1, 0, 0, 1, 0, 1],
];

function cellOnsets(cell, barSteps) {
	const out = [];
	const scale = barSteps / cell.length;
	for (let i = 0; i < cell.length; i++) {
		if (!cell[i]) continue;
		const step = Math.round(i * scale);
		if (step < barSteps && !out.includes(step)) out.push(step);
	}
	return out;
}

// --- Styles --------------------------------------------------------------------

const E = (...pairs) => pairs; // [[engine, weight], ...]

export const STYLES = {
	ambient: {
		id: 'ambient',
		name: 'ambient',
		tempo: [56, 84],
		swing: [0, 0],
		roots: [[2, 3], [1, 2]],
		bars: [[1, 1], [2, 2], [4, 2]],
		moods: [['overtone', 3], ['golden', 2], ['seeker', 3], ['dusk', 2], ['primes', 2], ['sevens', 1]],
		space: [0.65, 0.95],
		layers: [
			{ role: 'drone', p: 1, engines: E(['pad', 3], ['organ', 2], ['choir', 2], ['wind', 1]) },
			{ role: 'melody', p: 0.85, engines: E(['bells', 3], ['wind', 2], ['keys', 1], ['strings', 1]) },
			{ role: 'texture', p: 0.7, engines: E(['cloud', 4], ['bells', 1]) },
			{ role: 'chords', p: 0.45, engines: E(['choir', 2], ['organ', 2], ['pad', 1]) },
			{ role: 'arp', p: 0.3, engines: E(['bells', 2], ['strings', 1]) },
			{ role: 'drums', p: 0.15, engines: E(['drums', 1]) },
		],
	},
	lofi: {
		id: 'lofi',
		name: 'lo-fi',
		tempo: [70, 96],
		swing: [0.2, 0.45],
		roots: [[2, 4], [1, 1]],
		bars: [[2, 1], [4, 4]],
		moods: [['dusk', 3], ['seeker', 3], ['day', 2], ['night', 2], ['golden', 1]],
		space: [0.3, 0.55],
		layers: [
			{ role: 'drums', p: 1, engines: E(['drums', 1]) },
			{ role: 'chords', p: 1, engines: E(['keys', 4], ['pad', 1], ['organ', 1]) },
			{ role: 'bass', p: 0.9, engines: E(['bass', 1]) },
			{ role: 'melody', p: 0.7, engines: E(['keys', 1], ['bells', 2], ['wind', 1], ['strings', 1]) },
			{ role: 'texture', p: 0.3, engines: E(['cloud', 1]) },
		],
	},
	pulse: {
		id: 'pulse',
		name: 'pulse',
		tempo: [104, 136],
		swing: [0, 0.12],
		roots: [[2, 3], [1, 1]],
		bars: [[2, 1], [4, 3]],
		moods: [['seeker', 3], ['sevens', 2], ['night', 2], ['primes', 1], ['overtone', 1]],
		space: [0.35, 0.6],
		layers: [
			{ role: 'drums', p: 1, engines: E(['drums', 1]) },
			{ role: 'bass', p: 1, engines: E(['bass', 1]) },
			{ role: 'arp', p: 1, engines: E(['strings', 2], ['bells', 2], ['keys', 1]) },
			{ role: 'chords', p: 0.75, engines: E(['pad', 3], ['organ', 1], ['choir', 1]) },
			{ role: 'melody', p: 0.4, engines: E(['bells', 1], ['keys', 1], ['wind', 1]) },
			{ role: 'texture', p: 0.25, engines: E(['cloud', 1]) },
		],
	},
	cinematic: {
		id: 'cinematic',
		name: 'cinematic',
		tempo: [58, 92],
		swing: [0, 0],
		roots: [[1, 3], [2, 2]],
		bars: [[2, 1], [4, 3]],
		moods: [['night', 3], ['dusk', 2], ['seeker', 2], ['fifths', 2], ['sevens', 1]],
		space: [0.7, 0.95],
		layers: [
			{ role: 'drone', p: 1, engines: E(['choir', 2], ['organ', 2], ['pad', 2]) },
			{ role: 'chords', p: 0.85, engines: E(['choir', 2], ['strings', 1], ['pad', 2]) },
			{ role: 'arp', p: 0.6, engines: E(['strings', 3], ['bells', 1]) },
			{ role: 'drums', p: 0.55, engines: E(['drums', 1]) },
			{ role: 'melody', p: 0.55, engines: E(['wind', 2], ['choir', 1], ['bells', 1]) },
			{ role: 'bass', p: 0.4, engines: E(['bass', 1]) },
		],
	},
	minimal: {
		id: 'minimal',
		name: 'minimal',
		tempo: [88, 124],
		swing: [0, 0],
		roots: [[2, 3], [3, 1]],
		bars: [[1, 2], [2, 1]],
		moods: [['golden', 3], ['fifths', 2], ['seeker', 2], ['day', 2], ['overtone', 1]],
		space: [0.45, 0.7],
		layers: [
			{ role: 'arp', p: 1, engines: E(['bells', 3], ['keys', 1], ['strings', 1]) },
			{ role: 'arp', p: 1, engines: E(['bells', 2], ['strings', 2], ['keys', 1]) },
			{ role: 'melody', p: 0.6, engines: E(['bells', 2], ['wind', 1]) },
			{ role: 'drone', p: 0.6, engines: E(['organ', 2], ['pad', 1]) },
			{ role: 'drums', p: 0.45, engines: E(['drums', 1]) },
		],
	},
	chime: {
		id: 'chime',
		name: 'chime',
		tempo: [96, 128],
		swing: [0, 0.2],
		roots: [[2, 3], [3, 1]],
		bars: [[2, 1], [4, 3]],
		moods: [['golden', 3], ['day', 3], ['overtone', 1], ['seeker', 2]],
		space: [0.4, 0.65],
		layers: [
			{ role: 'melody', p: 1, engines: E(['bells', 3], ['keys', 1]) },
			{ role: 'arp', p: 0.75, engines: E(['bells', 2], ['strings', 1]) },
			{ role: 'chords', p: 0.7, engines: E(['keys', 2], ['organ', 1], ['pad', 1]) },
			{ role: 'bass', p: 0.6, engines: E(['bass', 1]) },
			{ role: 'drums', p: 0.7, engines: E(['drums', 1]) },
		],
	},
	techno: {
		id: 'techno',
		name: 'techno',
		tempo: [127, 137],
		swing: [0, 0.04],
		roots: [[1, 3], [2, 2]],
		// Techno holds one harmony for a long time.
		bars: [[1, 3], [2, 2], [4, 1]],
		moods: [['night', 3], ['seeker', 3], ['sevens', 2], ['primes', 1], ['dusk', 1]],
		space: [0.3, 0.55],
		layers: [
			{ role: 'drums', p: 1, engines: E(['drums', 1]) },
			{ role: 'bass', p: 1, engines: E(['bass', 1]) },
			{ role: 'arp', p: 0.75, engines: E(['bells', 2], ['strings', 1], ['keys', 1]) },
			{ role: 'chords', p: 0.6, engines: E(['pad', 3], ['organ', 1], ['keys', 1]) },
			{ role: 'texture', p: 0.35, engines: E(['cloud', 1]) },
			{ role: 'melody', p: 0.2, engines: E(['bells', 1], ['wind', 1]) },
		],
	},
	house: {
		id: 'house',
		name: 'house',
		tempo: [117, 125],
		swing: [0.12, 0.3],
		roots: [[2, 3], [1, 1]],
		bars: [[2, 1], [4, 4]],
		moods: [['day', 3], ['golden', 2], ['dusk', 2], ['seeker', 2], ['overtone', 1]],
		space: [0.3, 0.55],
		layers: [
			{ role: 'drums', p: 1, engines: E(['drums', 1]) },
			{ role: 'bass', p: 1, engines: E(['bass', 1]) },
			{ role: 'chords', p: 1, engines: E(['keys', 3], ['organ', 2], ['pad', 1]) },
			{ role: 'melody', p: 0.45, engines: E(['bells', 2], ['keys', 1], ['choir', 1]) },
			{ role: 'arp', p: 0.25, engines: E(['bells', 1], ['strings', 1]) },
			{ role: 'texture', p: 0.2, engines: E(['cloud', 1]) },
		],
	},
	dnb: {
		id: 'dnb',
		name: 'drum & bass',
		tempo: [168, 176],
		swing: [0, 0.06],
		roots: [[2, 2], [1, 2]],
		bars: [[2, 1], [4, 4]],
		moods: [['dusk', 3], ['night', 2], ['seeker', 2], ['overtone', 2], ['sevens', 1]],
		space: [0.45, 0.75],
		layers: [
			{ role: 'drums', p: 1, engines: E(['drums', 1]) },
			{ role: 'bass', p: 1, engines: E(['bass', 1]) },
			{ role: 'chords', p: 0.85, engines: E(['pad', 2], ['choir', 2], ['organ', 1]) },
			{ role: 'melody', p: 0.5, engines: E(['bells', 2], ['keys', 1], ['wind', 1]) },
			{ role: 'texture', p: 0.4, engines: E(['cloud', 1]) },
			{ role: 'arp', p: 0.2, engines: E(['bells', 1], ['strings', 1]) },
		],
	},
};

STYLES.breakbeat = {
	id: 'breakbeat',
	name: 'breakbeat',
	tempo: [127, 142],
	swing: [0.08, 0.25],
	roots: [[2, 3], [1, 2]],
	bars: [[2, 2], [4, 3]],
	moods: [['seeker', 3], ['sevens', 2], ['dusk', 2], ['night', 2], ['primes', 1]],
	space: [0.3, 0.55],
	layers: [
		{ role: 'drums', p: 1, engines: E(['drums', 1]) },
		{ role: 'bass', p: 1, engines: E(['bass', 1]) },
		{ role: 'chords', p: 0.75, engines: E(['keys', 2], ['organ', 2], ['pad', 1]) },
		{ role: 'melody', p: 0.45, engines: E(['bells', 2], ['wind', 1], ['keys', 1]) },
		{ role: 'arp', p: 0.3, engines: E(['strings', 1], ['bells', 1]) },
		{ role: 'texture', p: 0.2, engines: E(['cloud', 1]) },
	],
};

// Breakcore sets chopped, rolling drums against slow, beautiful harmony.
STYLES.breakcore = {
	id: 'breakcore',
	name: 'breakcore',
	tempo: [178, 206],
	swing: [0, 0],
	roots: [[2, 2], [1, 2]],
	bars: [[2, 1], [4, 4]],
	moods: [['night', 3], ['dusk', 2], ['seeker', 2], ['primes', 1], ['overtone', 1]],
	space: [0.45, 0.75],
	layers: [
		{ role: 'drums', p: 1, engines: E(['drums', 1]) },
		{ role: 'bass', p: 1, engines: E(['bass', 1]) },
		{ role: 'chords', p: 0.9, engines: E(['strings', 1], ['choir', 2], ['pad', 2]) },
		{ role: 'melody', p: 0.55, engines: E(['bells', 2], ['keys', 1], ['wind', 1]) },
		{ role: 'texture', p: 0.35, engines: E(['cloud', 1]) },
	],
};

// New styles go at the end: share links store a style by its position here.
export const GENERATOR_VERSION = 2;

export const STYLE_ORDER = ['ambient', 'lofi', 'pulse', 'cinematic', 'minimal', 'chime', 'techno', 'house', 'dnb', 'breakbeat', 'breakcore'];

// Styles built on a four-on-the-floor or breakbeat groove.
const CLUB = new Set(['techno', 'house', 'dnb', 'breakbeat', 'breakcore']);
// Club styles whose harmony moves slowly under long chords.
const SLOW_HARMONY = new Set(['ambient', 'cinematic', 'dnb', 'breakcore']);

// Instruments that suit each role when no style is in force.
const ROLE_ENGINES = {
	melody: E(['bells', 3], ['keys', 2], ['wind', 2], ['strings', 2], ['choir', 1]),
	chords: E(['keys', 2], ['pad', 2], ['organ', 2], ['choir', 2]),
	arp: E(['bells', 2], ['strings', 2], ['keys', 1]),
	bass: E(['bass', 1]),
	drone: E(['pad', 2], ['organ', 2], ['choir', 1], ['wind', 1]),
	texture: E(['cloud', 3], ['bells', 1]),
	drums: E(['drums', 1]),
};

// --- Sounds --------------------------------------------------------------------

// Role-specific ranges that override an instrument's general randomization.
const ROLE_SOUND = {
	bells: {
		arp: { decay: [0.5, 2.2], material: [['wood', 3], ['glass', 2], ['metal', 2], ['string', 2], ['bell', 1]] },
		melody: { material: [['bell', 3], ['glass', 2], ['metal', 2], ['wood', 2], ['string', 1]] },
		texture: { decay: [4, 10], material: [['bowl', 3], ['bell', 2], ['glass', 1]] },
	},
	pad: { drone: { attack: [1, 3.5], release: [2, 5] }, chords: { attack: [0.05, 0.8] } },
	organ: { drone: { attack: [0.8, 3], release: [2, 5] }, chords: { attack: [0.02, 0.5] } },
	choir: { drone: { attack: [0.8, 2.5], release: [2, 4.5] } },
	wind: { drone: { attack: [0.6, 2], release: [1.5, 4] }, melody: { attack: [0.03, 0.25] } },
	strings: { arp: { decay: [0.6, 2.5] } },
	keys: { chords: { decay: [2, 5] } },
	cloud: { texture: { attack: [0.4, 2], release: [1.5, 4] } },
};

const STYLE_SOUND = {
	drums: {
		ambient: { style: [['soft', 3], ['metal', 1]] },
		lofi: { style: [['lofi', 3], ['soft', 1], ['808', 1]] },
		pulse: { style: [['tight', 3], ['808', 2], ['metal', 1]] },
		cinematic: { style: [['soft', 2], ['metal', 2], ['break', 1]] },
		minimal: { style: [['metal', 2], ['soft', 2], ['tight', 1]] },
		chime: { style: [['soft', 2], ['tight', 2]] },
		// Drum & bass and breakcore open look-ahead gaps before their kicks and snares.
		techno: { style: [['techno', 4], ['club', 1], ['metal', 1]], decay: [0.45, 0.75], punch: [0.5, 0.85], gap: [0, 0.15] },
		house: { style: [['club', 4], ['808', 1], ['tight', 1]], decay: [0.35, 0.6], punch: [0.35, 0.65] },
		dnb: { style: [['dnb', 3], ['break', 2]], decay: [0.25, 0.5], punch: [0.5, 0.8], tone: [0.55, 0.85], gap: [0.4, 0.9] },
		breakbeat: { style: [['break', 3], ['dnb', 1], ['lofi', 1], ['808', 1]], decay: [0.3, 0.55], punch: [0.45, 0.8], gap: [0.1, 0.5] },
		breakcore: { style: [['break', 2], ['dnb', 2], ['metal', 1]], decay: [0.15, 0.4], punch: [0.6, 0.95], tone: [0.55, 0.9], gap: [0.5, 1] },
	},
	bass: {
		lofi: { character: [0, 0.35], cutoff: [0.1, 0.35] },
		pulse: { character: [0.4, 0.85], envelope: [0.4, 0.9] },
		techno: { character: [0.3, 0.7], cutoff: [0.15, 0.4], envelope: [0.5, 0.9], decay: [0.12, 0.3], drive: [0.2, 0.6], sub: [0.55, 0.9] },
		house: { character: [0, 0.45], cutoff: [0.2, 0.5], envelope: [0.3, 0.7], decay: [0.15, 0.4] },
		dnb: { character: [0.55, 0.95], cutoff: [0.12, 0.35], envelope: [0.1, 0.4], decay: [0.4, 1.2], drive: [0.3, 0.7], sub: [0.5, 0.9] },
		breakbeat: { character: [0.5, 0.95], cutoff: [0.15, 0.45], envelope: [0.55, 0.95], decay: [0.16, 0.4], drive: [0.3, 0.7] },
		breakcore: { character: [0.6, 1], cutoff: [0.15, 0.4], envelope: [0.2, 0.5], decay: [0.4, 1.2], drive: [0.55, 0.9], sub: [0.5, 0.9] },
	},
	// Short stabs for the club styles; long swells under drum & bass.
	pad: {
		techno: { attack: [0.003, 0.03], release: [0.15, 0.6], cutoff: [0.3, 0.6] },
		house: { attack: [0.003, 0.05], release: [0.2, 0.8] },
		dnb: { attack: [0.4, 1.5], release: [1.5, 4] },
		breakcore: { attack: [0.4, 1.5], release: [1.5, 4] },
	},
	organ: {
		techno: { attack: [0.005, 0.04], release: [0.1, 0.5] },
		house: { attack: [0.005, 0.04], release: [0.1, 0.5] },
	},
	keys: { house: { decay: [0.8, 2.5], color: [0.3, 0.6] } },
	choir: { dnb: { attack: [0.3, 1.2], release: [1.5, 3.5] }, breakcore: { attack: [0.3, 1.2], release: [1.5, 3.5] } },
	strings: { breakcore: { decay: [4, 10], sustain: [0.8, 1], sympathy: [0.4, 0.8] } },
};

function drawParam(param, rng, override) {
	if (param.type === 'choice') {
		if (Array.isArray(override)) return rng.weighted(override);
		const weights = param.randWeights || param.options.map(() => 1);
		return rng.weighted(param.options.map((o, i) => [o, weights[i]]));
	}
	const [lo, hi] = override || param.rand || [param.min, param.max];
	let value = param.curve === 'exp' ? lo * (hi / lo) ** rng.next() : rng.range(lo, hi);
	value = param.step ? Math.round(value / param.step) * param.step : Math.round(value * 1000) / 1000;
	return Math.min(param.max, Math.max(param.min, value));
}

// Bass models each style favors.
const BASS_MODELS = {
	any: E(['analog', 3], ['sub', 2], ['acid', 1], ['reese', 2], ['fm', 2], ['wobble', 1], ['finger', 2], ['square', 2], ['liquid', 1], ['hoover', 1], ['neuro', 1], ['talk', 1]),
	ambient: E(['sub', 2], ['finger', 1], ['square', 2], ['analog', 1], ['liquid', 2]),
	lofi: E(['finger', 3], ['sub', 2], ['analog', 2], ['square', 1], ['liquid', 1]),
	pulse: E(['analog', 2], ['acid', 2], ['fm', 2], ['square', 1], ['reese', 1], ['talk', 1]),
	cinematic: E(['sub', 2], ['reese', 2], ['analog', 1], ['liquid', 2]),
	minimal: E(['finger', 2], ['square', 2], ['fm', 1], ['analog', 1]),
	chime: E(['finger', 2], ['square', 2], ['analog', 1], ['fm', 1]),
	techno: E(['acid', 3], ['analog', 2], ['fm', 1], ['reese', 1], ['sub', 1], ['grit', 1], ['hoover', 0.5]),
	house: E(['analog', 2], ['finger', 2], ['fm', 2], ['sub', 1], ['square', 2], ['talk', 1]),
	dnb: E(['reese', 3], ['neuro', 2], ['liquid', 2], ['sub', 2], ['scream', 1], ['grit', 1], ['talk', 1], ['hoover', 0.5]),
	breakbeat: E(['acid', 3], ['analog', 2], ['reese', 2], ['hoover', 2], ['wobble', 1], ['talk', 1]),
	breakcore: E(['reese', 2], ['neuro', 2], ['grit', 2], ['scream', 2], ['sub', 2], ['hoover', 1], ['fm', 1]),
};

// Ranges that suit each bass model; they take precedence over role and style.
const BASS_MODEL_SOUND = {
	analog: { character: [0.1, 0.7] },
	sub: { character: [0.25, 0.75], decay: [0.3, 1.2], drive: [0.15, 0.6], envelope: [0.1, 0.5], sub: [0.1, 0.5] },
	acid: { character: [0.45, 0.9], envelope: [0.45, 0.95], decay: [0.1, 0.4], cutoff: [0.1, 0.4], drive: [0.2, 0.7], glide: [0.04, 0.09] },
	reese: { character: [0.2, 0.8], cutoff: [0.15, 0.45], envelope: [0.1, 0.5], sub: [0.45, 0.85], decay: [0.4, 1.5] },
	fm: { envelope: [0.25, 0.75], drive: [0, 0.5], cutoff: [0.15, 0.5] },
	wobble: { character: [0.2, 0.8], envelope: [0.4, 0.9], drive: [0.35, 0.85], cutoff: [0.1, 0.35], decay: [0.5, 1.5] },
	finger: { character: [0.1, 0.5], cutoff: [0.15, 0.5], decay: [0.4, 1.4], sub: [0.2, 0.6], drive: [0, 0.35] },
	square: { character: [0.2, 0.8], cutoff: [0.2, 0.55] },
	liquid: { character: [0.2, 0.7], cutoff: [0.15, 0.45], envelope: [0.05, 0.3], sub: [0.5, 0.9], decay: [0.6, 1.8] },
	scream: { character: [0.3, 0.8], cutoff: [0.15, 0.5], envelope: [0.3, 0.8], drive: [0.3, 0.8], sub: [0.5, 0.9] },
	grit: { character: [0.3, 0.9], cutoff: [0.2, 0.55], drive: [0.3, 0.7], sub: [0.5, 0.9] },
	hoover: { character: [0.4, 0.9], envelope: [0.3, 0.8], cutoff: [0.3, 0.7], decay: [0.4, 1.4] },
	neuro: { character: [0, 1], cutoff: [0.1, 0.7], envelope: [0.3, 0.9], drive: [0.2, 0.8], sub: [0.5, 0.9], decay: [0.3, 1.2] },
	talk: { character: [0, 1], envelope: [0.4, 1], cutoff: [0.3, 0.7], drive: [0.1, 0.5], decay: [0.2, 0.8] },
};

export function randomParams(engine, rng, role, styleId) {
	const out = {};
	let overrides = { ...(ROLE_SOUND[engine]?.[role] || {}), ...(STYLE_SOUND[engine]?.[styleId] || {}) };
	if (engine === 'bass') {
		const model = rng.weighted(BASS_MODELS[styleId] || BASS_MODELS.any);
		overrides = { ...overrides, ...BASS_MODEL_SOUND[model], model: [[model, 1]] };
		// 808s glide now and then, as in trap and breakcore.
		if (model === 'sub' && rng.chance(0.3)) overrides.glide = [0.03, 0.08];
	}
	for (const param of INSTRUMENTS[engine].params) out[param.id] = drawParam(param, rng, overrides[param.id]);
	return out;
}

// Ties some notes into the note that follows, so a gliding bass slides
// between them: the move that makes acid lines.
export function addSlides(pattern, rng, amount = 0.3) {
	const notes = pattern.notes;
	for (const note of notes) {
		const end = note[0] + note[2];
		const next = notes.some((n) => n !== note && n[0] === end);
		if (next && end < pattern.length && rng.chance(amount)) note[2] += 1;
	}
	return pattern;
}

export function randomEffectParams(type, rng) {
	const out = {};
	for (const param of EFFECTS[type].params) out[param.id] = drawParam(param, rng);
	return out;
}

// --- Patterns ------------------------------------------------------------------

function degreeOfHarmonic(palette, harmonic) {
	const i = palette.indexOf(harmonic);
	return i >= 0 ? i : null;
}

function nearestChordTone(row, chordDegrees, n) {
	let best = row;
	let bestDistance = Infinity;
	for (let r = row - n; r <= row + n; r++) {
		const degree = ((r % n) + n) % n;
		if (!chordDegrees.has(degree)) continue;
		const d = Math.abs(r - row);
		if (d < bestDistance) {
			bestDistance = d;
			best = r;
		}
	}
	return best;
}

function genMelody(h, rng) {
	const { n, chordDegrees, style } = h;
	const rate = rng.weighted(SLOW_HARMONY.has(style) ? [[2, 3], [1, 2]] : [[2, 4], [4, 2]]);
	const barSteps = rate * 4;
	const bars = rate >= 4 ? 1 : 2;
	const length = barSteps * bars;
	const lo = 0;
	const hi = 2 * n;
	const motif = rng.pick(MELODY_CELLS);
	const notes = [];
	let row = nearestChordTone(Math.round(n * rng.range(0.4, 1.1)), chordDegrees, n);
	const loose = SLOW_HARMONY.has(style);
	for (let bar = 0; bar < bars; bar++) {
		const cell = bar > 0 && rng.chance(0.35) ? rng.pick(MELODY_CELLS) : motif;
		const onsets = cellOnsets(cell, barSteps);
		for (let j = 0; j < onsets.length; j++) {
			if (j > 0 || bar > 0) {
				const move = rng.weighted([[1, 0.3], [-1, 0.3], [2, 0.12], [-2, 0.12], [0, 0.08], ['leap', 0.08]]);
				if (move === 'leap') row = nearestChordTone(row + rng.pick([-3, 3, 4, -4]), chordDegrees, n);
				else row += move;
				if (row > hi) row = hi - (row - hi);
				if (row < lo) row = lo + (lo - row);
			}
			if (j === 0) row = nearestChordTone(row, chordDegrees, n);
			const last = bar === bars - 1 && j === onsets.length - 1;
			if (last) row = nearestChordTone(row, h.restDegrees, n);
			const step = bar * barSteps + onsets[j];
			const next = j + 1 < onsets.length ? bar * barSteps + onsets[j + 1] : (bar + 1) * barSteps;
			const span = next - step;
			const len = Math.max(1, last ? span : Math.round(span * rng.range(0.6, 1)));
			const vel = j === 0 ? 0.85 : rng.range(0.55, 0.78);
			const chance = loose && j > 0 && rng.chance(0.3) ? rng.range(0.55, 0.85) : 1;
			notes.push([step, row, len, vel, chance]);
		}
	}
	return { rate, length, notes };
}

function genArp(h, rng) {
	const { n, chord, style } = h;
	const rates = {
		ambient: [[2, 2], [3, 1], [4, 1]],
		techno: [[4, 5], [3, 1]],
		house: [[4, 2], [2, 2]],
		dnb: [[2, 2], [4, 1]],
		breakbeat: [[4, 3], [2, 2]],
		breakcore: [[2, 2], [4, 1]],
	};
	const rate = rng.weighted(rates[style] || [[4, 4], [3, 2], [2, 2], [6, 1]]);
	const barSteps = rate * 4;
	let length = barSteps * (rng.chance(0.3) ? 2 : 1);
	// Minimal music and techno phase: patterns a few steps shorter than the bar drift against it.
	if (style === 'minimal' || (style === 'techno' && rng.chance(0.45))) {
		length = Math.max(5, barSteps - rng.pick([1, 2, 3, 4]) + (rng.chance(0.3) ? 6 : 0));
	}
	length = Math.min(length, 32);
	const tones = new Set();
	for (const r of chord) {
		for (const o of [0, n]) {
			const t = r + o;
			if (t >= 0 && t <= 2 * n + 1) tones.add(t);
		}
	}
	const list = [...tones].sort((a, b) => a - b).slice(0, rng.int(4, 7));
	const order = rng.pick(['up', 'down', 'updown', 'random', 'pedal']);
	const sequence = [];
	if (order === 'random') {
		const shuffled = rng.shuffle(list);
		for (let i = 0; i < length; i++) sequence.push(shuffled[i % shuffled.length]);
	} else if (order === 'pedal') {
		for (let i = 0; i < length; i++) sequence.push(i % 2 === 0 ? list[0] : list[1 + (Math.floor(i / 2) % (list.length - 1))]);
	} else {
		let cycle = order === 'down' ? list.slice().reverse() : list.slice();
		if (order === 'updown') cycle = list.concat(list.slice(1, -1).reverse());
		for (let i = 0; i < length; i++) sequence.push(cycle[i % cycle.length]);
	}
	const mask = rng.chance(0.45) ? euclid(Math.round(length * rng.range(0.55, 0.85)), length) : null;
	const notes = [];
	for (let s = 0; s < length; s++) {
		if (mask && !mask[s]) continue;
		const accent = s % rate === 0;
		notes.push([s, sequence[s], 1, accent ? 0.8 : rng.range(0.5, 0.68), style === 'ambient' && !accent && rng.chance(0.3) ? 0.7 : 1]);
	}
	return { rate, length, notes };
}

// Club bass lines: rolling sixteenths (techno), the offbeat (house), and long
// sub notes moving under the breakbeat (drum & bass).
function genClubBass(h, rng) {
	const { n, palette, style } = h;
	const fifth = degreeOfHarmonic(palette, 3) ?? Math.round(n * 0.6);
	const notes = [];
	if (style === 'techno') {
		const variant = rng.pick(['rolling', 'offbeat', 'gallop']);
		for (let s = 0; s < 16; s++) {
			const q = s % 4;
			const on = variant === 'rolling' ? q !== 0 : variant === 'offbeat' ? q === 2 : q >= 2;
			if (!on) continue;
			const row = rng.chance(0.12) ? rng.pick([n, fifth]) : 0;
			notes.push([s, row, variant === 'offbeat' ? 2 : 1, q === 2 ? 0.85 : 0.62, 1]);
		}
		return { rate: 4, length: 16, notes };
	}
	if (style === 'house') {
		const bars = rng.chance(0.5) ? 2 : 1;
		for (let bar = 0; bar < bars; bar++) {
			for (const s of [2, 6, 10, 14]) {
				const step = bar * 16 + s;
				const row = bar === 1 && s === 14 && rng.chance(0.6) ? rng.pick([fifth, n]) : s === 10 && rng.chance(0.3) ? n : 0;
				notes.push([step, row, 2, s === 2 ? 0.88 : 0.78, 1]);
			}
			if (rng.chance(0.4)) notes.push([bar * 16 + 15, rng.pick([fifth, n]), 1, 0.6, 0.8]);
		}
		return { rate: 4, length: 16 * bars, notes };
	}
	if (style === 'breakbeat') {
		// A syncopated riff that jumps octaves, with a fill at the end of the second bar.
		const hits = euclid(rng.int(5, 7), 16, rng.pick([0, 0, 2, 3]));
		if (!hits[0]) hits[0] = true;
		for (let bar = 0; bar < 2; bar++) {
			hits.forEach((on, s) => {
				if (!on) return;
				const step = bar * 16 + s;
				let row = s % 4 === 0 ? 0 : rng.weighted([[0, 4], [n, 2.5], [fifth, 1.5]]);
				if (bar === 1 && s >= 12) row = rng.pick([fifth, n, 2, 0]);
				notes.push([step, row, rng.chance(0.3) ? 2 : 1, s % 4 === 0 ? 0.9 : 0.72, 1]);
			});
		}
		return { rate: 4, length: 32, notes };
	}
	if (style === 'breakcore') {
		// Heavy, distorted notes that move once or twice a bar.
		const second = rng.pick([fifth, n, 2, 1]);
		notes.push([0, 0, 3, 0.95, 1]);
		notes.push([3, rng.pick([0, n]), 1, 0.8, 1]);
		notes.push([4, 0, 2, 0.85, 1]);
		notes.push([6, rng.pick([fifth, 2]), 2, 0.8, 1]);
		notes.push([8, 0, 3, 0.95, 1]);
		notes.push([11, second, 1, 0.8, 1]);
		notes.push([12, second, 4, 0.85, 1]);
		return { rate: 2, length: 16, notes };
	}
	// Drum & bass: a long root, then a move to another tone, in eighths over two bars.
	const second = rng.pick([fifth, n, 2, 1]);
	notes.push([0, 0, 6, 0.9, 1]);
	notes.push([6, rng.pick([0, fifth]), 2, 0.75, 1]);
	notes.push([8, 0, 5, 0.85, 1]);
	notes.push([13, second, 3, 0.8, 1]);
	return { rate: 2, length: 16, notes };
}

function genBass(h, rng) {
	const { n, palette, style } = h;
	if (CLUB.has(style)) return genClubBass(h, rng);
	const rate = style === 'pulse' ? rng.weighted([[4, 3], [2, 2]]) : rng.weighted([[2, 3], [1, 1], [4, 1]]);
	const barSteps = rate * 4;
	const bars = rng.chance(0.5) ? 2 : 1;
	const length = barSteps * bars;
	const fifth = degreeOfHarmonic(palette, 3) ?? Math.round(n * 0.6);
	const hitsPerBar = Math.max(2, Math.round(barSteps * rng.range(0.25, 0.5)));
	const pattern = euclid(hitsPerBar, barSteps);
	const notes = [];
	for (let bar = 0; bar < bars; bar++) {
		const onsets = [];
		for (let s = 0; s < barSteps; s++) if (pattern[s]) onsets.push(s);
		for (let j = 0; j < onsets.length; j++) {
			const step = bar * barSteps + onsets[j];
			let row = 0;
			if (j > 0) row = rng.weighted([[0, 5], [fifth, 2.5], [n, 1.2]]);
			const lastOfBar = j === onsets.length - 1 && onsets[j] >= barSteps - 2;
			if (lastOfBar && rng.chance(0.4)) row = rng.pick([1, 2, fifth]);
			const next = j + 1 < onsets.length ? bar * barSteps + onsets[j + 1] : (bar + 1) * barSteps;
			const span = next - step;
			const len = Math.max(1, style === 'lofi' || style === 'cinematic' ? span : Math.round(span * rng.range(0.5, 1)));
			notes.push([step, row, len, j === 0 ? 0.9 : rng.range(0.65, 0.85), 1]);
		}
	}
	return { rate, length, notes };
}

function genChords(h, rng) {
	const { chord, style } = h;
	let rate;
	let hits;
	if (SLOW_HARMONY.has(style)) {
		rate = 1;
		hits = [[0, 4]];
	} else if (style === 'breakbeat') {
		// Big-beat stabs against the break.
		rate = 4;
		hits = rng.pick([
			[[0, 2], [3, 2], [10, 2]],
			[[0, 3], [6, 2], [11, 3]],
			[[2, 2], [10, 2], [14, 2]],
			[[0, 4], [7, 1], [10, 4]],
		]);
	} else if (style === 'techno') {
		// Dub-style stabs, often against the beat.
		rate = 4;
		hits = rng.pick([
			[[2, 1], [6, 1], [10, 1], [14, 1]],
			[[0, 1], [3, 1], [6, 1], [10, 1], [13, 1]],
			[[3, 2], [11, 2]],
			[[0, 2], [6, 2], [12, 2]],
		]);
	} else if (style === 'house') {
		// Piano and organ stabs on the offbeats and in the classic 3-3-2 push.
		rate = 4;
		hits = rng.pick([
			[[2, 2], [6, 2], [10, 2], [14, 2]],
			[[0, 3], [3, 3], [6, 2], [10, 3], [14, 2]],
			[[0, 2], [3, 2], [6, 2], [8, 2], [11, 2], [14, 2]],
			[[3, 2], [6, 2], [11, 2], [14, 2]],
		]);
	} else if (style === 'lofi') {
		rate = 2;
		hits = rng.pick([[[0, 5], [6, 2]], [[0, 3], [3, 5]], [[0, 7]], [[1, 3], [5, 3]]]);
	} else if (style === 'pulse') {
		rate = 4;
		hits = rng.pick([[[0, 6], [6, 4], [12, 3]], [[0, 16]], [[2, 2], [6, 2], [10, 2], [14, 2]], [[0, 3], [3, 3], [8, 6]]]);
	} else {
		rate = 2;
		hits = rng.pick([[[0, 8]], [[0, 4], [4, 4]], [[0, 3], [3, 5]]]);
	}
	const length = rate * 4;
	const notes = [];
	for (const [step, len] of hits) {
		for (const row of chord) notes.push([step, row, len, step === 0 ? 0.75 : 0.62, 1]);
	}
	return { rate, length, notes };
}

function genDrone(h, rng) {
	const { palette, n } = h;
	const fifth = degreeOfHarmonic(palette, 3);
	const notes = [[0, 0, 4, 0.8, 1]];
	if (fifth !== null && rng.chance(0.7)) notes.push([0, fifth, 4, 0.6, 1]);
	if (rng.chance(0.35)) notes.push([0, n, 4, 0.5, 1]);
	return { rate: 1, length: 4, notes };
}

function genTexture(h, rng) {
	const { n, chord } = h;
	const length = rng.pick([8, 16]);
	const notes = [];
	let step = 0;
	while (step < length) {
		const len = Math.min(length - step, rng.int(2, 6));
		const row = rng.pick(chord) + n;
		notes.push([step, row, len, rng.range(0.5, 0.75), rng.range(0.6, 1)]);
		step += len + rng.int(0, 2);
	}
	return { rate: 1, length, notes };
}

// Drum rows: 0 kick, 1 snare, 2 clap, 3 closed hat, 4 open hat, 5 tom, 6 block, 7 shaker.
function genDrums(h, rng) {
	const { style } = h;
	const notes = [];
	const add = (step, row, vel = 0.8, chance = 1) => {
		if (!notes.some((n) => n[0] === step && n[1] === row)) notes.push([step, row, 1, Math.round(vel * 100) / 100, chance]);
	};
	const hats = (every, vel = 0.5, offset = 0) => {
		for (let s = offset; s < 16; s += every) add(s, 3, s % 4 === 0 ? vel + 0.12 : vel - rng.range(0, 0.15));
	};
	switch (style) {
		case 'techno': {
			for (const s of [0, 4, 8, 12]) add(s, 0, 0.95);
			if (rng.chance(0.25)) add(rng.pick([14, 15]), 0, 0.6, 0.6);
			if (rng.chance(0.75)) {
				const row = rng.chance(0.6) ? 2 : 1;
				add(4, row, 0.75);
				add(12, row, 0.8);
			}
			for (const s of [2, 6, 10, 14]) add(s, 4, 0.5);
			if (rng.chance(0.7)) for (let s = 0; s < 16; s++) if (s % 4 !== 2) add(s, 3, s % 2 ? 0.22 : 0.32, s % 2 ? 0.85 : 1);
			const perc = euclid(rng.int(3, 5), 16, rng.int(1, 5));
			const row = rng.pick([5, 6]);
			perc.forEach((on, s) => on && add(s, row, 0.5, 0.85));
			return { rate: 4, length: 16, notes };
		}
		case 'house': {
			for (const s of [0, 4, 8, 12]) add(s, 0, 0.9);
			add(4, 2, 0.8);
			add(12, 2, 0.82);
			if (rng.chance(0.4)) {
				add(4, 1, 0.5);
				add(12, 1, 0.5);
			}
			for (const s of [2, 6, 10, 14]) add(s, 4, 0.55);
			for (let s = 1; s < 16; s += 2) add(s, 3, rng.range(0.22, 0.34), 0.85);
			euclid(rng.int(5, 9), 16, rng.int(0, 3)).forEach((on, s) => on && add(s, 7, 0.3, 0.9));
			if (rng.chance(0.5)) add(15, 2, 0.35, 0.5);
			return { rate: 4, length: 16, notes };
		}
		case 'dnb': {
			// Two bars of the two-step: kick on one and the and-of-three, snare on two and four.
			add(0, 0, 0.95);
			add(10, 0, 0.88);
			add(16, 0, 0.95);
			add(rng.pick([26, 27, 25]), 0, 0.88);
			if (rng.chance(0.4)) add(18, 0, 0.7);
			for (const s of [4, 12, 20, 28]) add(s, 1, 0.92);
			for (const s of [7, 9, 15, 23, 25, 31]) if (rng.chance(0.45)) add(s, 1, 0.3, 0.7);
			for (let s = 0; s < 32; s += 2) add(s, 3, s % 4 === 2 ? 0.55 : 0.42);
			for (let s = 1; s < 32; s += 2) if (rng.chance(0.5)) add(s, 3, 0.25, 0.6);
			if (rng.chance(0.5)) add(rng.pick([14, 30]), 4, 0.5);
			return { rate: 4, length: 32, notes };
		}
		case 'breakbeat':
			return genBreakbeatDrums(rng);
		case 'breakcore':
			return genBreakcoreDrums(rng);
		case 'lofi': {
			for (const s of rng.pick([[0, 10], [0, 7, 10], [0, 9], [0, 3, 10]])) add(s, 0, 0.9);
			const back = rng.chance(0.7) ? 1 : 2;
			add(4, back, 0.8);
			add(12, back, 0.85);
			hats(2, 0.5);
			if (rng.chance(0.5)) add(rng.pick([7, 15]), 3, 0.3, 0.7);
			if (rng.chance(0.4)) add(14, 4, 0.45);
			if (rng.chance(0.3)) for (const s of [3, 11]) add(s, 7, 0.35, 0.8);
			return { rate: 4, length: 16, notes };
		}
		case 'pulse': {
			for (const s of [0, 4, 8, 12]) add(s, 0, 0.92);
			for (const s of [4, 12]) add(s, rng.chance(0.6) ? 2 : 1, 0.82);
			hats(4, 0.55, 2);
			if (rng.chance(0.6)) for (let s = 1; s < 16; s += 2) add(s, 3, 0.3, 0.85);
			if (rng.chance(0.4)) add(14, 4, 0.5);
			const perc = euclid(rng.int(3, 5), 16, rng.int(0, 3));
			const row = rng.pick([5, 6, 7]);
			perc.forEach((on, s) => on && add(s, row, 0.45, 0.85));
			return { rate: 4, length: 16, notes };
		}
		case 'cinematic': {
			for (const s of rng.pick([[0, 10], [0, 6, 10], [0]])) add(s, 0, 0.9);
			euclid(rng.int(4, 6), 16, rng.int(0, 2)).forEach((on, s) => on && add(s, 5, rng.range(0.55, 0.85)));
			if (rng.chance(0.5)) add(12, 2, 0.6, 0.75);
			return { rate: 4, length: 16, notes };
		}
		case 'minimal': {
			add(0, 0, 0.85);
			if (rng.chance(0.5)) add(8, 0, 0.75);
			euclid(rng.int(5, 7), 16, rng.int(0, 3)).forEach((on, s) => on && add(s, 6, rng.range(0.45, 0.7)));
			euclid(rng.int(3, 5), 16, rng.int(1, 4)).forEach((on, s) => on && add(s, 5, 0.5));
			euclid(rng.int(7, 9), 16).forEach((on, s) => on && add(s, 3, 0.35));
			return { rate: 4, length: 16, notes };
		}
		case 'ambient': {
			add(0, 0, 0.7, 0.8);
			euclid(rng.int(4, 6), 16, rng.int(0, 3)).forEach((on, s) => on && add(s, 7, rng.range(0.25, 0.4), 0.8));
			euclid(3, 16, rng.int(1, 5)).forEach((on, s) => on && add(s, rng.pick([5, 6]), 0.4, 0.7));
			return { rate: 4, length: 16, notes };
		}
		default: {
			for (const s of rng.pick([[0, 8], [0, 6, 8], [0, 10]])) add(s, 0, 0.88);
			add(4, 1, 0.75);
			add(12, 1, 0.8);
			hats(2, 0.5);
			if (rng.chance(0.4)) add(14, 4, 0.45);
			return { rate: 4, length: 16, notes };
		}
	}
}

// Two bars of a classic break, in sixteenths: kicks, backbeat snares, and
// ghost snares, after the breaks breakbeat records are built from.
const BREAKS = [
	{ kicks: [0, 10, 16, 26, 27], snares: [4, 12, 20, 28], ghosts: [7, 14, 23, 30] },
	{ kicks: [0, 2, 10, 16, 18, 22, 26], snares: [4, 12, 20, 28], ghosts: [7, 9, 15, 25, 31] },
	{ kicks: [0, 6, 10, 16, 22, 26], snares: [4, 12, 20, 28], ghosts: [14, 30] },
	{ kicks: [0, 3, 6, 10, 16, 19, 22, 26], snares: [4, 12, 20, 28], ghosts: [11, 27] },
];

// The breakcore cell: an amen-like break with syncopated snares.
const AMEN = { kicks: [0, 2, 10, 11, 16, 18, 26], snares: [4, 7, 9, 12, 15, 20, 23, 25, 28, 31], ghosts: [] };

function drumNotes() {
	const notes = [];
	const add = (step, row, vel, chance = 1) => {
		const existing = notes.find((n) => n[0] === step && n[1] === row);
		if (existing) existing[3] = Math.max(existing[3], Math.round(vel * 100) / 100);
		else notes.push([step, row, 1, Math.round(vel * 100) / 100, chance]);
	};
	return { notes, add };
}

function genBreakbeatDrums(rng) {
	const { notes, add } = drumNotes();
	const brk = rng.pick(BREAKS);
	for (const s of brk.kicks) add(s, 0, s % 16 === 0 ? 0.95 : 0.85);
	for (const s of brk.snares) add(s, 1, 0.9);
	for (const s of brk.ghosts) add(s, 1, 0.32, 0.8);
	for (let s = 0; s < 32; s += 2) add(s, 3, s % 4 === 2 ? 0.55 : 0.42);
	if (rng.chance(0.5)) for (let s = 1; s < 32; s += 2) add(s, 3, 0.22, 0.6);
	add(rng.pick([14, 30]), 4, 0.5);
	if (rng.chance(0.4)) add(28, 2, 0.6);
	// A ride in eighths, and a crash on the downbeat, as on the funk records.
	if (rng.chance(0.4)) for (let s = 0; s < 32; s += 2) add(s, 6, s % 8 === 0 ? 0.5 : 0.35, 0.9);
	if (rng.chance(0.5)) add(0, 7, 0.6);
	return { rate: 4, length: 32, notes };
}

// Breakcore on a 32nd-note grid: the amen cell, then edits — snare rolls,
// kick bursts, stutters, and chopped cells — some of which play only sometimes,
// so every pass sounds a little different.
function genBreakcoreDrums(rng) {
	const { notes, add } = drumNotes();
	const cell = (p) => p * 2; // sixteenth position to 32nd step
	for (const p of AMEN.kicks) add(cell(p), 0, p % 16 === 0 ? 0.95 : 0.85);
	for (const p of AMEN.snares) add(cell(p), 1, p % 4 === 0 ? 0.92 : 0.6);
	for (let p = 0; p < 32; p += 2) add(cell(p), 3, 0.42);
	add(cell(30), 4, 0.5);
	// Chop: move the hits of a few sixteenths elsewhere, as if the break were re-sliced.
	for (let k = rng.int(2, 4); k > 0; k--) {
		const from = rng.int(0, 31);
		const to = rng.int(0, 31);
		for (const n of notes.filter((x) => x[0] === cell(from) && x[1] <= 1)) add(cell(to), n[1], n[3] * 0.9, 0.85);
	}
	// Stutter: repeat a sixteenth's hits a 32nd later.
	for (let k = rng.int(2, 5); k > 0; k--) {
		const p = rng.int(0, 31);
		for (const n of notes.filter((x) => x[0] === cell(p) && x[1] <= 1)) add(cell(p) + 1, n[1], n[3] * 0.7, 0.75);
	}
	// A snare roll into the turnaround, sometimes into the middle too.
	const roll = (from, to) => {
		for (let s = from; s < to; s++) add(s, 1, 0.35 + (0.6 * (s - from)) / (to - from), 1);
	};
	if (rng.chance(0.85)) roll(rng.pick([48, 52, 56]), 64);
	if (rng.chance(0.35)) roll(24, 32);
	if (rng.chance(0.6)) add(0, 7, 0.65);
	if (rng.chance(0.3)) for (let s = 0; s < 64; s += 4) add(s, 6, 0.38, 0.85);
	// A burst of kicks.
	if (rng.chance(0.4)) {
		const at = rng.pick([40, 44]);
		for (let s = at; s < at + 4; s++) add(s, 0, 0.6 + 0.08 * (s - at), 0.85);
	}
	return { rate: 8, length: 64, notes };
}

const GENERATORS = {
	melody: genMelody,
	arp: genArp,
	bass: genBass,
	chords: genChords,
	drone: genDrone,
	texture: genTexture,
	drums: genDrums,
};

// Musical context shared by every generator for one composition.
function harmonyContext(comp, rng, style) {
	const palette = comp.palette;
	const n = palette.length;
	const chord = comp.chord && comp.chord.length ? comp.chord : buildChord(palette, 0, rng.pick([3, 3, 4]), rng);
	const chordDegrees = new Set(chord.map((r) => ((r % n) + n) % n));
	const fifth = degreeOfHarmonic(palette, 3);
	const restDegrees = new Set([0]);
	if (fifth !== null) restDegrees.add(fifth);
	return { palette, n, chord, chordDegrees, restDegrees, style: style || 'any', rng };
}

// The chord a composition implies: taken from its chords layer if it has one.
function impliedChord(comp, rng) {
	const chords = comp.layers.find((l) => l.role === 'chords' && l.pattern.notes.length);
	if (chords) {
		const first = Math.min(...chords.pattern.notes.map((n) => n[0]));
		const rows = chords.pattern.notes.filter((n) => n[0] === first).map((n) => n[1]);
		if (rows.length >= 2) return rows.sort((a, b) => a - b);
	}
	return buildChord(comp.palette, 0, 3, rng);
}

export function generatePattern(comp, layer, rng = new Rng(), style = comp.style) {
	const role = isDrums(layer) ? 'drums' : layer.role;
	const h = harmonyContext({ ...comp, chord: role === 'chords' ? null : impliedChord(comp, rng) }, rng, style);
	const pattern = (GENERATORS[role] || genMelody)(h, rng);
	if (layer.engine === 'bass' && layer.params.glide > 0.001) addSlides(pattern, rng);
	return cleanPattern(pattern, role === 'drums');
}

// Moves a layer by octaves until every note it can play, under every harmony
// shift, sits between 40 Hz and 4.2 kHz (when its range allows).
export function fitRegister(comp, layer) {
	if (isDrums(layer) || !layer.pattern.notes.length) return layer;
	const n = comp.palette.length;
	const shifts = layer.follow ? comp.harmony : [0];
	const range = (octave) => {
		let lo = Infinity;
		let hi = 0;
		for (const note of layer.pattern.notes) {
			for (const s of shifts) {
				const f = indexFrequency(comp.palette, note[1] + s + octave * n, comp.root);
				lo = Math.min(lo, f);
				hi = Math.max(hi, f);
			}
		}
		return [lo, hi];
	};
	for (let guard = 0; guard < 6; guard++) {
		const [lo, hi] = range(layer.octave);
		if (lo < 40 && hi * 2 <= 4200) layer.octave++;
		else if (hi > 4200 && lo / 2 >= 40) layer.octave--;
		else break;
	}
	return layer;
}

export function generateHarmony(comp, rng = new Rng()) {
	const bars = rng.weighted([[2, 2], [4, 4], [1, 1]]);
	return chooseProgression(comp.palette, impliedChord(comp, rng), bars, rng);
}

// Octave for a role's patterns given the composition root: bass sits at 48 Hz
// and drones at 96 Hz whatever the root; melodic parts follow the root but
// never drop below 192 Hz.
export function roleOctave(role, root) {
	switch (role) {
		case 'bass':
			return -root;
		case 'drone':
			return 1 - root;
		case 'melody':
		case 'arp':
		case 'texture':
			return Math.max(0, 2 - root);
		default:
			return 0;
	}
}

export function pickEngine(role, rng, styleId) {
	const entry = STYLES[styleId]?.layers.find((l) => l.role === role);
	return rng.weighted(entry?.engines || ROLE_ENGINES[role] || ROLE_ENGINES.melody);
}

// Gentle variation: moves, adds, or drops a note or two, keeping the pattern's shape.
export function evolvePattern(comp, layer, rng = new Rng()) {
	const pattern = layer.pattern;
	const notes = pattern.notes.map((n) => n.slice());
	const n = comp.palette.length;
	const drums = isDrums(layer);
	const occupied = (step, row) => notes.some((x) => x[0] === step && x[1] === row);
	const changes = rng.int(1, 2);
	for (let c = 0; c < changes; c++) {
		const roll = rng.next();
		if (notes.length && roll < 0.45) {
			const note = rng.pick(notes);
			if (drums) {
				note[3] = Math.round(Math.min(1, Math.max(0.2, note[3] + rng.range(-0.2, 0.2))) * 100) / 100;
			} else {
				const row = note[1] + rng.pick([-1, 1, -2, 2]);
				if (row >= -2 * n && row <= 3 * n && !occupied(note[0], row)) note[1] = row;
			}
		} else if (roll < 0.7 && notes.length > 2) {
			const candidates = notes.filter((x) => x[0] % pattern.rate !== 0 || drums);
			const victim = rng.pick(candidates.length ? candidates : notes);
			notes.splice(notes.indexOf(victim), 1);
		} else if (notes.length) {
			const source = rng.pick(notes);
			const step = (source[0] + rng.pick([1, 2, -1, pattern.rate])) % pattern.length;
			const row = drums ? source[1] : source[1] + rng.pick([0, 1, -1, 2]);
			if (step >= 0 && !occupied(step, row)) notes.push([step, row, 1, Math.round(rng.range(0.45, 0.75) * 100) / 100, rng.chance(0.4) ? 0.75 : 1]);
		}
	}
	return cleanPattern({ ...pattern, notes }, drums);
}

// --- Compositions ----------------------------------------------------------------

// Where each role sits in the stereo field. Levels come from the automatic
// balance (js/audio/balance.js), so every layer starts near the default volume.
const ROLE_PAN = { drone: 0, chords: 0, melody: 0.15, arp: -0.25, bass: 0, texture: 0, drums: 0 };

// How deeply the kick carves each role with the ring-mod sidechain: cut sample by sample
// where the kick has level, with no pumping. Club styles carve the beds too.
const SIDECHAIN = { bass: [0.85, 1], chords: [0.35, 0.6], drone: [0.2, 0.45], texture: [0.2, 0.45], arp: [0.1, 0.3], melody: [0, 0.15] };

const ADJECTIVES = ['quiet', 'glass', 'amber', 'distant', 'slow', 'hollow', 'silver', 'warm', 'lunar', 'drifting', 'patient', 'bright', 'deep', 'pale', 'golden', 'still', 'woven', 'tidal', 'faint', 'open'];
const NOUNS = ['orbit', 'meridian', 'signal', 'garden', 'harbor', 'lantern', 'current', 'field', 'choir', 'engine', 'river', 'archive', 'lattice', 'horizon', 'ember', 'spiral', 'canopy', 'echo', 'season', 'cavern'];

// How deeply a layer of this role is carved by the kick: with a kit playing,
// the bass always gives way to it, and in club styles the rest does too.
export function sidechainFor(comp, role, rng) {
	if (!comp.layers.some((l) => l.role === 'drums')) return 0;
	const club = CLUB.has(comp.style);
	const range = SIDECHAIN[role];
	if (!range || (!club && role !== 'bass')) return 0;
	const [lo, hi] = club ? range : [0.6, 0.9];
	return Math.round(rng.range(lo, hi) * 100) / 100;
}

export function randomName(rng) {
	return `${rng.pick(ADJECTIVES)} ${rng.pick(NOUNS)}`;
}

function addEffects(layer, rng, styleId) {
	const options = [];
	if (styleId === 'lofi' && (layer.role === 'chords' || layer.role === 'melody')) options.push(['lofi', 0.6]);
	if (layer.role === 'bass') options.push(['drive', 0.3]);
	if (layer.role === 'drums' && styleId !== 'pulse' && !CLUB.has(styleId)) options.push(['resonator', 0.25]);
	if (styleId === 'techno') {
		if (layer.role === 'bass') options.unshift(['drive', 0.5]);
		if (layer.role === 'chords') options.push(['filter', 0.6]);
		if (layer.role === 'arp') options.push(['filter', 0.35], ['shifter', 0.2]);
	}
	if (styleId === 'house' && layer.role === 'chords') options.push(['chorus', 0.25]);
	// Multiband squash brings up the grit and fizz of reese and neuro basses.
	const heavy = ['reese', 'neuro', 'grit', 'scream'].includes(layer.params.model);
	if ((styleId === 'dnb' || styleId === 'breakcore') && layer.role === 'bass' && heavy) options.unshift(['squash', 0.5]);
	if (styleId === 'dnb') {
		if (layer.role === 'bass') options.push(['drive', 0.4]);
		if (layer.role === 'chords') options.push(['chorus', 0.3]);
	}
	if (styleId === 'breakbeat') {
		if (layer.role === 'bass') options.unshift(['drive', 0.55]);
		if (layer.role === 'drums') options.push(['filter', 0.25]);
	}
	if (styleId === 'breakcore') {
		// The shifter's sliced, repitched repeats are breakcore's glitches.
		if (layer.role === 'drums') options.push(['shifter', 0.6], ['lofi', 0.25]);
		if (layer.role === 'bass') options.unshift(['drive', 0.7]);
	}
	if (layer.role === 'chords' && (styleId === 'pulse' || styleId === 'chime')) options.push(['filter', 0.3]);
	if (layer.role === 'arp' && styleId === 'pulse') options.push(['shifter', 0.2]);
	if ((layer.role === 'chords' || layer.role === 'drone') && layer.engine !== 'pad' && layer.engine !== 'choir') options.push(['chorus', 0.25]);
	if (layer.role === 'melody' && styleId === 'chime') options.push(['tremolo', 0.2]);
	for (const [type, p] of options) {
		if (layer.fx.length >= 2 || layer.fx.some((f) => f.type === type) || !rng.chance(p)) continue;
		const fx = newEffect(type);
		fx.params = { ...effectDefaults(type), ...randomEffectParams(type, rng) };
		if (type === 'filter') fx.params.sweep = rng.range(0.2, 0.6);
		// Breakcore glitches: short slices, partly mixed, repeating or bouncing.
		if (type === 'shifter' && styleId === 'breakcore') {
			fx.params.length = rng.pick(['1/16', '1/16', '1/8']);
			fx.params.mode = rng.pick(['loop', 'bounce']);
			fx.params.mix = Math.round(rng.range(0.3, 0.5) * 100) / 100;
			fx.params.feedback = Math.round(rng.range(0, 0.35) * 100) / 100;
		}
		// A slow filter sweep across the break, as on a big-beat build.
		if (type === 'filter' && layer.role === 'drums') {
			fx.params.position = Math.round(rng.range(-0.35, 0.25) * 100) / 100;
			fx.params.sweep = Math.round(rng.range(0.3, 0.6) * 100) / 100;
		}
		layer.fx.push(fx);
	}
}

export function generateComposition(seed = randomSeed(), styleId = null) {
	const rng = new Rng(seed);
	const style = STYLES[styleId] || STYLES[rng.pick(STYLE_ORDER)];
	const comp = newComposition();
	const mood = moodById(rng.weighted(style.moods)) || MOODS[0];
	comp.mood = mood.id;
	comp.palette = normalizePalette(mood.harmonics);
	comp.root = rng.weighted(style.roots);
	comp.tempo = nearestTempo(rng.range(style.tempo[0], style.tempo[1]));
	comp.swing = Math.round(rng.range(style.swing[0], style.swing[1]) * 100) / 100;
	comp.style = style.id;
	comp.origin = { v: GENERATOR_VERSION, seed: seed >>> 0, style: STYLES[styleId] ? styleId : null };
	comp.name = randomName(rng);

	const h = harmonyContext(comp, rng, style.id);
	comp.chord = h.chord;
	comp.harmony = chooseProgression(comp.palette, h.chord, rng.weighted(style.bars), rng);

	const chosen = style.layers.filter((entry) => rng.chance(entry.p));
	while (chosen.length < 3) {
		const extra = style.layers.find((e) => !chosen.includes(e));
		if (!extra) break;
		chosen.push(extra);
	}
	const usedEngines = new Set();
	chosen.slice(0, Math.min(MAX_LAYERS, 6)).forEach((entry, index) => {
		let engine = rng.weighted(entry.engines);
		if (usedEngines.has(engine) && entry.engines.length > 1) engine = rng.weighted(entry.engines.filter(([e]) => !usedEngines.has(e)).concat([[engine, 0.2]]));
		usedEngines.add(engine);
		const role = INSTRUMENTS[engine].drums ? 'drums' : entry.role;
		const layer = newLayer(engine, role, index % LAYER_COLORS.length);
		layer.octave = roleOctave(role, comp.root);
		layer.params = randomParams(engine, rng, role, style.id);
		const pattern = (GENERATORS[role] || genMelody)(h, rng);
		if (engine === 'bass' && layer.params.glide > 0.001) addSlides(pattern, rng);
		layer.pattern = cleanPattern(pattern, role === 'drums');
		layer.volume = Math.round(0.75 * rng.range(0.93, 1.05) * 100) / 100;
		layer.pan = Math.round((ROLE_PAN[role] * (rng.chance(0.5) ? 1 : -1) + rng.range(-0.1, 0.1)) * 100) / 100;
		const spaceBase = rng.range(style.space[0], style.space[1]);
		layer.space = Math.round(Math.min(1, spaceBase * (role === 'bass' ? 0.25 : role === 'drums' ? 0.45 : 1)) * 100) / 100;
		layer.echo = role === 'melody' || role === 'arp' ? Math.round(rng.range(0.1, 0.4) * 100) / 100 : 0;
		if (role === 'texture' || role === 'drone') layer.gate = 1;
		if (role === 'arp') layer.gate = rng.range(0.4, 0.8);
		// Club chords are stabs, cut short.
		if (role === 'chords' && (style.id === 'techno' || style.id === 'house' || style.id === 'breakbeat')) layer.gate = rng.range(0.35, 0.6);
		layer.gate = Math.round(layer.gate * 100) / 100;
		addEffects(layer, rng, style.id);
		fitRegister(comp, layer);
		comp.layers.push(layer);
	});

	for (const layer of comp.layers) layer.sidechain = sidechainFor(comp, layer.role, rng);
	comp.space = {
		size: Math.round(rng.range(style.space[0] - 0.1, style.space[1]) * 100) / 100,
		tone: Math.round(rng.range(0.35, 0.65) * 100) / 100,
	};
	comp.echo = {
		time: rng.weighted([[1, 2], [2, 3], [3, 2], [4, 1]]),
		feedback: Math.round(rng.range(0.25, 0.5) * 100) / 100,
		tone: Math.round(rng.range(0.3, 0.6) * 100) / 100,
	};
	return cleanComposition(comp);
}
