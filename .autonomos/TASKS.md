# PROJECT TASKS & ROADMAP

> **LEGEND**
> **Priority:** [🔴 Critical] [🟠 High] [🔵 Medium] [⚪ Low]
> **Complexity:** [S] Small (1h), [M] Medium (4h), [L] Large (1-2 days), [XL] Huge (Planning req.)
> **Status:** [ ] Todo, [/] In Progress, [x] Done, [!] Blocked

## 🚀 Active Sprint

- [x] **[PERF-05]** Sidebar page-cache (same version-keyed pattern as room/search) `Priority: 🟠` `Complexity: M`
- [x] **[PERF-06]** Writer-lock ceiling, part 1: batch enqueues, folded check, shared render (+8-29%, p99 56->38ms) `Priority: 🟠` `Complexity: L`

## ✅ Done

- [x] **[INIT-01]** Review project context and structure `Priority: 🔵` `Complexity: S`
- [x] **[PERF-01]** Whole-page + gzip caches: room/messages/search at Rust parity (`00db309`) `Priority: 🟠` `Complexity: M`
- [x] **[PERF-02]** SQLite composite index + off-thread WAL checkpoints + jobs durability (`50b6ac5`) `Priority: 🟠` `Complexity: M`
- [x] **[PERF-03]** Slimmer write transactions: sanitize outside txn, skip no-op reconcile/FTS-DELETE, messagesByIds batch (`00db309`) `Priority: 🟠` `Complexity: S`
- [x] **[PERF-04]** Cable indexed fanout with shared frames, no DB on broadcast (`038a30c`) `Priority: 🟠` `Complexity: M`

## 🔮 Backlog

- [ ] **[PERF-07]** `/up` trivial-route overhead (Elysia routing cost) `Priority: ⚪` `Complexity: S`
- [ ] **[PERF-10]** Single-writer IPC for mutations (Rust writer-thread model, cross-process) `Priority: 🔵` `Complexity: XL`
- [ ] **[PERF-08]** Cable scaling validation at 500/1000 clients `Priority: 🔵` `Complexity: M`
- [ ] **[PERF-09]** Interleaved multi-rep runs for publishable numbers `Priority: 🔵` `Complexity: S`
