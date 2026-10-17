// Browser storage: the song in progress, a library of saved songs, and small
// preferences. Songs are stored in their share-link encoding. Every access is
// guarded, since storage can be unavailable (private windows, blocked sites).

const CURRENT = 'seeker.current';
const LIBRARY = 'seeker.library';
const PREFS = 'seeker.prefs';

function read(key, fallback) {
	try {
		const raw = localStorage.getItem(key);
		return raw ? JSON.parse(raw) : fallback;
	} catch {
		return fallback;
	}
}

function write(key, value) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
		return true;
	} catch {
		return false;
	}
}

export function loadCurrent() {
	return read(CURRENT, null);
}

export function saveCurrent(payload) {
	write(CURRENT, payload);
}

export function library() {
	const list = read(LIBRARY, []);
	return Array.isArray(list) ? list : [];
}

export function saveToLibrary(name, payload) {
	const list = library().filter((s) => s.name !== name);
	list.unshift({ id: `${Date.now().toString(36)}`, name, saved: Date.now(), payload });
	write(LIBRARY, list.slice(0, 100));
	return list;
}

export function removeFromLibrary(id) {
	const list = library().filter((s) => s.id !== id);
	write(LIBRARY, list);
	return list;
}

export function prefs() {
	return read(PREFS, {});
}

export function setPref(key, value) {
	const p = prefs();
	p[key] = value;
	write(PREFS, p);
}
