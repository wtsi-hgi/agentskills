# Post-Merge Cleanup

1. Confirm the hosting service reports the PR as `MERGED`; a closed PR or
   missing remote branch is insufficient. Retain the PR's head, integration
   branch, and merge commit/result as evidence. Never delete `main`, `master`,
   `develop`, or the integration branch under this procedure.
2. Fetch the integration repository's remote with `git fetch --prune <remote>`
   to refresh the base and prune stale remote-tracking refs. For a fork PR,
   prune its distinct head remote too if configured. This deletes no remote
   branches. A failed fetch leaves the affected cleanup pending.
3. Apply [Git Safety deletion checks](../SKILL.md#git-safety). Compare the
   local task tip with the merged PR head and account for any extra commits.
   Verify the merge result in the fetched integration history; for a squash,
   inspect the resulting integration diff rather than requiring the task
   commits to be ancestors. Preserve pending dependency references, evidence,
   checkpoints, at-risk files and stashes outside any worktree being removed.
4. Leave the task branch before deleting it. In a primary worktree, switch
   safely to the local integration branch, or use
   `git switch --detach <fetched-base-sha>`. Do not reset or discard dirty work
   to make the switch succeed. For a disposable worktree, leave its directory
   and use `git worktree remove <path>` without force only after the deletion
   checks pass. If another worktree still needs the branch or cleanup would
   break a dependency, retain it and report the blocker.
5. Try `git branch -d <task-branch>`. If its ancestry check rejects a squash
   or other independently verified non-ancestry integration, `-D` is authorized
   only after the checks above leave no unaccounted-for work. Report the
   verification, deleted local branch/worktree, pruned refs, and any retained
   work or cleanup blocker.
