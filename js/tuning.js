// The Seeker tuning. Every pitch is 48 Hz multiplied by X / 2^N, where X and N
// are whole numbers. Equivalently, every pitch is a harmonic of 48 Hz or of one
// of its lower octaves. Rhythm follows the same rule: tempo, echo times, and
// modulation rates are all 48 Hz × X / 2^N.
//
// This module is shared by the interface and the audio worklet, so it must stay
// free of browser-only globals.

export const FUNDAMENTAL_HZ = 48;

// The root may only move by whole octaves: 48, 96, 192, or 384 Hz.
export const ROOT_OCTAVES = [0, 1, 2, 3];
export const DEFAULT_ROOT = 2;

// Largest odd harmonic a palette may contain. Bigger numbers are valid in the
// tuning, but they are too close together to be useful as scale degrees.
export const MAX_HARMONIC = 255;

export function oddPart(n) {
	let x = Math.round(Math.abs(n));
	if (x === 0) return 0;
	while (x % 2 === 0) x /= 2;
	return x;
}

export function isPowerOfTwo(n) {
	if (!Number.isInteger(n) || n < 1) return false;
	while (n % 2 === 0) n /= 2;
	return n === 1;
}

export function isValidRatio(num, den) {
	return Number.isInteger(num) && num > 0 && isPowerOfTwo(den);
}

// Largest power of two not above x.
function floorPow2(x) {
	let p = 1;
	while (p * 2 <= x) p *= 2;
	return p;
}

// Folds an odd harmonic into the octave [1, 2) and returns [numerator, denominator].
export function foldHarmonic(harmonic) {
	const odd = oddPart(harmonic);
	return [odd, floorPow2(odd)];
}

export function reduceRatio(num, den) {
	while (num % 2 === 0 && den % 2 === 0) {
		num /= 2;
		den /= 2;
	}
	return [num, den];
}

export function ratioLabel([num, den]) {
	return den === 1 ? String(num) : `${num}/${den}`;
}

export function cents(value) {
	return 1200 * Math.log2(value);
}

// A palette is a list of odd harmonics, sorted by their folded pitch, always
// starting with 1 (the root).
export function normalizePalette(harmonics) {
	const seen = new Set([1]);
	for (const h of harmonics || []) {
		const odd = oddPart(h);
		if (odd >= 1 && odd <= MAX_HARMONIC) seen.add(odd);
	}
	return [...seen].sort((a, b) => foldValue(a) - foldValue(b));
}

export function foldValue(harmonic) {
	const [num, den] = foldHarmonic(harmonic);
	return num / den;
}

// Splits a palette index into its degree and octave.
export function splitIndex(paletteLength, index) {
	const octave = Math.floor(index / paletteLength);
	return { degree: index - octave * paletteLength, octave };
}

// Exact ratio of a palette index relative to the root, as [numerator, denominator].
export function indexRatio(palette, index) {
	const { degree, octave } = splitIndex(palette.length, index);
	let [num, den] = foldHarmonic(palette[degree]);
	if (octave >= 0) num *= 2 ** octave;
	else den *= 2 ** -octave;
	return reduceRatio(num, den);
}

export function indexValue(palette, index) {
	const { degree, octave } = splitIndex(palette.length, index);
	return foldValue(palette[degree]) * 2 ** octave;
}

export function rootHz(root) {
	return FUNDAMENTAL_HZ * 2 ** root;
}

export function indexFrequency(palette, index, root) {
	return rootHz(root) * indexValue(palette, index);
}

// Ratio of an index relative to 48 Hz itself.
export function absoluteRatio(palette, index, root) {
	const [num, den] = indexRatio(palette, index);
	return root >= 0 ? reduceRatio(num * 2 ** root, den) : reduceRatio(num, den * 2 ** -root);
}

// Lowest and highest pitches the instruments play. Notes outside are folded by
// octaves, which keeps them Seeker ratios.
export const MIN_HZ = 30;
export const MAX_HZ = 5000;

export function foldFrequency(freq) {
	if (!(freq > 0) || !Number.isFinite(freq)) return MIN_HZ;
	while (freq < MIN_HZ) freq *= 2;
	while (freq > MAX_HZ) freq *= 0.5;
	return freq;
}

