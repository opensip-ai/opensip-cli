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
- **`sim`** — run simulation scenarios (experimental).
- **`init`** — generate a starter `opensip-tools.config.yml` targets file.
- **`dashboard`** — open an HTML report in your browser.
- **`plugin`** — install / list / remove plugin packages that contribute additional checks and recipes.
- **`completion`** — print a shell-completion script for bash / zsh / fish.
- **`uninstall`** — remove `~/.opensip-tools/` (plugins, sessions, logs) for a clean-slate reset.

## Full documentation

See the [repository README](https://github.com/opensip-ai/opensip-tools) for the complete reference — authoring plugins, CI integration, cloud reporting, configuration schema, and more.

## License

MIT
