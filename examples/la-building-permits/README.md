# Example adapters: City of Los Angeles building permits

Six complete dataset scripts, each behind a published report. They show the method at full depth:
each one documents its traps in its header comment, and every rule in it was hand-audited on
random samples and reproduced by an independent re-implementation before publishing.

**Source:** LA open data, dataset `pi9x-tg5x` ("Building and Safety - Building Permits Issued from
2020 to Present"). Public, no key, updated daily. The portal is `data.lacity.org`; the `.gov` host
no longer resolves. `valuation` is text (cast it), and it is a fee figure, not a cost.

**Run from the site root.** Output defaults to `./public/data/<slug>/`. Use `--out <dir>` for a dry
run, because regenerating in place without regenerating the article desyncs the page from its data.

| Script | Measures | Traps it handles |
|---|---|---|
| `la-permit-data.mjs` | New single-family houses, ADUs and alterations by year and area | Matched window; "Bldg-New / 1 or 2 Family Dwelling" includes ADUs, garages and sheds (use `use_desc`). ⚠️ Known gap: it does not yet merge the truncated area names (see the pool script's merge) |
| `la-build-timeline-data.mjs` | Permit issue → certificate of occupancy | Survivorship: completion as a fixed-horizon share of a whole cohort; completion is a floor; tract batches pull the median down |
| `la-approval-timeline-data.mjs` | Application → permit issue | Only issued permits exist in the source; cohort by issue year, never application year; batch releases distort area medians; field coverage decides which categories are measurable |
| `la-teardown-data.mjs` | Demolished houses and what replaced them | The unit is the parcel, not the permit; demolition is often not the first step; a label changed mid-2025; lot merges change the parcel number |
| `la-pool-permit-data.mjs` | New pools at houses | A quarter are revisions (permit-number rule); the type doesn't say what was built (classify from `work_desc`); truncated area names; data starts in 2020 so the "with a new house" share needs a two-year lead |
| `la-home-addition-data.mjs` | Living-space additions, upper floors, near-rebuilds | Revisions; outdoor "additions"; `square_footage` is not the area added; "2-story" usually describes the existing house; near-rebuilds keep a stated length of wall |

`--audit` (pool and addition scripts) prints random classification samples. Read them after any
change to a rule.

To adapt one to another city: swap the API URL, then redo the field checks from scratch. Field
names, coverage and labels differ by portal, and every trap above was found by looking, not assumed.
