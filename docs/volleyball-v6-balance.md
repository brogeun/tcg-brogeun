# Volleyball rules v6

Rebalance easy, normal and hard after v5 became too forgiving, particularly with the mobile jump-attack combo.

- Easy runs faster and attempts more jump returns while retaining slow decisions and simple attacks.
- Normal and hard choose attack timing by court position: a late, fast upward return in the back court; a reachable aerial strike near the net only when the predicted arc clears it.
- Hard reacts faster than normal and retains emergency slide defense. Running speed remains below the player; player movement, collision, jump, slide and spike physics are unchanged.
- Preserve the exact v3/v4/v5 simulation for already-issued sessions. New sessions use v6. Existing leaderboard records remain intact.
- Refresh all browser module cache versions together.

## Validation

- 120 fixed runs (8 seeds x 3 modes x 5 strategies), including the actual mobile input controller: all finish within 10 minutes. Basic touch wins: easy 8/8, normal 2/8, hard 0/8. Practiced touch wins: easy 8/8, normal 8/8, hard 3/8. These are automated strategies, not human win rates.
- 216 additional runs (24 new seeds x 3 modes x 3 strategies). All completed when the three hard/practiced-touch traces exceeding the initial 10-minute test cap were continued; longest 703 seconds. Difficulty ordering held for basic mobile inputs. Strong keyboard timing can still reliably beat hard; this is not an unbeatable AI.
- Regression checks cover unsafe back-court spikes, fast upward returns, near-net attacks, delayed/score-independent AI, unchanged player physics, touch concurrency, fullscreen/rotation, rendering fallback, feedback, rankings and exact old replay fixtures.
- Local Cloudflare Worker build succeeds. Tests use isolated SQLite and do not write public scores.
