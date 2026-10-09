# PROJECT TASKS & ROADMAP

> **LEGEND**
> **Priority:** [🔴 Critical] [🟠 High] [🔵 Medium] [⚪ Low]
> **Complexity:** [S] Small (1h), [M] Medium (4h), [L] Large (1-2 days), [XL] Huge (Planning req.)
> **Status:** [ ] Todo, [/] In Progress, [x] Done, [!] Blocked

## 🚀 Active Sprint

- [x] **[AUDIT-01]** Sidebar parity: placeholders + like-for-like response, re-measure `Priority: 🔴` `Complexity: M`
- [x] **[AUDIT-02]** Clonable repo: pinned reference, virgin-clone verify, MIT license `Priority: 🔴` `Complexity: M`
- [x] **[AUDIT-03]** Proof hardening: report fixes, all-rep errors, sizes, mixed load `Priority: 🟠` `Complexity: M`
- [x] **[AUDIT-04]** README restructure + prudent wording, separate bench doc `Priority: 🟠` `Complexity: S`
- [x] **[AUDIT-05]** Light touch-up only: obvious safe cleanups in routes/storage, no behavior change `Priority: ⚪` `Complexity: S`
- [x] **[PERF-17]** Bun/Elysia perf pass: build settings, runtime flags, Bun 1.4.3-canary check `Priority: 🔵` `Complexity: M`
- [x] **[PERF-18]** Bun.Image for hot thumbnail path (jpeg/png), lazy sharp fallback `Priority: 🟠` `Complexity: M`
- [x] **[PERF-19]** `bun build --compile` support: data path, writer env dispatch, first-boot race `Priority: 🟠` `Complexity: M`
- [x] **[PERF-20]** Bun 1.4.3 stable re-measure + Elysia beta.21→.27 + config audit `Priority: 🔵` `Complexity: M`
- [x] **[PERF-21]** Image fallback matrix (Bun.Image vs sharp per format) + compile-flag stacking + canary adoption `Priority: 🟠` `Complexity: L`
- [x] **[PORT-01]** Port Express 1fc0949 remainder: JSON-path redundant messageById + message_creation test gaps `Priority: 🔵` `Complexity: S`
- [x] **[HARNESS-01]** Verification-harness assessment + contract compliance (19/19 preflight) `Priority: 🔵` `Complexity: M`
- [x] **[PERF-22]** Rust Oct-7 response cache port: generation tickets (PRAGMA data_version observer), TTL, 3 routes `Priority: 🟠` `Complexity: L`
- [x] **[PERF-16]** Thumbnail serving: measured obsolete (0.288ms vs 0.226ms on current code, sharpen removal already fixed it) `Priority: ⚪` `Complexity: S`
- [x] **[HARNESS-02]** Official harness re-run after PERF-22 (fork flow; sidebar/search at Rust parity) `Priority: 🔵` `Complexity: M`

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

- [ ] **[HARNESS-03]** Upstream PR decision + seed rebuild with real bin/seed (VAPID pair) before official submission `Priority: 🔵` `Complexity: M`
- [ ] **[PERF-16]** Thumbnail serving: direct file serve vs redirect chain (GET thumb 1.3ms vs 0.2ms) `Priority: ⚪` `Complexity: S`
