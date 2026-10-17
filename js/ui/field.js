// The harmonic field: every palette pitch from 48 Hz up five octaves, laid on
// a spiral. Angle is position within the octave (the root points up); distance
// from the centre is height. Notes glow in their layer's color as they sound,
// and the dots themselves are an instrument: press, hold, and slide.

import { h, svg, ICONS, showTip, hideTip } from './dom.js';
import { indexValue, foldHarmonic, ratioLabel, oddPart, rootHz } from '../tuning.js';
import { LAYER_COLORS, isDrums, moodFor } from '../state.js';

const OCTAVES = 6;
const LIFE = 1.1;

export class Field {
	constructor(app) {
		this.app = app;
		this.canvas = h('canvas', { 'aria-label': 'harmonic field: press the dots to play notes' });
		this.center = h('button', { class: 'center', 'aria-label': 'play', title: 'play / stop (space)' }, svg(ICONS.play));
		this.leftLabel = h('div', { class: 'corner left' });
		this.rightLabel = h('div', { class: 'corner right' });
		// The next step on the main path (the phone dock says it instead).
		this.caption = h('div', { class: 'caption', 'aria-hidden': 'true' });
		this.el = h('div', { class: 'panel field' }, this.canvas, this.leftLabel, this.rightLabel, this.center, this.caption);
		this.nodes = [];
		this.flashes = [];
		this.pulses = [];
		this.held = new Map();
		this.hover = null;
		this.layoutKey = '';
		this.static = document.createElement('canvas');
		this.center.addEventListener('click', () => app.togglePlay());
		this.bindPointer();
		new ResizeObserver(() => this.layout(true)).observe(this.el);
		app.subscribe(() => this.update());
		app.audio.on('tick', (tick) => this.onTick(tick));
		this.frame = this.frame.bind(this);
		this.running = false;
		this.wake();
	}

	// Starts the animation loop; it stops itself once nothing is moving.
	wake() {
		this.dirty = true;
		if (this.running) return;
		this.running = true;
		requestAnimationFrame(this.frame);
	}

	update() {
		const playing = this.app.audio.playing;
		this.center.classList.toggle('on', playing);
		this.center.replaceChildren(svg(playing ? ICONS.stop : ICONS.play));
		this.center.setAttribute('aria-label', playing ? 'stop' : 'play');
		this.center.classList.toggle('invite', this.app.flow.step === 'play');
		if (this.caption.textContent !== this.app.flow.caption) this.caption.textContent = this.app.flow.caption;
		const comp = this.app.comp;
		const mood = moodFor(comp.palette);
		this.leftLabel.textContent = `${mood ? mood.name : 'custom'} · ${comp.palette.length} notes`;
		this.rightLabel.textContent = `root ${rootHz(comp.root)} hz`;
		this.layout(false);
	}

	layout(force) {
		const comp = this.app.comp;
		const rect = this.el.getBoundingClientRect();
		const size = Math.max(10, Math.min(rect.width, rect.height));
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		const key = `${comp.palette.join(',')}|${comp.root}|${size}|${dpr}`;
		if (!force && key === this.layoutKey) return;
		this.layoutKey = key;
		this.size = size;
		this.dpr = dpr;
		for (const c of [this.canvas, this.static]) {
			c.width = Math.round(size * dpr);
			c.height = Math.round(size * dpr);
		}
		const n = comp.palette.length;
		const cx = size / 2;
		const outer = size / 2 - 38;
		const inner = size * 0.13;
		this.cx = cx;
		this.inner = inner;
		this.nodes = [];
		for (let k = 0; k < OCTAVES; k++) {
			for (let d = 0; d < n; d++) {
				const value = indexValue(comp.palette, d);
				const p = k + Math.log2(value);
				const angle = 2 * Math.PI * (p - k) - Math.PI / 2;
				const r = inner + ((outer - inner) * p) / OCTAVES;
				const harmonic = comp.palette[d];
				const simplicity = Math.max(0, 1 - Math.log2(oddPart(harmonic)) / 7);
				this.nodes.push({
					x: cx + r * Math.cos(angle),
					y: cx + r * Math.sin(angle),
					r: (1.6 + 2.2 * simplicity) * (0.8 + (0.4 * k) / OCTAVES),
					p,
					k,
					d,
					freq: 48 * 2 ** k * value,
					index: (k - comp.root) * n + d,
					label: ratioLabel(foldHarmonic(harmonic)),
					root: d === 0,
				});
			}
		}
		this.drawStatic(outer);
		this.wake();
	}

