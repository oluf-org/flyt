# Live development findings

The retained [trial records](development-results.json) include unsuccessful trials and timeouts. They span changing implementations on the same configured `openrouter/z-ai/glm-5.3-flash` model route. They are debugging evidence, not a controlled estimate of production success.

The probes exposed and led to corrections for:

- Forced final submission preventing a worker from using ordinary tools.
- Nested ignored workspaces appearing empty to snapshots and effect attribution.
- Windows sandbox command quoting causing ordinary commands to fail.
- Lost tool evidence during correction of a malformed completion report.
- Numbered file previews being mishandled as source evidence.
- Missing post-fix reproduction checks when omitted by the worker.

Requiring every response to choose a tool added unnecessary calls and timeouts on this route. The implementation retains automatic tool selection while validating the returned report and allowing one evidence-backed format correction.

These matched automatic-selection development trials illustrate the cost of added verification:

| Smoke case | Candidate seconds / calls | Direct baseline seconds / calls | Candidate result |
| --- | --- | --- | --- |
| Make a change | 68.2 / 6 | 34.8 / 6 | Accepted |
| Review a change | 53.9 / 2 | 48.7 / 3 | Accepted |
| Research a question | 7.0 / 2 | 2.5 / 2 | Accepted |
| Plan an idea | 91.4 / 2 | 57.0 / 2 | Accepted |
| Fix a bug | 119.4 / 10 | 33.8 / 5 | Accepted |
| Deliver a complex task | 299.3 / 16 | 37.2 / 5 | Accepted |

The first four rows come from `release-pilot`; the last two come from `accepted-probe`. This table identifies successful automatic-selection examples, not an aggregate pass rate; the full JSON also contains earlier failures. Every case here is small. The single-milestone complex-task example paid for a duplicate integration review. The final implementation reuses acceptance for an unchanged single milestone checked against the complete original request; multi-milestone work still requires a separate integration check. The timings above precede that optimization.

The direct baseline was faster on these examples. Added stages provide explicit evidence and stronger completion checks; this smoke sample does not establish that their overhead is justified for every task or that they outperform direct work on hard tasks. Production-host failure-injection tests establish specific runtime guarantees, including rejection of false effects and failed checks and preservation of accepted progress. Representative hard-task comparisons and repeated trials across shipping model configurations remain release qualification work, as described in the [evaluation guide](README.md).
