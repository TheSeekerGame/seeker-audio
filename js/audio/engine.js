// The browser audio graph. One worklet node runs the sequencer and every
// instrument, with a stereo output per layer and a ninth carrying the
// sidechain. Each layer then passes through its insert effects, the sidechain
// duck, fader, and panner, and sends to the shared Space and Echo. The master
// bus is glued by a compressor, then normalized in the worklet so the output
// always peaks at -0.3 dBFS; the song's loudness sets how hard it is pushed.
//
//   song[i] → inserts → duck → fader → pan ─┬→ master → glue → leveler/clip/limiter → out
//   song[8] ─ × −sidechain ─┘               ├→ space send → Space ─┘
//                                           └→ echo send  → Echo ──┘

import { Space, Echo } from './space.js';
import { createEffect, ramp } from './fx.js';
import { renderSource, SOURCE_IDS } from './sources.js';
import { tempoBpm } from '../tuning.js';
import { MAX_LAYERS, audibleLayers } from '../state.js';

const SMOOTH = 0.03;
const json = (v) => JSON.stringify(v);

export const WORKLET_URL = new URL('../../worklet/processor.js', import.meta.url);

// The song node: one stereo output per layer, then the mono sidechain.
export function songNode(ctx, processorOptions) {
	return new AudioWorkletNode(ctx, 'seeker-song', {
		numberOfInputs: 0,
		numberOfOutputs: MAX_LAYERS + 1,
		outputChannelCount: [...new Array(MAX_LAYERS).fill(2), 1],
		processorOptions,
	});
}

// One layer's channel: inserts, sidechain duck, fader, pan, and sends to the
// shared Space and Echo.
export class Strip {
	constructor(ctx, master, space, echo, song, index) {
		this.ctx = ctx;
		this.input = ctx.createGain();
		// The duck's gain is 1 minus the sidechain signal times this layer's amount,
		// sample by sample: the song's sidechain output drives it directly.
		this.duck = ctx.createGain();
		this.sidechain = ctx.createGain();
		this.sidechain.gain.value = 0;
		song.connect(this.sidechain, MAX_LAYERS, 0);
		this.sidechain.connect(this.duck.gain);
		song.connect(this.input, index, 0);
		this.fader = ctx.createGain();
		this.fader.gain.value = 0;
		this.panner = ctx.createStereoPanner();
		this.spaceSend = ctx.createGain();
		this.echoSend = ctx.createGain();
		this.spaceSend.gain.value = 0;
		this.echoSend.gain.value = 0;
		this.fader.connect(this.panner);
		this.panner.connect(master);
		// Offline renders of dry stems pass no Space or Echo.
		if (space) this.panner.connect(this.spaceSend).connect(space.input);
		if (echo) this.panner.connect(this.echoSend).connect(echo.input);
		this.effects = [];
		this.fxKey = '';
		this.duck.connect(this.fader);
		this.input.connect(this.duck);
	}

	// `trim` is the automatic balance's gain for this layer.
	setMix(layer, audible, trim = 1, smooth = undefined) {
		const ctx = this.ctx;
		ramp(this.fader.gain, audible ? layer.volume * layer.volume * 1.2 * trim : 0, ctx, smooth);
		ramp(this.panner.pan, layer.pan, ctx);
		ramp(this.spaceSend.gain, layer.space * layer.space, ctx);
		ramp(this.echoSend.gain, layer.echo * layer.echo * 0.9, ctx);
		ramp(this.sidechain.gain, -(layer.sidechain || 0), ctx);
	}

	// Rebuilds the insert chain when effects are added, removed, reordered, or toggled.
	setEffects(fx, bpm) {
		const key = json(fx.map((f) => [f.type, f.on]));
		if (key !== this.fxKey) {
			this.fxKey = key;
			this.input.disconnect();
			for (const e of this.effects) {
				e.output.disconnect();
				e.dispose();
			}
			this.effects = fx.filter((f) => f.on).map((f) => ({ ...createEffect(this.ctx, f.type, f.params), params: '' }));
			let node = this.input;
			for (const e of this.effects) {
				node.connect(e.input);
				node = e.output;
			}
			node.connect(this.duck);
		}
		const active = fx.filter((f) => f.on);
		active.forEach((f, i) => {
			const e = this.effects[i];
			const p = json(f.params);
			if (e && e.params !== p) {
				e.params = p;
				e.set(f.params, bpm);
			}
		});
	}

