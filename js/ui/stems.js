// The stem export dialog: choose a length, the layers, and whether space and
// echo come as their own stems; then render offline and download one ZIP.

import { h, modal, iconEl } from './dom.js';
import { cycleBars, stemSeconds, stemName, renderStems } from '../audio/stems.js';
import { audibleLayers, LAYER_COLORS } from '../state.js';
import { tempoBpm } from '../tuning.js';

function slug(text) {
	return (text || 'seeker').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'seeker';
}

function choice(options, value, onPick) {
	const el = h('div', { class: 'seg', role: 'radiogroup' });
	const buttons = options.map(([v, label]) =>
		h(
			'button',
			{
				class: v === value ? 'on' : '',
				role: 'radio',
				'aria-checked': String(v === value),
				onclick: () => {
					buttons.forEach((b, i) => {
						b.classList.toggle('on', options[i][0] === v);
						b.setAttribute('aria-checked', String(options[i][0] === v));
					});
					onPick(v);
				},
			},
			label,
		),
	);
	el.append(...buttons);
	return el;
}

export function openStemsDialog(app) {
	const comp = JSON.parse(JSON.stringify(app.comp));
	if (!comp.layers.length) return;
	const cycle = cycleBars(comp);
	const lengths = [[cycle, `full cycle · ${cycle} bar${cycle === 1 ? '' : 's'}`]];
	for (const bars of [8, 16, 32]) if (bars !== cycle) lengths.push([bars, `${bars} bars`]);
	const state = {
		// A full cycle when it is a sensible length; very short or very long cycles default to 8 or 16 bars.
		bars: cycle < 4 ? 8 : cycle > 32 ? 16 : cycle,
		layers: new Set(audibleLayers(comp).flatMap((on, i) => (on ? [i] : []))),
		returns: true,
	};
	if (!state.layers.size) comp.layers.forEach((_, i) => state.layers.add(i));

	const duration = h('div', { class: 'hint', style: { padding: '6px 0 0' } });
	const files = h('div', { class: 'stem-files' });
	const button = h('button', { class: 'btn primary' }, 'render stems');
	const progress = h('div', { class: 'progress', hidden: true }, h('i'));
	const status = h('p', { style: { margin: '10px 0 0' } });

	const refresh = () => {
		const seconds = stemSeconds(comp, state.bars);
		duration.textContent = `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')} at ${+tempoBpm(comp.tempo).toFixed(3)} BPM, plus 4 s for tails`;
		const chosen = [...state.layers].sort((a, b) => a - b);
		const names = chosen.map((index, slot) => stemName(comp, index, slot));
		if (state.returns) names.push(`${String(chosen.length + 1).padStart(2, '0')} space (reverb return).wav`, `${String(chosen.length + 2).padStart(2, '0')} echo (delay return).wav`);
		files.textContent = names.length ? `${names.length} files: ${names.join(' · ')}` : 'choose at least one layer';
		button.disabled = !chosen.length;
	};

	const layerRows = comp.layers.map((layer, index) => {
		const row = h(
			'button',
			{
				class: `check${state.layers.has(index) ? ' on' : ''}`,
				role: 'checkbox',
				'aria-checked': String(state.layers.has(index)),
				style: { '--color': LAYER_COLORS[layer.color] },
				onclick: () => {
					state.layers.has(index) ? state.layers.delete(index) : state.layers.add(index);
					row.classList.toggle('on', state.layers.has(index));
					row.setAttribute('aria-checked', String(state.layers.has(index)));
					refresh();
				},
			},
			h('span', { class: 'box' }),
			h('span', { class: 'swatch' }),
			stemName(comp, index, index).replace(/^\d+ /, '').replace(/\.wav$/, ''),
		);
		return row;
	});

	let rendering = false;
	button.addEventListener('click', async () => {
		if (rendering) return;
		rendering = true;
		button.disabled = true;
		button.textContent = 'rendering…';
		progress.hidden = false;
		status.textContent = 'Rendering silently, faster than real time. This can take a few seconds.';
		try {
			const result = await renderStems(comp, {
				bars: state.bars,
				layers: [...state.layers].sort((a, b) => a - b),
				returns: state.returns,
				trims: await app.balancer.complete(comp),
				onProgress: (p) => (progress.firstChild.style.transform = `scaleX(${p})`),
			});
			const url = URL.createObjectURL(result.blob);
			const name = `${slug(comp.name)}-stems.zip`;
			const mb = (result.blob.size / 1048576).toFixed(1);
			status.textContent = `${result.names.length} stems ready · ${mb} MB`;
			const download = h('a', { class: 'btn primary', href: url, download: name }, iconEl('download'), 'download zip');
			button.replaceWith(download);
			download.click();
		} catch (error) {
			status.textContent = `Rendering failed: ${error.message}`;
			button.disabled = false;
			button.textContent = 'try again';
			rendering = false;
		}
	});

	const { close } = modal([
		h('h2', {}, 'export stems'),
		h('p', {}, 'Each layer as its own 24-bit WAV, with its own effects. Every file starts on bar 1 and has the same length, so they line up in any DAW.'),
		h('div', { class: 'field-row' }, h('span', { class: 'label' }, 'length'), h('div', {}, choice(lengths, state.bars, (v) => ((state.bars = v), refresh())), duration)),
		h('div', { class: 'field-row' }, h('span', { class: 'label' }, 'layers'), h('div', { class: 'checks' }, ...layerRows)),
		h(
			'div',
			{ class: 'field-row' },
			h('span', { class: 'label' }, 'space & echo'),
			h(
				'div',
				{},
				choice(
					[
						[true, 'as two extra stems'],
						[false, 'leave out (dry)'],
					],
					state.returns,
					(v) => ((state.returns = v), refresh()),
				),
				h('div', { class: 'hint', style: { padding: '6px 0 0' } }, 'with the extra stems, everything adds up to the song'),
			),
		),
		files,
		progress,
		status,
		h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => close() }, 'close'), button),
	]);
	refresh();
}
