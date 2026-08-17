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

// Averaging ALL pixels weighted by saturation still blends distinct
// saturated colors together (a blue wall + a yellow banner in the same
// band averages toward green in raw RGB, before any hue math even runs).
// Clustering around the single most-saturated PIXEL doesn't work either:
// HSL saturation spikes artificially for near-black pixels (a dark navy
// pixel can out-rank a genuinely vivid red one), so a JPEG-noise outlier
// can win over a color family that actually covers most of the region.
//
// Instead, bucket pixels into 12 hue bins and sum each bin's total s^2
// weight (its "visual mass" - vivid AND covers real area), then pick the
// bin family with the most total mass, not the single brightest pixel.
// Returns raw (unboosted) {r,g,b}.
const HUE_BINS = 12;
const HUE_BIN_SIZE = 360 / HUE_BINS;

async function rawCellColor(imagePath, left, top, width, height) {
	const { data, info } = await sharp(imagePath)
		.extract({ left, top, width, height })
		.resize(40, null, { fit: 'inside' })
		.raw()
		.toBuffer({ resolveWithObject: true });

	const channels = info.channels;
	const binWeight = new Array(HUE_BINS).fill(0);
	const binR = new Array(HUE_BINS).fill(0);
	const binG = new Array(HUE_BINS).fill(0);
	const binB = new Array(HUE_BINS).fill(0);
	let sr = 0;
	let sg = 0;
	let sb = 0;
	let count = 0;
	let maxS = 0;

	for (let i = 0; i < data.length; i += channels) {
		const r = data[i];
		const g = data[i + 1];
		const b = data[i + 2];
		const [h, s] = rgbToHsl(r, g, b);
		if (s > maxS) maxS = s;
		if (s >= 0.15) {
			const weight = s * s;
			const bin = Math.floor(h / HUE_BIN_SIZE) % HUE_BINS;
			binWeight[bin] += weight;
			binR[bin] += r * weight;
			binG[bin] += g * weight;
			binB[bin] += b * weight;
		}
		sr += r;
		sg += g;
		sb += b;
		count += 1;
	}

	if (maxS < 0.08) {
		// whole region is basically greyscale, no real color to cluster on
		return { r: sr / count, g: sg / count, b: sb / count };
	}

	// pick the hue bin (plus its two neighbors, to avoid an arbitrary hard
	// cut at a bin boundary) with the most total weighted mass
	let bestBin = 0;
	let bestMass = -1;
	for (let i = 0; i < HUE_BINS; i++) {
		const mass =
			binWeight[i] +
			binWeight[(i - 1 + HUE_BINS) % HUE_BINS] * 0.5 +
			binWeight[(i + 1) % HUE_BINS] * 0.5;
		if (mass > bestMass) {
			bestMass = mass;
			bestBin = i;
		}
	}

	let cr = 0;
	let cg = 0;
	let cb = 0;
	let cw = 0;
	for (const bin of [bestBin, (bestBin - 1 + HUE_BINS) % HUE_BINS, (bestBin + 1) % HUE_BINS]) {
		cr += binR[bin];
		cg += binG[bin];
		cb += binB[bin];
		cw += binWeight[bin];
	}
	if (cw === 0) return { r: sr / count, g: sg / count, b: sb / count };
	return { r: cr / cw, g: cg / cw, b: cb / cw };
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
