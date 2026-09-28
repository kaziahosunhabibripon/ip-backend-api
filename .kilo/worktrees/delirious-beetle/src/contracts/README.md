# Synced type contract

A straight copy of `ipscope-web`'s `types/*.ts`, per `NESTJS_BACKEND_PLAN.md` §1 option 2.

`ipscope-web`'s copy is the source of truth — when it changes, re-copy these files by hand and
update any DTOs here that drifted. Switch to a published `@ipscope/types` package once the
contract has stabilized and this manual diffing becomes a real risk.
