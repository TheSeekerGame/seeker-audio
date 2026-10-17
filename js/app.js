// Application state: the composition, selection, undo history, persistence,
// and the bridge to the audio engine. UI components subscribe and redraw.

import { AudioEngine } from './audio/engine.js';
import { Balancer } from './audio/balance.js';
import { Recorder } from './audio/recorder.js';
import { cleanComposition, clone, isDrums, MAX_LAYERS, newLayer, LAYER_COLORS } from './state.js';
import { generateComposition, generatePattern, evolvePattern, randomParams, pickEngine, roleOctave, fitRegister, sidechainFor } from './generate.js';
import { Rng } from './rng.js';
import { encodeStored } from './share.js';
import { saveCurrent } from './storage.js';
import { instrumentDefaults } from './instruments.js';

const HISTORY = 120;
const COALESCE_MS = 900;

export class App {
	constructor(comp) {
		this.comp = cleanComposition(comp);
		this.selected = this.comp.layers.length ? 0 : -1;
		this.view = 'pattern';
		this.history = [];
		this.future = [];
		this.listeners = new Set();
		this.audio = new AudioEngine();
		this.recorder = new Recorder(this.audio);
		this.evolve = false;
		this.style = null;
		this.lastBar = -1;
		this.version = 0;
		// Measures layers from the start, so the balance is ready before the first note.
		this.balancer = new Balancer((trims) => this.audio.setTrims(trims));
		this.balancer.update(this.comp);
		this.audio.on('tick', (tick) => this.onTick(tick));
		this.audio.on('ready', () => {
			this.audio.reset();
			this.audio.apply(this.comp);
		});
	}

