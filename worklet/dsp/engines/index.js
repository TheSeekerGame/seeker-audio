import { BellsEngine } from './bells.js';
import { StringsEngine } from './strings.js';
import { KeysEngine } from './keys.js';
import { OrganEngine } from './organ.js';
import { ChoirEngine } from './choir.js';
import { PadEngine } from './pad.js';
import { BassEngine } from './bass.js';
import { WindEngine } from './wind.js';
import { DrumsEngine } from './drums.js';
import { CloudEngine } from './cloud.js';

export const ENGINES = {
	bells: BellsEngine,
	strings: StringsEngine,
	keys: KeysEngine,
	organ: OrganEngine,
	choir: ChoirEngine,
	pad: PadEngine,
	bass: BassEngine,
	wind: WindEngine,
	drums: DrumsEngine,
	cloud: CloudEngine,
};

export function createEngine(id, sr, ctx) {
	const Engine = ENGINES[id] || ENGINES.bells;
	return new Engine(sr, ctx);
}