	drawStatic(outer) {
		const g = this.static.getContext('2d');
		const { dpr, size, cx, inner } = this;
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
		g.clearRect(0, 0, size, size);
		const n = this.app.comp.palette.length;
		// Rays, one per palette degree.
		g.lineWidth = 1;
		for (let d = 0; d < n; d++) {
			const node = this.nodes[d];
			const angle = Math.atan2(node.y - cx, node.x - cx);
			g.strokeStyle = d === 0 ? '#2a2a31' : '#141418';
			g.beginPath();
			g.moveTo(cx + inner * Math.cos(angle), cx + inner * Math.sin(angle));
			g.lineTo(cx + (outer + 8) * Math.cos(angle), cx + (outer + 8) * Math.sin(angle));
			g.stroke();
			g.fillStyle = d === 0 ? '#a9a9b2' : '#5c5c66';
			g.font = '10px JetBrains Mono, ui-monospace, monospace';
			g.textAlign = 'center';
			g.textBaseline = 'middle';
			g.fillText(node.label, cx + (outer + 17) * Math.cos(angle), cx + (outer + 17) * Math.sin(angle));
		}
		// Nested polygons: each octave's notes joined in order.
		for (let k = 0; k < OCTAVES; k++) {
			const ring = this.nodes.filter((node) => node.k === k);
			const fade = 0.25 + (0.75 * k) / OCTAVES;
			g.strokeStyle = `rgba(150,150,165,${0.16 * fade})`;
			g.beginPath();
			ring.forEach((node, i) => (i ? g.lineTo(node.x, node.y) : g.moveTo(node.x, node.y)));
			g.closePath();
			g.stroke();
		}
		// The spiral through every pitch in order.
		g.strokeStyle = 'rgba(190,190,205,0.22)';
		g.beginPath();
		this.nodes.forEach((node, i) => (i ? g.lineTo(node.x, node.y) : g.moveTo(node.x, node.y)));
		g.stroke();
		// The composition's root octave.
		const root = this.app.comp.root;
		for (const node of this.nodes) {
			const home = node.k === root;
			g.fillStyle = node.root ? (home ? '#ececef' : '#9a9aa4') : home ? '#8a8a94' : '#55555e';
			g.beginPath();
			g.arc(node.x, node.y, node.r, 0, Math.PI * 2);
			g.fill();
		}
	}

	nodeAt(x, y) {
		let best = null;
		let bestDistance = 18;
		for (const node of this.nodes) {
			const d = Math.hypot(node.x - x, node.y - y);
			if (d < bestDistance) {
				bestDistance = d;
				best = node;
			}
		}
		return best;
	}

	bindPointer() {
		const canvas = this.canvas;
		const point = (event) => {
			const rect = canvas.getBoundingClientRect();
			const scale = this.size / Math.min(rect.width, rect.height);
			return [(event.clientX - rect.left) * scale, (event.clientY - rect.top) * scale];
		};
		const press = (event, node) => {
			const app = this.app;
			const index = app.liveLayerIndex();
			if (index < 0 || !node) return;
			const layer = app.comp.layers[index];
			const n = app.comp.palette.length;
			const key = 1000 + (event.pointerId % 1000) * 64 + node.index + 32;
			const held = this.held.get(event.pointerId);
			if (held?.node === node) return;
			if (held) app.liveNote(0, held.key, false, held.layer);
			this.held.set(event.pointerId, { node, key, layer: index });
			this.wake();
			app.liveNote(node.index - layer.octave * n, key, true, index);
		};
		const release = (event) => {
			const held = this.held.get(event.pointerId);
			if (!held) return;
			this.app.liveNote(0, held.key, false, held.layer);
			this.held.delete(event.pointerId);
		};
		canvas.addEventListener('pointerdown', (event) => {
			canvas.setPointerCapture(event.pointerId);
			const [x, y] = point(event);
			press(event, this.nodeAt(x, y));
		});
		canvas.addEventListener('pointermove', (event) => {
			const [x, y] = point(event);
			const node = this.nodeAt(x, y);
			if (node !== this.hover) this.wake();
			this.hover = node;
			if (this.held.has(event.pointerId) && node) press(event, node);
			if (node) {
				const rect = canvas.getBoundingClientRect();
				const scale = Math.min(rect.width, rect.height) / this.size;
				showTip(rect.left + node.x * scale, rect.top + node.y * scale, h('span', {}, node.label, h('small', {}, ` · ${+node.freq.toFixed(2)} hz`)));
			} else hideTip();
		});
		canvas.addEventListener('pointerup', release);
		canvas.addEventListener('pointercancel', release);
		canvas.addEventListener('pointerleave', () => {
			this.hover = null;
			this.wake();
			hideTip();
		});
	}