	subscribe(fn) {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	notify() {
		this.version++;
		for (const fn of this.listeners) fn(this);
	}

	get layer() {
		return this.comp.layers[this.selected] || null;
	}

	// --- Changes and history ---------------------------------------------------

	snapshot(coalesce) {
		const now = performance.now();
		if (coalesce && coalesce === this.lastKey && now - this.lastTime < COALESCE_MS) {
			this.lastTime = now;
			return;
		}
		this.history.push(JSON.stringify({ comp: this.comp, selected: this.selected }));
		if (this.history.length > HISTORY) this.history.shift();
		this.future = [];
		this.lastKey = coalesce;
		this.lastTime = now;
	}

	// Applies a mutation. `coalesce` merges rapid edits (a knob drag) into one undo step.
	change(fn, { coalesce = null, record = true } = {}) {
		if (record) this.snapshot(coalesce);
		fn(this.comp);
		this.changed();
	}

	changed() {
		if (this.selected >= this.comp.layers.length) this.selected = this.comp.layers.length - 1;
		this.balancer.update(this.comp);
		this.scheduleApply();
		this.scheduleSave();
		this.notify();
	}

	scheduleApply() {
		if (this.applyQueued) return;
		this.applyQueued = true;
		requestAnimationFrame(() => {
			this.applyQueued = false;
			this.audio.apply(this.comp);
		});
	}

	scheduleSave() {
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(async () => saveCurrent(await encodeStored(this.comp)), 700);
	}

	restore(entry) {
		const { comp, selected } = JSON.parse(entry);
		this.comp = comp;
		this.selected = selected;
		this.lastKey = null;
		this.changed();
	}

	undo() {
		if (!this.history.length) return;
		this.future.push(JSON.stringify({ comp: this.comp, selected: this.selected }));
		this.restore(this.history.pop());
	}

	redo() {
		if (!this.future.length) return;
		this.history.push(JSON.stringify({ comp: this.comp, selected: this.selected }));
		this.restore(this.future.pop());
	}

	load(comp) {
		this.snapshot();
		this.comp = cleanComposition(comp);
		this.selected = this.comp.layers.length ? 0 : -1;
		this.lastBar = -1;
		this.changed();
	}

	// --- Audio -----------------------------------------------------------------

	async ensureAudio() {
		await this.audio.start();
		return this.audio;
	}

	async togglePlay(force) {
		await this.ensureAudio();
		const play = force ?? !this.audio.playing;
		if (play) {
			this.audio.apply(this.comp);
			this.audio.play();
			this.lastBar = -1;
		} else {
			this.audio.stop();
		}
		this.notify();
	}

	onTick(tick) {
		if (!this.evolve || !tick.playing) return;
		const bar = Math.floor(tick.beat / 4);
		if (bar === this.lastBar) return;
		this.lastBar = bar;
		// Every four bars, one layer changes a little.
		if (bar > 0 && bar % 4 === 0 && this.comp.layers.length) {
			const rng = new Rng();
			const candidates = this.comp.layers.filter((l) => l.pattern.notes.length);
			const layer = rng.pick(candidates);
			if (layer) this.change(() => (layer.pattern = evolvePattern(this.comp, layer, rng)), { record: false });
		}
	}

	// --- Composition actions ---------------------------------------------------

	surprise(style = this.style) {
		const comp = generateComposition(undefined, style || null);
		this.load(comp);
	}

	select(index) {
		this.selected = index;
		this.notify();
	}

	setView(view) {
		this.view = view;
		this.notify();
	}

	addLayer(role) {
		if (this.comp.layers.length >= MAX_LAYERS) return;
		const rng = new Rng();
		const used = new Set(this.comp.layers.map((l) => l.color));
		const color = [...LAYER_COLORS.keys()].find((c) => !used.has(c)) ?? this.comp.layers.length % LAYER_COLORS.length;
		const engine = pickEngine(role, rng, this.comp.style);
		const layer = newLayer(engine, role, color);
		layer.octave = roleOctave(role, this.comp.root);
		layer.params = randomParams(engine, rng, role, this.comp.style);
		layer.sidechain = sidechainFor(this.comp, role, rng);
		this.change((comp) => {
			layer.pattern = generatePattern(comp, layer, rng);
			fitRegister(comp, layer);
			comp.layers.push(cleanComposition({ ...comp, layers: [layer] }).layers[0]);
			this.selected = comp.layers.length - 1;
		});
		this.view = 'pattern';
		this.notify();
	}

	removeLayer(index) {
		this.change((comp) => comp.layers.splice(index, 1));
	}

	newPattern(index = this.selected) {
		const layer = this.comp.layers[index];
		if (!layer) return;
		const rng = new Rng();
		this.change((comp) => {
			layer.pattern = generatePattern(comp, layer, rng);
			fitRegister(comp, layer);
		});
	}

	newSound(index = this.selected) {
		const layer = this.comp.layers[index];
		if (!layer) return;
		this.change(() => (layer.params = randomParams(layer.engine, new Rng(), layer.role, this.comp.style)));
	}

	setEngine(index, engine) {
		const layer = this.comp.layers[index];
		if (!layer || layer.engine === engine) return;
		const wasDrums = isDrums(layer);
		this.change((comp) => {
			layer.engine = engine;
			layer.params = instrumentDefaults(engine);
			const drums = isDrums(layer);
			if (drums !== wasDrums) {
				layer.role = drums ? 'drums' : 'melody';
				layer.follow = !drums;
				layer.octave = drums ? 0 : roleOctave('melody', comp.root);
				layer.pattern = generatePattern(comp, layer, new Rng());
			}
		});
	}

	evolveLayer(index = this.selected) {
		const layer = this.comp.layers[index];
		if (!layer) return;
		this.change((comp) => (layer.pattern = evolvePattern(comp, layer, new Rng())));
	}

	// A sensible layer to play live notes on: the selected one unless it is drums.
	liveLayerIndex() {
		if (this.layer && !isDrums(this.layer)) return this.selected;
		return this.comp.layers.findIndex((l) => !isDrums(l));
	}

	async liveNote(row, key, on, index = this.liveLayerIndex(), vel = 0.8) {
		if (index < 0) return;
		await this.ensureAudio();
		if (on) this.audio.noteOn(index, row, key, vel);
		else this.audio.noteOff(index, key);
	}

	clone() {
		return clone(this.comp);
	}
}
