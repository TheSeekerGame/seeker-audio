// Insert effects for a layer. Filter, drive, chorus, and tremolo are native Web
// Audio graphs; resonator, shifter, and lo-fi run in the audio worklet. Every
// modulation rate is a harmonic rate of 48 Hz.

import { EFFECTS, RATE_BEATS } from '../instruments.js';

const SMOOTH = 0.03;

// Moves a parameter smoothly while audio runs; before the first sample (as in
// an offline render) it sets the value exactly so nothing fades in.
export function ramp(param, value, ctx, smooth = SMOOTH) {
	if (ctx.currentTime < 0.001) {
		param.cancelScheduledValues(0);
		param.value = value;
	} else {
		param.setTargetAtTime(value, ctx.currentTime, smooth);
	}
}

// Chorus speeds: 48 Hz × 1/256, 3/512, 1/128, 3/256, 9/512, 3/128.
const CHORUS_RATES = [0.1875, 0.28125, 0.375, 0.5625, 0.84375, 1.125];

function filterEffect(ctx) {
	const input = ctx.createGain();
	const output = ctx.createGain();
	const lowpass = ctx.createBiquadFilter();
	lowpass.type = 'lowpass';
	const highpass = ctx.createBiquadFilter();
	highpass.type = 'highpass';
	input.connect(lowpass).connect(highpass).connect(output);
	// Sweep: a slow LFO on the cutoffs, one cycle per two bars.
	const lfo = ctx.createOscillator();
	const depth = ctx.createGain();
	depth.gain.value = 0;
	lfo.connect(depth);
	depth.connect(lowpass.detune);
	depth.connect(highpass.detune);
	lfo.start();
	let last = null;
	return {
		input,
		output,
		set(p, bpm) {
			last = p;
			const pos = p.position;
			// A centre dead zone passes the signal untouched, as on a DJ mixer.
			const lp = pos < -0.05 ? 20000 * (110 / 20000) ** ((-pos - 0.05) / 0.95) : 22000;
			const hp = pos > 0.05 ? 20 * (7000 / 20) ** ((pos - 0.05) / 0.95) : 10;
			ramp(lowpass.frequency, lp, ctx);
			ramp(highpass.frequency, hp, ctx);
			const q = 0.7 + p.resonance * 7;
			ramp(lowpass.Q, q, ctx);
			ramp(highpass.Q, q, ctx);
			ramp(depth.gain, p.sweep * 2400, ctx);
			ramp(lfo.frequency, bpm / 60 / 8, ctx);
		},
		tempo(bpm) {
			if (last) this.set(last, bpm);
		},
		dispose() {
			lfo.stop();
		},
	};
}

function driveCurve(amount) {
	const n = 2048;
	const curve = new Float32Array(n);
	const k = 1 + amount * 9;
	for (let i = 0; i < n; i++) {
		const x = (i / (n - 1)) * 2 - 1;
		// Slight asymmetry adds even harmonics, like tape.
		const y = Math.tanh(k * (x + 0.08 * x * x)) / Math.tanh(k);
		curve[i] = y;
	}
	return curve;
}

function driveEffect(ctx) {
	const input = ctx.createGain();
	const output = ctx.createGain();
	const dry = ctx.createGain();
	const wet = ctx.createGain();
	const shaper = ctx.createWaveShaper();
	shaper.oversample = '4x';
	const tone = ctx.createBiquadFilter();
	tone.type = 'lowpass';
	const dc = ctx.createBiquadFilter();
	dc.type = 'highpass';
	dc.frequency.value = 25;
	input.connect(dry).connect(output);
	input.connect(shaper).connect(dc).connect(tone).connect(wet).connect(output);
	let amount = -1;
	return {
		input,
		output,
		set(p) {
			if (Math.abs(p.amount - amount) > 0.005) {
				amount = p.amount;
				shaper.curve = driveCurve(amount);
			}
			ramp(tone.frequency, 1800 * 2 ** (p.tone * 3.2), ctx);
			const makeup = 1 / (1 + p.amount * 0.6);
			ramp(wet.gain, p.mix * makeup, ctx);
			ramp(dry.gain, 1 - p.mix, ctx);
		},
		tempo() {},
		dispose() {},
	};
}

