# apps/web-tools

Vite + React + TypeScript app deployed to Cloudflare. Hosts three things:
- **Simulator** - drive the WASM `web-simulator` from a browser UI to try out patterns and inputs without flashing.
- **Trajectory grapher** - plot what Ruckig would do for a given motion sequence (uses `trajectory-recorder`).
- **Web flasher** - flash firmware to a connected ESP via Web Serial. Pulls release artefacts from GitHub plus per-PR artefacts from R2.

`pnpm`, Node 24, React 19. Radix UI for components. `react-three-fiber` for the 3D scene. `esptool-js` for the flasher.

Vite layout: `index.html` + `src/main.tsx` entry; routed pages under `src/pages/`; React hooks under `src/hooks/`; the Hono worker for `/api/*` under `src/api/`. `wrangler.toml` configures the Cloudflare Pages deploy.

## Building

`apps/web-tools` consumes the WASM packages via `link:`:

```json
"@ossm-rs/web-simulator": "link:../../bindings/web-simulator/pkg",
"@ossm-rs/trajectory-recorder": "link:../../bindings/trajectory-recorder/pkg"
```

So before `pnpm dev` works, the WASM has to be built. The [justfile](../justfile) handles this:

```sh
just web-tools     # build-wasm + pnpm dev --host
```

If a Rust change in `ossm/`, `pattern-engine/`, or a binding doesn't appear in the running app, kill `web-tools` and rerun. Vite caches the linked package and won't always pick up rebuilds.

## Backend

There's a tiny Hono worker in `src/api/` deployed alongside the static site as a Cloudflare Worker (see [wrangler.toml](../apps/web-tools/wrangler.toml)). It does:
- Proxies GitHub release asset downloads to bypass CORS.
- Fetches PR firmware artefact lists from R2.

The flasher needs both because flashing happens in the browser via Web Serial, but the artefacts live behind GitHub or R2 access controls.

## Per-PR firmware flow

A PR that touches firmware triggers [.github/workflows/build-firmware.yml](../.github/workflows/build-firmware.yml). Built artefacts are uploaded to R2. [.github/workflows/upload-firmware.yml](../.github/workflows/upload-firmware.yml) posts a comment on the PR with flash links pointing to `/flash/pr/<number>`.

The flasher page resolves the PR number to the artefact list, lets the user pick a board, downloads the binary, and flashes it. This is the path most contributors use to test changes on hardware before merging.

The board names the flasher offers (`ossm-alt`, `waveshare`, `seeed-xiao`, `ossm-reference`) are the firmware bin names. Each one corresponds to a `[[bin]]` entry under `firmware/esp32s3/src/bin/` or `firmware/esp32/src/bin/` plus a matching `flash-<name>` recipe in the [justfile](../justfile). See [firmware.md](firmware.md) for the per-bin layout when adding or renaming a target.

## Web Serial

Browser support: Chromium-based (Chrome, Edge, Arc, Opera). Firefox does not implement Web Serial. The flasher detects this and shows a message.

`esptool-js` does the heavy lifting: chip detection, partition writes, MD5 verify. The bootloader / partition table / app bin layout matches what `espflash` produces from `cargo +esp run --release`.

## When to change this app

- New simulator UI controls. Plumb them through `useSimulator.ts` to the WASM.
- New flasher feature (e.g. log streaming after flash). The simulator and flasher are independent; don't entangle them.
- New page. Add a route in `Layout.tsx`, a page in `pages/`. Keep API logic in `src/api/` so the Worker entry stays clean.

## When not to

- Changing motion/pattern behavior. That belongs in the Rust crates, not the React app.
- Adding state that should live in the simulator. Push into the WASM so the firmware behaves the same.
- Adding a TypeScript shim for behavior that should be in `pattern_engine::commands`. The point of those parsers is that they're shared.
