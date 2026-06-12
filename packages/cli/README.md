# opensip-tools

The `opensip-tools` command — codebase analysis from the command line.

## Install

```bash
curl -fsSL https://opensip.ai/cli/install.sh | bash
```

## Quick start

```bash
cd your-project
opensip-tools                            # welcome screen
opensip-tools init                       # detect language, scaffold layout
opensip-tools fit --recipe example       # smoke-test the example check
opensip-tools sim --recipe example       # smoke-test the example scenario
```

## What's in the box

- **`fit`** — run fitness checks against your codebase (core command).
- **`fit-list`** — list available checks.
- **`fit-recipes`** — list available recipes.
- **`dashboard`** — open an HTML report in your browser.
- **`sim`** — run simulation recipes.
- **`init`** — detect language and scaffold `opensip-tools.config.yml`
  plus example checks/recipes/scenarios under `opensip-tools/`.
- **`sessions list|purge`** — manage stored session data.
- **`configure`** — set up an OpenSIP Cloud API key for `--report-to`.
- **`plugin list|add|remove|sync`** — manage npm-installed plugin
  packages declared in `plugins.<domain>:` (project-local).
- **`completion`** — print a shell-completion script for bash / zsh / fish.
- **`uninstall`** — remove `~/.opensip-tools/` (user-level cloud
  config) for a clean-slate reset. Project-local
  `opensip-tools/.runtime/` is gitignored — delete it manually if
  needed.

The CLI is a generic [tool dispatcher](https://github.com/opensip-ai/opensip-tools#tool-plugin-architecture):
fitness and simulation are first-party tools, but the underlying CLI
doesn't hardcode either. Adding a new tool — `audit`, `lint`, `bench`,
whatever — is a plugin operation.

## Full documentation

See the [repository README](https://github.com/opensip-ai/opensip-tools) for the complete reference — authoring plugins, CI integration, cloud reporting, configuration schema, and more.

## License

MIT
