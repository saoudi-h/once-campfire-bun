# PROJECT TASKS & ROADMAP

> **LEGEND**
> **Priority:** [🔴 Critical] [🟠 High] [🔵 Medium] [⚪ Low]
> **Complexity:** [S] Small (1h), [M] Medium (4h), [L] Large (1-2 days), [XL] Huge (Planning req.)
> **Status:** [ ] Todo, [/] In Progress, [x] Done, [!] Blocked

## 🚀 Active Sprint

- [x] **[PERF-12]** Writer group-commit: tried, measured ~0, reverted (see worklog) `Priority: ⚪` `Complexity: M`
- [ ] **[PERF-14]** Scaling study 1-16 CPUs + CPU/RAM at rest and load, Bun vs Rust `Priority: 🟠` `Complexity: M`

## ✅ Done

- [x] **[INIT-01]** Review project context and structure `Priority: 🔵` `Complexity: S`
- [x] **[PERF-01]** Whole-page + gzip caches: room/messages/search at Rust parity (`00db309`) `Priority: 🟠` `Complexity: M`
- [x] **[PERF-02]** SQLite composite index + off-thread WAL checkpoints + jobs durability (`50b6ac5`) `Priority: 🟠` `Complexity: M`
- [x] **[PERF-03]** Slimmer write transactions: sanitize outside txn, skip no-op reconcile/FTS-DELETE, messagesByIds batch (`00db309`) `Priority: 🟠` `Complexity: S`
- [x] **[PERF-04]** Cable indexed fanout with shared frames, no DB on broadcast (`038a30c`) `Priority: 🟠` `Complexity: M`
- [x] **[PERF-05]** Sidebar page-cache `Priority: 🟠` `Complexity: M`
- [x] **[PERF-06]** Writer-lock ceiling, part 1 (`4feeb69`) `Priority: 🟠` `Complexity: L`

## 🔮 Backlog

- [ ] **[PERF-12]** Writer group-commit batching (amortize BEGIN/COMMIT+FTS over N posts) `Priority: ⚪` `Complexity: M`
- [ ] **[PERF-15]** Cache/memory tuning knob for small servers (per-worker caps) `Priority: 🔵` `Complexity: S`
- [x] **[PERF-11]** Avatar/static-asset serving gap (avatar x7 vs Rust front cache) `Priority: 🔵` `Complexity: M`
- [x] **[PERF-08]** Cable scaling validation at 500/1000 clients `Priority: 🔵` `Complexity: M`
- [x] **[PERF-09]** Interleaved multi-rep runs for publishable numbers `Priority: 🔵` `Complexity: S`
- [x] **[PERF-10]** Single-writer IPC for plain posts, writer child supervised by master (`ADR-001`) `Priority: 🔵` `Complexity: XL`
- [x] **[PERF-07]** `/up` native route `Priority: ⚪` `Complexity: S`
- [x] **[PERF-08]** Cable scaling validation at 500/1000 `Priority: 🔵` `Complexity: M`
- [x] **[PERF-09]** Interleaved compare harness + reports `Priority: 🔵` `Complexity: S`
- [x] **[PERF-11]** Avatar/static-asset serving `Priority: 🔵` `Complexity: M`
