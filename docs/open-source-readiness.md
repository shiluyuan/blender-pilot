# Public source readiness — 2026-10-29

**Recommendation: publish the source as an initial v0.1.0 preview.** This recommendation concerns public source distribution, not universal deployment or production certification.

## Reviewed

- Current tracked text files scanned for common API-key, GitHub-token, cloud-key, private-key and credential-URL patterns. Matches were documented placeholders or disposable test credentials; no real credential was identified.
- All 14 commits reachable from `main` at review start had their available text diffs scanned, including removed lines. The initial large package-lock file, which had no API diff, was read separately. This is a pattern-based review, not a guarantee against every possible secret or every historical binary.
- GitHub reported one branch (`main`); the tags namespace returned no refs. No history rewrite was performed.
- Current and three historical settings screenshots visually sampled: key fields show the saved-key placeholder, not secret values. Historical screenshots remain historical evidence; current README galleries point only to `docs/screenshots/current`.
- `npm audit --omit=dev` reported zero known vulnerabilities at review time. This describes the advisory database response, not proof of vulnerability-free software.
- MIT license exists for original project code, with separate third-party notices. The browser build now carries notices, license files, and the exact installed unmodified noVNC source under `/third-party/`.
- English and Chinese README setup instructions, platform qualifications, local document links and screenshot references checked against the remote tree.
- Version remains 0.1.0. The npm `private: true` setting intentionally prevents accidental npm publishing; it does not prevent making the GitHub repository public.

## Corrections made before publication

- Ignore `.env.*` except `.env.example`, local agent credential directories, private-key files and runtime data.
- Exclude native environments, database/data directories and credential files from Docker build context.
- Include third-party notices/source in the browser output and copy the required build inputs in Docker.
- Explicitly describe v0.1.0 as an early preview in both READMEs.

## Validation

The application source previously passed 119 Node tests, 13 Python deployment tests and five Chromium project-lifecycle checks. This review changed packaging/documentation/ignore rules; typecheck and the production build were rerun. The emitted noVNC source and license files were verified against the installed package. Ignore rules were checked for environment files, local config and credentials. No model call was made.

## Remaining scope

New native-launcher acceptance against real Blender, physical macOS/Windows, and target-host Docker/native PostgreSQL is still pending. These limits are documented in the README and release validation. They do not prevent sharing the source for feedback, but the project should not advertise all-platform production readiness.

The repository remains private until its owner changes visibility. Public visibility exposes repository history as well as the current files. This review is not a formal security or legal certification; ongoing dependency and disclosure maintenance is described in SECURITY.md and THIRD_PARTY_NOTICES.md.
