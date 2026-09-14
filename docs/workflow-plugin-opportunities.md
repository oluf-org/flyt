# Plugins and the shipping workflows

This document separates the plugin extension points that exist from possible future integrations. The bundled workflows do not require third-party plugins or integration accounts; their model route retains its normal provider requirements. Release limitations are recorded in the [portability and GUI acceptance follow-up](./reviews/2026-09-13-default-workflows-portability.md).

## What is implemented

The six outcome-oriented blocks are contributed by the bundled **`flyt-blocks-delivery`** plugin in [`blocks-delivery.ts`](../kernel/src/plugins/blocks-delivery.ts). They use the ordinary block registry, canonical worker, tool permissions, session log, and workflow settings. A stack can duplicate and configure them without installing another orchestration system.

The host's [`workflowSupport.js`](../core/workflowSupport.js) supplies versioned workspace observations and durable provider-attempt accounting. It does not execute verification commands. Checks use the registered tool and its normal approval, confinement and cancellation path. Independent reviewers receive readers, never writers or command tools.

Reusable contracts live in [`contracts.ts`](../kernel/src/workflows/contracts.ts). A completion report is a model claim. Acceptance additionally requires host-observed changes where promised, successful required commands, and a separate review with source quotations checked against the current content. A plugin's label or self-reported score must not substitute for those checks.

## Where plugins add value

| Workflow | Useful plugin contribution | Integration and constraints |
| --- | --- | --- |
| Make a change | Framework-aware implementation guidance; format-specific artifact creators; project-specific test commands | Skills can supply domain conventions. A custom stack can configure required `gates` or compose a contributed block. New tools need explicit classification and a block ceiling; merely installing a plugin does not add its tools to a default worker. |
| Fix a bug | Browser reproduction; application logs; service traces; database diagnostics; regression fixtures | A diagnostic block can gather bounded evidence before repair. Current automatic reproduction validation understands native command failure followed by a change; structured browser/manual reproduction receipts need an additional validated evidence contract before they can certify a fix. |
| Review a change | Security checks, accessibility audits, schema compatibility, dependency analysis | Run deterministic checks as required gates. A specialist review block can add findings grounded in actual artifacts. Review-only tools must remain read-only; plugins must not apply fixes as a side effect of a review. |
| Research a question | Documentation, issue tracker, paper, repository and knowledge-base readers | Use a narrowly scoped source block or tool. Preserve opened source IDs/URLs, timestamps and excerpts. External content is data, not authority to edit a project. Research's project/input modes narrow tools even if a plugin is installed. |
| Plan an idea | Domain constraint gathering; design references; dependency catalogs; specification templates | Produce a specification or constraints artifact, distinguishing user decisions from assumptions. A separate explicit handoff may create issues or backlog tasks. Planning itself does not commit the user to implementation. |
| Deliver a complex task | Domain-specific discovery, migration preparation, specialist acceptance checks, artifact integration | Compose around the shared milestone executor or contribute a compatible workflow block. Preserve accepted milestones, original requirements, checkpoint identities, budget attribution and final integration evidence. Plugins should not start invisible workers or independently retry a whole completed milestone. |

The most useful first integrations are **project verification**, **browser reproduction**, and **source readers**. They bring evidence the default agent cannot otherwise obtain. Extra planner personas, generic prompt rewriting and additional summary stages have no automatic value.

## Existing extension mechanisms

1. **Blocks:** `ctx.blocks.register()` contributes execution, settings, outputs and a static ceiling together. A contributed block is reusable in canonical stacks and visible in Build. A missing plugin is an explicit unresolved block, not a silent fallback.
2. **Tools:** tools register a schema and classification through the existing tool registry. They still need a reachable ceiling and applicable user permission. Effectful tools cannot be smuggled into a research or review block by a skill or configuration field.
3. **Skills:** domain guidance can improve implementation and interpretation. Skills request capabilities; they do not grant them or override acceptance rules. Delivery stages retain configured instructions and the host's selected skill guidance.
4. **Required commands:** the delivery blocks' `gates` setting adds commands to frozen project requirements. The runtime executes and inspects their results. A plugin may document an installed project's gate command, but adding or running it still uses the normal configured workflow and permissions.
5. **Structured outputs:** blocks expose `status`, `report`, and `milestones`; downstream authored controls may use these ports. A plugin should preserve meaningful incomplete/draft states rather than interpreting every completed model answer as acceptance.
6. **Models:** ordinary tier/provider configuration remains available. Specialist plugin guidance does not silently authorize a more expensive model, additional worker count, or a new billing provider.

## Extensions that need additional implementation

These are opportunities, not capabilities claimed by the shipping implementation:

