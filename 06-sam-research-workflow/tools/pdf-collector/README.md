# SAM Reference PDF Collector

A literature-retrieval tool for collecting reference papers and Supporting Information (SI) through academic APIs, repositories, and publisher services. The core retrieval workflow is deterministic and does **not** use an LLM API.

## What it does

- parses references and resolves DOI / bibliographic identity;
- routes retrieval across Crossref, Unpaywall, OpenAlex, CORE, Europe PMC, Figshare, repositories, and publisher APIs;
- validates document identity and completeness so previews or wrong papers are not counted as successful retrievals;
- records provenance and machine-readable failure reasons for main papers and SI;
- provides an optional browser fallback for selected unresolved cases without bypassing CAPTCHA or access controls.

## Evaluation

In a 30-reference test on 2026-07-24, one item was not a paper. The collector retrieved **17/29 (58.6%)** trustworthy complete main papers under that test condition.

## Quick start

**Windows:** double-click [`start.cmd`](start.cmd). On first launch it installs the local npm dependencies, opens the local web interface, and starts the server.

Optional provider keys can be configured from `.env.example`.

Manual launch:

```bash
npm install
npm start
```

## Current limitations

The main remaining challenges are publisher-specific routing, shared rate-limit/backoff handling, repository response robustness, SI discovery/provenance, and distinguishing software failures from external access or entitlement limits.
