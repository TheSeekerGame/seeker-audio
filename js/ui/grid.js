// The pattern grid. Columns are steps, rows are palette pitches (labeled with
// their ratio) or drum voices. Click to add a note and drag to lengthen it;
// click a note to remove it. Shift-click changes loudness, Alt-click changes
// how often it plays.

import { h } from './dom.js';
import { indexRatio, ratioLabel, splitIndex, indexFrequency } from '../tuning.js';
import { LAYER_COLORS, isDrums } from '../state.js';
import { DRUM_ROWS, drumRows } from '../instruments.js';

const GUTTER = 70;
const HEADER = 18;
const VELOCITIES = [0.4, 0.65, 0.9];
const CHANCES = [1, 0.75, 0.5, 0.25];

export class Grid {
	constructor(app) {
		this.app = app;
		this.canvas = h('canvas', { 'aria-label': 'pattern grid' });
		this.playhead = h('div', { class: 'playhead' });
		this.el = h('div', { class: 'grid-wrap' }, this.canvas, this.playhead);
		this.views = new Map();
		this.key = '';
		this.drag = null;
		this.bind();
		new ResizeObserver(() => this.draw(true)).observe(this.el);
		this.frame = this.frame.bind(this);
		this.running = false;
	}

	// Runs the playhead loop while the song plays.
	wake() {
		if (this.running || !this.app.audio.playing) return;
		this.running = true;
		requestAnimationFrame(this.frame);
	}

	get layer() {
		return this.app.layer;
	}

	geometry() {
		const layer = this.layer;
		const rect = this.el.getBoundingClientRect();
		const width = rect.width;
		const height = rect.height;
		const drums = isDrums(layer);
		const n = this.app.comp.palette.length;
		const rows = drums ? DRUM_ROWS.length : Math.max(7, Math.min(3 * n + 1, Math.floor((height - HEADER) / 19)));
		const low = drums ? 0 : this.lowRow(layer, rows);
		const rowH = (height - HEADER) / rows;
		const colW = (width - GUTTER) / layer.pattern.length;
		return { width, height, drums, rows, low, rowH, colW, n };
	}

	// Lowest visible row: remembered per layer, initially framing the notes.
	lowRow(layer, rows) {
		if (this.views.has(layer.id)) return this.views.get(layer.id);
		const notes = layer.pattern.notes;
		let low = 0;
		if (notes.length) {
			const min = Math.min(...notes.map((x) => x[1]));
			const max = Math.max(...notes.map((x) => x[1]));
			low = Math.round((min + max) / 2 - rows / 2);
			low = Math.min(low, min);
			if (low + rows - 1 < max) low = max - rows + 1;
		} else low = -1;
		this.views.set(layer.id, low);
		return low;
	}

	rowToY(g, row) {
		return HEADER + (g.rows - 1 - (row - g.low)) * g.rowH;
	}

