# Workstream D: demo. Static files only; any static server works.
PORT ?= 8080
.PHONY: setup test demo browser-check

setup:
	@$(MAKE) -C ../planner setup

# Planner tests first, then the demo engine tests (no browser needed).
test:
	@$(MAKE) -C ../planner test
	cd . && node --test

# Serves the repository root so /demo/ can import /planner/src/... modules.
demo:
	@echo "Open http://localhost:$(PORT)/demo/  (Ctrl+C to stop)"
	python3 -m http.server $(PORT) --directory ..

# D8: real-browser check (optional). Needs the Playwright package; set PLAYWRIGHT_PATH if it is not installed locally.
browser-check:
	node tools/browser_check.mjs
