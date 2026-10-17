// The editor for the selected layer (pattern, sound, effects) and the shared
// mix (space, echo, swing, loudness). Panels are rebuilt only when their
// structure changes; otherwise controls update in place.

import { h, iconEl, popover, closePopover, INSTRUMENT_ICONS, svg } from './dom.js';
import { Knob } from './knob.js';
import { Grid } from './grid.js';
import { INSTRUMENTS, INSTRUMENT_ORDER, EFFECTS, EFFECT_ORDER, effectDefaults, paramLabel } from '../instruments.js';
import { LAYER_COLORS, ROLES, MAX_FX, MAX_STEPS, isDrums, newEffect } from '../state.js';
import { STEP_RATES, ECHO_TIMES } from '../tuning.js';
import { randomEffectParams } from '../generate.js';
import { Rng } from '../rng.js';

const RATE_LABELS = { 0.5: '½', 1: '1', 2: '2', 3: '3', 4: '4', 6: '6', 8: '8' };

const MIX_PARAMS = [
	{ id: 'volume', label: 'volume', min: 0, max: 1, default: 0.75 },
	{ id: 'pan', label: 'pan', min: -1, max: 1, default: 0 },
	{ id: 'space', label: 'space', min: 0, max: 1, default: 0.3 },
	{ id: 'echo', label: 'echo', min: 0, max: 1, default: 0 },
	{ id: 'sidechain', label: 'sidechain', min: 0, max: 1, default: 0 },
	{ id: 'gate', label: 'legato', min: 0.05, max: 1, default: 0.85 },
];

function seg(options, value, onPick, label = (o) => o) {
	// Long lists (the bass models) wrap onto more lines.
	const el = h('div', { class: options.length > 9 ? 'seg wrap' : 'seg', role: 'radiogroup' });
	const buttons = options.map((option) =>
		h('button', { class: option === value ? 'on' : '', role: 'radio', 'aria-checked': String(option === value), onclick: () => onPick(option) }, label(option)),
	);
	el.append(...buttons);
	el.refresh = (v) => buttons.forEach((b, i) => {
		b.classList.toggle('on', options[i] === v);
		b.setAttribute('aria-checked', String(options[i] === v));
	});
	return el;
}

function stepper(text, onDown, onUp, title) {
	const value = h('span', { class: 'value' }, text);
	const el = h('div', { class: 'stepper', title }, h('button', { 'aria-label': 'less', onclick: onDown }, iconEl('minus')), value, h('button', { 'aria-label': 'more', onclick: onUp }, iconEl('plus')));
	el.setText = (t) => (value.textContent = t);
	return el;
}

export class Editor {
	constructor(app) {
		this.app = app;
		this.grid = new Grid(app);
		this.head = h('div', { class: 'editor-head' });
		this.body = h('div', { class: 'editor-body' });
		this.el = h('div', { class: 'panel editor' }, this.head, this.body);
		this.key = '';
		this.binders = [];
		app.subscribe(() => this.render());
		this.render();
	}

	bind(refresh) {
		this.binders.push(refresh);
	}

	render() {
		const app = this.app;
		const layer = app.layer;
		const view = app.view;
		const key = JSON.stringify([
			view,
			layer?.id,
			layer?.engine,
			layer?.color,
			view === 'effects' ? layer?.fx.map((f) => [f.type, f.on]) : 0,
			view === 'pattern' ? [isDrums(layer || {}), layer?.follow] : 0,
			// Some knob labels depend on a choice (the bass model), so a choice change rebuilds.
			view === 'sound' && layer ? INSTRUMENTS[layer.engine].params.filter((q) => q.type === 'choice').map((q) => layer.params[q.id]) : 0,
		]);
		if (key === this.key) {
			for (const refresh of this.binders) refresh();
			if (view === 'pattern') this.grid.draw();
			return;
		}
		this.key = key;
		this.binders = [];
		this.el.style.setProperty('--color', view === 'mix' ? '#f2f2f2' : LAYER_COLORS[layer?.color] || '#fff');
		if (view === 'mix') return this.renderMix();
		if (!layer) return this.renderEmpty();
		this.renderHead(layer);
		if (view === 'sound') this.renderSound(layer);
		else if (view === 'effects') this.renderEffects(layer);
		else this.renderPattern(layer);
	}

	renderEmpty() {
		this.head.replaceChildren(h('div', { class: 'title' }, 'nothing here yet'));
		this.body.replaceChildren(
			h('div', { class: 'section' }, h('p', { class: 'hint', style: { padding: 0 } }, 'add a layer from the list, or press ✦ surprise for a whole new song.')),
		);
	}

