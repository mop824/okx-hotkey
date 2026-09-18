`pre-push` refuses any push whose commits add or modify a path outside the published allowlist (`dist/**`, `README.md`, `release-notes-*.md`, `.gitignore`, `.github/**`, `.githooks/**`) — the public repo carries only the built extension; the source lives in the private repo.
Enable it once per clone with: `git config core.hooksPath .githooks`.
`git push --no-verify` bypasses this hook entirely.
