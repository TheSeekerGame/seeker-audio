// Stem export. The song is rendered offline (silently, faster than real time)
// through the same worklet and effect chains as playback, with each layer
// routed to its own pair of output channels. Space and Echo, which layers
// share, come out as two return stems, so the stems add up to the mix before
// the master limiter. Every stem starts on bar 1 and has the same length.

import { Strip, WORKLET_URL, songNode } from './engine.js';
import { Space, Echo } from './space.js';
import { renderSource, SOURCE_IDS } from './sources.js';
import { zip } from './zip.js';
import { CEILING } from '../../worklet/dsp/effects.js';
import { tempoBpm, tempoLabel, indexRatio, ratioLabel, rootHz } from '../tuning.js';
import { ROLES, audibleLayers, isDrums } from '../state.js';
import { INSTRUMENTS } from '../instruments.js';

const SR = 48000;
const TAIL_SECONDS = 4;
const UNITS_PER_BEAT = 24; // every step length is a whole number of 1/24 beats
const MAX_CYCLE_BARS = 64;

function gcd(a, b) {
	while (b) [a, b] = [b, a % b];
	return a;
}

// Bars until the harmony and every pattern line up again.
export function cycleBars(comp) {
	let units = comp.harmony.length * 4 * UNITS_PER_BEAT;
	for (const layer of comp.layers) {
		const layerUnits = Math.round((layer.pattern.length * UNITS_PER_BEAT) / layer.pattern.rate);
		units = (units / gcd(units, layerUnits)) * layerUnits;
		if (units > MAX_CYCLE_BARS * 4 * UNITS_PER_BEAT) return MAX_CYCLE_BARS;
	}
	return Math.max(1, Math.ceil(units / (4 * UNITS_PER_BEAT)));
}

export function stemSeconds(comp, bars) {
	return (bars * 4 * 60) / tempoBpm(comp.tempo);
}

export function stemName(comp, index, position) {
	const layer = comp.layers[index];
	return `${String(position + 1).padStart(2, '0')} ${INSTRUMENTS[layer.engine].name} (${ROLES[layer.role]?.name || layer.role}).wav`;
}

// 24-bit PCM stereo WAV.
function wav24(left, right, gain) {
	const frames = left.length;
	const bytes = new Uint8Array(44 + frames * 6);
	const view = new DataView(bytes.buffer);
	const text = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
	text(0, 'RIFF');
	view.setUint32(4, 36 + frames * 6, true);
	text(8, 'WAVE');
	text(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 2, true);
	view.setUint32(24, SR, true);
	view.setUint32(28, SR * 6, true);
	view.setUint16(32, 6, true);
	view.setUint16(34, 24, true);
	text(36, 'data');
	view.setUint32(40, frames * 6, true);
	let o = 44;
	for (let i = 0; i < frames; i++) {
		for (const channel of [left, right]) {
			const v = Math.round(Math.max(-1, Math.min(1, channel[i] * gain)) * 8388607);
			bytes[o] = v & 0xff;
			bytes[o + 1] = (v >> 8) & 0xff;
			bytes[o + 2] = (v >> 16) & 0xff;
			o += 3;
		}
	}
	return bytes;
}

