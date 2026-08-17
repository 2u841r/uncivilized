import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
	// Load Markdown and MDX files in the `src/content/blog/` directory.
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	// Type-check frontmatter using a schema
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			description: z.string(),
			// Transform string to Date object
			pubDate: z.coerce.date(),
			updatedDate: z.coerce.date().optional(),
			heroImage: z.optional(image()),
			videoId: z.string().optional(),
			videoUrl: z.string().optional(),
			colorLeft: z.string().optional(),
			colorCenter: z.string().optional(),
			colorRight: z.string().optional(),
			colorLeftBottom: z.string().optional(),
			colorCenterBottom: z.string().optional(),
			colorRightBottom: z.string().optional(),
		}),
});

export const collections = { blog };