	draw(force) {
		this.wake();
		const layer = this.layer;
		if (!layer || !this.el.isConnected) return;
		const rect = this.el.getBoundingClientRect();
		const comp = this.app.comp;
		const key = JSON.stringify([layer.id, layer.pattern, layer.octave, layer.color, comp.palette, comp.root, this.views.get(layer.id), rect.width, rect.height, layer.engine, layer.params.style]);
		if (!force && key === this.key) return;
		this.key = key;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		this.canvas.width = Math.round(rect.width * dpr);
		this.canvas.height = Math.round(rect.height * dpr);
		const g2 = this.canvas.getContext('2d');
		g2.setTransform(dpr, 0, 0, dpr, 0, 0);
		g2.clearRect(0, 0, rect.width, rect.height);
		const g = this.geometry();
		this.geo = g;
		const pattern = layer.pattern;
		const color = LAYER_COLORS[layer.color] || '#fff';
		const rate = pattern.rate;

		// Beat shading and bar lines.
		for (let s = 0; s < pattern.length; s++) {
			const beat = Math.floor(s / rate);
			const x = GUTTER + s * g.colW;
			g2.fillStyle = beat % 2 === 0 ? '#0a0a0c' : '#060607';
			g2.fillRect(x, HEADER, g.colW, g.height - HEADER);
			const beatPos = s / rate;
			const onBeat = Math.abs(beatPos - Math.round(beatPos)) < 1e-9;
			const onBar = onBeat && Math.round(beatPos) % 4 === 0;
			g2.fillStyle = onBar ? '#2c2c33' : onBeat ? '#18181c' : '#0f0f12';
			g2.fillRect(x, HEADER, 1, g.height - HEADER);
			if (onBeat && (rate >= 1 || onBar)) {
				g2.fillStyle = onBar ? '#8a8a94' : '#45454e';
				g2.font = '10px JetBrains Mono, ui-monospace, monospace';
				g2.textBaseline = 'top';
				g2.textAlign = 'left';
				g2.fillText(String(beat + 1), x + 3, 3);
			}
		}

		// Rows and their labels.
		g2.font = '11px JetBrains Mono, ui-monospace, monospace';
		g2.textBaseline = 'middle';
		for (let i = 0; i < g.rows; i++) {
			const row = g.low + i;
			const y = this.rowToY(g, row);
			let label;
			let strong = false;
			if (g.drums) {
				label = drumRows(layer.params.style)[row];
			} else {
				const index = row + layer.octave * g.n;
				const { degree } = splitIndex(g.n, index);
				const [num, den] = indexRatio(comp.palette, degree);
				strong = degree === 0;
				label = strong ? `1 · ${Math.round(indexFrequency(comp.palette, index, comp.root))}` : ratioLabel([num, den]);
			}
			g2.fillStyle = strong ? '#1d1d22' : '#0e0e11';
			g2.fillRect(GUTTER, y + g.rowH - 1, g.width - GUTTER, 1);
			g2.fillStyle = strong ? '#ececef' : '#6f6f79';
			g2.textAlign = 'right';
			g2.fillText(label, GUTTER - 10, y + g.rowH / 2);
		}

		// Notes.
		for (const [step, row, len, vel, chance] of pattern.notes) {
			if (row < g.low || row >= g.low + g.rows) continue;
			const x = GUTTER + step * g.colW + 1.5;
			const y = this.rowToY(g, row) + 2;
			const w = Math.min(len, pattern.length - step) * g.colW - 3;
			const hgt = g.rowH - 4;
			g2.globalAlpha = 0.35 + vel * 0.65;
			g2.fillStyle = color;
			roundRect(g2, x, y, w, hgt, Math.min(5, hgt / 2));
			if (chance < 1) {
				g2.globalAlpha = 1;
				g2.fillStyle = '#000';
				roundRect(g2, x + 2, y + 2, w - 4, hgt - 4, Math.min(3, hgt / 2));
				g2.globalAlpha = 0.25 + chance * 0.5;
				g2.fillStyle = color;
				roundRect(g2, x + 2, y + 2, (w - 4) * chance, hgt - 4, Math.min(3, hgt / 2));
			}
			g2.globalAlpha = 1;
		}
		// Out-of-view notes are marked at the edges.
		const above = pattern.notes.some((x) => x[1] >= g.low + g.rows);
		const below = pattern.notes.some((x) => x[1] < g.low);
		g2.fillStyle = color;
		if (above) g2.fillRect(GUTTER, HEADER, g.width - GUTTER, 2);
		if (below) g2.fillRect(GUTTER, g.height - 2, g.width - GUTTER, 2);
	}

	hit(event) {
		const g = this.geo;
		if (!g) return null;
		const rect = this.canvas.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;
		if (y < HEADER) return null;
		const step = Math.floor((x - GUTTER) / g.colW);
		const row = g.low + (g.rows - 1 - Math.floor((y - HEADER) / g.rowH));
		return { x, y, step, row, gutter: x < GUTTER };
	}

	audition(row) {
		const index = this.app.selected;
		const key = 9000 + Math.floor(Math.random() * 1000);
		this.app.liveNote(row, key, true, index, 0.75);
		setTimeout(() => this.app.liveNote(row, key, false, index), 220);
	}