// Nearest palette index to a pitch, measured in octaves above the root.
export function nearestIndex(palette, octavesAboveRoot) {
	const n = palette.length;
	const base = Math.floor(octavesAboveRoot) * n;
	let best = base;
	let bestDistance = Infinity;
	for (let i = base - n; i <= base + 2 * n; i++) {
		const distance = Math.abs(Math.log2(indexValue(palette, i)) - octavesAboveRoot);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = i;
		}
	}
	return best;
}

// Moves an index from one palette to the nearest pitch in another, so a
// pattern keeps its contour when the mood changes.
export function remapIndex(fromPalette, toPalette, index) {
	return nearestIndex(toPalette, Math.log2(indexValue(fromPalette, index)));
}

// Harmonic complexity of a degree, used to judge consonance: 1 is simplest.
export function harmonicWeight(harmonic) {
	return Math.log2(oddPart(harmonic) + 1);
}

// --- Time -------------------------------------------------------------------
//
// A beat lasts 1 / (48 Hz × X / 2^N) seconds, so beats per minute are
// 2880 × X / 2^N. A tempo is stored as [X, N].

export const TEMPO_MIN = 56;
export const TEMPO_MAX = 210; // room for breakcore at 191.25 and 202.5

function buildTempos() {
	const out = [];
	const seen = new Set();
	for (let x = 1; x <= 31; x += 2) {
		for (let n = 0; n <= 12; n++) {
			const bpm = (2880 * x) / 2 ** n;
			if (bpm < TEMPO_MIN || bpm > TEMPO_MAX) continue;
			const key = bpm.toFixed(6);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ x, n, bpm });
		}
	}
	return out.sort((a, b) => a.bpm - b.bpm);
}

export const TEMPOS = buildTempos();
export const DEFAULT_TEMPO = [1, 5]; // 90 BPM: a beat is 1/32 of 48 Hz

export function tempoBpm([x, n]) {
	return (2880 * x) / 2 ** n;
}

export function tempoIndex(tempo) {
	const bpm = tempoBpm(tempo);
	let best = 0;
	for (let i = 1; i < TEMPOS.length; i++) {
		if (Math.abs(TEMPOS[i].bpm - bpm) < Math.abs(TEMPOS[best].bpm - bpm)) best = i;
	}
	return best;
}

export function nearestTempo(bpm) {
	let best = TEMPOS[0];
	for (const t of TEMPOS) if (Math.abs(t.bpm - bpm) < Math.abs(best.bpm - bpm)) best = t;
	return [best.x, best.n];
}

export function isValidTempo(tempo) {
	return (
		Array.isArray(tempo) &&
		TEMPOS.some((t) => t.x === tempo[0] && t.n === tempo[1])
	);
}

export function tempoLabel(tempo) {
	const bpm = tempoBpm(tempo);
	return Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(bpm * 10 === Math.round(bpm * 10) ? 1 : 2);
}

// Steps per beat a pattern may use. Multiplying a valid rate by a whole number
// keeps it valid, so triplets (3) and sextuplets (6) belong; dotted values,
// which divide by three, do not.
export const STEP_RATES = [0.5, 1, 2, 3, 4, 6, 8];

// Echo times in beats. Each is the period of a valid rate: 1/3 beat is a rate of
// three per beat, 4/3 beats is a rate of 3/4 per beat.
export const ECHO_TIMES = [
	{ beats: 1 / 4, label: '1/16' },
	{ beats: 1 / 3, label: '1/8t' },
	{ beats: 1 / 2, label: '1/8' },
	{ beats: 2 / 3, label: '1/4t' },
	{ beats: 1, label: '1/4' },
	{ beats: 4 / 3, label: '1/2t' },
	{ beats: 2, label: '1/2' },
];

// True when hz equals 48 × X / 2^N for a whole X and N (within float error).
export function isHarmonicRate(hz) {
	if (!(hz > 0)) return false;
	let x = hz / FUNDAMENTAL_HZ;
	for (let n = 0; n < 40; n++) {
		const rounded = Math.round(x);
		if (Math.abs(x - rounded) < 1e-6 * Math.max(1, x)) return rounded > 0;
		x *= 2;
	}
	return false;
}
