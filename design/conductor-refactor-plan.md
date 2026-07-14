# Coolie → Conductor-style Refactor Plan (Phase 1: Visual)

Status: REVIEWED via /plan-eng-review (2026-07-14) — scope reduced to visual-only.
Scope: GUI chrome only (`packages/client`). No server/protocol changes. No behavior change.

## Goal

Make Coolie's chrome look **exactly like Conductor** (warm off-white, near-monochrome
macOS), while the center stays a **real xterm terminal**. Palette + settings sampled
pixel-for-pixel from the live Conductor.app; approved mockup: `design/Coolie macOS Redesign.html`.

## Constraints (hard)
1. Keep the terminal. No change to `CenterArea` / `TerminalView` / F3 keepalive.
2. No server/protocol/store changes. Pure CSS + markup + xterm colors.
3. Light-first, warm, monochrome. No blue accent. Active/toggle = near-black `#2b2826`.
   Theme still system/light/dark via `data-theme` (`settings/theme.ts` mechanism kept).

## Review decisions (locked)
- **D1 Footer → minimize.** Keep the bar but make it a thin, muted 1-line status bar
  (not removed). Keep `footerHints()` export intact (`footer.test.ts` imports it).
- **D2 Sidebar status → CSS-only dot.** `wsBadge()` and `sidebar-badge.test.ts`
  untouched (test asserts `glyph==="●"`). CSS hides the glyph text and draws a colored
  dot from the existing `cls` (`b-working/b-await/b-error/b-idle/...`).
- **D3 Vibrancy → native.** Rely on the app's native `window-vibrancy` (transparent
  body). Use solid warm tokens; **no CSS `backdrop-filter`** (redundant + GPU cost).
- **D4 History → skip.** Sidebar = Projects → workspace rows only. No dead History row.

## Design tokens (sampled from live Conductor, light)
```
--chrome #fcfcfb  --content #ffffff  --card #fafaf9  --composer #fdfdfc
--row-hover #f4f3f1  --row-sel #eeedeb
--text #2b2826  --text-2 #6f6b66  --text-3 #9a958f  --text-4 #b8b3ac
--line #ececea  --line-2 #e4e2df  --pill #efeeec  --hot #b07d5e
```
Dark = warm charcoal set (mockup `html[data-theme="dark"]`). Mono = Geist Mono → SF Mono.
`:root` default = light values (avoid dark FOUC before theme resolves).

## What already exists (reuse, don't rebuild)
- Theme switch: `settings/theme.ts` + `data-theme` + `useSettings.theme` — recolor only.
- Sidebar status: `wsBadge()` → keep; restyle `.badge` in CSS.
- Footer hints: `footerHints()` pure fn → keep; only the component chrome shrinks.
- Column layout in `App.tsx` — unchanged.

## File-by-file changes (Phase 1)
1. `packages/client/src/styles.css` — rewrite `:root` / `[data-theme]` tokens to the warm
   palette; restyle `.titlebar`, `.sidebar/.side-*/.proj-h/.ws-row/.ws-branch`,
   `.badge`→dot, `.tabsbar/.tab`→segmented, `.composer/.composer-box`,
   `.right-open/.right-head`, `.app-footer`→thin muted. No `backdrop-filter`.
   Mono family → `"Geist Mono", "SF Mono", ui-monospace, …` (terminal/diff only).
2. `packages/client/src/settings/theme.ts` — recolor `terminalTheme()` (light bg warm,
   dark `#1e1f24`, cursor near-black/accent).
3. `packages/client/test/theme.test.ts` — **update** `terminalTheme("light").background`
   assertion (line 41) to the new light bg. (Required — this test breaks otherwise.)
4. `packages/client/src/chrome/Titlebar.tsx` — center = `project › ws` breadcrumb
   (lookup `projects.find(p=>p.id===ws.projectId)`) + branch pill; keep conn/theme/lang.
5. `packages/client/src/sidebar/Sidebar.tsx` — project row as collapsible group header
   (monogram + name); workspace rows unchanged in logic (dot via CSS). No History.
6. `packages/client/src/composer/Composer.tsx` — wrap to Conductor card markup; no logic.
7. `packages/client/src/chrome/Footer.tsx` — shrink to thin muted status bar; keep
   `footerHints()` export.

## Test plan
- Existing suite must stay green: `sidebar-badge.test.ts` (glyphs preserved via D2),
  `footer.test.ts` (`footerHints` preserved via D1), `theme.test.ts` (assertion updated).
- No new unit logic in Phase 1. Primary verification = light + dark screenshot diff
  against `design/Coolie macOS Redesign.html`.
- Run: `bun test` in `packages/client` before/after.

## Failure modes
- FM1 (perf/correctness) — double vibrancy (CSS blur + native). Avoided by D3.
- FM2 (visual regression, silent) — global token rewrite leaves a modal/picker/palette
  reading a renamed/removed var → invisible or low-contrast text. **Mitigation:** grep
  every `var(--…)` usage across `styles.css` + scoped CSS; keep the same token *names*,
  only change *values*. Verify command palette (⌘K), cheatsheet (⌘/), keybinding
  settings (⌘,), toasts, dispatch panel visually.
- FM3 (test break) — `theme.test.ts` light-bg assertion. Covered by change #3.

## NOT in scope (deferred)
- **Diff-in-center** (clicking a diff opens in the center panel). Deferred to a future
  Phase 2 — it's the only behavior change and carries the terminal-unmount risk;
  keeping it separate isolates that risk. Right panel keeps today's in-place diff.
- Self-rendered agent conversation (Coolie keeps xterm by design).
- New settings pages (Appearance/Models), right-panel "Checks" real data,
  `Setup/Run/Terminal`/"Add run script" section (user removed it).
- Geist Mono bundling/licensing (fallback to SF Mono if not installed).

## Parallelization
Small, mostly one file (`styles.css`). Limited parallelism:
- Lane A (blocking): `styles.css` tokens + `theme.ts` + `theme.test.ts` — establishes the
  palette everything else renders against.
- Lane B (after A lands, parallel among themselves): `Titlebar.tsx`, `Sidebar.tsx`,
  `Composer.tsx`, `Footer.tsx` — independent files, markup-only.
Recommend sequential A → B; B files can be split across worktrees if desired.

## Completion summary
- Step 0 scope: REDUCED (visual-only; diff-in-center deferred to Phase 2).
- Architecture: 0 blocking; 1 flagged failure mode (FM2 token rewrite).
- Code quality: 1 decision (D2, resolved CSS-only).
- Tests: 1 required assertion update (theme.test.ts); existing suite stays green.
- Performance: 1 decision (D3, resolved native vibrancy).
- Deferred: diff-in-center (Phase 2).
