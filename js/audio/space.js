// The two shared sends: Space (a convolution reverb with a synthesized impulse
// response) and Echo (a tempo-synced ping-pong delay). Both use native Web
// Audio nodes, which run in optimized C++.

import { ECHO_TIMES } from '../tuning.js';
import { ramp } from './fx.js';

const SMOOTH = 0.05;

// Builds a stereo impulse response: early reflections, then decorrelated noise
// that decays and darkens over time.
function impulseResponse(ctx, size, tone) {
	const sr = ctx.sampleRate;
	const seconds = 1.1 + size * size * 5.4;
	const length = Math.round(seconds * sr);
	const buffer = ctx.createBuffer(2, length, sr);
	const decay = 6.9 / seconds;
	// High frequencies die faster than lows; tone sets how much faster.
	const startCutoff = 3500 + tone * 13000;
	const endCutoff = 500 + tone * 2500;
	let seed = 0x2f6b1;
	const rand = () => {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		return (seed >>> 0) / 2147483648 - 1;
	};
	for (let ch = 0; ch < 2; ch++) {
		const data = buffer.getChannelData(ch);
		let lp = 0;
		const fade = Math.round(sr * 0.004);
		for (let i = 0; i < length; i++) {
			const t = i / sr;
			const cutoff = endCutoff + (startCutoff - endCutoff) * Math.exp(-t * 2.2);
			const a = 1 - Math.exp((-2 * Math.PI * cutoff) / sr);
			lp += (rand() - lp) * a;
			let env = Math.exp(-decay * t);
			if (i < fade) env *= i / fade;
			data[i] = lp * env;
		}
		// Early reflections, different per side.
		for (let k = 0; k < 9; k++) {
			const t = 0.007 + k * 0.0093 + (ch ? 0.0031 : 0) + rand() * 0.002;
			const idx = Math.round(t * sr);
			if (idx < length) data[idx] += rand() * 0.6 * Math.exp(-k * 0.25);
		}
	}
	// Equal energy for every size, so the space control changes length, not level.
	let energy = 0;
	for (let ch = 0; ch < 2; ch++) {
		const data = buffer.getChannelData(ch);
		for (let i = 0; i < length; i++) energy += data[i] * data[i];
	}
	const gain = 0.6 / Math.sqrt(energy / 2);
	for (let ch = 0; ch < 2; ch++) {
		const data = buffer.getChannelData(ch);
		for (let i = 0; i < length; i++) data[i] *= gain;
	}
	return buffer;
}

export class Space {
	constructor(ctx) {
		this.ctx = ctx;
		this.input = ctx.createGain();
		this.output = ctx.createGain();
		this.predelay = ctx.createDelay(0.2);
		this.predelay.delayTime.value = 0.018;
		this.highpass = ctx.createBiquadFilter();
		this.highpass.type = 'highpass';
		this.highpass.frequency.value = 140;
		this.input.connect(this.highpass).connect(this.predelay);
		// Two convolvers crossfade when the impulse response changes.
		this.slots = [0, 1].map(() => {
			const convolver = ctx.createConvolver();
			const gain = ctx.createGain();
			gain.gain.value = 0;
			this.predelay.connect(convolver).connect(gain).connect(this.output);
			return { convolver, gain };
		});
		this.active = 0;
		this.key = '';
		this.timer = 0;
	}

	set({ size, tone }) {
		const key = `${size.toFixed(2)}|${tone.toFixed(2)}`;
		if (key === this.key) return;
		this.key = key;
		clearTimeout(this.timer);
		// Rebuilding the response takes a few milliseconds; wait for the knob to settle.
		this.timer = setTimeout(() => this.rebuild(size, tone), this.slots[this.active].convolver.buffer ? 120 : 0);
	}

	rebuild(size, tone) {
		const next = 1 - this.active;
		const old = this.slots[this.active];
		const now = this.ctx.currentTime;
		this.slots[next].convolver.buffer = impulseResponse(this.ctx, size, tone);
		this.slots[next].gain.gain.setTargetAtTime(1, now, SMOOTH * 2);
		old.gain.gain.setTargetAtTime(0, now, SMOOTH * 2);
		this.active = next;
		// Once faded out, the old convolver is replaced by an idle one, so only one
		// convolution runs at a time.
		clearTimeout(this.retire);
		this.retire = setTimeout(() => {
			if (this.slots[this.active] === old) return;
			old.convolver.disconnect();
			old.convolver = this.ctx.createConvolver();
			this.predelay.connect(old.convolver).connect(old.gain);
		}, 600);
	}

	// Sets the response at once, for offline rendering.
	prepare({ size, tone }) {
		this.key = `${size.toFixed(2)}|${tone.toFixed(2)}`;
		this.slots[0].convolver.buffer = impulseResponse(this.ctx, size, tone);
		this.slots[0].gain.gain.value = 1;
		this.active = 0;
	}
}

export class Echo {
	constructor(ctx) {
		this.ctx = ctx;
		this.input = ctx.createGain();
		this.output = ctx.createGain();
		this.left = ctx.createDelay(4);
		this.right = ctx.createDelay(4);
		this.feedbackL = ctx.createGain();
		this.feedbackR = ctx.createGain();
		this.toneL = ctx.createBiquadFilter();
		this.toneR = ctx.createBiquadFilter();
		for (const f of [this.toneL, this.toneR]) {
			f.type = 'lowpass';
			f.Q.value = 0.5;
		}
		this.lowcut = ctx.createBiquadFilter();
		this.lowcut.type = 'highpass';
		this.lowcut.frequency.value = 180;
		const merger = ctx.createChannelMerger(2);
		// Mono in, then bounce between the sides.
		this.input.connect(this.lowcut).connect(this.left);
		this.left.connect(this.toneL).connect(this.feedbackL).connect(this.right);
		this.right.connect(this.toneR).connect(this.feedbackR).connect(this.left);
		this.left.connect(merger, 0, 0);
		this.right.connect(merger, 0, 1);
		merger.connect(this.output);
		// Gentle tape wobble at 48/256 Hz.
		this.wobble = ctx.createOscillator();
		this.wobble.frequency.value = 0.1875;
		this.wobbleDepth = ctx.createGain();
		this.wobbleDepth.gain.value = 0.0012;
		this.wobble.connect(this.wobbleDepth);
		this.wobbleDepth.connect(this.left.delayTime);
		this.wobbleDepth.connect(this.right.delayTime);
		this.wobble.start();
	}

	set({ time, feedback, tone }, bpm) {
		const ctx = this.ctx;
		const beats = ECHO_TIMES[time]?.beats ?? 0.5;
		const seconds = Math.min(3.9, (beats * 60) / bpm);
		ramp(this.left.delayTime, seconds, ctx, SMOOTH);
		ramp(this.right.delayTime, seconds, ctx, SMOOTH);
		ramp(this.feedbackL.gain, feedback, ctx, SMOOTH);
		ramp(this.feedbackR.gain, feedback, ctx, SMOOTH);
		const cutoff = 900 * 2 ** (tone * 4);
		ramp(this.toneL.frequency, cutoff, ctx, SMOOTH);
		ramp(this.toneR.frequency, cutoff, ctx, SMOOTH);
	}
}
