#!/usr/bin/env bash
# Use real git.exe so Cursor does not inject Co-authored-by trailers.
set -euo pipefail
GIT_BIN="/c/Program Files/Git/mingw64/bin/git.exe"
cd "$(dirname "$0")/.."
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-DLbury}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-DLbury@users.noreply.github.com}"
export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-DLbury}"
export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-DLbury@users.noreply.github.com}"
"$GIT_BIN" commit "$@"
