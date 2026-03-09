#!/usr/bin/env python3
"""
SMD v1.1 Light — Local Eval Harness (v2)
=========================================
Hardened for decision-grade evaluation.

Changes from v1:
  - Token capture per stage (prompt/output/total) + model-aware cost estimate
  - Seeded, logged randomization for A/B assignment (--seed)
  - Skeptic prompt allows abstention (zero issues is valid; no forced minimum)
  - Structured unresolved_risks with explicit issue_id (removes fuzzy survival matching)
  - Extended summary: tokens, cost, position bias, word counts, zero-issue rate, seed
  - judge_model logged in every record
  - JudgeClient abstraction via judge_providers.py (gemini or external)

Usage:
    python smd_eval.py \\
        --api-key YOUR_GOOGLE_API_KEY \\
        --prompts prompts_general.jsonl \\
        --judge-prompt judge_prompt.txt \\
        --out results/ \\
        [--limit 10] \\
        [--model gemini-2.0-flash-001] \\
        [--judge-provider gemini] \\
        [--judge-model gemini-2.5-pro] \\
        [--seed 42]

Requirements:
    pip install google-generativeai
"""

import argparse
import json
import random
import statistics
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import google.generativeai as genai
    from google.generativeai.types import GenerationConfig
except ImportError:
    print("ERROR: google-generativeai not installed. Run: pip install google-generativeai")
    sys.exit(1)

from judge_providers import (
    JudgeClient,
    build_judge_client,
    decode_winner,
    estimate_cost,
    get_pricing,
    _extract_tokens_from_result,
)


# ── Schemas (mirrors smd_schemas.ts) ──────────────────────────────────────────

SKEPTIC_RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "issues": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "id": {"type": "STRING"},
                    "title": {"type": "STRING"},
                    "severity": {
                        "type": "STRING",
                        "enum": ["low", "medium", "high", "critical"],
                    },
                    "category": {
                        "type": "STRING",
                        "enum": [
                            "factuality", "logic", "completeness", "ambiguity",
                            "risk", "tradeoff", "instruction_following", "other",
                        ],
                    },
                    "why_it_matters": {"type": "STRING"},
                    "suggested_fix": {"type": "STRING"},
                    "confidence": {"type": "STRING", "enum": ["low", "medium", "high"]},
                },
                "required": [
                    "id", "title", "severity", "category",
                    "why_it_matters", "suggested_fix", "confidence",
                ],
            },
        },
    },
    "required": ["issues"],
}

# HARDENED: unresolved_risks is now {issue_id, description}[] instead of string[].
# This eliminates fuzzy text matching in the survival rule audit.
SYNTH_RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "accepted_changes": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "issue_id": {"type": "STRING"},
                    "summary": {"type": "STRING"},
                },
                "required": ["issue_id", "summary"],
            },
        },
        "rejected_criticisms": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "issue_id": {"type": "STRING"},
                    "reason": {"type": "STRING"},
                },
                "required": ["issue_id", "reason"],
            },
        },
        # CHANGED from string[] to {issue_id, description}[] for exact ID matching
        "unresolved_risks": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "issue_id": {"type": "STRING"},
                    "description": {"type": "STRING"},
                },
                "required": ["issue_id", "description"],
            },
        },
        "rewrite_instructions": {"type": "ARRAY", "items": {"type": "STRING"}},
        "should_rewrite": {"type": "BOOLEAN"},
        "overall_confidence": {"type": "STRING", "enum": ["low", "medium", "high"]},
    },
    "required": [
        "accepted_changes", "rejected_criticisms", "unresolved_risks",
        "rewrite_instructions", "should_rewrite", "overall_confidence",
    ],
}

