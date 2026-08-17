#!/usr/bin/env node
// Compute ambient colors from a 3x3 grid sample of each post's hero
// thumbnail, and write colorLeft/colorCenter/colorRight into its frontmatter.
//
// Usage: node scripts/add-thumbnail-colors.mjs

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = join(__dirname, '..');
const POSTS_DIR = join(SITE_ROOT, 'src', 'content', 'blog');
const ASSETS_DIR = join(SITE_ROOT, 'src', 'assets');

// Averaging a whole region tends toward muddy grey/brown once you mix
// background + face + text. Boost saturation and clamp lightness so the
// extracted color reads as an actual color against a black page instead of
// a grey smudge (same trick Spotify Canvas / YouTube ambient mode use).
function rgbToHsl(r, g, b) {
	r /= 255;
	g /= 255;
	b /= 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	let h = 0;
	let s = 0;
	const l = (max + min) / 2;
	const d = max - min;
	if (d !== 0) {
		s = d / (1 - Math.abs(2 * l - 1));
		switch (max) {
			case r:
				h = ((g - b) / d) % 6;
				break;
			case g:
				h = (b - r) / d + 2;
				break;
			default:
				h = (r - g) / d + 4;
		}
		h *= 60;
		if (h < 0) h += 360;
	}
	return [h, s, l];
}

function hslToRgb(h, s, l) {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	let [r, g, b] = [0, 0, 0];
	if (h < 60) [r, g, b] = [c, x, 0];
	else if (h < 120) [r, g, b] = [x, c, 0];
	else if (h < 180) [r, g, b] = [0, c, x];
	else if (h < 240) [r, g, b] = [0, x, c];
	else if (h < 300) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	return [r, g, b].map((v) => Math.round((v + m) * 255));
}

// Weight each pixel's contribution to a region's average by its own
// saturation, so vivid pixels (a logo) pull the result while flat/dark
// background pixels contribute almost nothing — same idea as Vibrant.js /
// Spotify Canvas. Returns raw (unboosted) {r,g,b} so callers can blend
// several cells together before boosting saturation/lightness once.
async function rawCellColor(imagePath, left, top, width, height) {
	const { data, info } = await sharp(imagePath)
		.extract({ left, top, width, height })
		.resize(40, null, { fit: 'inside' })
		.raw()
		.toBuffer({ resolveWithObject: true });

	const channels = info.channels;
	let wr = 0;
	let wg = 0;
	let wb = 0;
	let totalWeight = 0;
	let sr = 0;
	let sg = 0;
	let sb = 0;
	let count = 0;

	for (let i = 0; i < data.length; i += channels) {
		const r = data[i];
		const g = data[i + 1];
		const b = data[i + 2];
		const [, s] = rgbToHsl(r, g, b);
		const weight = s * s; // emphasize saturated pixels more
		wr += r * weight;
		wg += g * weight;
		wb += b * weight;
		totalWeight += weight;
		sr += r;
		sg += g;
		sb += b;
		count += 1;
	}

	if (totalWeight > count * 0.02) {
		return { r: wr / totalWeight, g: wg / totalWeight, b: wb / totalWeight };
	}
	// region is basically greyscale, fall back to plain average
	return { r: sr / count, g: sg / count, b: sb / count };
}

function blendRaw(cells) {
	const r = cells.reduce((sum, c) => sum + c.r, 0) / cells.length;
	const g = cells.reduce((sum, c) => sum + c.g, 0) / cells.length;
	const b = cells.reduce((sum, c) => sum + c.b, 0) / cells.length;
	return { r, g, b };
}

function boostToHex({ r, g, b }) {
	const [h, s, l] = rgbToHsl(r, g, b);
	const boostedS = Math.min(1, Math.max(s, 0.55));
	const boostedL = Math.min(0.6, Math.max(0.4, l));
	const [br, bg, bb] = hslToRgb(h, boostedS, boostedL);
	return `#${[br, bg, bb].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

async function sideColors(imagePath) {
	// A 2-point (left third / right third) sample only ever sees 2 colors,
	// even when a thumbnail has 5+. Sample a 3x3 grid instead and blend
	// each column's cells together — the dead-center cell (almost always a
	// face, not a color) is dropped from the center column's blend.
	const meta = await sharp(imagePath).metadata();
	const w = meta.width;
	const h = meta.height;
	const colW = Math.floor(w / 3);
	const rowH = Math.floor(h / 3);

	// cells[row][col]
	const cells = [];
	for (let row = 0; row < 3; row++) {
		const rowCells = [];
		for (let col = 0; col < 3; col++) {
			const left = col * colW;
			const top = row * rowH;
			const width = col === 2 ? w - left : colW;
			const height = row === 2 ? h - top : rowH;
			rowCells.push(await rawCellColor(imagePath, left, top, width, height));
		}
		cells.push(rowCells);
	}

	const leftRaw = blendRaw([cells[0][0], cells[1][0], cells[2][0]]);
	const rightRaw = blendRaw([cells[0][2], cells[1][2], cells[2][2]]);
	// skip cells[1][1] (dead center, usually a face)
	const centerRaw = blendRaw([cells[0][1], cells[2][1]]);

	return {
		left: boostToHex(leftRaw),
		center: boostToHex(centerRaw),
		right: boostToHex(rightRaw),
	};
}

function extractFrontmatter(content) {
	const match = content.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
	if (!match) return null;
	return { frontmatter: match[1], body: match[2] };
}

function getField(frontmatter, key) {
	const m = frontmatter.match(new RegExp(`^${key}:\\s*"(.*)"$`, 'm'));
	return m ? m[1] : null;
}

function setField(frontmatter, key, value) {
	const line = `${key}: "${value}"`;
	if (new RegExp(`^${key}:`, 'm').test(frontmatter)) {
		return frontmatter.replace(new RegExp(`^${key}:.*$`, 'm'), line);
	}
	return `${frontmatter}\n${line}`;
}

async function main() {
	const files = readdirSync(POSTS_DIR).filter((f) => f.endsWith('.md'));
	let updated = 0;

	for (const file of files) {
		const filePath = join(POSTS_DIR, file);
		const raw = readFileSync(filePath, 'utf-8');
		const parsed = extractFrontmatter(raw);
		if (!parsed) continue;

		let { frontmatter, body } = parsed;
		const heroImage = getField(frontmatter, 'heroImage');
		if (!heroImage) continue;

		const imagePath = join(ASSETS_DIR, 'thumbnails', heroImage.split('/').pop());
		let colors;
		try {
			colors = await sideColors(imagePath);
		} catch (err) {
			console.warn(`  skip ${file}: ${err.message}`);
			continue;
		}

		frontmatter = setField(frontmatter, 'colorLeft', colors.left);
		frontmatter = setField(frontmatter, 'colorCenter', colors.center);
		frontmatter = setField(frontmatter, 'colorRight', colors.right);
		writeFileSync(filePath, `---\n${frontmatter}\n---\n\n${body}`, 'utf-8');
		updated += 1;
	}

	console.log(`updated ${updated}/${files.length} posts with colorLeft/colorCenter/colorRight`);
}

main();