	tempo(bpm) {
		for (const e of this.effects) e.tempo(bpm);
	}

	clear() {
		this.setEffects([], 90);
		this.fader.gain.setTargetAtTime(0, this.ctx.currentTime, SMOOTH);
	}
}

// Synthesizes the cloud sources a little at a time so the page stays responsive.
export function sendSources(port, sampleRate, done) {
	const ids = SOURCE_IDS.slice();
	const next = () => {
		const id = ids.shift();
		if (!id) return done?.();
		const source = renderSource(id, sampleRate);
		port.postMessage({ type: 'source', id, data: source.data, rootHz: source.rootHz, sr: source.sr, gain: source.gain }, [source.data.buffer]);
		setTimeout(next, 30);
	};
	setTimeout(next, 50);
}

export class AudioEngine {
	constructor() {
		this.ctx = null;
		this.starting = null;
		this.listeners = {};
		this.applied = null;
		this.bpm = 90;
		this.position = { beat: 0, time: 0, playing: false };
		this.playing = false;
		this.trims = {};
	}

	on(event, fn) {
		(this.listeners[event] ||= []).push(fn);
	}

	emit(event, data) {
		for (const fn of this.listeners[event] || []) fn(data);
	}

	get running() {
		return !!this.ctx && this.ctx.state === 'running';
	}

	// Creates the audio context; must first be called from a user gesture.
	start() {
		if (this.starting) {
			if (this.ctx?.state === 'suspended') this.ctx.resume();
			return this.starting;
		}
		// Lets iOS play through the ringer switch, as a music app should.
		if (navigator.audioSession) navigator.audioSession.type = 'playback';
		this.starting = this.build();
		return this.starting;
	}

	async build() {
		let ctx;
		try {
			ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
		} catch {
			ctx = new AudioContext({ latencyHint: 'interactive' });
		}
		this.ctx = ctx;
		if (ctx.state === 'suspended') ctx.resume();
		await ctx.audioWorklet.addModule(WORKLET_URL);

		this.song = songNode(ctx);
		this.song.port.onmessage = (event) => this.onSongMessage(event.data);

		this.masterBus = ctx.createGain();
		this.glue = ctx.createDynamicsCompressor();
		this.glue.threshold.value = -16;
		this.glue.knee.value = 12;
		this.glue.ratio.value = 2.2;
		this.glue.attack.value = 0.02;
		this.glue.release.value = 0.25;
		this.master = new AudioWorkletNode(ctx, 'seeker-master', {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [2],
			channelCount: 2,
			channelCountMode: 'explicit',
		});
		this.master.port.onmessage = (event) => this.onMasterMessage(event.data);
		this.analyser = ctx.createAnalyser();
		this.analyser.fftSize = 2048;
		this.analyser.smoothingTimeConstant = 0.8;
		this.masterBus.connect(this.glue).connect(this.master);
		this.master.connect(ctx.destination);
		this.master.connect(this.analyser);

		this.space = new Space(ctx);
		this.echo = new Echo(ctx);
		this.space.output.connect(this.masterBus);
		this.echo.output.connect(this.masterBus);
		const echoToSpace = ctx.createGain();
		echoToSpace.gain.value = 0.3;
		this.echo.output.connect(echoToSpace).connect(this.space.input);

		this.strips = [];
		for (let i = 0; i < MAX_LAYERS; i++) {
			this.strips.push(new Strip(ctx, this.masterBus, this.space, this.echo, this.song, i));
		}
		this.sendSources();
		this.emit('ready');
		return this;
	}

	sendSources() {
		sendSources(this.song.port, this.ctx.sampleRate);
	}

	onSongMessage(msg) {
		if (msg.type !== 'tick') return;
		this.position = { beat: msg.beat, time: msg.time, playing: msg.playing };
		this.emit('tick', msg);
	}

