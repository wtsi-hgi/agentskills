---
name: code-smells
description: Named code smell baseline for reviewing changed code, from Fowler's Refactoring chapter 3. Referenced by pr-reviewer and the per-stack reviewer skills. Use when reviewing a diff for design problems the linter cannot name.
---

# Code Smells Skill

A fixed set of named smells to match against changed code, so a review can
name a design problem precisely instead of gesturing at it. Use alongside
**implementation-principles**, which owns the rules about reuse, abstraction,
and refactoring scope.

## Two Binding Rules

- **The project's conventions win.** Where the project's conventions skill
  endorses something this list would flag, the convention decides. Skip
  anything the project's linter or type checker already enforces.
- **Every entry is a judgement call.** Report a hit as "possible feature
  envy" with the hunk quoted, not as a violation. A smell blocks a review only
  when it breaks a documented convention or a rule in
  **implementation-principles**.

## The Baseline

- **Mysterious name.** A function, variable, or type whose name does not
  reveal what it does or holds. Rename it. If no honest name comes, the design
  is unclear.
- **Duplicated code.** The same logic shape in more than one place in the
  change. Extract it and call it from both, but only when both are the same
  responsibility (see **implementation-principles** on forced DRY).
- **Feature envy.** A function that reaches into another type's data more than
  its own. Move it onto the data it uses.
- **Data clumps.** The same few fields or parameters travelling together.
  Bundle them into one type and pass that.
- **Primitive obsession.** A string, int, or map standing in for a domain
  concept that deserves its own type.
- **Repeated switches.** The same branch on the same type recurring across the
  change. Replace it with one dispatch point that every site shares.
- **Shotgun surgery.** One logical change forcing scattered edits across many
  files. Gather what changes together.
- **Divergent change.** One file edited for several unrelated reasons. Split
  it so each part changes for one reason.
- **Speculative generality.** Abstraction, parameters, or hooks for needs no
  current requirement has. Delete it, and inline back until a real need
  appears.
- **Message chains.** `a.b().c().d()` navigation the caller should not depend
  on. Hide the walk behind one call on the first object.
- **Middle man.** A type or function that mostly delegates onward. Call the
  real target.
- **Refused bequest.** A subclass or implementer that ignores or overrides
  most of what it inherits. Use composition.

## Reporting

For each hit, give the file and lines, the smell's name, and the concrete fix.
Group smells below spec and correctness findings: they are design feedback,
not defects.
