// The top bar: song name, the main path (play, ✦ surprise and its style,
// share), undo, record, the library menu, and the song's tempo, root, mood,
// and harmony. On phones the main path becomes a dock at the bottom of the
// screen, under the thumb.

import { h, iconEl, svg, ICONS, popover, closePopover, modal, toast } from './dom.js';
import { TEMPOS, tempoIndex, tempoLabel, rootHz, ROOT_OCTAVES, indexRatio, ratioLabel } from '../tuning.js';
import { MOODS } from '../moods.js';
import { changePalette, moodFor, MAX_BARS } from '../state.js';
import { STYLES, STYLE_ORDER, generateHarmony } from '../generate.js';
import { Rng } from '../rng.js';
import { encode, encodeStored, decode, songUrl, xIntentUrl } from '../share.js';
import { library, saveToLibrary, removeFromLibrary } from '../storage.js';
import { openPaletteEditor } from './palette.js';
import { openStemsDialog } from './stems.js';

export class Top {
	constructor(app) {
		this.app = app;
		this.name = h('input', {
			class: 'song-name',
			type: 'text',
			'aria-label': 'song name',
			spellcheck: false,
			maxlength: 60,
			onchange: () => app.change((c) => (c.name = this.name.value.trim() || 'untitled')),
			onkeydown: (event) => event.key === 'Enter' && this.name.blur(),
		});
		this.play = h('button', { class: 'play-btn', title: 'play / stop (space)', 'aria-label': 'play', onclick: () => app.togglePlay() }, svg(ICONS.play));
		this.evolve = h(
			'button',
			{
				class: 'btn small',
				title: 'evolve: every four bars, one layer changes a little',
				onclick: () => {
					app.evolve = !app.evolve;
					app.notify();
				},
			},
			iconEl('evolve'),
			'evolve',
		);
		this.tempo = this.makeTempo();
		this.root = this.makeRoot();
		this.mood = h('button', { class: 'btn select', title: 'mood: which harmonics the song uses', onclick: () => this.openMood() });
		this.harmony = h('div', { class: 'harmony', title: 'harmony: each bar shifts the following layers along the palette' });
		this.surprise = h('button', { class: 'btn primary surprise', title: 'a whole new song', onclick: () => app.surprise() }, '✦ surprise');
		this.style = h('button', { class: 'btn select style', title: 'style for surprises', onclick: () => this.openStyle() });
		this.undo = h('button', { class: 'btn icon', title: 'undo (⌘Z)', 'aria-label': 'undo', onclick: () => app.undo() }, iconEl('undo'));
		this.redo = h('button', { class: 'btn icon', title: 'redo (⇧⌘Z)', 'aria-label': 'redo', onclick: () => app.redo() }, iconEl('redo'));
		this.rec = h('button', { class: 'btn rec', title: 'record what you hear to a WAV file', onclick: () => this.toggleRecord() }, iconEl('rec'), h('span', { class: 'wide' }, 'rec'));
		this.share = h('button', { class: 'btn share', title: 'share a link to this song', onclick: () => this.openShare() }, iconEl('share'), h('span', {}, 'share'));
		// The next step on the main path, said in a few words (shown in the phone dock).
		this.caption = h('div', { class: 'hero-caption', 'aria-live': 'polite' });
		this.hero = h('div', { class: 'hero' }, this.play, this.surprise, this.style, this.share, this.caption);
		this.menu = h('button', { class: 'btn icon', title: 'songs and help', 'aria-label': 'menu', onclick: () => this.openMenu() }, iconEl('menu'));
		this.meter = h('div', { class: 'out-meter', title: 'output level' }, h('i'), h('i'));
		this.el = h(
			'header',
			{ class: 'top' },
			h('div', { class: 'top-identity' }, h('div', { class: 'brand', title: 'every note is a harmonic of 48 Hz' }, h('b', {}, 'SEEKER'), h('small', {}, '48 hz')), this.name),
			this.hero,
			h('div', { class: 'top-utility' }, this.undo, this.redo, this.rec, this.menu),
			h('div', { class: 'top-transport' }, this.tempo, this.root, this.mood, this.harmony, this.evolve, this.meter),
		);
		app.audio.on('meter', (m) => this.showMeter(m));
		this.harmonyKey = '';
		app.subscribe(() => this.render());
		app.audio.on('tick', (tick) => this.highlightBar(tick));
		this.render();
		setInterval(() => this.recordClock(), 250);
	}