	renderHead(layer) {
		const app = this.app;
		const tabs = h(
			'div',
			{ class: 'tabs', role: 'tablist' },
			...['pattern', 'sound', 'effects'].map((tab) =>
				h('button', { class: `tab${app.view === tab ? ' on' : ''}`, role: 'tab', 'aria-selected': String(app.view === tab), onclick: () => app.setView(tab) }, tab),
			),
		);
		const remove = h('button', { class: 'btn small icon', title: 'remove layer', 'aria-label': 'remove layer', onclick: () => app.removeLayer(app.selected) }, iconEl('trash'));
		this.head.replaceChildren(
			h('span', { class: 'dot' }),
			h('span', { class: 'title' }, INSTRUMENTS[layer.engine].name),
			h('span', { class: 'subtitle' }, ROLES[layer.role]?.name || ''),
			tabs,
			h('span', { class: 'spacer' }),
			remove,
		);
	}

	// --- Pattern ---------------------------------------------------------------

	renderPattern(layer) {
		const app = this.app;
		const index = app.selected;
		const drums = isDrums(layer);
		const mutate = (fn, coalesce) => app.change((comp) => fn(comp.layers[index]), { coalesce });
		const rates = seg(STEP_RATES, layer.pattern.rate, (rate) => mutate((l) => (l.pattern.rate = rate)), (r) => RATE_LABELS[r]);
		rates.title = 'steps per beat';
		const length = stepper(
			String(layer.pattern.length),
			() => mutate((l) => resize(l, -1), 'length'),
			() => mutate((l) => resize(l, 1), 'length'),
			'pattern length in steps',
		);
		const octave = stepper(
			octaveText(layer.octave),
			() => mutate((l) => (l.octave = Math.max(-3, l.octave - 1))),
			() => mutate((l) => (l.octave = Math.min(3, l.octave + 1))),
			'move the whole layer by octaves',
		);
		const follow = h(
			'button',
			{
				class: `btn small${layer.follow ? ' on' : ''}`,
				title: 'move with the harmony strip, bar by bar',
				onclick: () => mutate((l) => (l.follow = !l.follow)),
			},
			'follow harmony',
		);
		this.bind(() => {
			const l = app.layer;
			if (!l) return;
			rates.refresh(l.pattern.rate);
			length.setText(String(l.pattern.length));
			octave.setText(octaveText(l.octave));
		});
		const tools = h(
			'div',
			{ class: 'group' },
			h('button', { class: 'btn small', title: 'rotate left', 'aria-label': 'rotate left', onclick: () => mutate((l) => rotate(l, -1)) }, iconEl('left')),
			h('button', { class: 'btn small', title: 'rotate right', 'aria-label': 'rotate right', onclick: () => mutate((l) => rotate(l, 1)) }, iconEl('right')),
			h('button', { class: 'btn small', title: 'clear', onclick: () => mutate((l) => (l.pattern.notes = [])) }, 'clear'),
			h('button', { class: 'btn small', title: 'change a note or two', onclick: () => app.evolveLayer() }, iconEl('evolve'), 'vary'),
			h('button', { class: 'btn small primary', title: 'new pattern', onclick: () => app.newPattern() }, '✦ new pattern'),
		);
		const toolbar = h(
			'div',
			{ class: 'toolbar' },
			h('span', { class: 'label' }, 'steps/beat'),
			rates,
			h('span', { class: 'label' }, 'length'),
			length,
			drums ? null : h('span', { class: 'label' }, 'octave'),
			drums ? null : octave,
			drums ? null : follow,
			h('span', { class: 'spacer' }),
			tools,
		);
		const hint = h(
			'div',
			{ class: 'hint' },
			'click to add · drag to lengthen · click a note to remove · ',
			h('kbd', {}, 'shift'),
			' louder/softer · ',
			h('kbd', {}, 'alt'),
			' sometimes',
			drums ? '' : ' · scroll to move up or down · click a ratio to hear it',
		);
		this.body.replaceChildren(toolbar, this.grid.el, hint);
		requestAnimationFrame(() => this.grid.draw(true));
	}

	// --- Sound -----------------------------------------------------------------

