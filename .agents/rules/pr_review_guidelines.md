# Pull Request Review & Merge Guidelines

1. **Never Merge Failing CI**:
   - Always run and verify that all automated unit tests, integration tests, contract tests, and static checks (TypeScript/Linter) pass 100% cleanly before executing a merge into `main`.

2. **Constructive Contributor Feedback**:
   - If a PR contains test failures, missing validation, gas inefficiencies, or breaking changes, leave clear, actionable review comments on GitHub using `gh pr review --comment` or `gh pr review --request-changes` so the contributor can fix the issue.

3. **Thorough Conflict Resolution & Clean Diffs**:
   - Resolve all merge conflicts cleanly before merging into `main`.
   - Never merge branches with stale upstream diff pollution or unhandled conflict markers.
