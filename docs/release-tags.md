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
`builder-agent`; confirm the version command resolves to the candidate checkout.

After the organization installer links the pinned set, verify both the command
and its global package link:

```sh
set -eu
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
```

After publishing the tag, update the organization manifest and validate the
complete pinned set through the organization release checklist. Do not advance
the builder-agent pin independently of that compatible-set verification.
