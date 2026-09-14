# Kanto environment asset staging

134 genuine GLB 2.0 assets, 48.4 MB including shared textures, prepared 2026-09-08.

- `quaternius/`: all 68 free Standard Stylized Nature MegaKit models. Use these as the main foliage/rock style.
- `nature/`: 45 selected Kenney Nature Kit props, palms, shore plants, statues, bridges and caves.
- `survival/`: 21 selected Kenney Survival Kit camp, workshop and metal structure props.
- `environment-manifest.json`: sources, hashes, licenses, dependencies, mesh metadata, accessor bounds and modifications.
- `licenses/`: unmodified downloaded license files.

Keep each model directory together with its `textures/` subdirectory. GLBs contain real binary geometry and reference shared local images. No live external request is needed. Texture maps are intentionally shared rather than embedded repeatedly in dozens of tree GLBs.

All three sources were verified as **CC0 1.0** at the current official source and in the downloaded pack's license. Attribution is optional. Suggested credit: “Environment models by Quaternius and Kenney — CC0.” The downloads and original files remain untouched outside this runtime directory.

The 68-model free Quaternius Standard edition excludes premium-only content and premade engine shaders. No premium/source-edition files were used. A custom wind shader should move leaves/grass in the game's own engine; the static models have no skeleton animations.

## Integration notes

Use `GLTFLoader`, cache templates, clone mesh instances and reuse geometry/textures. Use `InstancedMesh` where the material supports it. Respect the Quaternius leaves' `alphaMode: MASK`, `alphaCutoff: 0.2`, and double-sided materials. Trees are around 7–16 meters tall at scale 1. Kenney assets are roughly 0.5–1.5 units tall; normalize with an actual scene `Box3` and then apply a desired height. Original node transforms matter: accessor bounds alone are not full scene bounds.

The Kenney Nature source incorrectly marks many wood/leaf/stone materials metallic=1. Prepared copies set metallic=0 and roughness=0.9. Other geometry, textures and animation data are preserved.

Structural verification passed for all 134 assets: GLB header/version/length, local texture references, buffer sizes and every buffer view. Rendering in the game still needs verification; this staging report does not claim a browser rendering pass.

## Biome palette suggestions

| Region | Model names (directory prefix as above) |
| --- | --- |
| Camp | `nature/tent_detailedOpen`, `nature/campfire_logs`, `survival/workbench`, `survival/chest`, `nature/sign` |
| Grassland | `quaternius/CommonTree_1`, `Grass_Common_Tall`, `Flower_3_Group`, `Rock_Medium_1` |
| Forest | `quaternius/CommonTree_2`, `TwistedTree_1`, `Fern_1`, `Mushroom_Common`, `Bush_Common` |
| River/lake | `nature/bridge_wood`, `nature/lily_large`, `nature/canoe`, `quaternius/Grass_Wispy_Tall` |
| Coast | `nature/tree_palmDetailedTall`, `tree_palmDetailedShort`, `nature/rock_largeA`, `quaternius/Pebble_Round_1` |
| Mountain | `quaternius/Pine_1`, `Pine_3`, `Rock_Medium_2`, `nature/rock_tallA` |
| Cave | `nature/cliff_cave_rock`, `nature/rock_tallC`, `quaternius/Mushroom_Laetiporus`, `Rock_Medium_3` |
| Wetland | `nature/lily_small`, `crops_bambooStageB`, `hanging_moss`, `quaternius/Grass_Wispy_Tall` |
| Power plant | `survival/structure-metal`, `structure-metal-wall`, `structure-metal-roof`, `barrel`, `workbench-anvil` |
| Haunted ruins | `nature/statue_columnDamaged`, `statue_obelisk`, `statue_head`, `quaternius/DeadTree_1`, `DeadTree_3` |
| Safari | `nature/tree_plateau`, `fence_simple`, `fence_gate`, `quaternius/Grass_Common_Tall` |
| Volcanic | `quaternius/DeadTree_2`, `Rock_Medium_1`, `nature/rock_tallA`, `cliff_cave_rock` with dark material tint |
| Frozen altitude | `quaternius/Pine_2`, `Rock_Medium_2`, `nature/stone_tallA` with snow material/shader treatment |
| Secret laboratory | `survival/structure-metal`, `structure-metal-floor`, `structure-metal-doorway`, `workbench`, `box-large` |

Landmarks, water, volcanic fissures, snow cover, laboratories and boss staging still need deliberate game composition. These props alone do not constitute finished region design.

## Exact sources

- [Quaternius official page](https://quaternius.com/packs/stylizednaturemegakit.html)
- [Author's free Standard upload](https://opengameart.org/content/stylized-nature-megakit)
- [Kenney Nature Kit](https://kenney.nl/assets/nature-kit)
- [Kenney Survival Kit](https://kenney.nl/assets/survival-kit)
- [CC0 legal dedication](https://creativecommons.org/publicdomain/zero/1.0/)

Rebuild with `python .kanto-work/environment/prepare_environment.py` from the workspace root.
