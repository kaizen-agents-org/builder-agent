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

After publishing the tag, update the organization manifest and validate the
complete pinned set through the organization release checklist. Do not advance
the builder-agent pin independently of that compatible-set verification.
