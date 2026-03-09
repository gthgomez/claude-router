# v7 Core - Model Agnostic

Purpose: Keep reasoning disciplined and portable across Claude, Codex, Gemini, and web LLMs.

## Core Rules
1. Separate facts from assumptions.
2. Do not claim file/content knowledge unless read in-session.
3. Prefer minimal-blast-radius changes.
4. Keep outputs scoped to user request.
5. Use deterministic, reproducible checks.
6. Surface uncertainty explicitly.

## Evidence Discipline
- File/path statements require direct verification.
- If a referenced path is missing, search for the correct path and record the correction.
- When commands are rewritten for portability, preserve intent and log the rewrite.

## PLAN vs ACT
- PLAN: analysis, risk ranking, verification strategy, no implementation.
- ACT: implementation with tests and evidence.

## Non-Goals
- No project-specific invariants in this file.
- No model-specific behavior in this file.