// The whole song as worklet messages. They travel with the node's construction
// options, so the song is in place before the first sample renders.
function songMessages(comp, exported) {
	// Drums that carve an exported layer play even when they are not exported
	// themselves, so every stem sounds as it does in the mix.
	const carved = comp.layers.some((l, i) => exported.includes(i) && l.sidechain > 0);
	const audible = audibleLayers(comp);
	const messages = [
		{ type: 'tuning', palette: comp.palette, root: comp.root },
		{ type: 'tempo', tempo: comp.tempo, swing: comp.swing },
		{ type: 'harmony', shifts: comp.harmony },
	];
	comp.layers.forEach((layer, index) => {
		messages.push({
			type: 'layer',
			index,
			layer: {
				engine: layer.engine,
				params: layer.params,
				pattern: layer.pattern,
				follow: layer.follow,
				octave: layer.octave,
				gate: layer.gate,
				active: exported.includes(index) || (carved && isDrums(layer) && audible[index]),
			},
		});
	});
	if (comp.layers.some((l, i) => exported.includes(i) && l.engine === 'cloud')) {
		for (const id of SOURCE_IDS) {
			const s = renderSource(id, SR);
			messages.push({ type: 'source', id, data: s.data, rootHz: s.rootHz, sr: s.sr, gain: s.gain });
		}
	}
	messages.push({ type: 'play' });
	return messages;
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

// Renders the chosen layers and returns { blob, names, seconds }.
export async function renderStems(comp, { bars, layers: exported, returns, trims = {}, onProgress }) {
	const bpm = tempoBpm(comp.tempo);
	const seconds = stemSeconds(comp, bars) + TAIL_SECONDS;
	const length = Math.ceil(seconds * SR);
	const slots = exported.length + (returns ? 2 : 0);
	const channels = slots * 2;
	const ctx = new OfflineAudioContext({ numberOfChannels: channels, length, sampleRate: SR });
	ctx.destination.channelCount = channels;
	ctx.destination.channelCountMode = 'explicit';
	ctx.destination.channelInterpretation = 'discrete';
	await ctx.audioWorklet.addModule(WORKLET_URL);

	const song = songNode(ctx, { offline: true, messages: songMessages(comp, exported) });
	const merger = ctx.createChannelMerger(channels);
	merger.connect(ctx.destination);
	// A merger input is mono, so split each stereo stem into its two channels.
	const route = (node, slot) => {
		const split = ctx.createChannelSplitter(2);
		node.connect(split);
		split.connect(merger, 0, slot * 2);
		split.connect(merger, 1, slot * 2 + 1);
	};
	let space = null;
	let echo = null;
	if (returns) {
		space = new Space(ctx);
		echo = new Echo(ctx);
		space.prepare(comp.space);
		echo.set(comp.echo, bpm);
		const echoToSpace = ctx.createGain();
		echoToSpace.gain.value = 0.3;
		echo.output.connect(echoToSpace).connect(space.input);
		for (const [ret, slot] of [
			[space, exported.length],
			[echo, exported.length + 1],
		]) {
			route(ret.output, slot);
		}
	}
	exported.forEach((index, slot) => {
		const layer = comp.layers[index];
		const out = ctx.createGain();
		route(out, slot);
		const strip = new Strip(ctx, out, space, echo, song, index);
		strip.setMix(layer, true, trims[layer.id] ?? 1);
		strip.setEffects(layer.fx, bpm);
	});

	const steps = 24;
	for (let k = 1; k < steps; k++) {
		const at = (seconds * k) / steps;
		ctx.suspend(Math.floor((at * SR) / 128) * (128 / SR)).then(() => {
			onProgress?.(k / steps);
			ctx.resume();
		});
	}
	const buffer = await ctx.startRendering();
	onProgress?.(1);

	// One shared gain, so the stems keep their balance: their sum peaks at
	// -0.3 dBFS, like the song, and no single stem clips.
	let stemPeak = 1e-9;
	let mixPeak = 1e-9;
	for (const side of [0, 1]) {
		const sum = new Float32Array(length);
		for (let slot = 0; slot < slots; slot++) {
			const data = buffer.getChannelData(slot * 2 + side);
			for (let i = 0; i < length; i++) {
				const v = data[i];
				sum[i] += v;
				if (Math.abs(v) > stemPeak) stemPeak = Math.abs(v);
			}
		}
		for (let i = 0; i < length; i++) if (Math.abs(sum[i]) > mixPeak) mixPeak = Math.abs(sum[i]);
	}
	const gain = Math.min(CEILING / mixPeak, 0.98 / stemPeak, 8);

	const names = exported.map((index, slot) => stemName(comp, index, slot));
	if (returns) names.push(`${String(exported.length + 1).padStart(2, '0')} space (reverb return).wav`, `${String(exported.length + 2).padStart(2, '0')} echo (delay return).wav`);
	const files = [];
	for (let slot = 0; slot < slots; slot++) {
		files.push({ name: names[slot], data: wav24(buffer.getChannelData(slot * 2), buffer.getChannelData(slot * 2 + 1), gain) });
		await pause();
	}
	files.push({ name: 'about these stems.txt', data: new TextEncoder().encode(aboutText(comp, bars, gain, returns)) });
	return { blob: zip(files), names, seconds };
}

function aboutText(comp, bars, gain, returns) {
	const bpm = tempoBpm(comp.tempo);
	const pitches = comp.palette.map((_, d) => `${ratioLabel(indexRatio(comp.palette, d))} (${+(rootHz(comp.root) * (indexRatio(comp.palette, d)[0] / indexRatio(comp.palette, d)[1])).toFixed(3)} Hz)`);
	return [
		`${comp.name} — stems from SEEKER`,
		'',
		`tempo: ${bpm} BPM exactly (${tempoLabel(comp.tempo)} shown in the app)`,
		`length: ${bars} bars of 4/4 from bar 1, plus ${TAIL_SECONDS} seconds for tails to ring out`,
		`format: 48 kHz, 24-bit stereo WAV`,
		`root: ${rootHz(comp.root)} Hz; every pitch is 48 Hz × X / 2^N`,
		`palette: ${pitches.join(', ')}`,
		'',
		returns
			? 'Each layer includes its own effects. Space and echo are shared, so they come as two return stems. Line every file up at the start and they add up to the song (before the master limiter).'
			: 'Each layer includes its own effects but no space or echo, ready for your own reverb and delay.',
		`All stems were scaled together by ${gain >= 1 ? '+' : ''}${(20 * Math.log10(gain)).toFixed(1)} dB so their sum peaks at -0.3 dBFS; their balance is unchanged.`,
		'',
	].join('\n');
}
