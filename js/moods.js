// Moods are palettes: sets of odd harmonics folded into one octave. Every mood
// obeys the Seeker rule; they differ in which harmonics they admit.

export const MOODS = [
	{
		id: 'seeker',
		name: 'seeker',
		harmonics: [1, 9, 19, 21, 3, 7],
		about: 'the six Seeker pitches: 1, 9/8, 19/16, 21/16, 3/2, 7/4',
	},
	{
		id: 'golden',
		name: 'golden',
		harmonics: [1, 9, 5, 3, 27],
		about: 'a bright pentatonic built from fifths and the fifth harmonic',
	},
	{
		id: 'overtone',
		name: 'overtone',
		harmonics: [1, 9, 5, 11, 3, 13, 7, 15],
		about: 'harmonics eight through fifteen: the scale inside one note',
	},
	{
		id: 'dusk',
		name: 'dusk',
		harmonics: [1, 9, 19, 21, 3, 13, 7],
		about: 'the Seeker set with a soft 13/8 sixth',
	},
	{
		id: 'day',
		name: 'day',
		harmonics: [1, 9, 5, 21, 3, 27, 15],
		about: 'an open major-like scale',
	},
	{
		id: 'night',
		name: 'night',
		harmonics: [1, 9, 19, 43, 3, 51, 57],
		about: 'a minor-like scale from higher harmonics',
	},
	{
		id: 'primes',
		name: 'primes',
		harmonics: [1, 5, 11, 3, 13, 7],
		about: 'only prime harmonics: 5/4, 11/8, 3/2, 13/8, 7/4',
	},
	{
		id: 'fifths',
		name: 'fifths',
		harmonics: [1, 9, 81, 3, 27, 243],
		about: 'stacked fifths: every pitch is a power of three',
	},
	{
		id: 'sevens',
		name: 'sevens',
		harmonics: [1, 9, 21, 3, 7, 63],
		about: 'harmonics built from three and seven',
	},
];

export const DEFAULT_MOOD = 'seeker';

export function moodById(id) {
	return MOODS.find((m) => m.id === id) || null;
}

// Families of numbers, which the palette editor uses to describe and select
// harmonics.
export const FAMILIES = [
	{ id: 'seeker', name: 'seeker', test: (n) => [1, 3, 7, 9, 19, 21].includes(n) },
	{ id: 'primes', name: 'primes', test: (n) => n === 1 || isPrime(n) },
	{ id: 'threes', name: '3^n', test: (n) => isPowerOf(n, 3) },
	{ id: 'smooth', name: '7-smooth', test: (n) => isSmooth(n, [3, 5, 7]) },
	{ id: 'fives', name: '5-limit', test: (n) => isSmooth(n, [3, 5]) },
];

function isPrime(n) {
	if (n < 2) return false;
	for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;
	return true;
}

function isPowerOf(n, base) {
	while (n % base === 0) n /= base;
	return n === 1;
}

function isSmooth(n, primes) {
	for (const p of primes) while (n % p === 0) n /= p;
	return n === 1;
}
