# System One fixtures

Shared by the JS (`web/js/systemone.test.mjs`: `invalid-*`, the runs of `request-*` and the expected outcomes of `response-*`) and Rust tests. `request-*` and `response-*` bodies come from the real endpoint (`scripts/probe.sh`); `response-*` error cases and `invalid-*` are hand-made.

The endpoint returns the `probabilities` of a choice sorted by name, not in request order (so `"1"`, `"10"`, `"2"`); `expected.probabilities` is in option order, and for a score in level order.

`request-picture.json` carries a 32 px JPEG as a data URL in `images`; the `invalid-*picture*` cases cover the picture limits (4 pictures, 300 KB each, 600 KB together, JPEG only).
