# Cobblemon assets used by Kanto151

Pokémon models, textures and animations: **Cobblemon team and contributing artists**. Original project: [Cobblemon Assets](https://gitlab.com/cable-mc/cobblemon-assets), [Generation 1 source assets](https://gitlab.com/cable-mc/cobblemon-assets/-/tree/master/blockbench/pokemon/gen1). License: [Creative Commons Attribution–NonCommercial 3.0 Unported](https://creativecommons.org/licenses/by-nc/3.0/). Full license is preserved in `public/licenses/Cobblemon-CC-BY-NC-3.0.txt` and the upstream per-model `license` files remain beside each geometry.

The CURRENT original asset repository root LICENSE and Gen 1 LICENSE were inspected directly on GitLab on 2026-09-08 before downloading models. Both identify CC BY-NC 3.0 Unported. Each of the 151 runtime model directories also contains the matching noncommercial license. This is a private, noncommercial fan project; Pokémon IP rights are separate from the contributing artists' asset license. Pokémon and associated names belong to their respective owners; no official game music, cries, textures or ripped model data are included.

## Exact sources

- Original asset repository revision observed: `b3492e4396fdaf1235d1d9721a7de6f3d79f06df`.
- Runtime exports obtained from [Cobblemon repository, pinned revision](https://gitlab.com/cable-mc/cobblemon/-/tree/0d9a4f939219e48fcbda2548827abb950a04b065/common/src/main/resources/assets/cobblemon): `0d9a4f939219e48fcbda2548827abb950a04b065`.
- Source paths used: `common/src/main/resources/assets/cobblemon/bedrock/pokemon/{models,animations,resolvers,posers}/0001_bulbasaur` through `0151_mew`, and corresponding `textures/pokemon` directories.
- The original resource bytes remain unchanged. `public/asset-provenance.json` lists every specific imported file, its source URL, byte length and SHA-256. The manifest records each species' resolved base model, normal/shiny textures, animation files, layers, forms, gender variants and source links.
- 151 species; 226 geometry variants; 185 animation files containing 1,960 clip definitions / 1,954 distinct names within species; 743 texture files. All 151 have normal and shiny textures. Seventeen base species use emissive layers; five use animated texture layers.

## Attribution requirements preserved

Credit the original project and contributing artists, identify the source and license, preserve copyright/license notices and explain adaptations. The materials may be shared/adapted only under the applicable noncommercial license terms. No endorsement by Cobblemon contributors or Pokémon rights holders is implied. Do not remove the per-model licenses or source inventory when moving the game assets.

## Runtime adaptation

The browser adapter is original project code. It parses the original Bedrock geometry and animation JSON; it does not rename files to pretend they are GLB. Geometry is combined per bone, transformed from Bedrock coordinates and oriented toward +Z. Pixel textures retain their UVs and alpha; normal/shiny switching uses original texture variants. Emissive and animated texture layers use the resolver metadata.

Animation supports authored numeric transforms, linear and Catmull–Rom keyframes with pre/post values, degrees-based sine/cosine expressions, scalar/vector scales, named clips and bone hierarchy. A safe arithmetic parser interprets expressions without JavaScript evaluation. The source has a small number of malformed expressions: `ath.sin` is interpreted as `math.sin`; omitted multiplication operators are made explicit; literal `NaN` offsets are treated as zero to keep transforms finite. Raw source files are preserved. `public/expression-repairs.json` records every affected source expression and file.

Minecraft-specific riding input/history queries are mapped to movement/yaw/vertical velocity when available and neutral zero otherwise; `v.foot` uses a gait amplitude of 15. Random transform expressions use a stable midpoint to avoid frame jitter. Upstream sound/particle event references are not played because their game-runtime dependencies are absent; this game supplies original move/audio effects separately. Forty-seven species use Kotlin posers upstream, so browser semantic clip selection supplies their idle/walk/battle/faint mappings. Regional clip name collisions preserve the base species definition.

## Verification

`python audit_assets.py` rebuilds the manifest and validates all151 resolved geometry/normal/shiny/layer paths, PNG signatures, animations and bone parents. `node test-runtime.mjs` builds all226 geometry variants and evaluates all1960 animation definitions and17,237 unique expressions at multiple time points. The in-app browser ran `asset-preview.html` → **Audit all 151**: 151/151 passed GPU render, normal/shiny switching, four sampled animation times, finite scene bounds and WebGL error checks. No browser console warning/error remained. The species cache stayed at24 with one active preview. A hero grid and individual normal/shiny models were visually inspected.

Reports: `public/asset-audit.json`, `public/runtime-structural-audit.json`, `public/browser-runtime-audit.json`. Browser verification is an asset importer check, not a claim that the overall game playthrough is complete.

## Reproduce and integrate

1. `python inspect_sources.py` records current upstream metadata/licenses. The checked-in provenance revision pins this acquisition.
2. `python fetch_archives.py` downloads two official GitLab directory archives and extracts only Gen1 files. Extraction uses explicit paths inside the staging tree; it never extracts archive-provided filesystem paths directly.
3. `python audit_assets.py` rebuilds the manifest and local audit.
4. `node test-runtime.mjs` checks conversion and animation math.
5. Serve this directory: `python -m http.server 8237 --bind 127.0.0.1`, then open `http://127.0.0.1:8237/asset-preview.html` to inspect or run the GPU audit.

Copy `public/cobblemon/` into the game's chosen asset root and `pokemon-manifest.json` beside game data. Instantiate `new PokemonResources(THREE, manifest, '/game/assets/cobblemon/')`. `await resources.create(id,{shiny:false,scale:1})` returns a grounded group facing+Z. Call `group.userData.update(dt,{moving,action,battle,hitFlash})` each frame and `group.userData.release()` when done. `setShiny(boolean)` changes variants. `preload(ids)` handles biome resources; the cache defaults to24 inactive/active species combined, evicting only unused resources. Limit shadow casters to nearby actors for performance.
