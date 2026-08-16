#!/usr/bin/env node
// Compute an ambient color (average of left third / right third) for each
// post's hero thumbnail, and write colorLeft/colorRight into its frontmatter.
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

async function avgColorHex(imagePath, left, width, height) {
	const { data } = await sharp(imagePath)
		.extract({ left, top: 0, width, height })
		.resize(1, 1)
		.raw()
		.toBuffer({ resolveWithObject: true });
	const [r, g, b] = data;
	const [h, s, l] = rgbToHsl(r, g, b);
	const boostedS = Math.min(1, Math.max(s, 0.55));
	const boostedL = Math.min(0.6, Math.max(0.4, l));
	const [br, bg, bb] = hslToRgb(h, boostedS, boostedL);
	return `#${[br, bg, bb].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

async function sideColors(imagePath) {
	const meta = await sharp(imagePath).metadata();
	const third = Math.floor(meta.width / 3);
	const left = await avgColorHex(imagePath, 0, third, meta.height);
	const right = await avgColorHex(imagePath, meta.width - third, third, meta.height);
	return { left, right };
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
		frontmatter = setField(frontmatter, 'colorRight', colors.right);
		writeFileSync(filePath, `---\n${frontmatter}\n---\n\n${body}`, 'utf-8');
		updated += 1;
	}

	console.log(`updated ${updated}/${files.length} posts with colorLeft/colorRight`);
}

main();