	bind() {
		const canvas = this.canvas;
		canvas.addEventListener('pointerdown', (event) => {
			const layer = this.layer;
			const hit = this.hit(event);
			if (!layer || !hit) return;
			if (hit.gutter) {
				this.audition(hit.row);
				return;
			}
			if (hit.step < 0 || hit.step >= layer.pattern.length) return;
			canvas.setPointerCapture(event.pointerId);
			const notes = layer.pattern.notes;
			const existing = notes.find((x) => x[1] === hit.row && hit.step >= x[0] && hit.step < x[0] + x[2]);
			const gesture = `grid:${performance.now()}`;
			if (existing) {
				if (event.shiftKey || event.altKey) {
					this.app.change(() => {
						if (event.shiftKey) existing[3] = next(VELOCITIES, existing[3]);
						else existing[4] = next(CHANCES, existing[4]);
					});
					if (event.shiftKey) this.audition(hit.row);
					return;
				}
				this.drag = { note: existing, start: existing[0], moved: false, gesture, remove: true };
			} else {
				const note = [hit.step, hit.row, 1, 0.8, 1];
				this.app.change((comp) => comp.layers[this.app.selected].pattern.notes.push(note), { coalesce: gesture });
				this.drag = { note, start: hit.step, moved: false, gesture, remove: false };
				this.audition(hit.row);
			}
		});
		canvas.addEventListener('pointermove', (event) => {
			if (!this.drag) return;
			const hit = this.hit(event);
			if (!hit) return;
			const { note, start } = this.drag;
			const length = this.layer.pattern.length;
			const len = Math.max(1, Math.min(length - start, hit.step - start + 1));
			if (len !== note[2]) {
				this.drag.moved = true;
				this.drag.remove = false;
				this.app.change(() => (note[2] = len), { coalesce: this.drag.gesture });
			}
		});
		const end = () => {
			if (!this.drag) return;
			const { note, remove } = this.drag;
			this.drag = null;
			if (remove) {
				this.app.change((comp) => {
					const notes = comp.layers[this.app.selected].pattern.notes;
					const i = notes.indexOf(note);
					if (i >= 0) notes.splice(i, 1);
				});
			} else {
				this.app.change((comp) => {
					const pattern = comp.layers[this.app.selected].pattern;
					pattern.notes.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
				}, { record: false });
			}
		};
		canvas.addEventListener('pointerup', end);
		canvas.addEventListener('pointercancel', end);
		canvas.addEventListener(
			'wheel',
			(event) => {
				const layer = this.layer;
				if (!layer || isDrums(layer)) return;
				event.preventDefault();
				this.scroll(event.deltaY > 0 ? -1 : 1);
			},
			{ passive: false },
		);
	}

	scroll(rows) {
		const layer = this.layer;
		if (!layer) return;
		const low = this.views.get(layer.id) ?? 0;
		this.views.set(layer.id, low + rows);
		this.draw(true);
	}

	frame() {
		const layer = this.layer;
		const g = this.geo;
		const beat = this.app.audio.beatNow?.();
		if (!this.app.audio.playing) {
			this.playhead.style.opacity = '0';
			this.running = false;
			return;
		}
		requestAnimationFrame(this.frame);
		if (!layer || !g || beat === null || beat === undefined || !this.el.isConnected) {
			this.playhead.style.opacity = '0';
			return;
		}
		const pattern = layer.pattern;
		const pos = (beat * pattern.rate) % pattern.length;
		this.playhead.style.opacity = '1';
		this.playhead.style.transform = `translateX(${GUTTER + pos * g.colW}px)`;
	}
}

function next(list, value) {
	const i = list.findIndex((v) => Math.abs(v - value) < 0.02);
	return list[(i + 1) % list.length] ?? list[0];
}

function roundRect(g, x, y, w, hgt, r) {
	if (w <= 0 || hgt <= 0) return;
	g.beginPath();
	g.roundRect ? g.roundRect(x, y, w, hgt, r) : g.rect(x, y, w, hgt);
	g.fill();
}
