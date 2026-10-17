// Share links carry the whole song in the URL fragment, so a static site can
// reproduce any song with no server. Two forms, and a link uses the shorter:
//
//   seed  "g1.7.2kq8f0.k3x1[.patch]": a song made by ✦ is rebuilt from its
//         generator version, style, and seed; the four characters after the
//         seed fingerprint the generated song, so a link from an older
//         generator is recognized. Edits since then travel as a patch.
//   full  "z…": the whole song packed into positional arrays (parameters as
//         knob-grid integers, notes as small deltas), deflated, base64url.
//
// The browser's own storage keeps the full form, which survives generator changes.

import { cleanComposition, ROLES } from './state.js';
import { INSTRUMENTS, INSTRUMENT_ORDER, EFFECTS, EFFECT_ORDER, gridStep, fromNorm, PARAM_GRID } from './instruments.js';
import { STYLE_ORDER, GENERATOR_VERSION, generateComposition } from './generate.js';

const FORMAT = 2;
const ROLE_ORDER = Object.keys(ROLES);
const pct = (x) => Math.round(x * 100);
const twentieths = (x) => Math.round(x * 20);

// --- Packing -------------------------------------------------------------------

function packParams(defs, params) {
	return defs.map((d) => (d.type === 'choice' ? d.options.indexOf(params[d.id]) : d.step ? params[d.id] : gridStep(d, params[d.id])));
}

function unpackParams(defs, values, format) {
	const out = {};
	defs.forEach((d, i) => {
		const v = values?.[i];
		if (v === undefined || v === null) return;
		if (d.type === 'choice') out[d.id] = d.options[v];
		else out[d.id] = format === 1 || d.step ? v : fromNorm(d, v / PARAM_GRID);
	});
	return out;
}

// withOrigin appends where a generated song came from (for browser storage,
// so a reloaded song can still be shared as a short seed link).
export function pack(comp, withOrigin = false) {
	const packed = [
		FORMAT,
		comp.name,
		STYLE_ORDER.indexOf(comp.style),
		comp.palette,
		comp.root,
		comp.tempo,
		pct(comp.swing),
		comp.harmony,
		[pct(comp.space.size), pct(comp.space.tone)],
		[comp.echo.time, pct(comp.echo.feedback), pct(comp.echo.tone)],
		pct(comp.master.volume),
		comp.layers.map((l) => {
			// Notes are sorted, so each step is stored as the distance from the last.
			let last = 0;
			const notes = l.pattern.notes.flatMap((n) => {
				const delta = n[0] - last;
				last = n[0];
				return [delta, n[1], n[2], twentieths(n[3]), twentieths(n[4])];
			});
			return [
				INSTRUMENT_ORDER.indexOf(l.engine),
				ROLE_ORDER.indexOf(l.role),
				l.color,
				(l.follow ? 1 : 0) | (l.mute ? 2 : 0) | (l.solo ? 4 : 0),
				l.octave,
				pct(l.gate),
				pct(l.volume),
				pct(l.pan),
				pct(l.space),
				pct(l.echo),
				packParams(INSTRUMENTS[l.engine].params, l.params),
				[l.pattern.rate, l.pattern.length, notes],
				l.fx.map((f) => [EFFECT_ORDER.indexOf(f.type), f.on ? 1 : 0, packParams(EFFECTS[f.type].params, f.params)]),
				pct(l.sidechain),
			];
		}),
	];
	if (withOrigin && comp.origin) packed.push([comp.origin.v, comp.origin.seed, comp.origin.style]);
	return packed;
}

function unpackNotes(flat, format) {
	const notes = [];
	let step = 0;
	for (let i = 0; i + 4 < flat.length; i += 5) {
		if (format === 1) notes.push([flat[i], flat[i + 1], flat[i + 2], flat[i + 3] / 100, flat[i + 4] / 100]);
		else {
			step += flat[i];
			notes.push([step, flat[i + 1], flat[i + 2], flat[i + 3] / 20, flat[i + 4] / 20]);
		}
	}
	return notes;
}

export function unpack(data) {
	const format = Array.isArray(data) ? data[0] : null;
	if (format !== 1 && format !== 2) throw new Error('unknown song format');
	const [, name, style, palette, root, tempo, swing, harmony, space, echo, volume, layers, origin] = data;
	return cleanComposition({
		origin: Array.isArray(origin) ? { v: origin[0], seed: origin[1], style: origin[2] } : null,
		name,
		style: STYLE_ORDER[style] ?? null,
		palette,
		root,
		tempo,
		swing: swing / 100,
		harmony,
		space: { size: space[0] / 100, tone: space[1] / 100 },
		echo: { time: echo[0], feedback: echo[1] / 100, tone: echo[2] / 100 },
		master: { volume: volume / 100 },
		layers: (layers || []).map((l) => {
			const engine = INSTRUMENT_ORDER[l[0]];
			return {
				engine,
				role: ROLE_ORDER[l[1]],
				color: l[2],
				follow: !!(l[3] & 1),
				mute: !!(l[3] & 2),
				solo: !!(l[3] & 4),
				octave: l[4],
				gate: l[5] / 100,
				volume: l[6] / 100,
				pan: l[7] / 100,
				space: l[8] / 100,
				echo: l[9] / 100,
				params: INSTRUMENTS[engine] ? unpackParams(INSTRUMENTS[engine].params, l[10], format) : {},
				pattern: { rate: l[11]?.[0], length: l[11]?.[1], notes: unpackNotes(l[11]?.[2] || [], format) },
				fx: (l[12] || []).map((f) => {
					const type = EFFECT_ORDER[f[0]];
					return { type, on: !!f[1], params: EFFECTS[type] ? unpackParams(EFFECTS[type].params, f[2], format) : {} };
				}),
				sidechain: (l[13] ?? 0) / 100,
			};
		}),
	});
}