	onMasterMessage(msg) {
		if (msg.type === 'meter') this.emit('meter', msg);
		else if (msg.type === 'chunk') this.emit('chunk', msg);
	}

	post(msg) {
		this.song?.port.postMessage(msg);
	}

	// Beat the listener is hearing now, accounting for output latency.
	beatNow() {
		if (!this.ctx || !this.position.playing) return this.position.playing ? this.position.beat : null;
		const latency = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
		const elapsed = this.ctx.currentTime - this.position.time - latency;
		return Math.max(0, this.position.beat + (elapsed * this.bpm) / 60);
	}

	play() {
		this.playing = true;
		this.post({ type: 'play' });
	}

	stop() {
		this.playing = false;
		this.post({ type: 'stop' });
	}

	noteOn(index, row, key, vel = 0.8) {
		this.post({ type: 'live', index, row, key, vel, on: true });
	}

	noteOff(index, key) {
		this.post({ type: 'live', index, key, on: false });
	}

	record(on) {
		this.master?.port.postMessage({ type: 'record', on });
	}

	// New balance trims (by layer id): faders glide to them.
	setTrims(trims) {
		this.trims = trims;
		const comp = this.applied;
		if (!comp) return;
		const audible = audibleLayers(comp);
		comp.layers.forEach((layer, i) => {
			if (layer.id in trims) this.strips[i].setMix(layer, audible[i], trims[layer.id], 0.08);
		});
	}

	// Sends whatever changed since the last call.
	apply(comp) {
		if (!this.ctx) return;
		const prev = this.applied;
		const bpm = tempoBpm(comp.tempo);
		this.bpm = bpm;
		if (!prev || json(prev.palette) !== json(comp.palette) || prev.root !== comp.root) {
			this.post({ type: 'tuning', palette: comp.palette, root: comp.root });
		}
		if (!prev || json(prev.tempo) !== json(comp.tempo) || prev.swing !== comp.swing) {
			this.post({ type: 'tempo', tempo: comp.tempo, swing: comp.swing });
			for (const strip of this.strips) strip.tempo(bpm);
		}
		if (!prev || json(prev.harmony) !== json(comp.harmony)) this.post({ type: 'harmony', shifts: comp.harmony });

		const audible = audibleLayers(comp);
		for (let i = 0; i < MAX_LAYERS; i++) {
			const layer = comp.layers[i];
			const before = prev?.layers[i];
			const strip = this.strips[i];
			if (!layer) {
				if (before || !prev) {
					this.post({ type: 'remove', index: i });
					strip.clear();
				}
				continue;
			}
			const flags = { follow: layer.follow, octave: layer.octave, gate: layer.gate, active: audible[i] };
			if (!before || before.id !== layer.id || before.engine !== layer.engine) {
				this.post({ type: 'layer', index: i, layer: { engine: layer.engine, params: layer.params, pattern: layer.pattern, ...flags } });
			} else {
				if (json(before.params) !== json(layer.params)) this.post({ type: 'params', index: i, params: layer.params });
				if (json(before.pattern) !== json(layer.pattern)) this.post({ type: 'pattern', index: i, pattern: layer.pattern });
				const wasAudible = audibleLayers(prev)[i];
				if (before.follow !== layer.follow || before.octave !== layer.octave || before.gate !== layer.gate || wasAudible !== audible[i]) {
					this.post({ type: 'flags', index: i, ...flags });
				}
			}
			strip.setMix(layer, audible[i], this.trims[layer.id]);
			strip.setEffects(layer.fx, bpm);
		}

		if (!prev || json(prev.space) !== json(comp.space)) this.space.set(comp.space);
		if (!prev || json(prev.echo) !== json(comp.echo) || json(prev.tempo) !== json(comp.tempo)) this.echo.set(comp.echo, bpm);
		if (!prev || prev.master.volume !== comp.master.volume) this.master.port.postMessage({ type: 'loudness', value: comp.master.volume });
		this.applied = JSON.parse(json(comp));
	}

	// Forces a full resend, for example after loading a new composition.
	reset() {
		this.applied = null;
	}
}
