# Conversion example (README before/after)

These files are **generated artifacts** embedded in the project [`README.md`](../../README.md)
to show a real PlantUML-C4 → draw.io conversion. They are committed (not
`.gitignore`d) so the README renders the before/after on GitHub without a
build step.

| File | What it is | Produced by |
|------|------------|-------------|
| `example.puml.png` | PlantUML render of the **source** | `plantuml/plantuml` (pinned) |
| `example.drawio` | The converted draw.io XML | `node src/cli.mjs` via the vendored catalyst at `CATALYST_REF` |
| `example.drawio.png` | draw.io render of the conversion | `rlespinasse/drawio-export` (pinned) |

**Source of truth:** the input is **[`sample/example.puml`](../../sample/example.puml)**
— it is *not* duplicated here on purpose (one canonical copy, also used by the
e2e/parity suites; a second copy would silently drift).

**Regenerate** (after a `CATALYST_REF` bump or any converter change):

```bash
make examples-png      # rewrites all three files from sample/example.puml
git add docs/examples/  # commit the refreshed artifacts
```

`make examples-check` (part of `make static-check`) byte-compares the committed
`example.drawio` against a fresh conversion and fails CI if it has drifted —
so a stale example cannot ship.
