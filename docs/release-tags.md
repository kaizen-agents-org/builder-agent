# Release tag checklist

The organization-level [release tag guide](https://github.com/kaizen-agents-org/.github/blob/main/docs/release-tags.md)
defines compatible component sets. Do not redefine compatibility here:
`.github/onboarding/versions.json` is the source of truth for the set installed
by the onboarding kit.

Before tagging a builder-agent commit, run the same checks as CI from a clean
checkout:

```sh
npm ci
npm run check:dist
npm test
npm run validate:json
node dist/cli.js --version --json
```

The onboarding installer clones the pinned tag, installs development
dependencies, runs `npm run build`, and links that checkout. A release must not
depend on uncommitted generated output or an older globally linked
`builder-agent`.

After publishing the tag, update the organization manifest, run its installer,
and set `BUILDER_AGENT_CANDIDATE_REF` to the released tag or commit. Then verify
the installed checkout revision, global package link, and resolved command:

```sh
set -eu
: "${BUILDER_AGENT_CANDIDATE_REF:?Set the released builder-agent tag or commit}"
builder-agent --version --json
builder_agent_command="$(command -v builder-agent)"
builder_agent_link="$(npm prefix -g)/lib/node_modules/@kaizen-agents/builder-agent"
builder_agent_checkout="${KAIZEN_HOME:-$HOME/.kaizen}/toolchain/builder-agent"
test -d "$builder_agent_link"
test -d "$builder_agent_checkout"
test "$(cd "$builder_agent_link" && pwd -P)" = \
  "$(cd "$builder_agent_checkout" && pwd -P)"
builder_agent_command_real="$(node -e \
  'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' \
  "$builder_agent_command")"
builder_agent_cli_real="$(node -e \
  'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' \
  "$builder_agent_checkout/dist/cli.js")"
test "$builder_agent_command_real" = "$builder_agent_cli_real"
candidate_commit="$(git -C "$builder_agent_checkout" rev-parse --verify \
  "${BUILDER_AGENT_CANDIDATE_REF}^{commit}")"
test "$(git -C "$builder_agent_checkout" rev-parse HEAD)" = "$candidate_commit"
```

Finally, validate the complete pinned set through the organization release
checklist. Do not advance the builder-agent pin independently of that
compatible-set verification.