JUDGE_RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "response_a": {
            "type": "OBJECT",
            "properties": {
                "accuracy": {"type": "INTEGER"},
                "completeness": {"type": "INTEGER"},
                "precision": {"type": "INTEGER"},
                "conciseness": {"type": "INTEGER"},
                "risk_coverage": {"type": "INTEGER"},
                "total": {"type": "INTEGER"},
                "notes": {"type": "STRING"},
            },
            "required": [
                "accuracy", "completeness", "precision",
                "conciseness", "risk_coverage", "total", "notes",
            ],
        },
        "response_b": {
            "type": "OBJECT",
            "properties": {
                "accuracy": {"type": "INTEGER"},
                "completeness": {"type": "INTEGER"},
                "precision": {"type": "INTEGER"},
                "conciseness": {"type": "INTEGER"},
                "risk_coverage": {"type": "INTEGER"},
                "total": {"type": "INTEGER"},
                "notes": {"type": "STRING"},
            },
            "required": [
                "accuracy", "completeness", "precision",
                "conciseness", "risk_coverage", "total", "notes",
            ],
        },
        "winner": {"type": "STRING", "enum": ["A", "B", "tie"]},
        "winner_reason": {"type": "STRING"},
    },
    "required": ["response_a", "response_b", "winner", "winner_reason"],
}


# ── Prompt builders ────────────────────────────────────────────────────────────

def build_draft_prompt(user_query: str) -> str:
    return "\n".join([
        "Answer the following request directly and usefully.",
        "Be accurate. Briefly state assumptions only if necessary.",
        "Do not hedge unnecessarily. Do not mention any review process.",
        "",
        "REQUEST:",
        user_query.strip(),
    ])


def build_skeptic_prompt(user_query: str, draft_text: str) -> str:
    # CHANGED: Removed "at least 2 weaknesses" floor.
    # Abstention (empty issues array) is now valid and expected for strong answers.
    # Anti-theater pressure is preserved: do not manufacture issues.
    return "\n".join([
        "You are an expert critical reviewer evaluating a candidate answer.",
        "",
        "IMPORTANT: You did NOT write this answer. Evaluate it as if reviewing someone else's work.",
        "",
        "REVIEW RULES:",
        "- Identify genuine, substantive weaknesses only.",
        "- If no material weakness exists, return an empty issues array. Do NOT manufacture issues.",
        "- Report as many real issues as truly exist — no minimum, no maximum.",
        "- Focus on: factual errors, logical gaps, missing tradeoffs, overconfident claims,",
        "  overlooked failure modes, incomplete coverage, ambiguous framing.",
        "- Prefer non-obvious issues over surface-level style nitpicks.",
        "- Look for what a careful, domain-expert reader would immediately spot.",
        "- Do NOT rewrite the answer or suggest how to improve phrasing.",
        "- Do NOT include praise or filler.",
        "- Do NOT repeat the question back.",
        "- Assign each issue a unique short id (e.g. \"i1\", \"i2\", ...).",
        "",
        "ORIGINAL REQUEST:",
        user_query.strip(),
        "",
        "CANDIDATE ANSWER TO EVALUATE:",
        draft_text.strip(),
        "",
        "Output strictly valid JSON matching the SkepticOutput schema. No other text.",
        "Every issue must have all required fields: id, title, severity, category,",
        "why_it_matters, suggested_fix, confidence.",
    ])


def build_synth_prompt(user_query: str, draft_text: str, skeptic_output: dict) -> str:
    compact_issues = [
        {
            "id": i["id"],
            "title": i["title"],
            "severity": i["severity"],
            "category": i["category"],
            "confidence": i["confidence"],
            "why_it_matters": i["why_it_matters"][:220],
            "suggested_fix": i["suggested_fix"][:160],
        }
        for i in skeptic_output.get("issues", [])
    ]
    return "\n".join([
        "You are an expert adjudicator reviewing critique of a candidate answer.",
        "Decide what must change and what can be safely dismissed.",
        "",
        "HARD RULES:",
        "- Every issue with severity \"high\" or \"critical\" MUST appear in exactly one of:",
        "  accepted_changes, rejected_criticisms (with explicit non-vague reason),",
        "  or unresolved_risks.",
        "- It cannot silently disappear.",
        "- rejected_criticisms.reason must be a specific argument, not just \"not relevant\".",
        "- rewrite_instructions must be concise directives (not prose paragraphs).",
        "- Do NOT generate any final answer or prose here. Output the SynthDecision JSON ONLY.",
        "- If no critique is worth addressing, set should_rewrite=false and leave accepted_changes empty.",
        # CHANGED: instruct model to use structured issue_id in unresolved_risks
        "- Each unresolved_risks entry must set issue_id to the exact issue id from the critique.",
        "",
        "ORIGINAL REQUEST:",
        user_query.strip(),
        "",
        "CANDIDATE ANSWER EXCERPT (for reference, first 600 chars):",
        draft_text[:600].strip(),
        "",
        "CRITIQUE JSON:",
        json.dumps({"issues": compact_issues}),
        "",
        "Output strictly valid JSON matching the SynthDecision schema. No other text.",
    ])


