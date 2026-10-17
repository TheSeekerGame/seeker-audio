// Audio worklet entry. Registers three processors that share one global state
// object (tuning, tempo, transport, and synthesized sources):
//   seeker-song    the sequencer and instruments, one stereo output per layer
//                  and a mono sidechain output
//   seeker-fx      a custom effect inserted on a layer
//   seeker-master  the leveler, soft clipper, look-ahead limiter, meter, and recorder

import { Song, MAX_LAYERS } from './dsp/song.js';
import { WORKLET_EFFECTS, Leveler, Limiter, masterClip } from './dsp/effects.js';

const shared = globalThis.__seeker || (globalThis.__seeker = {});
const POST_INTERVAL = 1 / 30;

class SongProcessor extends AudioWorkletProcessor {
	constructor(options) {
		super();
		this.song = new Song(sampleRate, shared);
		this.lastPost = 0;
		// Offline renders (stems) arrive with the whole song and need no visual updates.
		this.quiet = !!options?.processorOptions?.offline;
		for (const msg of options?.processorOptions?.messages || []) this.song.handle(msg);
		this.port.onmessage = (event) => {
			const msg = event.data;
			// Lets the interface wait until every earlier message has been handled.
			if (msg.type === 'ping') this.port.postMessage({ type: 'pong', id: msg.id });
			else this.song.handle(msg);
		};
	}

	process(_inputs, outputs) {
		const n = outputs[0]?.[0]?.length || 128;
		this.song.render(outputs, n);
		if (this.quiet) {
			this.song.notes.length = 0;
			return true;
		}
		if (currentTime - this.lastPost >= POST_INTERVAL) {
			this.lastPost = currentTime;
			this.port.postMessage({
				type: 'tick',
				time: currentTime,
				beat: shared.beat,
				playing: shared.playing,
				levels: this.song.takeLevels(),
				notes: this.song.takeNotes(),
			});
		}
		return true;
	}
}

class FxProcessor extends AudioWorkletProcessor {
	constructor(options) {
		super();
		const Effect = WORKLET_EFFECTS[options.processorOptions?.type];
		this.Effect = Effect;
		this.fx = Effect ? new Effect(sampleRate, shared) : null;
		if (options.processorOptions?.params) this.fx?.setParams(options.processorOptions.params);
		this.silence = new Float32Array(128);
		this.port.onmessage = (event) => {
			if (event.data.params) this.fx?.setParams(event.data.params);
		};
	}

	process(inputs, outputs) {
		const out = outputs[0];
		const n = out[0].length;
		if (this.silence.length < n) this.silence = new Float32Array(n);
		const input = inputs[0];
		const inL = input?.[0] || this.silence;
		const inR = input?.[1] || inL;
		const outL = out[0];
		const outR = out[1] || out[0];
		if (!this.fx) {
			outL.set(inL);
			if (outR !== outL) outR.set(inR);
			return true;
		}
		this.fx.process(inL, inR, outL, outR, n);
		// An invalid sample would stay in the browser's filters after this effect
		// for good: drop the block and start the effect afresh.
		for (let i = 0; i < n; i++) {
			if (!(Math.abs(outL[i]) + Math.abs(outR[i]) < 64)) {
				outL.fill(0);
				if (outR !== outL) outR.fill(0);
				const params = this.fx.params;
				this.fx = new this.Effect(sampleRate, shared);
				this.fx.setParams(params);
				break;
			}
		}
		return true;
	}
}

const CHUNK = 16384;

class MasterProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.leveler = new Leveler(sampleRate);
		this.limiter = new Limiter(sampleRate);
		this.recording = false;
		this.chunkL = new Float32Array(CHUNK);
		this.chunkR = new Float32Array(CHUNK);
		this.fill = 0;
		this.peakL = 0;
		this.peakR = 0;
		this.lastPost = 0;
		this.port.onmessage = (event) => {
			const msg = event.data;
			if (msg.type === 'loudness') this.leveler.setLoudness(msg.value);
			else if (msg.type === 'record') {
				if (!msg.on && this.recording) this.flush(true);
				this.recording = !!msg.on;
				this.fill = 0;
			}
		};
	}

	flush(final) {
		const l = this.chunkL.slice(0, this.fill);
		const r = this.chunkR.slice(0, this.fill);
		this.port.postMessage({ type: 'chunk', l, r, final }, [l.buffer, r.buffer]);
		this.fill = 0;
	}

	process(inputs, outputs) {
		const out = outputs[0];
		const outL = out[0];
		const outR = out[1] || out[0];
		const n = outL.length;
		const input = inputs[0];
		if (input?.[0]) {
			outL.set(input[0]);
			outR.set(input[1] || input[0]);
			// Invalid input never reaches the leveler or limiter.
			for (let i = 0; i < n; i++) {
				if (!(Math.abs(outL[i]) < 64)) outL[i] = 0;
				if (!(Math.abs(outR[i]) < 64)) outR[i] = 0;
			}
		} else {
			outL.fill(0);
			outR.fill(0);
		}
		this.leveler.process(outL, outR, n);
		masterClip(outL, outR, n);
		this.limiter.process(outL, outR, n);
		for (let i = 0; i < n; i++) {
			const l = Math.abs(outL[i]);
			const r = Math.abs(outR[i]);
			if (l > this.peakL) this.peakL = l;
			if (r > this.peakR) this.peakR = r;
		}
		if (this.recording) {
			let i = 0;
			while (i < n) {
				const take = Math.min(n - i, CHUNK - this.fill);
				this.chunkL.set(outL.subarray(i, i + take), this.fill);
				this.chunkR.set(outR.subarray(i, i + take), this.fill);
				this.fill += take;
				i += take;
				if (this.fill >= CHUNK) this.flush(false);
			}
		}
		if (currentTime - this.lastPost >= POST_INTERVAL) {
			this.lastPost = currentTime;
			this.port.postMessage({ type: 'meter', l: this.peakL, r: this.peakR, reduction: this.limiter.reduction });
			this.peakL = 0;
			this.peakR = 0;
		}
		return true;
	}
}

registerProcessor('seeker-song', SongProcessor);
registerProcessor('seeker-fx', FxProcessor);
registerProcessor('seeker-master', MasterProcessor);

export { MAX_LAYERS };