	showMeter({ l, r }) {
		const [left, right] = this.meter.children;
		// Peak level on a decibel scale from -48 dB to 0.
		const scale = (v) => Math.max(0, Math.min(1, 1 + (20 * Math.log10(Math.max(v, 1e-5))) / 48));
		left.style.transform = `scaleX(${scale(l).toFixed(3)})`;
		right.style.transform = `scaleX(${scale(r).toFixed(3)})`;
	}

	render() {
		const { comp, audio } = this.app;
		if (document.activeElement !== this.name) this.name.value = comp.name;
		this.play.classList.toggle('on', audio.playing);
		this.play.replaceChildren(svg(audio.playing ? ICONS.stop : ICONS.play));
		this.play.setAttribute('aria-label', audio.playing ? 'stop' : 'play');
		this.evolve.classList.toggle('on', this.app.evolve);
		this.tempo.setText(comp.tempo);
		this.root.setText(comp.root);
		const mood = moodFor(comp.palette);
		this.mood.replaceChildren(h('span', {}, mood ? mood.name : 'custom'), svg(ICONS.caret));
		this.mood.querySelector('svg').classList.add('caret');
		this.style.replaceChildren(h('span', {}, this.app.style ? STYLES[this.app.style].name : 'any style'), svg(ICONS.caret));
		this.style.querySelector('svg').classList.add('caret');
		this.undo.disabled = !this.app.history.length;
		this.redo.disabled = !this.app.future.length;
		const { step, caption } = this.app.flow;
		this.play.classList.toggle('invite', step === 'play');
		this.surprise.classList.toggle('invite', step === 'surprise');
		this.share.classList.toggle('invite', step === 'share');
		if (this.caption.textContent !== caption) this.caption.textContent = caption;
		this.renderHarmony();
	}

	makeTempo() {
		const app = this.app;
		const step = (dir) => {
			const i = Math.max(0, Math.min(TEMPOS.length - 1, tempoIndex(app.comp.tempo) + dir));
			app.change((c) => (c.tempo = [TEMPOS[i].x, TEMPOS[i].n]), { coalesce: 'tempo' });
		};
		const value = h('span', { class: 'value', title: 'tempo: every tempo is a harmonic rate of 48 Hz — drag or click' });
		const el = h('div', { class: 'stepper' }, h('button', { 'aria-label': 'slower', onclick: () => step(-1) }, iconEl('left')), value, h('button', { 'aria-label': 'faster', onclick: () => step(1) }, iconEl('right')));
		// Drag the number up or down to scrub through tempos.
		let startY = null;
		let moved = false;
		value.addEventListener('pointerdown', (event) => {
			startY = event.clientY;
			moved = false;
			value.setPointerCapture(event.pointerId);
		});
		value.addEventListener('pointermove', (event) => {
			if (startY === null) return;
			const steps = Math.trunc((startY - event.clientY) / 8);
			if (steps) {
				moved = true;
				startY = event.clientY;
				step(steps);
			}
		});
		value.addEventListener('pointerup', () => {
			if (!moved) this.openTempo(el);
			startY = null;
		});
		el.setText = (tempo) => {
			value.replaceChildren(tempoLabel(tempo), h('small', {}, 'bpm'));
		};
		return el;
	}

	openTempo(anchor) {
		const app = this.app;
		const current = tempoIndex(app.comp.tempo);
		const items = TEMPOS.map((t, i) => {
			const beatHz = `48 × ${t.x}/${2 ** t.n}`;
			return h(
				'button',
				{
					class: `menu-item${i === current ? ' on' : ''}`,
					onclick: () => {
						closePopover();
						app.change((c) => (c.tempo = [t.x, t.n]));
					},
				},
				`${tempoLabel([t.x, t.n])} bpm`,
				h('small', {}, `one beat per ${beatHz} Hz`),
			);
		});
		const el = popover(anchor, [h('div', { class: 'heading' }, 'tempos that are harmonic rates of 48 Hz'), ...items]);
		el?.querySelector('.on')?.scrollIntoView({ block: 'center' });
	}