def build_formatter_prompt(user_query: str, draft_text: str, synth: dict) -> str:
    lines = [
        "Produce the final answer to the request below.",
        "You are improving a candidate answer based on a set of rewrite instructions.",
        "",
        "RULES:",
        "- Apply all rewrite instructions faithfully.",
        "- If any unresolved risks are listed and are relevant to the answer, surface them clearly.",
        "- Do NOT mention the review process, critique, or any internal pipeline.",
        "- Do NOT add unnecessary hedging or caveats beyond what the content genuinely requires.",
        "- Do NOT pad the answer with extra length for completeness theater.",
        "- Do NOT introduce new information that was not present in the original request or draft.",
        "- Output the final answer only. No preamble.",
        "",
        "ORIGINAL REQUEST:",
        user_query.strip(),
        "",
        "CANDIDATE ANSWER (improve this):",
        draft_text.strip(),
    ]

    rewrite_instructions = synth.get("rewrite_instructions", [])
    if rewrite_instructions:
        lines.append("")
        lines.append("REWRITE INSTRUCTIONS (apply all):")
        for idx, inst in enumerate(rewrite_instructions, 1):
            lines.append(f"{idx}. {inst.strip()}")
    else:
        lines.append("")
        lines.append("No rewrite instructions. The candidate answer was deemed acceptable.")
        lines.append("Return it cleanly without additions or alterations.")

    # CHANGED: unresolved_risks is now [{issue_id, description}]; extract description
    unresolved_risks = synth.get("unresolved_risks", [])
    if unresolved_risks:
        lines.append("")
        lines.append("UNRESOLVED RISKS (surface in your answer if directly relevant):")
        for risk in unresolved_risks:
            desc = risk.get("description", str(risk)) if isinstance(risk, dict) else str(risk)
            lines.append(f"- {desc.strip()}")

    lines.append("")
    lines.append("Now produce the final answer.")
    return "\n".join(lines)


# ── Google API helpers ─────────────────────────────────────────────────────────

def call_generate_text(model: Any, prompt: str, max_tokens: int = 1500) -> tuple[str, dict]:
    """Non-streaming text generation. Returns (text, tokens_dict)."""
    result = model.generate_content(
        prompt,
        generation_config=GenerationConfig(max_output_tokens=max_tokens),
    )
    return result.text, _extract_tokens_from_result(result)


def call_generate_json(
    model: Any, prompt: str, schema: dict, max_tokens: int = 1024
) -> tuple[dict, dict]:
    """Non-streaming JSON generation. Returns (parsed_dict, tokens_dict)."""
    result = model.generate_content(
        prompt,
        generation_config=GenerationConfig(
            max_output_tokens=max_tokens,
            response_mime_type="application/json",
            response_schema=schema,
        ),
    )
    return json.loads(result.text), _extract_tokens_from_result(result)


# ── SMD pipeline ──────────────────────────────────────────────────────────────

