# uncivilized site

Astro blog for the uncivilized documentary channel. Turns YouTube videos into blog posts: captions are downloaded, cleaned, and published as Markdown articles.

## Project structure

The git repo covers `site/` only. The sibling `data/` and `scripts/` folders live outside the repo on the local machine:

```text
../data/                     # NOT in git (local working data)
│   ├── videos.json          # video metadata (fetched from YouTube)
│   ├── captions_raw/        # raw .vtt caption downloads
│   ├── captions_clean/      # cleaned plain-text captions (.txt)
│   ├── cleaning-prompt.md   # prompt for AI-assisted transcript cleaning
│   └── thumbnails/          # downloaded video thumbnails
../scripts/                  # NOT in git (Python pipeline)
site/                        # this Astro project (git root)
├── public/
├── src/
│   ├── assets/thumbnails/   # hero images used by posts (in git)
│   ├── components/
│   ├── content/blog/        # the blog posts (.md)
│   ├── layouts/
│   └── pages/
├── astro.config.mjs
└── package.json
```

## Content pipeline

Python scripts live in `../scripts/` (outside the repo) and operate on `../data/` (also outside the repo):

| Script | Action |
| :----------------------------- | :------------------------------------------------------------ |
| `download_captions.py`         | Download `.vtt` captions into `data/captions_raw/`            |
| `clean_vtt.py`                 | Strip VTT markup into plain text in `data/captions_clean/`    |
| `fetch_channel_videos.py`      | List channel videos into `data/videos.json`                   |
| `fetch_video_details.py`       | Fetch per-video metadata                                      |
| `build_blog_posts.py`          | Generate posts in `site/src/content/blog/` from `videos.json` + `captions_clean/` |

Final transcript cleanup into publication-ready prose is done with an AI assistant using the rules in `data/cleaning-prompt.md`. When editing posts by hand, keep the YAML frontmatter byte-for-byte intact.

Each post's frontmatter includes `title`, `description`, `pubDate`, `heroImage`, `videoId`, `videoUrl`, and gradient `color*` fields used by the layout.

## Commands

All commands are run from `site/`:

| Command                | Action                                        |
| :--------------------- | :-------------------------------------------- |
| `pnpm install`         | Installs dependencies                         |
| `pnpm dev`             | Starts local dev server at `localhost:4321`   |
| `pnpm build`           | Build your production site to `./dist/`       |
| `pnpm preview`         | Preview your build locally, before deploying  |
| `pnpm astro ...`       | Run CLI commands like `astro add`, `astro check` |

Per `AGENTS.md`, prefer background dev server mode:

```sh
astro dev --background   # start
astro dev status         # check
astro dev logs           # tail logs
astro dev stop           # stop
```

## Docs

- [Astro docs](https://docs.astro.build)
- [Content collections](https://docs.astro.build/en/guides/content-collections/)

Theme based on the [Astro Blog template](https://github.com/withastro/astro/tree/main/examples/blog).