	onTick(tick) {
		if (document.hidden || !tick.notes.length) return;
		const ctx = this.app.audio.ctx;
		const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
		const sr = ctx.sampleRate;
		for (const note of tick.notes) {
			const layer = this.app.comp.layers[note.layer];
			if (!layer) continue;
			const color = LAYER_COLORS[layer.color] || '#fff';
			const at = tick.time + note.offset / sr + latency;
			if (isDrums(layer)) {
				if (note.row <= 2) this.pulses.push({ at, color, strength: note.row === 0 ? note.vel : note.vel * 0.5 });
				continue;
			}
			const p = Math.log2(note.freq / 48);
			const node = this.nodes.find((x) => Math.abs(x.p - p) < 1e-4);
			if (node) this.flashes.push({ node, at, color, vel: note.vel });
		}
		if (this.flashes.length > 160) this.flashes.splice(0, this.flashes.length - 160);
		if (this.pulses.length > 24) this.pulses.splice(0, this.pulses.length - 24);
		this.wake();
	}

	frame() {
		const ctx = this.app.audio.ctx;
		const now = ctx ? ctx.currentTime : 0;
		this.flashes = this.flashes.filter((f) => now - f.at < LIFE);
		this.pulses = this.pulses.filter((f) => now - f.at < 0.5);
		const moving = this.flashes.length || this.pulses.length || this.held.size;
		if (!moving && !this.dirty) {
			this.running = false;
			return;
		}
		requestAnimationFrame(this.frame);
		this.dirty = false;
		const g = this.canvas.getContext('2d');
		const { dpr } = this;
		g.setTransform(1, 0, 0, 1, 0, 0);
		g.clearRect(0, 0, this.canvas.width, this.canvas.height);
		g.drawImage(this.static, 0, 0);
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
		g.globalCompositeOperation = 'lighter';
		// Drum hits pulse around the centre.
		for (const pulse of this.pulses) {
			const age = now - pulse.at;
			if (age < 0) continue;
			const t = age / 0.5;
			g.strokeStyle = pulse.color;
			g.globalAlpha = (1 - t) ** 2 * 0.6 * pulse.strength;
			g.lineWidth = 2;
			g.beginPath();
			g.arc(this.cx, this.cx, this.inner * (0.75 + t * 0.5), 0, Math.PI * 2);
			g.stroke();
		}
		for (const flash of this.flashes) {
			const age = now - flash.at;
			if (age < 0) continue;
			const t = age / LIFE;
			const { node } = flash;
			const glow = g.createRadialGradient(node.x, node.y, 0, node.x, node.y, 16 + 10 * flash.vel);
			glow.addColorStop(0, flash.color);
			glow.addColorStop(1, 'transparent');
			g.globalAlpha = (1 - t) ** 1.6 * (0.5 + flash.vel * 0.5);
			g.fillStyle = glow;
			g.beginPath();
			g.arc(node.x, node.y, 16 + 10 * flash.vel, 0, Math.PI * 2);
			g.fill();
			g.globalAlpha = (1 - t) ** 3;
			g.strokeStyle = flash.color;
			g.lineWidth = 1;
			g.beginPath();
			g.arc(node.x, node.y, node.r + 4 + t * 22, 0, Math.PI * 2);
			g.stroke();
		}
		for (const { node, layer } of this.held.values()) {
			const color = LAYER_COLORS[this.app.comp.layers[layer]?.color] || '#fff';
			g.globalAlpha = 0.9;
			g.fillStyle = color;
			g.beginPath();
			g.arc(node.x, node.y, node.r + 3, 0, Math.PI * 2);
			g.fill();
		}
		g.globalAlpha = 1;
		g.globalCompositeOperation = 'source-over';
		if (this.hover) {
			g.strokeStyle = '#ececef';
			g.lineWidth = 1;
			g.beginPath();
			g.arc(this.hover.x, this.hover.y, this.hover.r + 4, 0, Math.PI * 2);
			g.stroke();
		}
	}
}