def run_smd_pipeline(model: Any, user_query: str, model_name: str = "") -> dict:
    """
    Run all four SMD stages. Returns metadata including per-stage token counts.
    model_name is used for model-aware cost estimation.
    Raises on any stage failure — caller should catch and fall back.
    """
    t_start = time.time()

    # Stage 1: Draft
    draft_text, tok_draft = call_generate_text(
        model, build_draft_prompt(user_query), max_tokens=1500
    )
    t_draft = time.time()

    # Stage 2: Skeptic (structured JSON)
    skeptic_output, tok_skeptic = call_generate_json(
        model,
        build_skeptic_prompt(user_query, draft_text),
        schema=SKEPTIC_RESPONSE_SCHEMA,
        max_tokens=1024,
    )
    t_skeptic = time.time()

    # Stage 3: SynthDecision (structured JSON)
    synth_output, tok_synth = call_generate_json(
        model,
        build_synth_prompt(user_query, draft_text, skeptic_output),
        schema=SYNTH_RESPONSE_SCHEMA,
        max_tokens=1024,
    )
    t_synth = time.time()

    # Survival audit — HARDENED: exact issue_id matching only, no fuzzy text search
    issues = skeptic_output.get("issues", [])
    high_critical_ids = {i["id"] for i in issues if i["severity"] in ("high", "critical")}
    accepted_ids = {ac["issue_id"] for ac in synth_output.get("accepted_changes", [])}
    rejected_ids = {rc["issue_id"] for rc in synth_output.get("rejected_criticisms", [])}
    unresolved_ids = {
        ur["issue_id"]
        for ur in synth_output.get("unresolved_risks", [])
        if isinstance(ur, dict) and ur.get("issue_id")
    }
    missing_ids = [
        iid for iid in high_critical_ids
        if iid not in accepted_ids
        and iid not in rejected_ids
        and iid not in unresolved_ids
    ]

    # Stage 4: Formatter
    final_text, tok_formatter = call_generate_text(
        model,
        build_formatter_prompt(user_query, draft_text, synth_output),
        max_tokens=2000,
    )
    t_formatter = time.time()

    stage_tokens = {
        "draft": tok_draft,
        "skeptic": tok_skeptic,
        "synth": tok_synth,
        "formatter": tok_formatter,
    }
    total_tokens = {
        "prompt": sum(t["prompt"] for t in stage_tokens.values()),
        "output": sum(t["output"] for t in stage_tokens.values()),
        "total": sum(t["total"] for t in stage_tokens.values()),
    }

    return {
        "final_text": final_text,
        "draft_text": draft_text,
        "skeptic_output": skeptic_output,
        "synth_output": synth_output,
        "issue_count": len(issues),
        "high_critical_count": len(high_critical_ids),
        "unresolved_risk_count": len(synth_output.get("unresolved_risks", [])),
        "high_critical_survival_violations": missing_ids,
        "should_rewrite": synth_output.get("should_rewrite", False),
        "timings_s": {
            "draft": round(t_draft - t_start, 2),
            "skeptic": round(t_skeptic - t_draft, 2),
            "synth": round(t_synth - t_skeptic, 2),
            "formatter": round(t_formatter - t_synth, 2),
            "total": round(t_formatter - t_start, 2),
        },
        "tokens": stage_tokens,
        "tokens_total": total_tokens,
        "cost_usd": estimate_cost(total_tokens, model_name),
    }


# Judge calls go through JudgeClient (imported from judge_providers)


# ── Summary ────────────────────────────────────────────────────────────────────

