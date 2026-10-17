// Small DOM helpers: element creation, icons, popovers, modals, toasts.

export function h(tag, attrs = {}, ...children) {
	const el = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs || {})) {
		if (value === undefined || value === null || value === false) continue;
		if (key === 'class') el.className = value;
		else if (key === 'style' && typeof value === 'object') {
			// Custom properties (--color) need setProperty; plain ones can be assigned.
			for (const [prop, v] of Object.entries(value)) {
				if (prop.startsWith('--')) el.style.setProperty(prop, v);
				else el.style[prop] = v;
			}
		}
		else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
		else if (key === 'html') el.innerHTML = value;
		else if (key in el && typeof value !== 'string') el[key] = value;
		else el.setAttribute(key, value === true ? '' : value);
	}
	for (const child of children.flat()) {
		if (child === null || child === undefined || child === false) continue;
		el.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
	return el;
}

export function svg(markup) {
	const template = document.createElement('template');
	template.innerHTML = markup.trim();
	return template.content.firstChild;
}

const icon = (body, view = 24) =>
	`<svg viewBox="0 0 ${view} ${view}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
	play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg>',
	stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5.5" y="5.5" width="13" height="13" rx="1.5" fill="currentColor"/></svg>',
	undo: icon('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
	redo: icon('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
	rec: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="5.5" fill="currentColor"/></svg>',
	share: icon('<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>'),
	menu: icon('<path d="M4 7h16M4 12h16M4 17h16"/>'),
	plus: icon('<path d="M12 5v14M5 12h14"/>'),
	minus: icon('<path d="M5 12h14"/>'),
	left: icon('<path d="m15 6-6 6 6 6"/>'),
	right: icon('<path d="m9 6 6 6-6 6"/>'),
	up: icon('<path d="m6 15 6-6 6 6"/>'),
	down: icon('<path d="m6 9 6 6 6-6"/>'),
	caret: icon('<path d="m6 9 6 6 6-6"/>'),
	close: icon('<path d="M6 6l12 12M18 6 6 18"/>'),
	trash: icon('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
	power: icon('<path d="M12 3v8"/><path d="M6.3 7a8 8 0 1 0 11.4 0"/>'),
	evolve: icon('<path d="M4 12c2.5-4 5-4 8 0s5.5 4 8 0"/><path d="M4 18c2.5-4 5-4 8 0s5.5 4 8 0" opacity=".45"/><path d="M4 6c2.5-4 5-4 8 0s5.5 4 8 0" opacity=".45"/>'),
	copy: icon('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
	download: icon('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
	x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.77zm-1.08 16.18h1.7L7.4 4.73H5.58z"/></svg>',
	dice: icon('<path d="M12 2.5 14 9.5 21.5 12 14 14.5 12 21.5 10 14.5 2.5 12 10 9.5z"/>'),
	clear: icon('<path d="M5 19h14"/><path d="m8 15 8-8M8 7l8 8" opacity=".7"/>'),
	tune: icon('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="3.5" r="1.4" fill="currentColor"/><circle cx="19.4" cy="16" r="1.4" fill="currentColor"/><circle cx="6.5" cy="18.5" r="1.4" fill="currentColor"/>'),
	help: icon('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"/><circle cx="12" cy="17.2" r=".6" fill="currentColor"/>'),
};

export const INSTRUMENT_ICONS = {
	bells: icon('<path d="M6 17h12M8 17V11a4 4 0 0 1 8 0v6"/><path d="M12 7V4"/><circle cx="12" cy="19.5" r="1.2"/>'),
	strings: icon('<path d="M6 4v16M10 4v16M14 4v16M18 4v16"/><path d="M4 9c5 2 11 2 16 0" opacity=".5"/>'),
	keys: icon('<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M8 5v8M12 5v8M16 5v8"/><path d="M8 13v6M12 13v6M16 13v6" opacity=".45"/>'),
	organ: icon('<path d="M5 20V10M9 20V6M13 20V4M17 20V8M21 20V12M3 20h20"/>'),
	choir: icon('<circle cx="8" cy="9" r="2.5"/><circle cx="16" cy="9" r="2.5"/><path d="M4 19c0-3 2-5 4-5s4 2 4 5M12 19c0-3 2-5 4-5s4 2 4 5"/>'),
	pad: icon('<path d="M3 14c3-6 6-6 9 0s6 6 9 0"/><path d="M3 10c3-6 6-6 9 0s6 6 9 0" opacity=".45"/>'),
	bass: icon('<path d="M2 12c2.5-6 5.5-6 8 0s5.5 6 8 0 2.5-3 4-3"/>'),
	wind: icon('<path d="M3 9h11a3 3 0 1 0-3-3"/><path d="M3 14h15a3 3 0 1 1-3 3"/><path d="M3 19h6" opacity=".5"/>'),
	drums: icon('<ellipse cx="12" cy="9" rx="8" ry="3"/><path d="M4 9v7c0 1.7 3.6 3 8 3s8-1.3 8-3V9"/><path d="m15 3-3 6M9 3l3 6" opacity=".6"/>'),
	cloud: icon('<circle cx="6" cy="12" r="1.3"/><circle cx="10" cy="8" r="1"/><circle cx="12" cy="13" r="1.6"/><circle cx="16" cy="9" r="1.2"/><circle cx="18" cy="14" r="1"/><circle cx="9" cy="16.5" r=".9"/><circle cx="15" cy="17" r=".8"/>'),
};

export function iconEl(name) {
	return svg(ICONS[name] || INSTRUMENT_ICONS[name] || ICONS.plus);
}

// --- Popover -------------------------------------------------------------------

let openPopover = null;

export function closePopover() {
	if (!openPopover) return;
	openPopover.el.remove();
	document.removeEventListener('pointerdown', openPopover.outside, true);
	document.removeEventListener('keydown', openPopover.key, true);
	openPopover = null;
}

// Opens `content` next to `anchor`; clicking outside or pressing Escape closes it.
export function popover(anchor, content, { align = 'start' } = {}) {
	if (openPopover?.anchor === anchor) {
		closePopover();
		return null;
	}
	closePopover();
	const el = h('div', { class: 'popover', role: 'dialog' }, content);
	document.body.append(el);
	const rect = anchor.getBoundingClientRect();
	const width = el.offsetWidth;
	const height = el.offsetHeight;
	let left = align === 'end' ? rect.right - width : rect.left;
	left = Math.max(12, Math.min(left, innerWidth - width - 12));
	let top = rect.bottom + 6;
	if (top + height > innerHeight - 12) top = Math.max(12, rect.top - height - 6);
	el.style.left = `${left}px`;
	el.style.top = `${top}px`;
	const outside = (event) => {
		if (!el.contains(event.target) && !anchor.contains(event.target)) closePopover();
	};
	const key = (event) => {
		if (event.key === 'Escape') {
			event.stopPropagation();
			closePopover();
		}
	};
	document.addEventListener('pointerdown', outside, true);
	document.addEventListener('keydown', key, true);
	openPopover = { el, anchor, outside, key };
	return el;
}

// --- Modal ---------------------------------------------------------------------

export function modal(content, { onClose } = {}) {
	closePopover();
	const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, content);
	const scrim = h('div', { class: 'scrim' }, box);
	const close = () => {
		scrim.remove();
		document.removeEventListener('keydown', key, true);
		onClose?.();
	};
	const key = (event) => {
		if (event.key === 'Escape') {
			event.stopPropagation();
			close();
		}
	};
	scrim.addEventListener('pointerdown', (event) => {
		if (event.target === scrim) close();
	});
	document.addEventListener('keydown', key, true);
	document.body.append(scrim);
	return { box, close };
}

// --- Toast ---------------------------------------------------------------------

let toastTimer = 0;
let toastEl = null;

export function toast(message) {
	toastEl?.remove();
	clearTimeout(toastTimer);
	toastEl = h('div', { class: 'toast', role: 'status' }, message);
	document.body.append(toastEl);
	toastTimer = setTimeout(() => {
		toastEl?.remove();
		toastEl = null;
	}, 2200);
}

// --- Tooltip -------------------------------------------------------------------

let tip = null;

export function showTip(x, y, content) {
	if (!tip) {
		tip = h('div', { class: 'tooltip' });
		document.body.append(tip);
	}
	tip.replaceChildren(content);
	tip.style.left = `${x}px`;
	tip.style.top = `${y}px`;
	tip.classList.add('show');
}

export function hideTip() {
	tip?.classList.remove('show');
}

export function formatValue(param, value) {
	if (param.type === 'choice') return String(value);
	if (param.unit === 's') return value < 1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(value < 10 ? 2 : 1)} s`;
	if (param.unit === '/s') return `${value.toFixed(value < 10 ? 1 : 0)}/s`;
	if (param.step === 1) return String(Math.round(value));
	if (param.min < 0) return `${value > 0 ? '+' : ''}${Math.round(value * 100)}`;
	return `${Math.round(((value - param.min) / (param.max - param.min)) * 100)}%`;
}