	makeRoot() {
		const app = this.app;
		const step = (dir) => {
			const i = ROOT_OCTAVES.indexOf(app.comp.root) + dir;
			if (i < 0 || i >= ROOT_OCTAVES.length) return;
			app.change((c) => (c.root = ROOT_OCTAVES[i]));
		};
		const value = h('span', { class: 'value', style: { cursor: 'default' }, title: 'root: 48 Hz or one of its octaves' });
		const el = h('div', { class: 'stepper' }, h('button', { 'aria-label': 'octave down', title: '÷2', onclick: () => step(-1) }, '÷2'), value, h('button', { 'aria-label': 'octave up', title: '×2', onclick: () => step(1) }, '×2'));
		el.setText = (root) => value.replaceChildren(String(rootHz(root)), h('small', {}, 'hz'));
		return el;
	}

	openMood() {
		const app = this.app;
		const current = moodFor(app.comp.palette);
		const items = MOODS.map((mood) =>
			h(
				'button',
				{
					class: `menu-item${current?.id === mood.id ? ' on' : ''}`,
					onclick: () => {
						closePopover();
						app.change((c) => changePalette(c, mood.harmonics));
					},
				},
				mood.name,
				h('small', {}, mood.about),
			),
		);
		popover(this.mood, [
			h('div', { class: 'heading' }, 'mood — the harmonics your song uses'),
			...items,
			h('div', { class: 'sep' }),
			h(
				'button',
				{
					class: 'menu-item',
					onclick: () => {
						closePopover();
						openPaletteEditor(app);
					},
				},
				'choose harmonics…',
				h('small', {}, 'build your own palette on the harmonic circle'),
			),
		]);
	}

	openStyle() {
		const app = this.app;
		const options = [null, ...STYLE_ORDER];
		popover(
			this.style,
			[
				h('div', { class: 'heading' }, 'style for ✦ surprise'),
				...options.map((id) =>
					h(
						'button',
						{
							class: `menu-item${app.style === id ? ' on' : ''}`,
							onclick: () => {
								closePopover();
								app.style = id;
								app.surprise(id);
							},
						},
						id ? STYLES[id].name : 'any style',
					),
				),
			],
			{ align: 'end' },
		);
	}

	// --- Harmony strip ---------------------------------------------------------

	renderHarmony() {
		const { comp } = this.app;
		const key = JSON.stringify([comp.harmony, comp.palette]);
		if (key === this.harmonyKey) return;
		this.harmonyKey = key;
		const app = this.app;
		this.cells = comp.harmony.map((shift, bar) => {
			const cell = h('button', { class: 'cell', title: `bar ${bar + 1}`, onclick: () => this.openShift(cell, bar) }, ratioLabel(indexRatio(comp.palette, shift)));
			return cell;
		});
		const mini = (label, title, fn, disabled) => h('button', { class: 'mini', title, 'aria-label': title, disabled, onclick: fn }, label);
		this.harmony.replaceChildren(
			h('span', { class: 'label wide' }, 'harmony'),
			...this.cells,
			mini('−', 'one bar fewer', () => app.change((c) => c.harmony.length > 1 && c.harmony.pop()), comp.harmony.length <= 1),
			mini('+', 'one bar more', () => app.change((c) => c.harmony.length < MAX_BARS && c.harmony.push(0)), comp.harmony.length >= MAX_BARS),
			mini('✦', 'new harmony', () => app.change((c) => (c.harmony = generateHarmony(c, new Rng())))),
		);
	}

	openShift(cell, bar) {
		const app = this.app;
		const { palette, harmony } = app.comp;
		const n = palette.length;
		const options = [];
		for (let s = -(n - 1); s <= n - 1; s++) options.push(s);
		popover(cell, [
			h('div', { class: 'heading' }, `bar ${bar + 1}: move the harmony to…`),
			h(
				'div',
				{ class: 'row' },
				...options.map((s) =>
					h(
						'button',
						{
							class: `btn small${harmony[bar] === s ? ' on' : ''}`,
							onclick: () => {
								closePopover();
								app.change((c) => (c.harmony[bar] = s));
							},
						},
						ratioLabel(indexRatio(palette, s)),
					),
				),
			),
		]);
	}