function chorusEffect(ctx) {
	const input = ctx.createGain();
	const output = ctx.createGain();
	const dry = ctx.createGain();
	const wet = ctx.createGain();
	const left = ctx.createDelay(0.05);
	const right = ctx.createDelay(0.05);
	left.delayTime.value = 0.013;
	right.delayTime.value = 0.017;
	const merger = ctx.createChannelMerger(2);
	const lfo = ctx.createOscillator();
	const depthL = ctx.createGain();
	const depthR = ctx.createGain();
	lfo.connect(depthL).connect(left.delayTime);
	lfo.connect(depthR).connect(right.delayTime);
	lfo.start();
	input.connect(dry).connect(output);
	input.connect(left).connect(merger, 0, 0);
	input.connect(right).connect(merger, 0, 1);
	merger.connect(wet).connect(output);
	return {
		input,
		output,
		set(p) {
			const d = 0.0006 + p.depth * 0.0034;
			ramp(depthL.gain, d, ctx);
			ramp(depthR.gain, -d, ctx);
			const rate = CHORUS_RATES[Math.min(CHORUS_RATES.length - 1, Math.round(p.rate * (CHORUS_RATES.length - 1)))];
			ramp(lfo.frequency, rate, ctx);
			ramp(wet.gain, p.mix * 0.8, ctx);
			ramp(dry.gain, 1 - p.mix * 0.4, ctx);
		},
		tempo() {},
		dispose() {
			lfo.stop();
		},
	};
}

function tremoloEffect(ctx) {
	const input = ctx.createGain();
	const output = ctx.createGain();
	const amp = ctx.createGain();
	const panner = ctx.createStereoPanner();
	const lfo = ctx.createOscillator();
	const ampDepth = ctx.createGain();
	const panDepth = ctx.createGain();
	lfo.connect(ampDepth).connect(amp.gain);
	lfo.connect(panDepth).connect(panner.pan);
	lfo.start();
	input.connect(amp).connect(panner).connect(output);
	let last = null;
	return {
		input,
		output,
		set(p, bpm) {
			last = p;
			const beats = RATE_BEATS[p.rate] ?? 0.5;
			ramp(lfo.frequency, bpm / 60 / beats, ctx);
			const volume = p.mode === 'volume';
			ramp(amp.gain, volume ? 1 - p.depth * 0.5 : 1, ctx);
			ramp(ampDepth.gain, volume ? p.depth * 0.5 : 0, ctx);
			ramp(panDepth.gain, volume ? 0 : p.depth * 0.9, ctx);
		},
		tempo(bpm) {
			if (last) this.set(last, bpm);
		},
		dispose() {
			lfo.stop();
		},
	};
}

function workletEffect(ctx, type, params) {
	// Initial settings travel with the node, so they apply from its first sample.
	const node = new AudioWorkletNode(ctx, 'seeker-fx', {
		numberOfInputs: 1,
		numberOfOutputs: 1,
		outputChannelCount: [2],
		channelCount: 2,
		channelCountMode: 'explicit',
		processorOptions: { type, params },
	});
	return {
		input: node,
		output: node,
		set(p) {
			node.port.postMessage({ params: p });
		},
		tempo() {},
		dispose() {
			node.port.close();
		},
	};
}

const NATIVE = { filter: filterEffect, drive: driveEffect, chorus: chorusEffect, tremolo: tremoloEffect };

export function createEffect(ctx, type, params) {
	if (EFFECTS[type]?.kind === 'worklet') return workletEffect(ctx, type, params);
	return (NATIVE[type] || driveEffect)(ctx);
}
