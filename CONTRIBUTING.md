# Contributing

Thank you for helping make Blender Pilot useful to creators.

## Report a problem

Include your OS/architecture, Blender version, deployment mode, reproduction steps, expected/actual behavior, and sanitized logs. For duplicate creation, include whether Blender startup failed and whether the submit button was clicked again. Never include API keys, cookies, private asset files, or database passwords.

## Develop

Use Node.js 22.12+ or 24 LTS and Python 3.12+. Run `npm ci`, then `npm run check`. Tests require PostgreSQL through `PILOT_TEST_DATABASE_URL` or Docker. For restricted test environments only, set `PILOT_TEST_POSTGRES_MODE=wasm-wire` and label the results accordingly.

Use `./local-up.sh --setup` for an integrated native workspace. `npm run dev`, `npm run runner`, and `npm run web` are separate development processes; configure the same data directory, PostgreSQL URL, and internal token for the API and runner.

## Pull requests

Keep changes focused. Explain the user-visible problem, resulting behavior, verification, and limitations. Add regression coverage for lifecycle, persistence, concurrency, authentication, or protocol changes. UI changes should include actual screenshots in both themes where relevant. Update both README languages when setup or capabilities change.

Do not commit `.data`, `.env`, runtime dependencies, API credentials, private models, or generated asset packages. Preserve upstream license notices. New contributors retain copyright in their contributions and contribute under the project's MIT license.

## Release checklist

- Update package metadata and CHANGELOG together.
- Run typecheck, automated tests, deployment checks, and production build.
- Validate native Blender separately from protocol fixtures; record host and runtime versions.
- Run target-host PostgreSQL/Docker checks and authorized real-model checks before claiming production acceptance.
- Verify README links and screenshot provenance; never label an unexecuted check as passing.
- Create a version tag/release only against the verified commit. Automatic GitHub CI is not enabled by this project workflow.
