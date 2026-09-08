# Merge game quality update

The two version-3 modes keep their existing physics, scoring, replay format and member records. This update improves the browser experience at `/games/jigglypuff/`.

- Aim by dragging; release to drop. Pointer cancellation does not drop. The landing ghost shows the current vertical collision estimate, while a cooldown ring and short late-input buffer make timing clearer.
- Interpolated rendering, merge pops, particles, floating points and consecutive-merge feedback are visual only. Reduced-motion preferences remove the larger effects. Animation bookkeeping is pruned as pieces disappear.
- Optional synthesized audio starts muted, activates through user gestures, and suspends when play pauses or the page is backgrounded.
- A result card distinguishes completion, overflow and examples. Confirmations protect an active match when restarting, changing modes or opening examples. Speed time counts active simulation time from the first drop; paused and background time remain excluded.
- The white and teal layout includes an expanded play view for portrait and landscape phones, next-piece preview, stage progress and an overflow meter. Gameplay buttons have at least a 44-pixel touch target.
- Completed ranked replays survive a reload in session storage if submission fails. Recovery is validated and requires an explicit retry; successful or discarded records are cleared. Storage failures remain recoverable while the page stays open.
- The existing release workflow explicitly includes the merge-game API in its deployment bundle.

Validation: the physics and real SQLite API suite, audio suite, submission-recovery suite and controller suite pass; the Cloudflare Functions build succeeds. The controller suite exercises actual inputs with the real engine, including pointer cancellation, queued drops, slow-frame timing, pause and confirmation state, stall recovery, and both examples without saving records. Browser checks cover drag/release, first-drop timing, pause, active-match confirmation, speed completion, endless clearing and continued play, sound controls and no console errors. Responsive checks cover 320x568 and 390x844 portrait plus 667x375 and 844x390 landscape, including expanded play without horizontal overflow. Physical iOS/Android devices were not used. No synthetic scores were submitted to the public rankings.
