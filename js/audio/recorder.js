// Records the master output (after the limiter) and encodes a 16-bit WAV file
// whose highest peak sits exactly at -0.3 dBFS.

import { CEILING } from '../../worklet/dsp/effects.js';

export class Recorder {
	constructor(engine) {
		this.engine = engine;
		this.chunks = [];
		this.recording = false;
		this.started = 0;
		this.resolve = null;
		engine.on('chunk', (msg) => this.onChunk(msg));
	}

	get seconds() {
		return this.recording ? (performance.now() - this.started) / 1000 : 0;
	}

	start() {
		this.chunks = [];
		this.recording = true;
		this.started = performance.now();
		this.engine.record(true);
	}

	// Resolves with the WAV blob once the final chunk arrives.
	stop() {
		if (!this.recording) return Promise.resolve(null);
		this.recording = false;
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.engine.record(false);
		});
	}

	onChunk(msg) {
		if (msg.l.length) this.chunks.push(msg);
		if (msg.final && this.resolve) {
			const resolve = this.resolve;
			this.resolve = null;
			resolve(this.encode());
		}
	}

	encode() {
		const sr = this.engine.ctx.sampleRate;
		let frames = 0;
		for (const c of this.chunks) frames += c.l.length;
		if (!frames) return null;
		const buffer = new ArrayBuffer(44 + frames * 4);
		const view = new DataView(buffer);
		const text = (offset, s) => {
			for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
		};
		text(0, 'RIFF');
		view.setUint32(4, 36 + frames * 4, true);
		text(8, 'WAVE');
		text(12, 'fmt ');
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true);
		view.setUint16(22, 2, true);
		view.setUint32(24, sr, true);
		view.setUint32(28, sr * 4, true);
		view.setUint16(32, 4, true);
		view.setUint16(34, 16, true);
		text(36, 'data');
		view.setUint32(40, frames * 4, true);
		let offset = 44;
		let peak = 0;
		for (const c of this.chunks) {
			for (let i = 0; i < c.l.length; i++) peak = Math.max(peak, Math.abs(c.l[i]), Math.abs(c.r[i]));
		}
		const gain = peak > 1e-4 ? Math.min(8, CEILING / peak) : 1;
		// Triangular dither hides the 16-bit quantization in quiet tails.
		const dither = () => (Math.random() - Math.random()) / 32768;
		for (const c of this.chunks) {
			for (let i = 0; i < c.l.length; i++) {
				const l = Math.max(-1, Math.min(1, c.l[i] * gain + dither()));
				const r = Math.max(-1, Math.min(1, c.r[i] * gain + dither()));
				view.setInt16(offset, Math.round(l * 32767), true);
				view.setInt16(offset + 2, Math.round(r * 32767), true);
				offset += 4;
			}
		}
		this.chunks = [];
		return new Blob([buffer], { type: 'audio/wav' });
	}
}
