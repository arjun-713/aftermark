# Aftermark

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

SaaS engineering teams shipping agents that create issues, update CRM contacts, and complete internal workflows. Engineers instrument completed runs, investigate outcomes, review uncertain findings, and protect subsequent releases with regression cases. Workspace owners and admins manage access, connections, usage, billing, and operational health.

## Product Purpose

Aftermark answers whether an agent completed its task, which evidence supports that conclusion, and whether the next release preserves the expected behavior. It is a paid, multi-tenant SaaS for asynchronous outcome verification, human review, and customer-run CI regression checks.

## Positioning

An agent claim, a successful reported tool result, and an independently observed external state are different evidence. Aftermark keeps their provenance visible and carries a reviewed finding into a versioned regression case.

## Operating Context

Customer infrastructure runs agents and regression candidates. The platform receives telemetry, freezes run revisions, evaluates deterministic assertions and bounded typed Jev questions, collects provider observations or signed customer receipts, and queues cases for review. GitHub Issues, HubSpot Contacts, and customer-operated verifiers are the supported outcome sources.

## Capabilities and Constraints

- Keep execution status, evaluation processing, quality decision, and outcome verification independent.
- Missing, stale, unavailable, or insufficient evidence remains unknown; required unknown outcomes can block CI.
- Provider observations and customer-operated receipts have distinct provenance. Observed state establishes neither historical causality nor permanence.
- Preserve run revisions, immutable policy and dataset versions, review claims and concurrency controls, API-key scopes, invitations and roles, connection flows, billing entitlements, quotas, retention, storage, signed alerts, and health views.
- Semantic confidence is not guaranteed correctness. Semantic detectors require calibration and explicit activation before release blocking.
- Primary storage targets Singapore; redacted Jev context may be processed elsewhere. Do not promise Singapore-only processing or provider zero retention.
- Namespace, API, SDK, environment, issuer, and database identities remain `agent-quality` / `aq`; the new name is the display identity.

## Brand Commitments

The user delegated a new product name and identity. The display name is Aftermark. Public presentation should read as a complete product and omit preview or proposed-launch branding. Keep the language precise, direct, and grounded in evidence.

## Evidence on Hand

The repository contains working application routes, APIs, automated workflow checks, and explicit sample fixtures. No customer logos, testimonials, user counts, production benchmarks, live payment proof, or external pilot results are available. Demonstration material must remain identifiable as an example. Deployment and integration readiness are internal operational facts, not invented public claims.

## Product Principles

- Evidence earns a conclusion; a confident claim does not.
- Unknown is an explicit, useful outcome.
- A review decision preserves the original evidence and assessment.
- A real failure should become a reproducible regression case.
- Keep customer execution under customer control.
