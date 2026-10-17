// The path most people take through SEEKER: press play, press ✦ surprise
// until a song feels right, then share it. Flow follows how far along the
// listener is and names the next step, which the interface invites gently
// with a slow ring on that step's button and a short caption. It never limits
// what can be pressed.

import { prefs, setPref } from './storage.js';

// Seconds of listening to one song before sharing it is suggested.
const DWELL_SECONDS = 20;

export class Flow {
	constructor(app) {
		this.app = app;
		this.hasPlayed = false;
		this.surprises = 0;
		this.hasShared = !!prefs().shared;
		// Seconds of playback since the song last changed.
		this.listened = 0;
		this.shown = null;
		setInterval(() => this.tick(), 1000);
	}

	played() {
		this.hasPlayed = true;
	}

	songChanged() {
		this.listened = 0;
	}

	surprised() {
		this.surprises++;
	}

	shared() {
		this.hasShared = true;
		setPref('shared', true);
	}

	tick() {
		if (this.app.audio.playing) this.listened++;
		// Redraw only when the invitation changes.
		const shown = `${this.step}|${this.caption}`;
		if (shown !== this.shown) {
			this.shown = shown;
			this.app.notify();
		}
	}

	// 'play', 'surprise', 'share', or null when there is nothing to suggest.
	get step() {
		if (!this.app.audio.playing) return this.hasPlayed ? null : 'play';
		if (this.hasShared) return null;
		return this.listened >= DWELL_SECONDS ? 'share' : 'surprise';
	}

	get caption() {
		switch (this.step) {
			case 'play':
				return 'press play to listen';
			case 'surprise':
				return this.surprises ? 'not quite? ✦ surprise again' : '✦ surprise makes a new song';
			case 'share':
				return 'like this one? share it';
			default:
				return this.app.audio.playing ? 'touch the dots to play along' : 'press play to listen';
		}
	}
}