// --- Patches: what changed since a song was generated -----------------------------
//
// A patch mirrors the packed song: an object lists, by position, what changed
// inside an array ("n" gives a new length); any other value replaces what was
// there. Packed songs contain only numbers, strings, and arrays, so an object
// always means "descend". Each level keeps whichever is shorter, the patch or
// the replacement.

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function diff(a, b) {
	if (same(a, b)) return undefined;
	if (!Array.isArray(a) || !Array.isArray(b)) return b;
	const patch = {};
	for (let i = 0; i < b.length; i++) {
		const d = diff(a[i], b[i]);
		if (d !== undefined) patch[i] = d;
	}
	if (a.length !== b.length) patch.n = b.length;
	return JSON.stringify(patch).length < JSON.stringify(b).length ? patch : b;
}

export function makePatch(base, current) {
	const patch = diff(base, current);
	return patch === undefined ? null : patch;
}

export function applyPatch(base, patch) {
	if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
	const out = Array.isArray(base) ? base.slice() : [];
	if (Number.isInteger(patch.n)) out.length = patch.n;
	for (const [key, value] of Object.entries(patch)) {
		if (key === 'n') continue;
		const i = Number(key);
		out[i] = applyPatch(out[i], value);
	}
	return out;
}

// FNV-1a of the generated song, as four base-36 characters.
function fingerprint(packed) {
	const text = JSON.stringify(packed);
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
	return ((h >>> 0) % 36 ** 4).toString(36).padStart(4, '0');
}

// --- Bytes and text ------------------------------------------------------------------

function toBase64Url(bytes) {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
	const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function transform(bytes, stream) {
	const response = new Response(new Blob([bytes]).stream().pipeThrough(stream));
	return new Uint8Array(await response.arrayBuffer());
}

const canCompress = typeof CompressionStream !== 'undefined';

// "z" + deflated JSON, or "j" + plain JSON when that is shorter (tiny patches)
// or the browser lacks CompressionStream.
async function packText(value) {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	const plain = `j${toBase64Url(bytes)}`;
	if (!canCompress) return plain;
	try {
		const zipped = `z${toBase64Url(await transform(bytes, new CompressionStream('deflate-raw')))}`;
		return zipped.length < plain.length ? zipped : plain;
	} catch {
		return plain;
	}
}

async function unpackText(text) {
	let bytes = fromBase64Url(text.slice(1));
	if (text[0] === 'z') bytes = await transform(bytes, new DecompressionStream('deflate-raw'));
	else if (text[0] !== 'j') throw new Error('unknown song encoding');
	return JSON.parse(new TextDecoder().decode(bytes));
}

// --- Encoding ------------------------------------------------------------------------

export function encodeFull(comp) {
	return packText(pack(comp));
}

// For this browser's own storage: the full song plus its origin.
export function encodeStored(comp) {
	return packText(pack(comp, true));
}

async function encodeSeed(comp) {
	const { v, seed, style } = comp.origin;
	if (v !== GENERATOR_VERSION) return null;
	const base = pack(generateComposition(seed, style));
	const head = `g${v}.${style ? STYLE_ORDER.indexOf(style) : 'x'}.${seed.toString(36)}.${fingerprint(base)}`;
	const patch = makePatch(base, pack(comp));
	return patch ? `${head}.${await packText(patch)}` : head;
}

// The shortest text that reproduces the song.
export async function encode(comp) {
	const full = await encodeFull(comp);
	if (!comp.origin) return full;
	const seeded = await encodeSeed(comp);
	return seeded && seeded.length < full.length ? seeded : full;
}

// Resolves to the song. A seed link made by an older generator is rebuilt by
// this one, and the song comes back marked `outdated`.
export async function decode(text) {
	if (text[0] !== 'g') return unpack(await unpackText(text));
	const [version, styleCode, seedText, hash, patchText] = text.slice(1).split('.');
	const style = styleCode === 'x' ? null : STYLE_ORDER[Number(styleCode)] ?? null;
	const seed = parseInt(seedText, 36) >>> 0;
	const base = pack(generateComposition(seed, style));
	const packed = patchText ? applyPatch(base, await unpackText(patchText)) : base;
	const comp = unpack(packed);
	comp.origin = { v: GENERATOR_VERSION, seed, style };
	if (Number(version) !== GENERATOR_VERSION || fingerprint(base) !== hash) comp.outdated = true;
	return comp;
}

export function songUrl(payload) {
	return `${location.origin}${location.pathname}#s=${payload}`;
}

export function payloadFromHash(hash = location.hash) {
	const match = /[#&]s=([A-Za-z0-9_.-]+)/.exec(hash);
	return match ? match[1] : null;
}

// The post is the credit, with the song's link on a line of its own.
export function xIntentUrl(url) {
	const text = `made with @TheSeekerGame 👁️\n${url}`;
	return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}
