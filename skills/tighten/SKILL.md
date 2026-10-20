---
name: tighten
description: "Only when explicitly invoked, rewrite your previous answer much shorter, by default in at most 60 words or within a limit the user gives."
---

# Tighten

Rewrite your previous answer in at most 60 words, or in the number the user
gives (`/tighten 40`). The `**Your next action:**` line that
**final-response** requires does not count toward the limit; keep it. Count
the words before sending.

- Keep only the direct answer, the single best fix with its reason and
  command, and at most one clause for what the fix leaves uncovered.
- Cut whole facts rather than compressing every fact into fewer words.
- Drop mechanism (library, function, and file names), repetition, details the
  asker didn't raise, and anything they'll see when they follow the fix.
- Write short, plain sentences. Don't meet the limit with semicolons,
  parentheses, or dropped articles.
- If the question was relayed from someone else, write to that person, ready
  to paste.
- Don't add facts. Drop any claim you didn't verify.
- Plain prose: no headings, bullets, bold, or code blocks. Inline code is
  fine.