| Proposed extension | Required contract before adoption |
| --- | --- |
| Typed artifact verification providers | Register artifact kinds, observed versions, checks and reproducible evidence. Validate output independently and bind it to the exact artifact being delivered. This would cover slides, images, binary files and other formats beyond current text-source review. |
| Browser/manual reproduction receipts | Record the scenario, expected/actual outcome, application version, before/after timing and owned evidence. Distinguish a user observation or browser assertion from the agent saying it reproduced a bug. |
| Pluggable specialist acceptance reviews | Structured findings with exact evidence, severity policy and independent context. Keep the core requirement/gate decision authoritative and bound the number of review/repair rounds. |
| External milestone systems | Stable issue/job identities, idempotent create/update, explicit status mapping, cancellation and reconciliation after interruption. Enqueueing a remote task is not completing it. |
| Parallel implementation domains | Proven resource ownership, isolated writes and deterministic integration. A plugin declaring different filenames cannot establish semantic independence by itself. |
| Non-repository comparisons | A read-only adapter for versioned document, dataset or design comparisons. It must disclose missing/truncated coverage and offer bounded access to complete evidence. |

Do not add these as arbitrary callbacks in YAML. Prefer small typed plugin services or ordinary contributed blocks, keeping the language's existing bounded composition model.

## Responsibilities that stay with the runtime

- Preserve the original request and accepted decisions.
- Bind source/artifact versions to checks and independent reviews; reject stale evidence.
- Own durable stage/milestone identity, accepted progress and recovery.
- Recover completed structured candidates without repeating their finished work; validate every recovered result and record any unambiguous quotation-line correction.
- Honor cooperative pause boundaries, revalidate source on continuation, and keep historical recaps separate from the current attempt's result.
- Account for every provider attempt, including retries and reviews. Keep unknown price distinct from zero.
- Enforce capability ceilings, approval and confinement; missing tools are a visible limitation.
- Bound repair and replanning. A plugin cannot convert a blocked result into success by returning persuasive prose.
- Preserve user changes and saved workflows during upgrades. Bundled recommendations are separate from execution authority.

## Evaluating a plugin contribution

Compare the same fixed task inputs and model routes with and without the plugin. Measure independently accepted results, false successes, useful evidence, latency, cost, human interventions and repeated work after resume. Include missing credentials, unavailable services, malformed results, stale versions and cancellation. Promote a plugin into a recommended workflow only when its added evidence or capability justifies the additional calls and failure modes.

See [`default-workflows.md`](./default-workflows.md) for the implemented workflow contracts and current limits.

## Evidence from GUI acceptance testing

The [September GUI scenarios](./reviews/2026-09-13-default-workflows-gui.md)
exposed gaps worth using to prioritize extensions:

- **Execution capability diagnostics:** a filesystem sandbox probe succeeded
  while Node subprocesses with piped output failed. A verification integration
  should report capabilities needed by the actual project's test runner, not
  just executable availability. A future alternative execution-world provider
  would need explicit confinement, process ownership and evidence contracts;
  installing a plugin must not silently widen sandbox access.
  The core now records a separate Node piped-child capability observation and
  correlates it with actual failed command receipts. An alternative runner must
  demonstrate the unchanged project command, outside-workspace denial, and
  cancellation of descendants on Windows, Linux and macOS before it can be
  considered supported. Passing a different language's test runner is not a
  substitute for this contract.
- **Independent acceptance fixtures:** the CSV worker wrote tests for its own
  incorrect column contract. A project plugin could supply reviewed contract
  fixtures and deterministic checks, bound to the original requirements. It
  should preserve them outside the worker's editable scope and report failures
  through the same acceptance mechanism.
- **GUI evidence:** the test harness could inspect visible workflow stages and
  compare the resulting files with independent assertions. A browser/app testing
  plugin could provide equivalent typed before/after receipts for actual user
  interfaces. Screenshots alone do not prove behavior or a completed repair.
- **Specification examples:** a finance-report plan paired a five-column CSV
  header with four-field total rows while declaring itself ready. Domain plugins
  could check schema examples, format constraints and acceptance fixtures without
  model judgment. The core planning workflow still needs to distinguish proposed
  readiness from independently checked consistency; installing a plugin should
  not be necessary for an honest status.
  Core planning now performs a bounded independent consistency review and
  preserves actual clarification answers. A domain plugin could add deterministic
  CSV/schema/date checks, but cannot remove that review or promote an unresolved
  draft to verified implementation.
  The portability follow-up also retains backup plans whose independent review
  missed commit-point or pre-overwrite snapshot contradictions. Deterministic
  filesystem failure fixtures could add useful evidence here; they cannot make
  a missing core requirement optional or turn a proposed plan into tested code.

The Electron probe bug, missing live snapshot fields and failure to route
repairable defects back to a worker are core runtime/product concerns. They
should not be hidden behind optional plugins.