	highlightBar(tick) {
		if (!this.cells) return;
		const bars = this.app.comp.harmony.length;
		const now = tick.playing ? Math.floor(this.app.audio.beatNow() / 4) % bars : -1;
		this.cells.forEach((cell, i) => cell.classList.toggle('now', i === now));
	}

	// --- Recording -------------------------------------------------------------

	async toggleRecord() {
		const app = this.app;
		const recorder = app.recorder;
		if (!recorder.recording) {
			await app.ensureAudio();
			if (!app.audio.playing) await app.togglePlay(true);
			recorder.start();
			this.rec.classList.add('on');
			return;
		}
		this.rec.classList.remove('on');
		this.rec.querySelector('span').textContent = 'rec';
		const blob = await recorder.stop();
		if (blob) this.showRecording(blob);
	}

	recordClock() {
		const recorder = this.app.recorder;
		if (!recorder.recording) return;
		const s = Math.floor(recorder.seconds);
		this.rec.querySelector('span').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	}

	showRecording(blob) {
		const url = URL.createObjectURL(blob);
		const name = `${slug(this.app.comp.name)}.wav`;
		const seconds = (blob.size - 44) / 4 / this.app.audio.ctx.sampleRate;
		const download = h('a', { class: 'btn primary', href: url, download: name }, iconEl('download'), 'download wav');
		const { close } = modal(
			[
				h('h2', {}, 'recording ready'),
				h('p', {}, `${seconds.toFixed(1)} seconds of “${this.app.comp.name}”, 48 kHz stereo WAV.`),
				h('audio', { controls: true, src: url }),
				h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => close() }, 'close'), download),
			],
			{ onClose: () => setTimeout(() => URL.revokeObjectURL(url), 60000) },
		);
	}

	// --- Sharing ---------------------------------------------------------------

	async openShare() {
		const app = this.app;
		app.flow.shared();
		app.notify();
		const url = songUrl(await encode(app.comp));
		const copy = async () => {
			try {
				await navigator.clipboard.writeText(url);
				toast('link copied');
			} catch {
				toast('select the link and copy it');
			}
		};
		const actions = [
			h('a', { class: 'btn primary', href: xIntentUrl(url), target: '_blank', rel: 'noopener' }, svg(ICONS.x), 'post on X'),
			h('button', { class: 'btn', onclick: copy }, iconEl('copy'), 'copy link'),
		];
		if (navigator.share) {
			actions.push(
				h(
					'button',
					{ class: 'btn', onclick: () => navigator.share({ title: `${app.comp.name} — SEEKER`, text: 'a song where every note is a harmonic of 48 Hz', url }).catch(() => {}) },
					iconEl('share'),
					'more…',
				),
			);
		}
		modal([
			h('h2', {}, 'share this song'),
			h('p', {}, 'The link holds the whole song — every note, sound, and effect. Anyone who opens it hears exactly this, and can change it.'),
			h('div', { class: 'link-box' }, h('code', {}, url), h('button', { class: 'btn small', onclick: copy }, 'copy')),
			h('div', { class: 'actions', style: { justifyContent: 'flex-start' } }, ...actions),
		]);
	}

	// --- Library and help ------------------------------------------------------

	openMenu() {
		const app = this.app;
		const saved = library();
		const items = [
			h(
				'button',
				{
					class: 'menu-item',
					onclick: () => {
						closePopover();
						this.saveDialog();
					},
				},
				'save to this browser…',
				h('small', {}, 'keep this song in your library'),
			),
			h(
				'button',
				{
					class: 'menu-item',
					onclick: () => {
						closePopover();
						app.load({ name: 'untitled', palette: app.comp.palette, root: app.comp.root, tempo: app.comp.tempo, layers: [] });
					},
				},
				'new empty song',
				h('small', {}, 'start from silence'),
			),
			h(
				'button',
				{
					class: 'menu-item',
					disabled: !app.comp.layers.length,
					onclick: () => {
						closePopover();
						openStemsDialog(app);
					},
				},
				'export stems…',
				h('small', {}, 'each layer as its own WAV, for your DAW'),
			),
		];
		if (saved.length) {
			items.push(h('div', { class: 'sep' }), h('div', { class: 'heading' }, 'your songs'));
			for (const song of saved) {
				items.push(
					h(
						'div',
						{ style: { display: 'flex', alignItems: 'center', gap: '4px' } },
						h(
							'button',
							{
								class: 'menu-item',
								onclick: async () => {
									closePopover();
									try {
										app.load(await decode(song.payload));
									} catch {
										toast('that song could not be opened');
									}
								},
							},
							song.name,
							h('small', {}, new Date(song.saved).toLocaleDateString()),
						),
						h(
							'button',
							{
								class: 'btn small icon',
								title: 'delete',
								'aria-label': `delete ${song.name}`,
								onclick: () => {
									removeFromLibrary(song.id);
									closePopover();
									this.openMenu();
								},
							},
							iconEl('close'),
						),
					),
				);
			}
		}
		items.push(
			h('div', { class: 'sep' }),
			h(
				'button',
				{
					class: 'menu-item',
					onclick: () => {
						closePopover();
						openAbout();
					},
				},
				'about the tuning',
				h('small', {}, 'why every note is a harmonic of 48 Hz'),
			),
			h(
				'button',
				{
					class: 'menu-item',
					onclick: () => {
						closePopover();
						openShortcuts();
					},
				},
				'keyboard',
				h('small', {}, 'play notes and control the song from the keyboard'),
			),
		);
		popover(this.menu, items, { align: 'end' });
	}

	saveDialog() {
		const app = this.app;
		const input = h('input', { type: 'text', value: app.comp.name, maxlength: 60, 'aria-label': 'name' });
		const save = async () => {
			const name = input.value.trim() || app.comp.name;
			app.change((c) => (c.name = name));
			saveToLibrary(name, await encodeStored(app.comp));
			close();
			toast(`saved “${name}”`);
		};
		input.addEventListener('keydown', (event) => event.key === 'Enter' && save());
		const { close } = modal([
			h('h2', {}, 'save to this browser'),
			h('p', {}, 'Saved songs live in this browser only. To keep a song anywhere, share its link.'),
			input,
			h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => close() }, 'cancel'), h('button', { class: 'btn primary', onclick: save }, 'save')),
		]);
		input.select();
	}
}

