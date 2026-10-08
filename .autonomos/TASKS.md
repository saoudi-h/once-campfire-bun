# PROJECT TASKS & ROADMAP

> **LEGEND**
> **Priority:** [🔴 Critical] [🟠 High] [🔵 Medium] [⚪ Low]
> **Complexity:** [S] Small (1h), [M] Medium (4h), [L] Large (1-2 days), [XL] Huge (Planning req.)
> **Status:** [ ] Todo, [/] In Progress, [x] Done, [!] Blocked

## 🚀 Active Sprint

- [x] **[PUBLISH-01]** Readability pass: prune stale comments, English-only texts `Priority: 🟠` `Complexity: M`
- [x] **[PUBLISH-02]** README + benchmark docs in English `Priority: 🟠` `Complexity: M`
- [x] **[PUBLISH-03]** Final exhaustive benchmark (all suites, 3 reps) + results tables `Priority: 🟠` `Complexity: M`

## ✅ Done

- [x] **[INIT-01]** Review project context and structure `Priority: 🔵` `Complexity: S`
- [x] **[PERF-01]** Whole-page + gzip caches: room/messages/search at Rust parity (`00db309`) `Priority: 🟠` `Complexity: M`
- [x] **[PERF-02]** SQLite composite index + off-thread WAL checkpoints + jobs durability (`50b6ac5`) `Priority: 🟠` `Complexity: M`
- [x] **[PERF-03]** Slimmer write transactions: sanitize outside txn, skip no-op reconcile/FTS-DELETE, messagesByIds batch (`00db309`) `Priority: 🟠` `Complexity: S`
- [x] **[PERF-04]** Cable indexed fanout with shared frames, no DB on broadcast (`038a30c`) `Priority: 🟠` `Complexity: M`
- [x] **[PERF-05]** Sidebar page-cache (`6b65919`) `Priority: 🟠` `Complexity: M`
- [x] **[PERF-06]** Writer-lock ceiling, part 1 (`4feeb69`) `Priority: 🟠` `Complexity: L`
- [x] **[PERF-15]** Cache/memory tuning knob, perf-neutral (`2957180`) `Priority: 🔵` `Complexity: S`
- [x] **[PERF-07]** `/up` native route (`16a201c`) `Priority: ⚪` `Complexity: S`
- [x] **[PERF-08]** Cable scaling validation at 500/1000 (`9953859` incl. bodyHtmlCache bound) `Priority: 🔵` `Complexity: M`
- [x] **[PERF-09]** Interleaved compare harness + reports (`0b82593`) `Priority: 🔵` `Complexity: S`
- [x] **[PERF-10]** Single-writer IPC for plain posts, ADR-001 accepted (`d5ba927`) `Priority: 🔵` `Complexity: XL`
- [x] **[PERF-11]** Avatar/static-asset serving (`4b02867`) `Priority: 🔵` `Complexity: M`
- [x] **[PERF-12]** Writer group-commit: tried, measured ~0, reverted (`d53a06f`) `Priority: ⚪` `Complexity: M`
- [x] **[PERF-13]** Consolidation: full 3-rep compare on final code (`a75c019`) `Priority: 🟠` `Complexity: M`
- [x] **[PERF-14]** Scaling study 1-8 threads + CPU/RAM (`f075370`) `Priority: 🟠` `Complexity: M`

## 🔮 Backlog

- [ ] **[PERF-16]** Thumbnail serving: direct file serve vs redirect chain (GET thumb 1.3ms vs 0.2ms) `Priority: ⚪` `Complexity: S`
