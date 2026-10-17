// Writes og.svg, the link-preview card: the Seeker palette's harmonic spiral
// beside the name, 1200 × 630, centred on a square canvas. On macOS:
//   qlmanage -t -s 1200 -o . og.svg && sips --cropToHeightWidth 630 1200 og.svg.png --out og.png
// Run with `node tools/og-image.mjs`.

import { writeFileSync } from 'node:fs';
import { normalizePalette, indexValue, foldHarmonic, ratioLabel } from '../js/tuning.js';

const W = 1200;
const H = 630;
const palette = normalizePalette([1, 9, 19, 21, 3, 7]);
const n = palette.length;
const OCTAVES = 6;
const cx = 330;
const cy = H / 2;
const outer = 250;
const inner = 46;
const colors = ['#78b6e6', '#e0a24a', '#e469a4', '#6ea34f', '#1fb39f', '#8a8ff0'];

const nodes = [];
for (let k = 0; k < OCTAVES; k++) {
	for (let d = 0; d < n; d++) {
		const p = k + Math.log2(indexValue(palette, d));
		const angle = 2 * Math.PI * (p - k) - Math.PI / 2;
		const r = inner + ((outer - inner) * p) / OCTAVES;
		nodes.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), k, d });
	}
}

const f = (v) => v.toFixed(1);
const parts = [];
parts.push(`<rect width="${W}" height="${H}" fill="#000"/>`);
for (let d = 0; d < n; d++) {
	const a = Math.atan2(nodes[d].y - cy, nodes[d].x - cx);
	parts.push(`<line x1="${f(cx + inner * Math.cos(a))}" y1="${f(cy + inner * Math.sin(a))}" x2="${f(cx + (outer + 10) * Math.cos(a))}" y2="${f(cy + (outer + 10) * Math.sin(a))}" stroke="#1a1a1f" stroke-width="1.5"/>`);
	const label = ratioLabel(foldHarmonic(palette[d]));
	parts.push(`<text x="${f(cx + (outer + 34) * Math.cos(a))}" y="${f(cy + (outer + 34) * Math.sin(a) + 6)}" fill="${d === 0 ? '#ececef' : '#6f6f79'}" font-family="Menlo, monospace" font-size="17" text-anchor="middle">${label}</text>`);
}
for (let k = 0; k < OCTAVES; k++) {
	const ring = nodes.filter((node) => node.k === k).map((node) => `${f(node.x)},${f(node.y)}`).join(' ');
	parts.push(`<polygon points="${ring}" fill="none" stroke="rgba(170,170,185,${0.12 + k * 0.05})" stroke-width="1.5"/>`);
}
parts.push(`<polyline points="${nodes.map((node) => `${f(node.x)},${f(node.y)}`).join(' ')}" fill="none" stroke="rgba(200,200,215,0.35)" stroke-width="1.5"/>`);
// A few notes glowing, as if a chord were sounding.
const lit = [
	[2, 0],
	[2, 4],
	[3, 2],
	[3, 5],
	[4, 1],
	[1, 0],
];
parts.push('<defs>');
lit.forEach((_, i) => parts.push(`<radialGradient id="g${i}"><stop offset="0" stop-color="${colors[i]}" stop-opacity="0.9"/><stop offset="1" stop-color="${colors[i]}" stop-opacity="0"/></radialGradient>`));
parts.push('</defs>');
for (const node of nodes) {
	const r = 3 + node.k * 0.5 + (node.d === 0 ? 1.5 : 0);
	parts.push(`<circle cx="${f(node.x)}" cy="${f(node.y)}" r="${r}" fill="${node.d === 0 ? '#ececef' : '#5c5c66'}"/>`);
}
lit.forEach(([k, d], i) => {
	const node = nodes.find((x) => x.k === k && x.d === d);
	parts.push(`<circle cx="${f(node.x)}" cy="${f(node.y)}" r="34" fill="url(#g${i})"/>`);
	parts.push(`<circle cx="${f(node.x)}" cy="${f(node.y)}" r="6" fill="${colors[i]}"/>`);
});
parts.push(`<circle cx="${cx}" cy="${cy}" r="${inner - 8}" fill="#000" stroke="#45454e" stroke-width="1.5"/>`);
parts.push(`<path d="M${cx - 7} ${cy - 12} L${cx - 7} ${cy + 12} L${cx + 13} ${cy} Z" fill="#ececef"/>`);
// Wordmark and line.
const tx = 690;
parts.push(`<text x="${tx}" y="262" fill="#f2f2f2" font-family="Menlo, monospace" font-size="64" font-weight="600" letter-spacing="22">SEEKER</text>`);
parts.push(`<text x="${tx}" y="318" fill="#a9a9b2" font-family="Menlo, monospace" font-size="24">every note is a harmonic</text>`);
parts.push(`<text x="${tx}" y="352" fill="#a9a9b2" font-family="Menlo, monospace" font-size="24">of 48 Hz</text>`);
parts.push(`<rect x="${tx}" y="400" width="214" height="52" rx="26" fill="#f2f2f2"/>`);
parts.push(`<text x="${tx + 107}" y="433" fill="#000" font-family="Menlo, monospace" font-size="21" text-anchor="middle">✦ surprise</text>`);
parts.push(`<text x="${tx + 236}" y="433" fill="#6f6f79" font-family="Menlo, monospace" font-size="19">make a song</text>`);

// A square canvas with the card centred; Quick Look draws SVG at 1.5625 pixels
// per unit, so the intrinsic size is scaled down to land on exactly 1200 pixels.
const QL_SCALE = 1.5625;
const pad = (W - H) / 2;
writeFileSync(
	new URL('../og.svg', import.meta.url),
	`<svg xmlns="http://www.w3.org/2000/svg" width="${W / QL_SCALE}" height="${W / QL_SCALE}" viewBox="0 0 ${W} ${W}"><rect width="${W}" height="${W}" fill="#000"/><g transform="translate(0 ${pad})">${parts.join('')}</g></svg>\n`,
);
console.log('wrote og.svg');