function slug(text) {
	return (text || 'seeker').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'seeker';
}

export function openAbout() {
	let close = null;
	({ close } = modal([
		h('h2', {}, 'every note is a harmonic of 48 Hz'),
		h(
			'p',
			{},
			'SEEKER plays only pitches of the form 48 Hz × X / 2ⁿ — whole-number harmonics of 48 Hz and its lower octaves, folded into whatever octave you need. 9/8, 19/16, and 7/4 belong; ratios like 4/3 or 6/5, whose denominators are not powers of two, do not.',
		),
		h(
			'p',
			{},
			'Because every pitch belongs to one harmonic series, everything you place agrees with everything else. Moods choose which harmonics a song uses; the root can move only by whole octaves (48, 96, 192, 384 Hz).',
		),
		h('p', {}, 'Time follows the same rule: tempos, echo times, and modulation rates are all 48 Hz × X / 2ⁿ. At 90 BPM a beat is exactly 1/32 of 48 Hz.'),
		h(
			'p',
			{},
			'SEEKER is part of The Seeker and is free and open source (MIT or Apache-2.0). ',
			h('a', { href: 'https://github.com/TheSeekerGame/seeker-audio', target: '_blank', rel: 'noopener', style: { color: 'var(--text)' } }, 'Source on GitHub'),
			'.',
		),
		h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => close() }, 'close')),
	]));
}

export function openShortcuts() {
	const row = (keys, what) => h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '16px', padding: '5px 0', borderBottom: '1px solid var(--line)' } }, h('span', { style: { color: 'var(--text)' } }, keys), h('span', { style: { color: 'var(--muted)' } }, what));
	let close = null;
	({ close } = modal([
		h('h2', {}, 'keyboard'),
		row('space', 'play / stop'),
		row('z x c v b n m , . /', 'play notes, lowest octave'),
		row('a s d f g h j k l ;', 'play notes, one octave up'),
		row('q w e r t y u i o p', 'play notes, two octaves up'),
		row('⌘Z  /  ⇧⌘Z', 'undo / redo'),
		row('1 – 8', 'select a layer'),
		h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => close() }, 'close')),
	]));
}
