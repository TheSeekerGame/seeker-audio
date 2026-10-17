// Instrument and effect definitions shared by the interface and the audio
// worklet. Each parameter's full range is chosen to sound good; `rand` narrows
// the range the randomizer draws from. Parameters marked `main` appear first in
// the sound panel.

const p = (id, label, min, max, def, extra = {}) => ({ id, label, min, max, default: def, ...extra });
const choice = (id, label, options, def, extra = {}) => ({ id, label, type: 'choice', options, default: def, ...extra });

export const DRUM_ROWS = ['kick', 'snare', 'clap', 'hat', 'open hat', 'tom', 'block', 'shaker'];

// Each kit voices the eight rows its own way. Rows keep their roles across
// kits: kick, snare, backbeat layer, closed hat, open hat, low percussion,
// high percussion, and cymbal or shaker.
export const DRUM_KIT_ROWS = {
	soft: ['kick', 'snare', 'snap', 'hat', 'open hat', 'tom', 'block', 'shaker'],
	tight: DRUM_ROWS,
	lofi: ['kick', 'snare', 'rim', 'hat', 'open hat', 'tom', 'block', 'shaker'],
	metal: ['kick', 'snare', 'clap', 'hat', 'open hat', 'metal', 'anvil', 'shaker'],
	club: ['kick', 'snare', 'clap', 'hat', 'open hat', 'conga', 'rim', 'shaker'],
	break: ['kick', 'snare', 'rim', 'hat', 'open hat', 'tom', 'ride', 'crash'],
	808: ['kick', 'snare', 'clap', 'hat', 'open hat', 'tom', 'cowbell', 'maracas'],
	dnb: ['kick', 'snare', 'clap', 'hat', 'open hat', 'perc', 'ride', 'shaker'],
	techno: ['kick', 'snare', 'clap', 'hat', 'open hat', 'perc', 'ride', 'shaker'],
};

export function drumRows(kit) {
	return DRUM_KIT_ROWS[kit] || DRUM_ROWS;
}

