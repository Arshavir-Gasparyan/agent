# Project context

Vite + React 19 + TypeScript single-page app. No router, no state library, no
backend — `src/main.tsx` mounts `src/App.tsx` and that is the whole app.

`api/` is not part of the app bundle. It holds one Vercel Edge function that
relays Linear webhooks to GitHub Actions. Do not import from `src/` there or
vice versa.

## Commands

- `npm run dev` — dev server
- `npx tsc -b` — typecheck (app, node config, and api projects)
- `npm run lint` — ESLint
- `npm run build` — typecheck + production build to `dist/`

Run typecheck and lint before finishing any change.

## Conventions

- Components are function declarations, default-exported at the bottom of the
  file (see `src/App.tsx`).
- Double quotes and semicolons in `src/App.tsx`; the Vite-generated files use
  single quotes. Match whichever file you are editing rather than reformatting.
- Import assets (`import heroImg from "./assets/hero.png"`) instead of writing
  string paths, except for files in `public/` which are referenced by URL
  (`/icons.svg#github-icon`).
- Plain CSS in `src/App.css` and `src/index.css`, addressed by semantic id or
  class (`#next-steps`, `.counter`). No CSS-in-JS, no utility framework.
- Decorative images and SVGs get `alt=""` / `aria-hidden="true"`; meaningful
  ones get real labels. Keep that distinction.
- TypeScript is strict with `noUnusedLocals` and `noUnusedParameters` — no
  unused imports or leftover variables.

## Boundaries

- Do not add dependencies unless the task genuinely requires one; say so in the
  PR body when you do.
- Do not change build config, workflows, or `api/` unless the task is about
  them.
- Do not commit secrets. Relay configuration lives in Vercel env vars, listed
  in `.env.example`.
