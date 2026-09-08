# Volleyball art — 2026-09-08

Generated with the built-in `image_gen.imagegen` tool. No fallback CLI, image conversion, resizing, or raster editing was used. Generated files were copied byte-for-byte into this workspace. Metadata and alpha bounds were inspected read-only.

## Delivered assets

- `charmander-atlas-v1.png`: 1254 × 1254, RGBA PNG, 806,599 bytes. Four smooth cel-shaded poses facing right: idle, airborne attack, horizontal slide/dive, victory.
- `coastal-court-v1.png`: 1672 × 941, opaque RGB PNG, 1,983,738 bytes. Tropical coastal background with open center, clean foreground sand, and no characters, equipment, or UI.
- `pikachu-ready-v1.svg`: 512 × 512 scalable transparent SVG, full-body ready pose from unchanged existing Dream World artwork paths. Mirrored in its wrapper to face right.
- `squirtle-ready-v1.svg`: 512 × 512 scalable transparent SVG, full-body ready pose from unchanged existing Dream World artwork paths.
- `manifest.json`: dimensions, source crops, optional body-center/baseline anchors, and source provenance.

The generated atlas follows a 2 × 2 arrangement but has slight quadrant drift in the dive pose. The manifest's individual crop rectangles prevent clipping and fit the actual figures. Character pixels have true alpha transparency; the dark preview surround is not a painted background. The scene is approximately 16:9 and can be drawn full-bleed at 960 × 540.

The character crops include a 6px transparent margin around alpha bounds measured at alpha > 32. Anchors are approximate render hints relative to each crop, with the x coordinate near the body center and y coordinate near the lowest foot/body edge. The renderer may use centered fitted crops instead.

## Unavailable requested assets

The image service rejected Pikachu and Squirtle atlas outputs with explicit safety-system output rejections, category `other`. A first concurrent batch did not surface its per-item failures; one retry for each then returned the explicit rejection. No filter bypass was attempted. Those new atlas files do not exist. The manifest instead includes ready-pose entries for the existing vector artwork described below.

## Existing vector artwork reuse