	renderSound(layer) {
		const app = this.app;
		const index = app.selected;
		const def = INSTRUMENTS[layer.engine];
		const drums = isDrums(layer);
		const instruments = h(
			'div',
			{ class: 'instruments' },
			...INSTRUMENT_ORDER.map((id) =>
				h(
					'button',
					{ class: `instrument${id === layer.engine ? ' on' : ''}`, title: INSTRUMENTS[id].about, onclick: () => app.setEngine(index, id) },
					svg(INSTRUMENT_ICONS[id]),
					INSTRUMENTS[id].name,
				),
			),
		);
		const knobs = h('div', { class: 'knobs' });
		// Choices (material, model, kit) come first: they decide what the knobs mean.
		const ordered = [...def.params.filter((q) => q.type === 'choice'), ...def.params.filter((q) => q.type !== 'choice')];
		for (const param of ordered) {
			const labelled = { ...param, label: paramLabel(param, layer.params) };
			knobs.append(this.paramControl(labelled, () => app.layer?.params, (value) => app.change((c) => (c.layers[index].params[param.id] = value), { coalesce: `p:${layer.id}:${param.id}` })));
		}
		const soundSection = h(
			'div',
			{ class: 'section' },
			h(
				'div',
				{ class: 'section-head' },
				h('span', {}, def.name),
				h('span', { class: 'about' }, def.about),
				h('span', { class: 'spacer' }),
				h('button', { class: 'btn small primary', onclick: () => app.newSound() }, '✦ new sound'),
			),
			knobs,
		);
		const mix = h('div', { class: 'knobs' });
		for (const param of MIX_PARAMS) {
			if (param.id === 'gate' && drums) continue;
			mix.append(this.paramControl(param, () => app.layer, (value) => app.change((c) => (c.layers[index][param.id] = value), { coalesce: `m:${layer.id}:${param.id}` })));
		}
		const mixSection = h('div', { class: 'section' }, h('div', { class: 'section-head' }, 'level and sends'), mix);
		this.body.replaceChildren(instruments, soundSection, mixSection);
	}

	// A knob or a segmented choice bound to `source()[param.id]`.
	paramControl(param, source, set) {
		if (param.type === 'choice') {
			const control = seg(param.options, source()?.[param.id], set);
			this.bind(() => control.refresh(source()?.[param.id]));
			return h('div', { class: 'choice' }, h('span', { class: 'label' }, param.label), control);
		}
		const knob = new Knob({ param, value: source()?.[param.id] ?? param.default, onInput: set });
		this.bind(() => {
			const v = source()?.[param.id];
			if (v !== undefined) knob.setValue(v);
		});
		return knob.el;
	}

	// --- Effects -----------------------------------------------------------------

	renderEffects(layer) {
		const app = this.app;
		const index = app.selected;
		const list = h('div', { class: 'fx-list' });
		layer.fx.forEach((fx, i) => {
			const def = EFFECTS[fx.type];
			const knobs = h('div', { class: 'knobs' });
			for (const param of def.params) {
				knobs.append(
					this.paramControl(
						param,
						() => app.layer?.fx[i]?.params,
						(value) => app.change((c) => (c.layers[index].fx[i].params[param.id] = value), { coalesce: `fx:${layer.id}:${i}:${param.id}` }),
					),
				);
			}
			const move = (dir) =>
				app.change((c) => {
					const fxs = c.layers[index].fx;
					const j = i + dir;
					if (j < 0 || j >= fxs.length) return;
					[fxs[i], fxs[j]] = [fxs[j], fxs[i]];
				});
			list.append(
				h(
					'div',
					{ class: `fx${fx.on ? '' : ' off'}` },
					h(
						'div',
						{ class: 'fx-head' },
						h('button', { class: `toggle${fx.on ? ' on' : ''}`, title: fx.on ? 'turn off' : 'turn on', 'aria-pressed': String(fx.on), onclick: () => app.change((c) => (c.layers[index].fx[i].on = !fx.on)) }, svg('<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 4v7"/><path d="M7 7.5a7 7 0 1 0 10 0"/></svg>')),
						h('span', { class: 'name' }, def.name),
						h('button', { class: 'btn small icon', title: '✦ new settings', onclick: () => app.change((c) => (c.layers[index].fx[i].params = { ...effectDefaults(fx.type), ...randomEffectParams(fx.type, new Rng()) })) }, '✦'),
						i > 0 ? h('button', { class: 'btn small icon', title: 'move earlier', 'aria-label': 'move earlier', onclick: () => move(-1) }, iconEl('left')) : null,
						i < layer.fx.length - 1 ? h('button', { class: 'btn small icon', title: 'move later', 'aria-label': 'move later', onclick: () => move(1) }, iconEl('right')) : null,
						h('button', { class: 'btn small icon', title: 'remove', 'aria-label': 'remove effect', onclick: () => app.change((c) => c.layers[index].fx.splice(i, 1)) }, iconEl('close')),
					),
					h('div', { class: 'fx-about' }, def.about),
					knobs,
				),
			);
		});
		if (layer.fx.length < MAX_FX) {
			const add = h('button', { class: 'fx fx-add btn', style: { height: 'auto', padding: '18px', borderRadius: '14px' } }, iconEl('plus'), 'add effect');
			add.addEventListener('click', () => {
				const items = EFFECT_ORDER.map((type) =>
					h(
						'button',
						{
							class: 'menu-item',
							onclick: () => {
								closePopover();
								app.change((c) => c.layers[index].fx.push(newEffect(type)));
							},
						},
						EFFECTS[type].name,
						h('small', {}, EFFECTS[type].about),
					),
				);
				popover(add, [h('div', { class: 'heading' }, `effects run in order, left to right`), ...items]);
			});
			list.append(add);
		}
		this.body.replaceChildren(list, h('div', { class: 'hint' }, 'the shared space and echo are under “space & mix”.'));
	}

