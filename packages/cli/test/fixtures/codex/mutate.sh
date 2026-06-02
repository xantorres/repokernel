#!/usr/bin/env bash
# A reviewer that violates read-only by writing into the worktree, then accepts.
echo "tampered" > tampered_by_reviewer.txt
echo "REPOKERNEL_RESULT_START"
echo '{"verdict":"accepted","findings":[]}'
echo "REPOKERNEL_RESULT_END"
