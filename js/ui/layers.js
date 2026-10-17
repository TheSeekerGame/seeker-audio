// The layer list: one row per instrument, with level, mute, solo, and a
// re-roll. Selecting a row opens it in the editor.

import { h, iconEl, popover, closePopover } from './dom.js';
import { LAYER_COLORS, ROLES, MAX_LAYERS } from '../state.js';
import { INSTRUMENTS } from '../instruments.js';

const ROLE_ABOUT = {
	melody: 'a tune that wanders over the harmony',
	chords: 'stacked harmonics, held or struck',
	arp: 'broken chords in steady motion',
	bass: 'low notes around 48 Hz',
	drone: 'one long tone under everything',
	texture: 'a slow cloud of grains',
	drums: 'a kit tuned to the fundamental',
};

export class Layers {
	constructor(app) {
		this.app = app;
		this.list = h('div', { class: 'layer-list', role: 'listbox', 'aria-label': 'layers' });
		this.addButton = h('button', { class: 'btn small', onclick: () => this.openAdd() }, iconEl('plus'), 'add layer');
		this.mixButton = h('button', { class: 'btn small', onclick: () => app.setView(app.view === 'mix' ? 'pattern' : 'mix') }, 'space & mix');
		this.count = h('span');
		this.el = h(
			'div',
			{ class: 'panel layers' },
			h('div', { class: 'panel-title' }, 'layers', this.count),
			this.list,
			h('div', { class: 'layer-foot' }, this.addButton, this.mixButton),
		);
		this.rows = [];
		this.key = '';
		app.subscribe(() => this.render());
		app.audio.on('tick', (tick) => this.meters(tick.levels));
		this.render();
	}

	render() {
		const { comp, selected, view } = this.app;
		const audibleSolo = comp.layers.some((l) => l.solo);
		const key = JSON.stringify([comp.layers.map((l) => [l.id, l.engine, l.role, l.color, l.mute, l.solo]), selected, view]);
		this.addButton.disabled = comp.layers.length >= MAX_LAYERS;
		this.mixButton.classList.toggle('on', view === 'mix');
		this.count.textContent = `${comp.layers.length}/${MAX_LAYERS}`;
		this.count.style.marginLeft = 'auto';
		if (key === this.key) return;
		this.key = key;
		this.rows = comp.layers.map((layer, index) => {
			const silent = audibleSolo ? !layer.solo : layer.mute;
			const meter = h('i');
			const toggle = (label, prop, title) =>
				h(
					'button',
					{
						class: `toggle${layer[prop] ? ' on' : ''}`,
						title,
						'aria-pressed': String(layer[prop]),
						onclick: (event) => {
							event.stopPropagation();
							this.app.change((c) => (c.layers[index][prop] = !c.layers[index][prop]));
						},
					},
					label,
				);
			const row = h(
				'div',
				{
					class: `layer${index === selected && view !== 'mix' ? ' selected' : ''}${silent ? ' silent' : ''}`,
					style: { '--color': LAYER_COLORS[layer.color] },
					role: 'option',
					'aria-selected': String(index === selected),
					tabindex: '0',
					onclick: () => {
						this.app.selected = index;
						if (this.app.view === 'mix') this.app.view = 'pattern';
						this.app.notify();
					},
					onkeydown: (event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							row.click();
						}
					},
				},
				h('div', { class: 'bar' }),
				h('div', { class: 'info' }, h('div', { class: 'name' }, INSTRUMENTS[layer.engine].name), h('div', { class: 'role' }, ROLES[layer.role]?.name || layer.role)),
				h(
					'div',
					{ class: 'actions' },
					h('div', { class: 'meter' }, meter),
					toggle('m', 'mute', 'mute'),
					toggle('s', 'solo', 'solo'),
					h(
						'button',
						{
							class: 'toggle',
							title: 'new pattern and sound for this layer',
							onclick: (event) => {
								event.stopPropagation();
								this.app.select(index);
								this.app.newSound(index);
								this.app.newPattern(index);
							},
						},
						'✦',
					),
				),
			);
			row.meter = meter;
			return row;
		});
		this.list.replaceChildren(...this.rows);
		if (!comp.layers.length) {
			this.list.append(h('div', { class: 'hint', style: { padding: '12px 4px' } }, 'no layers yet — add one, or press ✦ surprise'));
		}
	}

	meters(levels) {
		this.rows.forEach((row, i) => {
			const level = Math.min(1, Math.sqrt(levels[i] || 0) * 1.3);
			row.meter.style.transform = `scaleX(${level.toFixed(3)})`;
		});
	}

	openAdd() {
		const items = Object.keys(ROLES).map((role) =>
			h(
				'button',
				{
					class: 'menu-item',
					onclick: () => {
						closePopover();
						this.app.addLayer(role);
					},
				},
				ROLES[role].name,
				h('small', {}, ROLE_ABOUT[role]),
			),
		);
		popover(this.addButton, [h('div', { class: 'heading' }, 'add a layer'), ...items]);
	}
}
