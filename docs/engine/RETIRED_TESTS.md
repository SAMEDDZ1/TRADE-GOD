# Retired inherited tests

These StarNet tests checked files that TRADE GOD deliberately does not ship. They were removed from
`test/fast.list` and deleted (they remain in StarNet's history). If one of these areas comes back, restore the test
from the StarNet repository and adapt it.

## StarNet art assets (sprites / industrial props) were removed

- `test/authored-furniture-motion.test.js`
- `test/authored-machine-config.test.js`
- `test/authored-surface-mounts.test.js`
- `test/cli-dashboard.test.js`
- `test/coordinated-prop-recipes.test.js`
- `test/industrial-shells.test.js`
- `test/remaster-skin-import.test.js`
- `test/remote-view.test.js`
- `test/sprite-assets.test.js`
- `test/sprite-detached-prop.test.js`
- `test/sprite-direction-details.test.js`
- `test/sprite-sit-facing.test.js`
- `test/sprite-walk-motion.test.js`
- `test/world-idle-renderer.test.js`

## The StarNet marketing website (website/) was removed

- `test/build-mode-easy.test.js`
- `test/community-hide-until-live.test.js`
- `test/community-maps.test.js`
- `test/conveyor-choices.test.js`
- `test/help-copy-matches-screen.test.js`
- `test/simulation-lighting.test.js`
- `test/skill-market-catalog.test.js`
- `test/skill-market-tools.test.js`
- `test/updatecore.test.js`
- `test/webkit-zoom-pointer.test.js`
- `test/website-app-sync.test.js`
- `test/website-deploy-staging.test.js`
- `test/website-docs-navigation.test.js`
- `test/website-live-preview.test.js`
- `test/website-pricing-hold.test.js`
- `test/website-skill-market.test.js`

## StarNet's GitHub release/CI workflows (.github/workflows) were removed; TRADE GOD needs its own

- `test/bundle-source-integrity.test.js`
- `test/connector-reliability-wiring.test.js`
- `test/desktop-build-macos-notarization.test.js`
- `test/desktop-voice-bundle.test.js`
- `test/fast-gate-shards.test.js`
- `test/google-connector.test.js`
- `test/install-manifest.test.js`
- `test/installer-upgrade-resilience.test.js`
- `test/process-identity.fixtures.test.js`
- `test/release-contract-docs.test.js`
- `test/release-train-chrome-warmup.test.js`
- `test/release-train-macos-trust.test.js`
- `test/release-train-provenance.test.js`
- `test/release-train-windows-trust.test.js`
- `test/source-release-mirror.test.js`
- `test/webkit-floor-boot.test.js`

## StarNet's internal docs/ planning files were removed

- `test/desktop-artifact-open.test.js`
- `test/projection-prop-effects.test.js`
- `test/run-recovery-ui.test.js`
- `test/station-recovery-packaged.test.js`
- `test/station-templates.test.js`
- `test/workflow-panel-sendto-truth.test.js`

## The StarNet QA archive (qa/) was removed

- `test/eval-comparison.test.js`
- `test/eval-parity-offline.test.js`
- `test/qa-bug-lifecycle.test.js`
- `test/qa-bugs-fixed-in-tree.test.js`
- `test/qa-bugs-register.test.js`
- `test/qa-product-perfect.test.js`

## StarNet art tooling under dev/ was removed

- `dev/computer-eval/adapter.test.js`
- `dev/industrial-textures/approved-sheet-effects.test.cjs`
- `dev/industrial-textures/coordinated-effects/accessories.test.cjs`
- `dev/industrial-textures/coordinated-effects/utility.test.cjs`
- `dev/industrial-textures/prop-catalog-review.test.cjs`

## StarNet's release-QA loops, packaging probes and art-dependent renders (second pass)

These pinned StarNet's release pipeline (signing, clean installs, update delivery, public distribution, the
open-source launch), packaged-process names, or rendered StarNet sprite sets:

- `test/opensource-readiness.test.js`
- `test/phase5.runner.test.js`
- `test/t0-clean-install.test.js`
- `test/t1-signing.test.js`
- `test/t3-release-smoke.test.js`
- `test/t4-update-delivery.test.js`
- `test/t5-public-distribution.test.js`
- `test/packaged-lifecycle.test.js`
- `test/desktop-build-macos-python-host.test.js`
- `test/voice-floor-canary.test.js`
- `test/frontend-dist-staging.test.js`
- `test/cli-floor.test.js`
- `test/world-immersion-characters.test.js`
- `test/local-voice-cache-root.test.js`

## Still owed

- TRADE GOD's own CI and release workflows (signing key, updater key, installers) — then restore release tests against them.
