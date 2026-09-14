# Kanto 151 — credits and licenses

Private, noncommercial fan game for personal use in TCG Hub. Pokémon names and characters belong to Nintendo, Game Freak and Creatures. Third-party fan-asset licensing does not grant ownership of the underlying Pokémon intellectual property. No affiliation or endorsement is implied.

## Pokémon assets

**Cobblemon team and contributing artists** — [Cobblemon Assets](https://gitlab.com/cable-mc/cobblemon-assets), [Generation 1 sources](https://gitlab.com/cable-mc/cobblemon-assets/-/tree/master/blockbench/pokemon/gen1). **Creative Commons Attribution–NonCommercial 3.0 Unported**. The current repository and Gen 1 licenses were inspected on September 8, 2026 before use. Source asset revision: `b3492e4396fdaf1235d1d9721a7de6f3d79f06df`. Runtime exports: Cobblemon revision `0d9a4f939219e48fcbda2548827abb950a04b065`.

Specific files, source URLs, SHA-256 hashes and sizes: `reports/asset-provenance.json`. Individual model licenses remain beside their original geometry in `assets/cobblemon/bedrock/pokemon/models/`. Full license and adaptation notes: `licenses/` and `licenses/COBBLEMON-ADAPTATIONS.md`.

The original geometry, animation JSON and texture bytes are preserved. The original browser adapter converts Bedrock geometry into Three.js buffers, merges cubes per bone, interprets keyframes and arithmetic Molang expressions, normalizes coordinate direction and ground alignment, and loads normal/shiny/emissive/animated texture layers. Expression repairs and neutral substitutes for Minecraft-only inputs are documented in `reports/expression-repairs.json`. Upstream game audio and particle-event references are replaced by this game's own effects.

## Environment

**Quaternius** — [Stylized Nature MegaKit Standard](https://quaternius.com/packs/stylizednaturemegakit.html), free Standard edition from the author's [OpenGameArt upload](https://opengameart.org/content/stylized-nature-megakit). **CC0 1.0**. 68 licensed models converted from glTF to genuine GLB with shared local texture images.

**Kenney** — [Nature Kit](https://kenney.nl/assets/nature-kit) and [Survival Kit](https://kenney.nl/assets/survival-kit). **CC0 1.0**. Selected camp, landscape and industrial props. Nonmetal nature materials corrected to metallic=0 and roughness=0.9; camp materials tinted for consistency.

Current official pages and bundled licenses were checked before use. Per-file source/hash/conversion records: `assets/environment/environment-manifest.json`. Original licenses: `assets/environment/licenses/`. Scene composition, terrain, water, wind, lighting, weather, landmarks and effects are original project code.

## Data and software

**PokéAPI contributors** — [PokéAPI](https://github.com/PokeAPI/pokeapi), **BSD 3-Clause**, pinned revision `d4f9a4af58ade123fbc0558f68b1c69daa97d9e4`. Species metadata, modern types/stats, FireRed/LeafGreen learnsets, evolution relations and move facts. Runtime balance, habitat rules and descriptions are original adaptations. Exact cached-file provenance: `data/provenance.json`. License: `licenses/POKEAPI-LICENSE.md`.

**Three.js authors** — [Three.js](https://threejs.org/), version 0.180.0, **MIT**. Local runtime, GLTFLoader and BufferGeometryUtils. License: `licenses/THREE-MIT.txt`.

## Music and sound

Original synthesized score, ambience, sound effects, capture cues, evolution and registration motifs generated through the Web Audio API in `src/audio.mjs`. No external audio files and no official Pokémon game music, cries, ROM/APK/console-game models or ripped textures are included.

## Polish Pass 02

Korean and English species, move, type and item names were cross-checked against the pinned PokéAPI localized CSV tables (Korean language 3, English 9). Exact source hashes are in `reports/localization-provenance.json`; authored action descriptions are generated from the actual 325-move runtime mechanics. Original flavor prose was not copied. Reproduction instructions and the reviewed data overlay are in `scripts/pipeline-polish/`.

Fourteen authored region compositions, 43 landmarks, ecology pockets, terrain, traversal, Korean/English expedition prose, hit feedback, signature presentations and procedural audio are original additions. Existing GLB source bytes remain unchanged; regional canopy color preserves texture alpha and luminance in a runtime shader. The changes and test limitations are documented in `reports/POLISH_PASS_02.md`.
