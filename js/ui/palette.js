// The palette editor: one octave drawn as a circle, with every odd harmonic up
// to 63 placed at its pitch. Simple harmonics sit near the centre, complex ones
// at the edge. Touch a harmonic to add it to the song or remove it.

import { h, modal } from './dom.js';
import { foldHarmonic, foldValue, ratioLabel, normalizePalette, nearestIndex } from '../tuning.js';
import { FAMILIES } from '../moods.js';
import { changePalette, moodFor } from '../state.js';

const MAX_CANDIDATE = 63;
const MIN_NOTES = 3;
const MAX_NOTES = 12;

export function openPaletteEditor(app) {
	const canvas = h('canvas', { class: 'palette-circle', 'aria-label': 'harmonic circle' });
	const chips = h('div', { class: 'ratio-chips' });
	const status = h('p', {});
	const families = h('div', { class: 'ratio-chips' });
	let hover = null;
	let nodes = [];

	const candidates = () => {
		const set = new Set();
		for (let x = 1; x <= MAX_CANDIDATE; x += 2) set.add(x);
		for (const x of app.comp.palette) set.add(x);
		return [...set];
	};

	const layout = () => {
		const size = canvas.clientWidth || 380;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		canvas.width = size * dpr;
		canvas.height = size * dpr;
		const c = size / 2;
		const outer = c - 26;
		nodes = candidates().map((x) => {
			const value = foldValue(x);
			const angle = 2 * Math.PI * Math.log2(value) - Math.PI / 2;
			const r = outer * (0.18 + (0.82 * Math.log2(x + 1)) / Math.log2(256));
			return { x, value, px: c + r * Math.cos(angle), py: c + r * Math.sin(angle), label: ratioLabel(foldHarmonic(x)) };
		});
		draw(size, dpr, c, outer);
	};

	const draw = (size, dpr, c, outer) => {
		const g = canvas.getContext('2d');
		g.setTransform(dpr, 0, 0, dpr, 0, 0);
		g.clearRect(0, 0, size, size);
		const palette = app.comp.palette;
		g.strokeStyle = '#1f1f24';
		for (const f of [0.35, 0.6, 0.85, 1]) {
			g.beginPath();
			g.arc(c, c, outer * f, 0, Math.PI * 2);
			g.stroke();
		}
		// The selected harmonics as a polygon, in pitch order.
		const chosen = nodes.filter((n) => palette.includes(n.x)).sort((a, b) => a.value - b.value);
		g.strokeStyle = 'rgba(236,236,239,0.35)';
		g.beginPath();
		chosen.forEach((n, i) => (i ? g.lineTo(n.px, n.py) : g.moveTo(n.px, n.py)));
		g.closePath();
		g.stroke();
		g.font = '10px JetBrains Mono, ui-monospace, monospace';
		g.textAlign = 'center';
		g.textBaseline = 'middle';
		for (const n of nodes) {
			const on = palette.includes(n.x);
			const r = 2 + 3.2 * Math.max(0, 1 - Math.log2(n.x) / 7);
			g.fillStyle = on ? '#f2f2f2' : n === hover ? '#8a8a94' : '#3d3d45';
			g.beginPath();
			g.arc(n.px, n.py, on ? r + 1.5 : r, 0, Math.PI * 2);
			g.fill();
			if (on || n === hover) {
				g.fillStyle = on ? '#ececef' : '#a9a9b2';
				g.fillText(n.label, n.px, n.py - r - 9);
			}
		}
	};

	const refresh = () => {
		const palette = app.comp.palette;
		chips.replaceChildren(...palette.map((x) => h('span', { class: 'ratio-chip' }, ratioLabel(foldHarmonic(x)))));
		const mood = moodFor(palette);
		status.textContent = `${palette.length} notes per octave${mood ? ` — the “${mood.name}” mood` : ''}. The root (1) always stays.`;
		layout();
	};

	const preview = (x) => {
		const palette = app.comp.palette;
		const index = app.liveLayerIndex();
		if (index < 0) return;
		const layer = app.comp.layers[index];
		const row = nearestIndex(palette, Math.log2(foldValue(x))) - layer.octave * palette.length;
		const key = 7000 + x;
		app.liveNote(row, key, true, index, 0.7);
		setTimeout(() => app.liveNote(row, key, false, index), 380);
	};

	const toggle = (x) => {
		const palette = app.comp.palette;
		if (x === 1) return;
		const on = palette.includes(x);
		if (on && palette.length <= MIN_NOTES) return;
		if (!on && palette.length >= MAX_NOTES) return;
		// Two harmonics that fold to the same pitch would duplicate a degree.
		if (!on && palette.some((p) => Math.abs(foldValue(p) - foldValue(x)) < 1e-9)) return;
		const next = on ? palette.filter((p) => p !== x) : [...palette, x];
		app.change((c) => changePalette(c, next));
		if (!on) preview(x);
		refresh();
	};

	const pick = (event) => {
		const rect = canvas.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;
		let best = null;
		let bestD = 16;
		for (const n of nodes) {
			const d = Math.hypot(n.px - x, n.py - y);
			if (d < bestD) {
				bestD = d;
				best = n;
			}
		}
		return best;
	};

	canvas.addEventListener('pointermove', (event) => {
		const n = pick(event);
		if (n !== hover) {
			hover = n;
			layout();
		}
	});
	canvas.addEventListener('pointerdown', (event) => {
		const n = pick(event);
		if (n) toggle(n.x);
	});

	for (const family of FAMILIES) {
		families.append(
			h(
				'button',
				{
					class: 'btn small',
					title: `harmonics that are ${family.name}`,
					onclick: () => {
						const members = [];
						for (let x = 1; x <= 255 && members.length < 7; x += 2) {
							if (!family.test(x)) continue;
							if (members.some((m) => Math.abs(foldValue(m) - foldValue(x)) < 1e-9)) continue;
							members.push(x);
						}
						app.change((c) => changePalette(c, normalizePalette(members)));
						refresh();
					},
				},
				family.name,
			),
		);
	}

	const { close } = modal([
		h('h2', {}, 'choose harmonics'),
		h('p', {}, 'One octave as a circle. Every dot is a harmonic of 48 Hz folded into the octave: simple ones near the centre, complex ones at the edge. Touch to add or remove.'),
		canvas,
		chips,
		status,
		h('div', { class: 'section-head', style: { margin: '6px 0 0' } }, 'start from a family'),
		families,
		h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => close() }, 'done')),
	]);
	requestAnimationFrame(refresh);
}
