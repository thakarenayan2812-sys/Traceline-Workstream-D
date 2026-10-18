# Workstream D: planner. Needs only Node 20+. No dependencies to install.
.PHONY: setup test fixtures bench sample coverage crowd optimize plan analytics browser-check

setup:
	@node -e "const v=+process.versions.node.split('.')[0]; if(v<20){console.error('Node 20+ required, found '+process.version); process.exit(1)} console.log('Node '+process.version+' OK. No packages to install.')"

test:
	node --test

fixtures:
	node tools/make_sample_replay.js 4242

bench:
	node tools/bench_geometry.js

PORT ?= 8080
PLAN ?= fixtures/sample_plan.json
RANGE ?=

coverage:
	@test -n "$(RANGE)" || (echo "Set the assumed range, e.g. make coverage RANGE=15"; exit 1)
	node tools/run_coverage.js $(PLAN) --range $(RANGE)

FALLBACK ?=
crowd:
	@test -n "$(RANGE)" || (echo "Set the assumed range, e.g. make crowd RANGE=15 FALLBACK=2"; exit 1)
	node tools/run_crowd.js $(PLAN) --range $(RANGE) $(if $(FALLBACK),--fallback-density $(FALLBACK),)

OUT ?= reports/optimizer
optimize:
	@test -n "$(RANGE)" || (echo "Set the assumed range, e.g. make optimize RANGE=15 FALLBACK=2"; exit 1)
	node tools/run_optimizer.js $(PLAN) --range $(RANGE) $(if $(FALLBACK),--fallback-density $(FALLBACK),) --out $(OUT)

sample:
	node tools/make_sample_blueprint.js

# Serves the repo root so /planner/ can import its modules. Open http://localhost:$(PORT)/planner/
plan:
	@echo "Open http://localhost:$(PORT)/planner/  (Ctrl+C to stop)"
	python3 -m http.server $(PORT) --directory ..

# D8: placeholder analytics stand-in for the demo panels (values are seeded placeholders, not results).
analytics:
	node tools/make_analytics_standin.js 4242

# Browser check of the planner page (optional; needs Playwright, see tools/browser_check.mjs).
browser-check:
	node tools/browser_check.mjs