	// --- Mix ---------------------------------------------------------------------

	renderMix() {
		const app = this.app;
		this.head.replaceChildren(h('span', { class: 'title' }, 'space & mix'), h('span', { class: 'subtitle' }, 'shared by every layer'));
		const knobRow = (params, source, write) => {
			const row = h('div', { class: 'knobs' });
			for (const param of params) row.append(this.paramControl(param, source, (value) => app.change((c) => write(c, param.id, value), { coalesce: `mix:${param.id}` })));
			return row;
		};
		const space = knobRow(
			[
				{ id: 'size', label: 'size', min: 0, max: 1, default: 0.55 },
				{ id: 'tone', label: 'tone', min: 0, max: 1, default: 0.5 },
			],
			() => app.comp.space,
			(c, id, v) => (c.space[id] = v),
		);
		const echoTime = seg(
			ECHO_TIMES.map((_, i) => i),
			app.comp.echo.time,
			(i) => app.change((c) => (c.echo.time = i)),
			(i) => ECHO_TIMES[i].label,
		);
		this.bind(() => echoTime.refresh(app.comp.echo.time));
		const echo = knobRow(
			[
				{ id: 'feedback', label: 'repeats', min: 0, max: 0.85, default: 0.35 },
				{ id: 'tone', label: 'tone', min: 0, max: 1, default: 0.45 },
			],
			() => app.comp.echo,
			(c, id, v) => (c.echo[id] = v),
		);
		const groove = knobRow([{ id: 'swing', label: 'swing', min: 0, max: 0.6, default: 0 }], () => app.comp, (c, id, v) => (c.swing = v));
		// The output always peaks at -0.3 dBFS; loudness is how hard the master pushes into its limiter.
		const master = knobRow([{ id: 'volume', label: 'loudness', min: 0, max: 1, default: 0.85 }], () => app.comp.master, (c, id, v) => (c.master.volume = v));
		this.body.replaceChildren(
			h('div', { class: 'mix-grid' },
			h('div', { class: 'section' }, h('div', { class: 'section-head' }, 'space', h('span', { class: 'about' }, 'a reverb every layer can send to')), space),
			h(
				'div',
				{ class: 'section' },
				h('div', { class: 'section-head' }, 'echo', h('span', { class: 'about' }, 'repeats in time with the beat; every echo time is a harmonic rate')),
				h('div', { class: 'choice', style: { marginBottom: '14px' } }, h('span', { class: 'label' }, 'time'), echoTime),
				echo,
			),
			h('div', { class: 'section' }, h('div', { class: 'section-head' }, 'groove'), groove),
			h('div', { class: 'section' }, h('div', { class: 'section-head' }, 'master', h('span', { class: 'about' }, 'always peaks at -0.3 dB; louder pushes harder into the limiter')), master),
			),
		);
	}
}

function octaveText(octave) {
	return octave === 0 ? '0' : octave > 0 ? `+${octave}` : String(octave);
}

function resize(layer, dir) {
	const pattern = layer.pattern;
	const length = Math.max(1, Math.min(MAX_STEPS, pattern.length + dir));
	pattern.length = length;
	pattern.notes = pattern.notes.filter((n) => n[0] < length).map((n) => [n[0], n[1], Math.min(n[2], length - n[0]), n[3], n[4]]);
}

function rotate(layer, dir) {
	const { length } = layer.pattern;
	layer.pattern.notes = layer.pattern.notes.map((n) => [(n[0] + dir + length) % length, n[1], n[2], n[3], n[4]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
