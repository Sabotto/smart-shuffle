# True & Smart Shuffle (TidaLuna plugin)

Replaces TIDAL's shuffle with a more random and customizable shuffle. Built for TidaLuna 1.21.9-beta.

## Install

In TidaLuna: **Settings → Plugin Store → Install from URL**, paste:

```
https://github.com/Sabotto/smart-shuffle/releases/download/latest/store.json
```

The store appears with a **True & Smart Shuffle** card (name, author, version). Install it, then open the plugin's settings.

## Develop

```sh
pnpm install
pnpm run watch   # builds + serves on http://127.0.0.1:3000, shows up as the [DEV] store in Luna
```

Repo layout follows the official [luna-template](https://github.com/Inrixia/luna-template): plugin source lives in `plugins/SmartShuffle`, and `pnpm run build` writes `dist/store.json`, `dist/sabotto.smart-shuffle.json` and `dist/sabotto.smart-shuffle.mjs`.

## Releasing

Pushing to the default branch runs `.github/workflows/releaseMaster.yml`, which publishes `dist/` to the `latest` release.
Requires **Settings → Actions → General → Workflow permissions → Read and write permissions**.
