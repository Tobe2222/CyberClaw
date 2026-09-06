# CHANGES/

Per-version release notes for CyberClaw desktop.

## Convention (added v3.3.3)

Each version push creates a new file named `CHANGES_X.Y.Z.md` in
this directory, following the existing pattern from v3.1.5 onwards.
**Do NOT add `CHANGES_*.md` files to the project root.** The root
was getting cluttered with 100+ of these — moved into here so the
project root stays readable.

## File format

One-file-per-release, dated at the top, with a short summary and
a bullet-list of the user-facing changes. Tag the commit with the
same `vX.Y.Z` you used for the CHANGES filename. See
`CHANGES_3.3.3.md` (the version that introduced this convention)
for the canonical example.

## Index

- All `CHANGES_X.Y.Z.md` files in this directory, sorted by version.
- `CHANGELOG.md` at the project root carries the consolidated
  changelog (every version gets a one-line summary there).
