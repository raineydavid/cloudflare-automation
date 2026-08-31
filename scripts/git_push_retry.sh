#!/usr/bin/env bash
#
# Push a commit-back, surviving a concurrent push to the same branch.
#
# Sixteen workflows commit generated assets back to the branch, and all
# sixteen used the same line:
#
#     git push || (git pull --rebase && git push)
#
# One retry. On 2026-07-27 `gen-showcase` and `verify-transform-reveal`
# both went red with "Updates were rejected because the remote contains
# work that you do not have locally" — while a developer was pushing
# commits every few minutes. Both had already done their expensive work:
# the renders succeeded, the Runway and Runware calls were paid for, and
# `verify-transform-reveal` had uploaded its 4.9 MB clip as an artifact.
# The job still reported failure, and the generated files were lost.
#
# That is the worst shape a CI failure can take. It is not caused by the
# thing the workflow does, it costs real money each time it happens, and
# because the red is unrelated to the change that triggered it, the
# habit it teaches is to ignore these workflows going red.
#
# Two things were wrong with the one-liner:
#
#   1. One retry loses to any branch busier than "quiet". A second
#      concurrent push during the rebase window is enough.
#   2. Bare `git pull --rebase` depends on branch tracking that the
#      runner's checkout does not always provide, so the retry could
#      fail before it ever reached a push. Naming the remote and branch
#      explicitly removes that dependency.
#
# Usage:  bash scripts/git_push_retry.sh
#         bash scripts/git_push_retry.sh || echo "::warning::..."
#
# Exits 0 on a successful push, non-zero when every attempt failed — so
# callers keep whichever failure posture they already chose. Callers
# that also upload an artifact should stay non-fatal: the work survives
# in the artifact and a lost commit-back is not worth a red run.

set -uo pipefail

# GIT_PUSH_BRANCH for a commit-back into ANOTHER repository's branch, as
# the mint and mirror workflows do: they clone Screening Studio, generate
# into it, and push there. GITHUB_REF_NAME is this repository's branch and
# is the wrong answer inside that clone — today the two happen to share a
# name, which is a coincidence and not a design.
BRANCH="${GIT_PUSH_BRANCH:-${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD)}}"
REMOTE="${GIT_PUSH_REMOTE:-origin}"
ATTEMPTS="${GIT_PUSH_ATTEMPTS:-5}"

for attempt in $(seq 1 "$ATTEMPTS"); do
  if git push "$REMOTE" "HEAD:${BRANCH}"; then
    echo "commit-back pushed on attempt ${attempt}"
    exit 0
  fi

  if [ "$attempt" -eq "$ATTEMPTS" ]; then
    break
  fi

  echo "push rejected (attempt ${attempt}/${ATTEMPTS}) — rebasing onto ${REMOTE}/${BRANCH}"
  # Abort a half-finished rebase before trying again; a conflicted
  # rebase left in place makes every later attempt fail for a second,
  # more confusing reason.
  if ! git pull --rebase "$REMOTE" "$BRANCH"; then
    git rebase --abort || true
    echo "rebase failed — retrying the fetch"
  fi

  # Linear backoff. The collisions this handles are other CI jobs and
  # humans pushing, which resolve in seconds, not minutes.
  sleep $((attempt * 3))
done

echo "commit-back failed after ${ATTEMPTS} attempts against ${REMOTE}/${BRANCH}" >&2
exit 1
