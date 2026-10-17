// Measures layer loudness for the automatic balance, off the main thread.

import { measureLayer } from './balance.js';
import { renderSource, SOURCE_IDS } from './sources.js';

const SR = 48000;
let sources = null;

self.onmessage = (event) => {
	const { id, spec, cloud } = event.data;
	if (cloud && !sources) sources = new Map(SOURCE_IDS.map((sid) => [sid, renderSource(sid, SR)]));
	let db = -120;
	try {
		db = measureLayer(spec, cloud ? sources : new Map());
	} catch {
		db = -120;
	}
	self.postMessage({ id, db });
};
