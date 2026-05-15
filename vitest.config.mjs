import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.mjs'],
    // Keep the unit lane unit-only. `*.integration.test.mjs` files also match
    // the include glob; without this exclude `make test` would run the full
    // catalyst pipeline (after `make deps`) in the "fast, no-catalyst" lane,
    // violating the documented three-layer pyramid. Integration specs run via
    // `make integration-test` (vitest.integration.config.mjs).
    exclude: [...configDefaults.exclude, 'test/**/*.integration.test.mjs'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.mjs'],
      exclude: ['src/cli.mjs', 'src/layout-drawio-cli.mjs'],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80
      }
    }
  }
})