export const INSTRUMENTS = {
	bells: {
		name: 'bells',
		about: 'struck bars, bowls, and bells',
		params: [
			choice('material', 'material', ['wood', 'metal', 'glass', 'bell', 'string', 'bowl'], 'bell', { main: true }),
			p('tone', 'tone', 0, 1, 0.55, { main: true, rand: [0.25, 0.85] }),
			p('decay', 'decay', 0.2, 12, 2.5, { main: true, curve: 'exp', unit: 's', rand: [0.6, 6] }),
			p('hardness', 'mallet', 0, 1, 0.5, { main: true, rand: [0.2, 0.8] }),
			p('position', 'strike', 0, 1, 0.3, { rand: [0.1, 0.6] }),
			p('damping', 'damping', 0, 1, 0.4, { rand: [0.2, 0.7] }),
			p('sustain', 'ring', 0, 1, 1, { rand: [0.6, 1] }),
			p('width', 'width', 0, 1, 0.6, { rand: [0.3, 0.9] }),
		],
	},
	strings: {
		name: 'strings',
		about: 'plucked strings with a halo of sympathetic strings',
		params: [
			p('tone', 'tone', 0, 1, 0.5, { main: true, rand: [0.25, 0.8] }),
			p('decay', 'decay', 0.3, 15, 3, { main: true, curve: 'exp', unit: 's', rand: [0.8, 6] }),
			p('position', 'pluck', 0, 1, 0.25, { main: true, rand: [0.1, 0.5] }),
			p('sympathy', 'sympathy', 0, 1, 0.4, { main: true, rand: [0.1, 0.7] }),
			p('body', 'body', 0, 1, 0.4, { rand: [0.1, 0.7] }),
			p('sustain', 'ring', 0, 1, 0.6, { rand: [0.3, 1] }),
			p('width', 'width', 0, 1, 0.6, { rand: [0.3, 0.9] }),
		],
	},
	keys: {
		name: 'keys',
		about: 'an electric piano of struck tines',
		params: [
			p('color', 'color', 0, 1, 0.45, { main: true, rand: [0.15, 0.7] }),
			p('decay', 'decay', 0.3, 8, 2.5, { main: true, curve: 'exp', unit: 's', rand: [1, 5] }),
			choice('ratio', 'harmonic', ['1/2', '1', '2', '3', '4', '7'], '1', { main: true, randWeights: [1, 6, 3, 2, 1, 1] }),
			p('bell', 'bell', 0, 1, 0.3, { main: true, rand: [0, 0.6] }),
			p('motion', 'motion', 0, 1, 0.25, { rand: [0, 0.6] }),
			p('sustain', 'ring', 0, 1, 0.3, { rand: [0.1, 0.6] }),
			p('width', 'width', 0, 1, 0.5, { rand: [0.2, 0.8] }),
		],
	},
	organ: {
		name: 'organ',
		about: 'additive tones built from families of harmonics',
		params: [
			choice('family', 'harmonics', ['all', 'odd', 'seeker', 'primes', 'fifths', 'octaves', 'fibonacci'], 'seeker', { main: true }),
			p('tone', 'tone', 0, 1, 0.45, { main: true, rand: [0.2, 0.7] }),
			p('partials', 'partials', 3, 24, 12, { main: true, step: 1, rand: [5, 16] }),
			p('motion', 'shimmer', 0, 1, 0.35, { main: true, rand: [0.1, 0.8] }),
			p('attack', 'attack', 0.005, 4, 0.08, { curve: 'exp', unit: 's', rand: [0.02, 1.2] }),
			p('release', 'release', 0.05, 8, 1.2, { curve: 'exp', unit: 's', rand: [0.4, 3] }),
			p('width', 'width', 0, 1, 0.7, { rand: [0.4, 1] }),
		],
	},
	choir: {
		name: 'choir',
		about: 'voices singing vowels',
		params: [
			p('vowel', 'vowel', 0, 1, 0.5, { main: true, rand: [0.1, 0.9] }),
			p('size', 'size', 0, 1, 0.5, { main: true, rand: [0.25, 0.75] }),
			p('breath', 'breath', 0, 1, 0.25, { main: true, rand: [0.05, 0.5] }),
			p('ensemble', 'ensemble', 0, 1, 0.6, { main: true, rand: [0.3, 0.9] }),
			p('attack', 'attack', 0.01, 4, 0.35, { curve: 'exp', unit: 's', rand: [0.08, 1.5] }),
			p('release', 'release', 0.05, 8, 1.5, { curve: 'exp', unit: 's', rand: [0.5, 3] }),
		],
	},
	pad: {
		name: 'pad',
		about: 'warm analog-style chords',
		params: [
			p('shape', 'shape', 0, 1, 0.45, { main: true, rand: [0.1, 0.8] }),
			choice('interval', 'layer', ['unison', 'octave', '3/2', '3', '7/4', '9/4'], 'octave', { main: true, randWeights: [2, 4, 3, 2, 1, 1] }),
			p('cutoff', 'brightness', 0, 1, 0.45, { main: true, rand: [0.25, 0.65] }),
			p('motion', 'motion', 0, 1, 0.4, { main: true, rand: [0.15, 0.7] }),
			p('resonance', 'resonance', 0, 1, 0.2, { rand: [0, 0.45] }),
			p('ensemble', 'ensemble', 0, 1, 0.6, { rand: [0.3, 0.9] }),
			p('attack', 'attack', 0.005, 4, 0.6, { curve: 'exp', unit: 's', rand: [0.1, 2] }),
			p('release', 'release', 0.05, 8, 1.8, { curve: 'exp', unit: 's', rand: [0.6, 3.5] }),
		],
	},
	bass: {
		name: 'bass',
		about: 'fourteen kinds of bass, from 808 sub and acid to reese, neuro, and talking basses',
		// Parameters are stored by position in share links, so new ones go at the end.
		params: [
			p('character', 'character', 0, 1, 0.45, {
				main: true,
				rand: [0.1, 0.75],
				labels: {
					analog: 'shape',
					sub: 'drop',
					acid: 'resonance',
					reese: 'movement',
					fm: 'harmonic',
					wobble: 'speed',
					finger: 'pluck',
					square: 'pulse',
					liquid: 'movement',
					scream: 'scream',
					grit: 'grit',
					hoover: 'pulse',
					neuro: 'harmonic',
					talk: 'vowel',
				},
			}),
			p('cutoff', 'brightness', 0, 1, 0.35, { main: true, rand: [0.15, 0.6], labels: { neuro: 'comb', talk: 'mouth' } }),
			p('envelope', 'pluck', 0, 1, 0.45, { main: true, rand: [0.1, 0.8], labels: { sub: 'click', fm: 'bite', wobble: 'depth', finger: 'snap', hoover: 'scoop', neuro: 'kick', talk: 'talk' } }),
			p('drive', 'drive', 0, 1, 0.25, { main: true, rand: [0, 0.5], labels: { fm: 'growl', neuro: 'fold' } }),
			p('decay', 'decay', 0.05, 2, 0.35, { curve: 'exp', unit: 's', rand: [0.12, 0.8] }),
			p('sub', 'sub', 0, 1, 0.4, { rand: [0.1, 0.7], labels: { sub: 'body' } }),
			choice('model', 'model', ['analog', 'sub', 'acid', 'reese', 'fm', 'wobble', 'finger', 'square', 'liquid', 'scream', 'grit', 'hoover', 'neuro', 'talk'], 'analog', { main: true }),
			p('glide', 'glide', 0, 0.3, 0, { rand: [0, 0] }),
		],
	},
	wind: {
		name: 'wind',
		about: 'breathy flutes and wind tones',
		params: [
			p('purity', 'purity', 0, 1, 0.55, { main: true, rand: [0.3, 0.85] }),
			p('harmonics', 'overtones', 0, 1, 0.35, { main: true, rand: [0.1, 0.7] }),
			p('noise', 'air', 0, 1, 0.3, { main: true, rand: [0.1, 0.55] }),
			p('tone', 'tone', 0, 1, 0.5, { main: true, rand: [0.25, 0.75] }),
			p('attack', 'attack', 0.01, 4, 0.25, { curve: 'exp', unit: 's', rand: [0.05, 1] }),
			p('release', 'release', 0.05, 8, 0.8, { curve: 'exp', unit: 's', rand: [0.3, 2.5] }),
			p('width', 'width', 0, 1, 0.5, { rand: [0.2, 0.8] }),
		],
	},
	drums: {
		name: 'drums',
		about: 'nine kits, from 808 and 909 to jungle breaks, tuned to the fundamental',
		drums: true,
		params: [
			// club is a 909-style house kit; break an acoustic jungle kit with ride and crash.
			choice('style', 'kit', ['soft', 'tight', 'lofi', 'metal', 'club', 'break', '808', 'dnb', 'techno'], 'soft', { main: true }),
			p('tone', 'tone', 0, 1, 0.55, { main: true, rand: [0.3, 0.8] }),
			p('decay', 'decay', 0, 1, 0.45, { main: true, rand: [0.2, 0.7] }),
			p('punch', 'punch', 0, 1, 0.4, { main: true, rand: [0.1, 0.7] }),
			p('tune', 'tune', 0, 5, 0, { step: 1, rand: [0, 3] }),
			p('width', 'width', 0, 1, 0.4, { rand: [0.2, 0.7] }),
			// How far ahead of each kick and snare the sidechained layers fall silent.
			p('gap', 'sidechain gap', 0, 1, 0, { rand: [0, 0] }),
		],
	},
	cloud: {
		name: 'cloud',
		about: 'clouds of tiny grains from sampled voices, glass, and strings',
		params: [
			choice('source', 'source', ['choir', 'glass', 'strings', 'air'], 'choir', { main: true }),
			p('position', 'position', 0, 1, 0.35, { main: true, rand: [0.1, 0.8] }),
			p('size', 'grain size', 0.02, 0.6, 0.16, { main: true, curve: 'exp', unit: 's', rand: [0.06, 0.35] }),
			p('density', 'density', 2, 80, 18, { main: true, curve: 'exp', unit: '/s', rand: [6, 40] }),
			p('spray', 'spray', 0, 1, 0.3, { rand: [0.05, 0.6] }),
			p('harmonics', 'harmonics', 0, 1, 0.25, { rand: [0, 0.6] }),
			p('reverse', 'reverse', 0, 1, 0.15, { rand: [0, 0.5] }),
			p('pulse', 'pulse', 0, 1, 0, { rand: [0, 0.4] }),
			p('attack', 'attack', 0.005, 4, 0.3, { curve: 'exp', unit: 's', rand: [0.05, 1.2] }),
			p('release', 'release', 0.05, 8, 1.5, { curve: 'exp', unit: 's', rand: [0.5, 3] }),
			p('width', 'width', 0, 1, 0.7, { rand: [0.4, 1] }),
		],
	},
};

