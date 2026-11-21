# Downstream release checks

Keep the downstream changes as linear commits on `codex/maintained`, based on a
stable upstream release tag recorded in `.downstream-base`. Do not retag
releases or publish the upstream artifacts from the fork.

The **Check downstream patches against latest release** workflow runs daily and
on demand. When upstream releases a newer stable version, it cherry-picks the
downstream commits onto that tag in a throwaway checkout. It runs the affected
tests, type checks, and builds the binary. On success it uploads a patch series;
it does not update the branch, release an artifact publicly, or deploy.

To bring the candidate forward locally, fetch the upstream tag, make a fresh
branch from the tag, and apply the downloaded series with `git am`. If replay
stops at a conflict, use the workflow log to find the conflicting commit, check
whether the upstream change already covers it, and resolve it on the fresh
branch. Update `.downstream-base` to the new tag. Compare the final diff against the new tag and repeat the tests before
updating `codex/maintained`. Verify desktop and gateway behavior before moving
a running gateway to a new binary.

Never add gateway configuration, credentials, request data, or environment
files to the downstream branch.
