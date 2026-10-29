# Collection implementation checkpoint — 2026-10-29

Status: INCOMPLETE. This branch is a recovery checkpoint, not a release and not a production deployment.

The local Windows execution environment disconnected during integration. Shell execution fails during sandbox provisioning; Node and computer-use transports also closed. Connected GitHub tools remain available. This checkpoint preserves code and source evidence that had already been transferred before that failure. It does not replace the final local working copy or establish that the full release gate passed.

## Accepted scope

- Keep the existing sidebar Card Info entry. Append Collection immediately after Chiikawa in its game-tab row, as annotated by the user.
- Collection contains Artist, Character, and Personal collection views. Collection buttons and collection ownership state belong only to that tab.
- Eight curated artist recommendations with credited representative artwork; all remaining supported artist labels searchable. Pokémon: Shinji Kanda, Mitsuhiro Arita, AKIRA EGAWA, Tomokazu Komiya. One Piece: Eiichiro Oda, Gege Akutami, Boichi, Peach Momoko. Do not describe these as a measured popularity ranking or count studios/aliases as individual people.
- Character collectors include Beedrill and Scizor, with Korean/English aliases, explicit language/game scope, optional mega/forms and optional evolution-family inclusion.
- Personal collections are explicit card snapshots: create, rename, delete, individually add/remove cards, manual owned/missing and progress. Adding new public data must not silently grow an existing collection.
- Do not introduce box/set collection creation. The separately approved rarity filter stays in the existing Card Info box slide panel beside its count, before pagination/counts, using actual source rarity values and multi-select OR.
- Do not change holdings or transaction quantities when a user checks collection ownership.

## Preserved here

The collection frontend module/styles/packed-shard codec, private API/schema/account-deletion hook, test sources and portable DOM fixture, release-gate scaffold, existing adapter changes, deployment-copy/CI edits, and the extra English/Chinese artist-source snapshot are preserved from previously uploaded immutable objects.

Important: index.html integration, rarity helper/enrichment metadata, the catalog builder, final generated catalog/card/key shards/manifest, and some later fixes were still local-only when the environment disconnected. The preserved code cannot be deployed as a complete feature.

## Required before release

1. Restore the final local implementation worktree and compare every file to this checkpoint. Do not stage deletions from the partial worktree.
2. Recover final frontend fixes (cryptographic UUID fallback, Collection deep links, strict verified source-card exceptions). Finish the personal-view card picker for all eligible baseline cards, including Item cards with no artist or character metadata.
3. Recover the latest private API verified-exception change. The last local API suite reported 23 passing tests; that result must not be attributed to this earlier checkpoint snapshot without rerunning.
4. Finish and validate the generated public registry: all 62,242 baseline rows, all 16 key shards, four lossless packed card shards, version-consistent catalog and manifest, and a portable offline builder with committed source inputs.
5. Audit all 43 official Shinji Kanda source entries against final canonical targets. Treat exact duplicate artwork/printings explicitly and report unresolved matches.
6. Verify the three officially confirmed source-only One Piece printings (Oda ST01-012_p3 / ST01-012_p4 and Boichi P-028_p1). Only exact boolean characterDiscoveryVerified=true plus correct character membership may opt them into character discovery; sourceOnly remains true and never derives automatic asset ownership.
7. Restore the rarity patch utility, exact-source enrichment and post-await stale-request guards. Unknown/conflicting rarity stays unknown. Do not globally infer MHR/MUR or assign rarity from print-number position.
8. Apply the index auth/script/tab integration and cache query versions without disturbing unrelated concurrent work.
9. Run the complete release gate and the real deployment bundle checks. Verify account-switch isolation, lost-response retries, revision conflicts, arbitrary-card picking and outside-tab behavior.
10. Rebase/merge against the current main branch and preserve concurrent changes. Deploy only the complete passing build; then verify live deep links, public assets and anonymous private API rejection.

## Recovery identifiers

- Original base commit: e986e6b43bd493fa21176453e10a5c694606da77.
- Previously prepared code tree: 5068f6f4da869cbcc8c9c5aae58472e4d79f84da.
- English/Chinese artist-source blob: 28a99f0b4d0947056aef328494a51a8083a5d7ed.
- Last local backend Git blob hash (not confirmed uploaded): c0dbffbd86a1de99ded1f220cb97899a13588a10.
- Last locally verified frontend SHA-256 before the unfinished manual picker: 0e8e9a53985a763af88c19b1800da0d57ec0fb90694f06d42bda1bc0840a8ecd.

No real-user collection writes or production deployment were performed for this checkpoint.