export const INSTRUMENT_ORDER = ['bells', 'strings', 'keys', 'organ', 'choir', 'pad', 'bass', 'wind', 'drums', 'cloud'];

// A knob position in [0, 1] for a value, following the parameter's curve.
export function toNorm(param, value) {
	if (param.curve === 'exp') return Math.log(value / param.min) / Math.log(param.max / param.min);
	return (value - param.min) / (param.max - param.min);
}

// Four significant digits keep short exponential ranges (a 5 ms attack) precise.
export function fromNorm(param, norm) {
	const t = Math.min(1, Math.max(0, norm));
	const value = param.curve === 'exp' ? param.min * (param.max / param.min) ** t : param.min + (param.max - param.min) * t;
	if (param.step) return Math.round(value / param.step) * param.step;
	return Number(value.toPrecision(4));
}

// Stored values sit on a grid of 200 knob positions, finer than the ear can
// tell apart, so share links store each as a small integer.
export const PARAM_GRID = 200;

export function gridStep(param, value) {
	return Math.round(Math.min(1, Math.max(0, toNorm(param, value))) * PARAM_GRID);
}

export function snapParam(param, value) {
	if (param.step) return Math.round(value / param.step) * param.step;
	return Math.min(param.max, Math.max(param.min, fromNorm(param, gridStep(param, value) / PARAM_GRID)));
}

