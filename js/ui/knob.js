// A minimal rotary control. Drag vertically (Shift for fine), scroll, or use
// the arrow keys; double-click resets. The label shows the value while in use.

import { h, formatValue } from './dom.js';
import { toNorm, fromNorm } from '../instruments.js';

const NS = 'http://www.w3.org/2000/svg';
const START = -135;
const END = 135;

function polar(cx, cy, r, degrees) {
	const a = ((degrees - 90) * Math.PI) / 180;
	return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx, cy, r, from, to) {
	if (Math.abs(to - from) < 0.01) return '';
	const [x0, y0] = polar(cx, cy, r, from);
	const [x1, y1] = polar(cx, cy, r, to);
	const large = Math.abs(to - from) > 180 ? 1 : 0;
	const sweep = to > from ? 1 : 0;
	return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export { toNorm, fromNorm };

export class Knob {
	constructor({ param, value, onInput, onCommit, size = 44 }) {
		this.param = param;
		this.onInput = onInput;
		this.onCommit = onCommit;
		this.value = value;
		const svg = document.createElementNS(NS, 'svg');
		svg.setAttribute('viewBox', '0 0 44 44');
		svg.style.width = svg.style.height = `${size}px`;
		const track = document.createElementNS(NS, 'path');
		track.setAttribute('class', 'track');
		track.setAttribute('d', arcPath(22, 22, 18, START, END));
		this.arc = document.createElementNS(NS, 'path');
		this.arc.setAttribute('class', 'arc');
		const cap = document.createElementNS(NS, 'circle');
		cap.setAttribute('class', 'cap');
		cap.setAttribute('cx', '22');
		cap.setAttribute('cy', '22');
		cap.setAttribute('r', '12.5');
		this.tick = document.createElementNS(NS, 'line');
		this.tick.setAttribute('class', 'tick');
		svg.append(track, this.arc, cap, this.tick);
		this.label = h('div', { class: 'label' }, param.label);
		this.el = h('div', { class: 'knob', tabindex: '0', role: 'slider', 'aria-label': param.label }, svg, this.label);
		this.bind();
		this.draw();
	}

	setValue(value) {
		if (value === this.value) return;
		this.value = value;
		this.draw();
	}

	draw() {
		const p = this.param;
		const norm = Math.min(1, Math.max(0, toNorm(p, this.value)));
		const angle = START + (END - START) * norm;
		const from = p.min < 0 ? 0 : START;
		this.arc.setAttribute('d', from <= angle ? arcPath(22, 22, 18, from, angle) : arcPath(22, 22, 18, angle, from));
		const [x0, y0] = polar(22, 22, 5, angle);
		const [x1, y1] = polar(22, 22, 10.5, angle);
		this.tick.setAttribute('x1', x0.toFixed(2));
		this.tick.setAttribute('y1', y0.toFixed(2));
		this.tick.setAttribute('x2', x1.toFixed(2));
		this.tick.setAttribute('y2', y1.toFixed(2));
		this.el.setAttribute('aria-valuetext', formatValue(p, this.value));
		if (this.showing) this.label.textContent = formatValue(p, this.value);
	}

	show(on) {
		this.showing = on;
		this.label.textContent = on ? formatValue(this.param, this.value) : this.param.label;
		this.el.classList.toggle('active', on);
	}

	set(norm, commit) {
		const value = fromNorm(this.param, norm);
		if (value !== this.value) {
			this.value = value;
			this.draw();
			this.onInput?.(value);
		}
		if (commit) this.onCommit?.(this.value);
	}

	bind() {
		const el = this.el;
		let startY = 0;
		let startNorm = 0;
		let dragging = false;
		el.addEventListener('pointerdown', (event) => {
			if (event.button !== 0) return;
			event.preventDefault();
			el.setPointerCapture(event.pointerId);
			el.focus({ preventScroll: true });
			dragging = true;
			startY = event.clientY;
			startNorm = toNorm(this.param, this.value);
			this.show(true);
		});
		el.addEventListener('pointermove', (event) => {
			if (!dragging) return;
			const range = event.shiftKey ? 900 : 180;
			startNorm += (startY - event.clientY) / range;
			startY = event.clientY;
			this.set(startNorm, false);
		});
		const end = () => {
			if (!dragging) return;
			dragging = false;
			this.show(false);
			this.onCommit?.(this.value);
		};
		el.addEventListener('pointerup', end);
		el.addEventListener('pointercancel', end);
		el.addEventListener('pointerenter', () => this.show(true));
		el.addEventListener('pointerleave', () => !dragging && this.show(false));
		el.addEventListener('dblclick', () => {
			this.value = undefined;
			this.set(toNorm(this.param, this.param.default), true);
		});
		el.addEventListener(
			'wheel',
			(event) => {
				event.preventDefault();
				const step = this.param.step ? (this.param.step / (this.param.max - this.param.min)) * Math.sign(-event.deltaY) : -event.deltaY * 0.0015;
				this.set(toNorm(this.param, this.value) + step, false);
				clearTimeout(this.wheelTimer);
				this.wheelTimer = setTimeout(() => this.onCommit?.(this.value), 400);
			},
			{ passive: false },
		);
		el.addEventListener('keydown', (event) => {
			const fine = this.param.step ? this.param.step / (this.param.max - this.param.min) : 0.01;
			const delta = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[event.key];
			if (delta) {
				event.preventDefault();
				this.set(toNorm(this.param, this.value) + delta * (event.shiftKey ? fine * 10 : fine), true);
			} else if (event.key === 'Home' || event.key === 'End') {
				event.preventDefault();
				this.set(event.key === 'Home' ? 0 : 1, true);
			}
		});
		el.addEventListener('focus', () => this.show(true));
		el.addEventListener('blur', () => this.show(false));
	}
}
