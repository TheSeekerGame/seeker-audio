// Entry point: picks the first song (shared link, last session, or a gentle
// default), builds the interface, and wires the keyboard.

import { App } from './app.js';
import { Top } from './ui/top.js';
import { Field } from './ui/field.js';
import { Layers } from './ui/layers.js';
import { Editor } from './ui/editor.js';
import { h, toast } from './ui/dom.js';
import { generateComposition } from './generate.js';
import { decode, payloadFromHash } from './share.js';
import { loadCurrent } from './storage.js';

// A calm first song: a pad drone, bells, and a grain cloud in the Seeker mood.
const FIRST_SONG = { seed: 595403, style: 'ambient' };

async function initialSong() {
	const payload = payloadFromHash();
	if (payload) {
		try {
			return { comp: await decode(payload), from: 'link' };
		} catch {
			toast('that link could not be read — here is a fresh song');
		}
	}
	const saved = loadCurrent();
	if (saved) {
		try {
			return { comp: await decode(saved), from: 'saved' };
		} catch {
			// Fall through to a new song.
		}
	}
	return { comp: generateComposition(FIRST_SONG.seed, FIRST_SONG.style), from: 'new' };
}

function linkMessage(comp) {
	return comp.outdated
		? 'this link was made with an earlier SEEKER — it may sound a little different'
		: 'song loaded from a link — press play';
}

// Physical key positions, so the layout works on any keyboard language.
const KEY_ROWS = [
	['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'],
	['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'],
	['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP'],
];

function keyRow(code, paletteLength) {
	for (let r = 0; r < KEY_ROWS.length; r++) {
		const c = KEY_ROWS[r].indexOf(code);
		if (c >= 0) return r * paletteLength + c;
	}
	return null;
}

function typing(event) {
	const t = event.target;
	return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable || !!document.querySelector('.scrim');
}

function bindKeyboard(app) {
	const held = new Map();
	document.addEventListener('keydown', (event) => {
		if (typing(event)) return;
		const mod = event.metaKey || event.ctrlKey;
		if (mod && event.code === 'KeyZ') {
			event.preventDefault();
			event.shiftKey ? app.redo() : app.undo();
			return;
		}
		if (mod || event.altKey) return;
		if (event.code === 'Space') {
			event.preventDefault();
			app.togglePlay();
			return;
		}
		if (/^Digit[1-8]$/.test(event.code)) {
			const index = Number(event.code.slice(5)) - 1;
			if (index < app.comp.layers.length) app.select(index);
			return;
		}
		const row = keyRow(event.code, app.comp.palette.length);
		if (row === null || event.repeat || held.has(event.code)) return;
		const index = app.liveLayerIndex();
		if (index < 0) return;
		const key = 5000 + held.size + KEY_ROWS.flat().indexOf(event.code) * 8;
		held.set(event.code, { key, index });
		app.liveNote(row, key, true, index);
	});
	document.addEventListener('keyup', (event) => {
		const note = held.get(event.code);
		if (!note) return;
		held.delete(event.code);
		app.liveNote(0, note.key, false, note.index);
	});
	window.addEventListener('blur', () => {
		for (const note of held.values()) app.liveNote(0, note.key, false, note.index);
		held.clear();
	});
}

async function boot() {
	const { comp, from } = await initialSong();
	const app = new App(comp);
	const top = new Top(app);
	const field = new Field(app);
	const layers = new Layers(app);
	const editor = new Editor(app);
	const root = document.getElementById('app');
	root.replaceChildren(top.el, h('main', { class: 'main' }, field.el, layers.el, editor.el));
	app.notify();
	bindKeyboard(app);

	if (from === 'link') {
		toast(linkMessage(comp));
		// From here on the song lives in this browser; a reload keeps your edits.
		history.replaceState(null, '', location.pathname + location.search);
	}

	// Audio can only start inside a user gesture; prepare it on the first touch.
	const warm = () => app.ensureAudio().catch(() => {});
	document.addEventListener('pointerdown', warm, { once: true, capture: true });
	document.addEventListener('keydown', warm, { once: true, capture: true });

	window.addEventListener('hashchange', async () => {
		const payload = payloadFromHash();
		if (!payload) return;
		try {
			const comp = await decode(payload);
			app.load(comp);
			history.replaceState(null, '', location.pathname + location.search);
			toast(linkMessage(comp));
		} catch {
			toast('that link could not be read');
		}
	});
	window.seeker = app;
}

boot();