// A parameter's label can depend on another choice, such as the bass model.
export function paramLabel(param, params) {
	return (param.labels && params && param.labels[params.model]) || param.label;
}

export function instrumentDefaults(id) {
	const def = INSTRUMENTS[id];
	const out = {};
	if (!def) return out;
	for (const param of def.params) out[param.id] = param.default;
	return out;
}

// Effects inserted on a layer. `kind` says where the effect runs: native Web
// Audio nodes or the shared audio worklet.
export const EFFECTS = {
	resonator: {
		name: 'resonator',
		about: 'six tuned resonators that make anything ring in the palette',
		kind: 'worklet',
		params: [
			choice('mode', 'body', ['modal', 'strings'], 'modal'),
			p('decay', 'decay', 0.1, 10, 2, { curve: 'exp', unit: 's', rand: [0.6, 5] }),
			p('color', 'color', 0, 1, 0.5, { rand: [0.25, 0.75] }),
			p('chord', 'chord', 0, 1, 0.5, { rand: [0, 1] }),
			p('mix', 'mix', 0, 1, 0.5, { rand: [0.3, 0.7] }),
		],
	},
	shifter: {
		name: 'shifter',
		about: 'records the beat and replays it at harmonic pitches',
		kind: 'worklet',
		params: [
			p('shift', 'shift', -12, 12, 6, { step: 1, rand: [-6, 12] }),
			choice('length', 'length', ['1/16', '1/8', '1/8t', '1/4', '1/2'], '1/8'),
			choice('mode', 'mode', ['once', 'loop', 'bounce'], 'loop'),
			p('feedback', 'feedback', 0, 0.95, 0.3, { rand: [0, 0.6] }),
			p('spread', 'spread', 0, 1, 0.5, { rand: [0.2, 0.9] }),
			p('mix', 'mix', 0, 1, 0.4, { rand: [0.25, 0.6] }),
		],
	},
	filter: {
		name: 'filter',
		about: 'one knob: darker to the left, thinner to the right',
		kind: 'native',
		params: [
			p('position', 'filter', -1, 1, -0.3, { rand: [-0.6, 0.4] }),
			p('resonance', 'resonance', 0, 1, 0.2, { rand: [0, 0.5] }),
			p('sweep', 'sweep', 0, 1, 0, { rand: [0, 0.6] }),
		],
	},
	drive: {
		name: 'drive',
		about: 'warm tape saturation',
		kind: 'native',
		params: [
			p('amount', 'drive', 0, 1, 0.35, { rand: [0.15, 0.6] }),
			p('tone', 'tone', 0, 1, 0.5, { rand: [0.3, 0.7] }),
			p('mix', 'mix', 0, 1, 0.8, { rand: [0.5, 1] }),
		],
	},
	chorus: {
		name: 'chorus',
		about: 'slow shimmering width',
		kind: 'native',
		params: [
			p('depth', 'depth', 0, 1, 0.5, { rand: [0.3, 0.8] }),
			p('rate', 'rate', 0, 1, 0.3, { rand: [0.1, 0.6] }),
			p('mix', 'mix', 0, 1, 0.5, { rand: [0.3, 0.7] }),
		],
	},
	lofi: {
		name: 'lo-fi',
		about: 'worn tape and old samplers',
		kind: 'worklet',
		params: [
			p('crush', 'crush', 0, 1, 0.3, { rand: [0.1, 0.5] }),
			p('wobble', 'wobble', 0, 1, 0.3, { rand: [0.1, 0.6] }),
			p('dust', 'dust', 0, 1, 0.25, { rand: [0.05, 0.5] }),
			p('tone', 'tone', 0, 1, 0.5, { rand: [0.3, 0.7] }),
			p('mix', 'mix', 0, 1, 1, { rand: [0.6, 1] }),
		],
	},
	tremolo: {
		name: 'tremolo',
		about: 'pulsing volume or panning in time with the beat',
		kind: 'native',
		params: [
			choice('rate', 'rate', ['1/2', '1/4', '1/8', '1/8t', '1/16'], '1/8'),
			p('depth', 'depth', 0, 1, 0.5, { rand: [0.2, 0.7] }),
			choice('mode', 'mode', ['volume', 'pan'], 'pan'),
		],
	},
	pump: {
		name: 'pump',
		about: 'ducks on every beat, as if the kick pushed the sound aside',
		kind: 'worklet',
		params: [
			choice('rate', 'rate', ['1/2', '1/4', '1/8'], '1/4'),
			p('depth', 'depth', 0, 1, 0.6, { rand: [0.4, 0.8] }),
			p('release', 'release', 0, 1, 0.5, { rand: [0.3, 0.7] }),
		],
	},
	squash: {
		name: 'squash',
		about: 'three-band upward and downward compression: hidden grit and fizz come forward',
		kind: 'worklet',
		params: [
			p('depth', 'depth', 0, 1, 0.5, { rand: [0.3, 0.8] }),
			p('upward', 'upward', 0, 1, 0.6, { rand: [0.4, 0.9] }),
			p('time', 'time', 0, 1, 0.3, { rand: [0.1, 0.5] }),
		],
	},
};

// New effects go at the end: share links store an effect by its position here.
export const EFFECT_ORDER = ['resonator', 'shifter', 'filter', 'drive', 'chorus', 'lofi', 'tremolo', 'pump', 'squash'];

export function effectDefaults(type) {
	const out = {};
	for (const param of EFFECTS[type]?.params || []) out[param.id] = param.default;
	return out;
}

// Rate choices shared by effects, in beats per cycle. Each is the period of a
// valid harmonic rate.
export const RATE_BEATS = { '1/2': 2, '1/4': 1, '1/8': 0.5, '1/8t': 1 / 3, '1/16': 0.25 };