The existing repository files `games/jigglypuff/sprites/pikachu.svg` and `squirtle.svg` contain full-body Pokémon Dream World artwork wrapped in portrait-only crops. Their local `SOURCES.md` identifies [PokeAPI/sprites](https://github.com/PokeAPI/sprites), original paths `sprites/pokemon/other/dream-world/25.svg` and `7.svg`.

The new ready-pose SVG files reuse those exact vector paths without modifying any path data or character drawing. Only the enclosing viewport and crop were changed: the circular portrait clipping mask and colored backdrop were removed, full-body bounds were restored, and the Pikachu wrapper was mirrored for right-facing gameplay. The source-to-output path data comparison passes for all 54 Pikachu paths and 60 Squirtle paths. The original character artwork remains its original Dream World style; these SVGs are not generated animation atlases.

`reframe-source-art.mjs` documents and reproduces that reframing. It derives actual bounds analytically from the original quadratic Bézier path data and updates manifest crops for 512px intrinsic SVG dimensions. The game can use these ready images with the existing PMD slide poses. Pokémon character rights remain with their respective owners; this reuse does not alter the source rights.
## Exact prompt set

### pikachu-atlas-v1.png

```text
Use case: stylized-concept.
Asset type: production transparent PNG character animation atlas for a polished 2D side-view beach volleyball game.
Create ONE square image, exactly 2 columns and 2 rows of equal square animation cells, four separate full-body poses of the SAME character. Each cell occupies exactly one quadrant. Invisible cell boundaries at 50% image width and 50% image height. Every silhouette has generous transparent margins, never touches a cell edge, and never overlaps another cell. Character faces RIGHT in profile or slight three-quarter right in ALL four cells.
Pose order: TOP LEFT = ready idle stance, knees gently bent, eyes concentrating to the right, hands ready; TOP RIGHT = airborne athletic volleyball spike pose with one paw/hand high above head, the other lowered, body stretched upward, feet off ground; BOTTOM LEFT = clearly distinct LOW HORIZONTAL diving/slide pose, full body nearly horizontal, face to the right, both arms/paws reaching ahead to the RIGHT at low height, legs trailing to the LEFT, not sitting, not standing; BOTTOM RIGHT = cheerful happy victory pose, confident joyful grin with one arm/paw triumphantly raised. No volleyballs.
Production framing: same character anatomy, relative body size, proportions, coloring, and outline weight in all cells; full figure with all ears/tail/flame fitting each cell. Character approximately centered in each cell, standing or lowest point at about 85% of that cell's height. Each pose fills roughly 70-76% of its cell's available width or height, the horizontal dive slightly wider but with safe margins.
Style: beautiful hand-drawn Japanese anime game key art, smooth antialiased line art, clean confident dark contours, rich simple cel shading, gentle glossy highlights, vibrant warm colors, crisp readable silhouette at 80px, lovable accurate Pokémon design. Professional finished bitmap illustration, NOT pixel art, NOT low resolution, not 3D render.
Background: truly transparent alpha channel everywhere outside the four character cutouts, not white, not gray, not a painted checkerboard. No grid lines, text, numbers, labels, logos, borders, scenery, cast ground shadows, or detached decorative effects.
Subject: iconic Pikachu, vivid golden yellow mouse Pokémon, two long black-tipped ears, round red cheek patches, bright expressive black eyes, tiny snout, brown-backed lower zigzag lightning-bolt tail, two brown back stripes visible only where appropriate. Compact cute round athletic proportions, accurate recognizable Pikachu silhouette. No costume or accessories. Flame/electric effects absent; just clean character cutouts.
```

### charmander-atlas-v1.png

```text
Use case: stylized-concept.
Asset type: production transparent PNG character animation atlas for a polished 2D side-view beach volleyball game.
Create ONE square image, exactly 2 columns and 2 rows of equal square animation cells, four separate full-body poses of the SAME character. Each cell occupies exactly one quadrant. Invisible cell boundaries at 50% image width and 50% image height. Every silhouette has generous transparent margins, never touches a cell edge, and never overlaps another cell. Character faces RIGHT in profile or slight three-quarter right in ALL four cells.
Pose order: TOP LEFT = ready idle stance, knees gently bent, eyes concentrating to the right, hands ready; TOP RIGHT = airborne athletic volleyball spike pose with one paw/hand high above head, the other lowered, body stretched upward, feet off ground; BOTTOM LEFT = clearly distinct LOW HORIZONTAL diving/slide pose, full body nearly horizontal, face to the right, both arms/paws reaching ahead to the RIGHT at low height, legs trailing to the LEFT, not sitting, not standing; BOTTOM RIGHT = cheerful happy victory pose, confident joyful grin with one arm/paw triumphantly raised. No volleyballs.
Production framing: same character anatomy, relative body size, proportions, coloring, and outline weight in all cells; full figure with all ears/tail/flame fitting each cell. Character approximately centered in each cell, standing or lowest point at about 85% of that cell's height. Each pose fills roughly 70-76% of its cell's available width or height, the horizontal dive slightly wider but with safe margins.
Style: beautiful hand-drawn Japanese anime game key art, smooth antialiased line art, clean confident dark contours, rich simple cel shading, gentle glossy highlights, vibrant warm colors, crisp readable silhouette at 80px, lovable accurate Pokémon design. Professional finished bitmap illustration, NOT pixel art, NOT low resolution, not 3D render.
Background: truly transparent alpha channel everywhere outside the four character cutouts, not white, not gray, not a painted checkerboard. No grid lines, text, numbers, labels, logos, borders, scenery, cast ground shadows, or detached decorative effects.
Subject: iconic Charmander, cute smooth orange bipedal lizard Pokémon, creamy pale-yellow belly and underside, large expressive blue eyes, small muzzle, short arms with little claws, stubby legs, tapering long orange tail ending in its small bright red-orange/yellow flame. Accurate recognizable Charmander silhouette and tail flame included in every pose, no horns/wings. Tail and flame remain fully inside their own cell with generous padding. No costume or accessories.
```

### squirtle-atlas-v1.png

```text
Use case: stylized-concept.
Asset type: production transparent PNG character animation atlas for a polished 2D side-view beach volleyball game.
Create ONE square image, exactly 2 columns and 2 rows of equal square animation cells, four separate full-body poses of the SAME character. Each cell occupies exactly one quadrant. Invisible cell boundaries at 50% image width and 50% image height. Every silhouette has generous transparent margins, never touches a cell edge, and never overlaps another cell. Character faces RIGHT in profile or slight three-quarter right in ALL four cells.
Pose order: TOP LEFT = ready idle stance, knees gently bent, eyes concentrating to the right, hands ready; TOP RIGHT = airborne athletic volleyball spike pose with one paw/hand high above head, the other lowered, body stretched upward, feet off ground; BOTTOM LEFT = clearly distinct LOW HORIZONTAL diving/slide pose, full body nearly horizontal, face to the right, both arms/paws reaching ahead to the RIGHT at low height, legs trailing to the LEFT, not sitting, not standing; BOTTOM RIGHT = cheerful happy victory pose, confident joyful grin with one arm/paw triumphantly raised. No volleyballs.
Production framing: same character anatomy, relative body size, proportions, coloring, and outline weight in all cells; full figure with all ears/tail/flame fitting each cell. Character approximately centered in each cell, standing or lowest point at about 85% of that cell's height. Each pose fills roughly 70-76% of its cell's available width or height, the horizontal dive slightly wider but with safe margins.
Style: beautiful hand-drawn Japanese anime game key art, smooth antialiased line art, clean confident dark contours, rich simple cel shading, gentle glossy highlights, vibrant warm colors, crisp readable silhouette at 80px, lovable accurate Pokémon design. Professional finished bitmap illustration, NOT pixel art, NOT low resolution, not 3D render.
Background: truly transparent alpha channel everywhere outside the four character cutouts, not white, not gray, not a painted checkerboard. No grid lines, text, numbers, labels, logos, borders, scenery, cast ground shadows, or detached decorative effects.
Subject: iconic Squirtle, cute light-blue turtle Pokémon, smooth large round head, big expressive dark reddish-brown eyes, pale cream segmented front belly shell, round brown turtle shell with cream rim on its back, short blue limbs with tiny claws, curled blue squirrel-like tail. Accurate recognizable Squirtle silhouette, compact cute athletic proportions. No costume, sunglasses or accessories.
```

### coastal-court-v1.png

```text
Use case: stylized-concept.
Asset type: landscape BACKDROP ONLY for a polished 2D side-view beach-volleyball game.
Create one beautiful wide 16:9 illustration: a tropical coastal Pokémon-inspired beach stadium in radiant late-morning sunshine. Open pastel aqua sky with soft fluffy clouds; turquoise ocean and far green islands; breezy palm trees, lush seaside vegetation, tasteful wood beach grandstands and sun umbrellas on far edges. Painterly hand-drawn Japanese animated game environment with polished cel-shaded forms, beautiful clean shapes, subtle texture, rich luminous color, inviting summer holiday atmosphere. Consistent camera straight across a side-view volleyball arena, not an aerial or perspective playing-court view.
Composition is a clean playable background: the distant ocean horizon sits around 57-60% of image height; broad open airy central area; distant grandstands small and only left/right sides; bottom third is SIMPLE SMOOTH WARM SAND, broad horizontal flat foreground with only very subtle texture. Preserve uncluttered central action visibility. A code renderer will draw the actual horizontal court floor across the lower third, so do not paint a court diagram.
No characters, Pokémon, people, spectators with visible faces, silhouettes, net, poles, ropes, volleyballs, balls, court lines, sports equipment, text, branding, logos, UI, scoreboards, borders, watermark. This is scenery only. Opaque full-bleed polished finished 16:9 background illustration.
```
