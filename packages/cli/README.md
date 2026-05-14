# @opensip-tools/cli

The `opensip-tools` command — codebase analysis from the command line.

## Install

```bash
npm install -g @opensip-tools/cli
```

## Quick start

```bash
cd your-project
opensip-tools             # welcome screen
opensip-tools init        # create a targets config
opensip-tools fit         # run fitness checks
```

## What's in the box

- **`fit`** — run fitness checks against your codebase (core command).
- **`fit-list`** (alias `list-checks`) — list available checks.
- **`fit-recipes`** (alias `list-recipes`) — list available recipes.
- **`dashboard`** — open an HTML report in your browser.
- **`sim`** — run simulation scenarios (experimental).
- **`init`** — generate a starter `opensip-tools.config.yml` targets file.
- **`sessions list|purge`** — manage stored session data.
- **`configure`** — set up an OpenSIP Cloud API key for `--report-to`.
- **`plugin list|install|remove|sync|add`** — manage plugin packages
  that contribute additional checks and recipes.
- **`completion`** — print a shell-completion script for bash / zsh / fish.
- **`uninstall`** — remove `~/.opensip-tools/` (plugins, sessions, logs) for a clean-slate reset.

The CLI is a generic [tool dispatcher](https://github.com/opensip-ai/opensip-tools#tool-plugin-architecture):
fitness and simulation are first-party tools, but the underlying CLI
doesn't hardcode either. Adding a new tool — `audit`, `lint`, `bench`,
whatever — is a plugin operation.

## Full documentation

See the [repository README](https://github.com/opensip-ai/opensip-tools) for the complete reference — authoring plugins, CI integration, cloud reporting, configuration schema, and more.

## License

MIT