def build_summary(
    results: list[dict],
    run_id: str,
    pipeline_model: str,
    judge_model_name: str,
    seed: int,
    raw_out_path: Path,
) -> str:
    ok = [r for r in results if r.get("status") == "ok"]
    errors = len(results) - len(ok)
    ok_count = len(ok)

    wins: dict[str, int] = {"smd": 0, "baseline": 0, "tie": 0}
    for r in ok:
        wins[r.get("winner", "tie")] = wins.get(r.get("winner", "tie"), 0) + 1

    def pct(n: int) -> str:
        return f"{n / ok_count * 100:.1f}%" if ok_count else "—"

    # Position bias: split by A/B assignment
    a_baseline = [r for r in ok if r.get("a_is_baseline") is True]
    a_smd = [r for r in ok if r.get("a_is_baseline") is False]
    smd_wins_when_a_base = sum(1 for r in a_baseline if r.get("winner") == "smd")
    smd_wins_when_a_smd = sum(1 for r in a_smd if r.get("winner") == "smd")

    # Token totals
    baseline_tok = sum(r.get("tokens_baseline", {}).get("total", 0) for r in ok)
    smd_tok = sum(r.get("tokens_smd_total", {}).get("total", 0) for r in ok)
    judge_tok = sum(r.get("tokens_judge", {}).get("total", 0) for r in ok)
    tok_mult = smd_tok / baseline_tok if baseline_tok else 0.0

    # Cost totals
    baseline_cost = sum(r.get("cost_baseline_usd", 0.0) for r in ok)
    smd_cost = sum(r.get("cost_smd_usd", 0.0) for r in ok)
    judge_cost = sum(r.get("cost_judge_usd", 0.0) for r in ok)

    # Word counts
    def wc(text: str) -> int:
        return len(text.split()) if text else 0

    baseline_wcs = [wc(r.get("baseline_text", "")) for r in ok]
    smd_wcs = [wc(r.get("smd_final_text", "")) for r in ok]
    avg_base_wc = statistics.mean(baseline_wcs) if baseline_wcs else 0
    avg_smd_wc = statistics.mean(smd_wcs) if smd_wcs else 0
    wc_delta_pct = (avg_smd_wc / avg_base_wc - 1) * 100 if avg_base_wc else 0

    # Skeptic stats
    should_rewrite_n = sum(1 for r in ok if r.get("smd_should_rewrite"))
    zero_issue_n = sum(1 for r in ok if r.get("smd_issue_count", -1) == 0)
    hc_prompt_n = sum(1 for r in ok if r.get("smd_high_critical_count", 0) > 0)
    violations = [r for r in ok if r.get("smd_survival_violations")]

    # Per-category
    cat_wins: dict = defaultdict(lambda: {"smd": 0, "baseline": 0, "tie": 0, "errors": 0})
    for r in results:
        cat = r.get("category", "unknown")
        if r.get("status") == "error":
            cat_wins[cat]["errors"] += 1
        else:
            w = r.get("winner", "tie")
            cat_wins[cat][w] = cat_wins[cat].get(w, 0) + 1

    lines = [
        "SMD v1.1 Light — Eval Summary (v2)",
        f"Run ID:         {run_id}",
        f"Pipeline model: {pipeline_model}",
        f"Judge model:    {judge_model_name}",
        f"RNG seed:       {seed}",
        f"Prompts:        {len(results)} | OK: {ok_count} | Errors: {errors}",
        "",
        "== OVERALL RESULTS ==",
        f"  SMD wins:      {wins['smd']:3d} / {ok_count}  ({pct(wins['smd'])})",
        f"  Baseline wins: {wins['baseline']:3d} / {ok_count}  ({pct(wins['baseline'])})",
        f"  Ties:          {wins['tie']:3d} / {ok_count}  ({pct(wins['tie'])})",
        "",
        "== POSITION BIAS CHECK ==",
        f"  A=baseline prompts: {len(a_baseline):2d}  →  SMD won {smd_wins_when_a_base} "
        f"({smd_wins_when_a_base/len(a_baseline)*100:.1f}%)" if a_baseline else "  A=baseline: N/A",
        f"  A=SMD prompts:      {len(a_smd):2d}  →  SMD won {smd_wins_when_a_smd} "
        f"({smd_wins_when_a_smd/len(a_smd)*100:.1f}%)" if a_smd else "  A=SMD: N/A",
        "  (>10pp difference between the two indicates position bias)",
        "",
        "== SKEPTIC STATS ==",
        f"  should_rewrite=true:    {should_rewrite_n:3d} / {ok_count}  ({pct(should_rewrite_n)})",
        f"  Zero-issue runs:        {zero_issue_n:3d} / {ok_count}  ({pct(zero_issue_n)})",
        f"  Prompts with hc issue:  {hc_prompt_n:3d} / {ok_count}  ({pct(hc_prompt_n)})",
        f"  Survival violations:    {len(violations):3d} / {ok_count}",
        "",
        "== WORD COUNT ==",
        f"  Baseline avg: {avg_base_wc:.0f} words",
        f"  SMD avg:      {avg_smd_wc:.0f} words",
        f"  Delta:        {avg_smd_wc - avg_base_wc:+.0f} words ({wc_delta_pct:+.1f}%)",
        "",
        "== TOKEN USAGE ==",
        f"  Baseline total:        {baseline_tok:>9,}",
        f"  SMD pipeline total:    {smd_tok:>9,}",
        f"  Judge total:           {judge_tok:>9,}",
        f"  Grand total:           {baseline_tok + smd_tok + judge_tok:>9,}",
        f"  SMD/Baseline multiplier: {tok_mult:.1f}x",
        "",
        f"== COST ESTIMATE (USD) ==",
        f"  Pipeline ({pipeline_model}): "
        f"${get_pricing(pipeline_model)[0]}/M in  ${get_pricing(pipeline_model)[1]}/M out",
        f"  Judge    ({judge_model_name}): "
        f"${get_pricing(judge_model_name)[0]}/M in  ${get_pricing(judge_model_name)[1]}/M out",
        f"  Baseline:  ${baseline_cost:.4f}",
        f"  SMD:       ${smd_cost:.4f}",
        f"  Judge:     ${judge_cost:.4f}",
        f"  Run total: ${baseline_cost + smd_cost + judge_cost:.4f}",
        "",
        "== PER-CATEGORY BREAKDOWN ==",
    ]
    for cat, counts in sorted(cat_wins.items()):
        lines.append(
            f"  {cat:30s}  smd={counts.get('smd',0)} "
            f"baseline={counts.get('baseline',0)} "
            f"tie={counts.get('tie',0)} err={counts.get('errors',0)}"
        )

    lines += [
        "",
        "== HIGH/CRITICAL SURVIVAL VIOLATIONS ==",
        f"  Prompts with violations: {len(violations)} / {ok_count}",
    ]
    for r in violations:
        lines.append(f"  {r['prompt_id']:10s}  violations={r['smd_survival_violations']}")

    lines += ["", f"Raw output: {raw_out_path}"]
    return "\n".join(lines)


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="SMD v1.1 Light — Local Eval Harness (v2)")
    parser.add_argument("--api-key", required=True, help="Google Generative AI API key")
    parser.add_argument("--prompts", default="prompts_general.jsonl")
    parser.add_argument("--judge-prompt", default="judge_prompt.txt")
    parser.add_argument("--out", default="results")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--model", default="gemini-2.0-flash-001",
                        help="Pipeline model (Draft/Skeptic/Synth/Formatter)")
    parser.add_argument("--judge-provider", default="gemini",
                        choices=["gemini", "external"],
                        help="Judge provider: 'gemini' (live API) or 'external' (--scores-file)")
    parser.add_argument("--judge-model", default="gemini-2.0-flash-001",
                        help="Judge model name (gemini provider only)")
    parser.add_argument("--scores-file", default="",
                        help="Pre-computed scores JSONL (external provider only)")
    parser.add_argument("--delay-s", type=float, default=2.0)
    parser.add_argument("--seed", type=int, default=None,
                        help="RNG seed for A/B assignment (default: current epoch second)")
    args = parser.parse_args()

    # Seeded RNG — deterministic, logged, reproducible
    seed = args.seed if args.seed is not None else int(time.time())
    rng = random.Random(seed)

    genai.configure(api_key=args.api_key)

    prompts_path = Path(args.prompts)
    if not prompts_path.exists():
        print(f"ERROR: prompts file not found: {prompts_path}")
        sys.exit(1)
    prompts = [json.loads(ln) for ln in prompts_path.read_text().splitlines() if ln.strip()]
    if args.limit > 0:
        prompts = prompts[: args.limit]

    judge_template_path = Path(args.judge_prompt)
    if not judge_template_path.exists():
        print(f"ERROR: judge prompt not found: {judge_template_path}")
        sys.exit(1)
    judge_template = judge_template_path.read_text(encoding="utf-8")

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    raw_out_path = out_dir / f"raw_{run_id}.jsonl"
    summary_path = out_dir / f"summary_{run_id}.txt"

    # Pipeline model (google-generativeai)
    pipeline_model_obj = genai.GenerativeModel(args.model)

    # Judge client — provider-agnostic
    judge_client = build_judge_client(
        provider=args.judge_provider,
        model_name=args.judge_model,
        api_key=args.api_key,
        scores_file=args.scores_file,
    )
    judge_display = judge_client.display_name

    print(f"SMD Eval v2 — {len(prompts)} prompts")
    print(f"  Pipeline model:  {args.model}")
    print(f"  Judge provider:  {args.judge_provider}")
    print(f"  Judge model:     {judge_display}")
    print(f"  RNG seed:        {seed}")
    print(f"  Output:          {out_dir}")
    print("")

    results: list[dict[str, Any]] = []
    wins_baseline = wins_smd = ties = errors = 0

    with open(raw_out_path, "w", encoding="utf-8") as raw_f:
        for idx, prompt_entry in enumerate(prompts):
            prompt_id = prompt_entry.get("id", f"p{idx+1}")
            category = prompt_entry.get("category", "unknown")
            user_query = prompt_entry["prompt"]

            print(f"[{idx+1}/{len(prompts)}] {prompt_id} ({category}) ... ", end="", flush=True)

            record: dict[str, Any] = {
                "prompt_id": prompt_id,
                "category": category,
                "query": user_query,
                "run_id": run_id,
                "pipeline_model": args.model,
                "judge_provider": args.judge_provider,
                "judge_model": judge_display,
                "rng_seed": seed,
            }

            try:
                # Baseline
                t0 = time.time()
                baseline_text, tok_baseline = call_generate_text(
                    pipeline_model_obj, build_draft_prompt(user_query), max_tokens=1500
                )
                baseline_latency = round(time.time() - t0, 2)

                # SMD pipeline
                smd = run_smd_pipeline(pipeline_model_obj, user_query, model_name=args.model)

                # A/B assignment: seeded random, logged per record
                a_is_baseline: bool = rng.random() < 0.5
                response_a = baseline_text if a_is_baseline else smd["final_text"]
                response_b = smd["final_text"] if a_is_baseline else baseline_text

                judgment, tok_judge = judge_client.score(
                    prompt_id, user_query, response_a, response_b,
                    judge_template=judge_template,
                )

                winner = decode_winner(judgment.get("winner", "tie"), a_is_baseline)

                if winner == "baseline":
                    wins_baseline += 1
                elif winner == "smd":
                    wins_smd += 1
                else:
                    ties += 1

                cost_base = estimate_cost(tok_baseline, args.model)
                cost_judge = estimate_cost(tok_judge, judge_display)
                tok_mult = (
                    smd["tokens_total"]["total"] / max(tok_baseline["total"], 1)
                )

                record.update({
                    "status": "ok",
                    "baseline_text": baseline_text,
                    "baseline_latency_s": baseline_latency,
                    "tokens_baseline": tok_baseline,
                    "cost_baseline_usd": cost_base,
                    "smd_final_text": smd["final_text"],
                    "smd_draft_text": smd["draft_text"],
                    "smd_skeptic_output": smd["skeptic_output"],
                    "smd_synth_output": smd["synth_output"],
                    "smd_timings_s": smd["timings_s"],
                    "smd_issue_count": smd["issue_count"],
                    "smd_high_critical_count": smd["high_critical_count"],
                    "smd_unresolved_risk_count": smd["unresolved_risk_count"],
                    "smd_survival_violations": smd["high_critical_survival_violations"],
                    "smd_should_rewrite": smd["should_rewrite"],
                    "tokens_smd": smd["tokens"],
                    "tokens_smd_total": smd["tokens_total"],
                    "cost_smd_usd": smd["cost_usd"],
                    "judgment": judgment,
                    "tokens_judge": tok_judge,
                    "cost_judge_usd": cost_judge,
                    "a_is_baseline": a_is_baseline,
                    "winner": winner,
                })
                print(
                    f"winner={winner} | issues={smd['issue_count']} hc={smd['high_critical_count']}"
                    f" | {smd['timings_s']['total']}s | tok_mult={tok_mult:.1f}x"
                )

            except Exception as exc:
                errors += 1
                record["status"] = "error"
                record["error"] = str(exc)
                print(f"ERROR: {exc}")

            results.append(record)
            raw_f.write(json.dumps(record, ensure_ascii=False) + "\n")
            raw_f.flush()

            if idx < len(prompts) - 1:
                time.sleep(args.delay_s)

    summary_text = build_summary(
        results, run_id, args.model, judge_display, seed, raw_out_path
    )
    summary_path.write_text(summary_text, encoding="utf-8")

    print("")
    print(summary_text)
    print(f"\nSummary: {summary_path}")
    print(f"Raw:     {raw_out_path}")


if __name__ == "__main__":
    main()
