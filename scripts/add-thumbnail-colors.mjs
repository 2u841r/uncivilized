#!/usr/bin/env node
// Compute ambient colors from top/bottom bands of each post's hero
// thumbnail, and write color*/color*Bottom fields into its frontmatter.
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

function hueDistance(a, b) {
	const d = Math.abs(a - b) % 360;
	return d > 180 ? 360 - d : d;
}

// Averaging ALL pixels weighted by saturation still blends distinct
// saturated colors together (a blue wall + a yellow banner in the same
// band averages toward green in raw RGB, before any hue math even runs) -
// and filtering by saturation MAGNITUDE alone doesn't help either, since
// two totally different hues (blue wall, yellow banner) can both be highly
// saturated. Instead find the single most-saturated pixel, then average
// only the pixels whose HUE is close to it - the actual color family that
// pixel belongs to - rather than the whole region. Returns raw
// (unboosted) {r,g,b}.
async function rawCellColor(imagePath, left, top, width, height) {
	const { data, info } = await sharp(imagePath)
		.extract({ left, top, width, height })
		.resize(40, null, { fit: 'inside' })
		.raw()
		.toBuffer({ resolveWithObject: true });

	const channels = info.channels;
	const pixels = [];
	let peak = null;
	let sr = 0;
	let sg = 0;
	let sb = 0;
	let count = 0;

	for (let i = 0; i < data.length; i += channels) {
		const r = data[i];
		const g = data[i + 1];
		const b = data[i + 2];
		const [h, s] = rgbToHsl(r, g, b);
		const px = { r, g, b, h, s };
		pixels.push(px);
		if (!peak || s > peak.s) peak = px;
		sr += r;
		sg += g;
		sb += b;
		count += 1;
	}

	if (!peak || peak.s < 0.08) {
		// whole region is basically greyscale, no real color to cluster on
		return { r: sr / count, g: sg / count, b: sb / count };
	}

	// cluster on pixels close in hue to the peak pixel's color family,
	// ignoring pixels that are themselves too washed-out to have a
	// meaningful hue
	let cr = 0;
	let cg = 0;
	let cb = 0;
	let cn = 0;
	for (const p of pixels) {
		if (p.s >= 0.15 && hueDistance(p.h, peak.h) <= 35) {
			cr += p.r;
			cg += p.g;
			cb += p.b;
			cn += 1;
		}
	}
	if (cn === 0) return { r: peak.r, g: peak.g, b: peak.b };
	return { r: cr / cn, g: cg / cn, b: cb / cn };
}

function boostToHex({ r, g, b }) {
	const [h, s, l] = rgbToHsl(r, g, b);
	if (s < 0.08) {
		// Region is essentially neutral (grey wall, smoke, etc). Hue is
		// numerically unstable this close to grey - forcing a saturation
		// floor here doesn't "boost" a real color, it invents one from
		// rounding noise (this is why a grey region could turn out green).
		// Keep it desaturated instead of hallucinating a hue.
		const greyL = Math.min(0.35, Math.max(0.12, l));
		const [gr, gg, gb] = hslToRgb(h, 0, greyL);
		return `#${[gr, gg, gb].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
	}
	const boostedS = Math.min(1, Math.max(s, 0.55));
	const boostedL = Math.min(0.6, Math.max(0.4, l));
	const [br, bg, bb] = hslToRgb(h, boostedS, boostedL);
	return `#${[br, bg, bb].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

async function sideColors(imagePath) {
	// Blending cells that are far apart (e.g. blue smoke top-right + yellow
	// text bottom-right) produces a color that doesn't exist anywhere in the
	// picture - blue+yellow averages toward green. Instead, sample a band
	// near the top and a band near the bottom independently, each split into
	// left/center/right, and use each region's own color as-is - no
	// cross-region blending. Top band feeds the glow behind the header;
	// bottom band feeds a second glow under the picture/title.
	const meta = await sharp(imagePath).metadata();
	const w = meta.width;
	const h = meta.height;
	const colW = Math.floor(w / 3);
	const bandH = Math.floor(h * 0.4);

	async function band(top) {
		const left = await rawCellColor(imagePath, 0, top, colW, bandH);
		const center = await rawCellColor(imagePath, colW, top, colW, bandH);
		const right = await rawCellColor(imagePath, w - colW, top, colW, bandH);
		return {
			left: boostToHex(left),
			center: boostToHex(center),
			right: boostToHex(right),
		};
	}

	const top = await band(0);
	const bottom = await band(h - bandH);
	return { top, bottom };
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

		frontmatter = setField(frontmatter, 'colorLeft', colors.top.left);
		frontmatter = setField(frontmatter, 'colorCenter', colors.top.center);
		frontmatter = setField(frontmatter, 'colorRight', colors.top.right);
		frontmatter = setField(frontmatter, 'colorLeftBottom', colors.bottom.left);
		frontmatter = setField(frontmatter, 'colorCenterBottom', colors.bottom.center);
		frontmatter = setField(frontmatter, 'colorRightBottom', colors.bottom.right);
		writeFileSync(filePath, `---\n${frontmatter}\n---\n\n${body}`, 'utf-8');
		updated += 1;
	}

	console.log(`updated ${updated}/${files.length} posts with top/bottom ambient colors`);
}

main();
