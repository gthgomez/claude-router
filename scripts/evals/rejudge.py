#!/usr/bin/env python3
"""
SMD v1.1 Light — Rejudge Utility
===================================
Re-score an existing raw_*.jsonl file with a different judge model, prompt, or provider.
Does NOT re-run generation. Reads baseline_text and smd_final_text from the raw file.

Usage — live Gemini judge:
    python rejudge.py \\
        --api-key YOUR_KEY \\
        --raw results/raw_20260308T223112Z.jsonl \\
        --judge-model gemini-2.5-pro \\
        --out results/

Usage — external pre-computed scores (no API call):
    python rejudge.py \\
        --raw results/raw_20260308T223112Z.jsonl \\
        --judge-provider external \\
        --scores-file my_claude_scores.jsonl \\
        --out results/

Flags:
    --preserve-ab   (default: True)  Keep original A/B assignment for apples-to-apples comparison.
    --no-preserve-ab                 Re-randomize A/B with --seed (tests position sensitivity).

Output:
    results/rejudge_<judge>_<run-id>.jsonl   — per-prompt records with rejudge_* fields added
    results/rejudge_<judge>_<run-id>.txt     — agreement summary vs original judge
"""

import argparse
import json
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from judge_providers import (
    JudgeClient,
    build_judge_client,
    decode_winner,
    estimate_cost,
)

try:
    import google.generativeai as genai
except ImportError:
    genai = None  # only needed for gemini provider


def main() -> None:
    parser = argparse.ArgumentParser(description="SMD Rejudge — rescore existing raw output")
    parser.add_argument("--api-key", default="",
                        help="API key (required for gemini provider)")
    parser.add_argument("--raw", required=True,
                        help="Path to raw_*.jsonl file to rescore")
    parser.add_argument("--judge-prompt", default="judge_prompt.txt")
    parser.add_argument("--judge-provider", default="gemini",
                        choices=["gemini", "external"],
                        help="Judge provider: 'gemini' (live) or 'external' (--scores-file)")
    parser.add_argument("--judge-model", default="gemini-2.0-flash-001",
                        help="Model name for gemini provider")
    parser.add_argument("--scores-file", default="",
                        help="Pre-computed scores JSONL for external provider. "
                             "See judge_providers.py for the expected format.")
    parser.add_argument("--out", default="results")
    parser.add_argument("--delay-s", type=float, default=2.0,
                        help="Delay between API calls (gemini provider only)")
    # Default is preserve-ab=True; --no-preserve-ab re-randomizes
    parser.add_argument("--preserve-ab", action=argparse.BooleanOptionalAction, default=True,
                        help="Preserve original A/B assignments (default: True). "
                             "Use --no-preserve-ab to re-randomize.")
    parser.add_argument("--seed", type=int, default=None,
                        help="RNG seed when --no-preserve-ab is set")
    args = parser.parse_args()

    raw_path = Path(args.raw)
    if not raw_path.exists():
        print(f"ERROR: raw file not found: {raw_path}")
        sys.exit(1)

    judge_template_path = Path(args.judge_prompt)
    if not judge_template_path.exists():
        print(f"ERROR: judge prompt not found: {judge_template_path}")
        sys.exit(1)
    judge_template = judge_template_path.read_text(encoding="utf-8")

    records = [
        json.loads(ln)
        for ln in raw_path.read_text().splitlines()
        if ln.strip()
    ]

    seed = args.seed if args.seed is not None else int(time.time())
    rng = random.Random(seed)

    if args.judge_provider == "gemini" and genai is not None:
        genai.configure(api_key=args.api_key)

    judge_client = build_judge_client(
        provider=args.judge_provider,
        model_name=args.judge_model,
        api_key=args.api_key,
        scores_file=args.scores_file,
    )
    judge_display = judge_client.display_name

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    safe_label = judge_display.replace("/", "-").replace(".", "_").replace(":", "-")
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_path = out_dir / f"rejudge_{safe_label}_{run_id}.jsonl"
    summary_path = out_dir / f"rejudge_{safe_label}_{run_id}.txt"

    orig_run_id = records[0].get("run_id", "unknown") if records else "unknown"

    print(f"Rejudge — {len(records)} records from '{raw_path.name}'")
    print(f"  Judge provider: {args.judge_provider}")
    print(f"  Judge model:    {judge_display}")
    print(f"  Preserve A/B:   {args.preserve_ab}")
    if not args.preserve_ab:
        print(f"  RNG seed:       {seed}")
    print(f"  Output:         {out_dir}")
    print("")

    rejudged: list[dict] = []
    wins: dict[str, int] = {"smd": 0, "baseline": 0, "tie": 0}
    judge_tok_total = 0
    judge_cost_total = 0.0
    errors = 0

    with open(out_path, "w", encoding="utf-8") as out_f:
        for idx, r in enumerate(records):
            prompt_id = r.get("prompt_id", f"p{idx+1}")
            category = r.get("category", "unknown")
            print(f"[{idx+1}/{len(records)}] {prompt_id} ({category}) ... ", end="", flush=True)

            if r.get("status") != "ok":
                entry: dict[str, Any] = {**r, "rejudge_status": "skipped_original_error"}
                out_f.write(json.dumps(entry, ensure_ascii=False) + "\n")
                rejudged.append(entry)
                print("SKIP (original had error)")
                continue

            baseline_text = r.get("baseline_text", "")
            smd_text = r.get("smd_final_text", "")
            query = r.get("query", "")

            if not baseline_text or not smd_text:
                entry = {**r, "rejudge_status": "skipped_missing_text"}
                out_f.write(json.dumps(entry, ensure_ascii=False) + "\n")
                rejudged.append(entry)
                print("SKIP (missing text)")
                continue

            try:
                # A/B assignment
                if args.preserve_ab:
                    a_is_baseline = bool(r.get("a_is_baseline", True))
                else:
                    a_is_baseline = rng.random() < 0.5

                response_a = baseline_text if a_is_baseline else smd_text
                response_b = smd_text if a_is_baseline else baseline_text

                judgment, tok_judge = judge_client.score(
                    prompt_id, query, response_a, response_b,
                    judge_template=judge_template,
                )

                # External provider may supply a_is_baseline in the scores file;
                # if it differs from what we set, it wins (the external scorer knew the order).
                ext_ab = judgment.pop("_external_a_is_baseline", None)
                if ext_ab is not None:
                    a_is_baseline = bool(ext_ab)

                winner = decode_winner(judgment.get("winner", "tie"), a_is_baseline)
                wins[winner] = wins.get(winner, 0) + 1

                cost_judge = estimate_cost(tok_judge, judge_display)
                judge_tok_total += tok_judge.get("total", 0)
                judge_cost_total += cost_judge

                entry = {
                    **r,
                    "rejudge_status": "ok",
                    "rejudge_judge_provider": args.judge_provider,
                    "rejudge_judge_model": judge_display,
                    "rejudge_preserve_ab": args.preserve_ab,
                    "rejudge_rng_seed": seed if not args.preserve_ab else None,
                    "rejudge_a_is_baseline": a_is_baseline,
                    "rejudge_judgment": judgment,
                    "rejudge_tokens_judge": tok_judge,
                    "rejudge_cost_judge_usd": cost_judge,
                    "rejudge_winner": winner,
                }
                rejudged.append(entry)
                out_f.write(json.dumps(entry, ensure_ascii=False) + "\n")
                out_f.flush()
                print(f"winner={winner}")

            except Exception as exc:
                errors += 1
                entry = {**r, "rejudge_status": "error", "rejudge_error": str(exc)}
                rejudged.append(entry)
                out_f.write(json.dumps(entry, ensure_ascii=False) + "\n")
                print(f"ERROR: {exc}")

            if idx < len(records) - 1 and args.judge_provider == "gemini":
                time.sleep(args.delay_s)

    ok_count = wins["smd"] + wins["baseline"] + wins["tie"]

    def pct(n: int) -> str:
        return f"{n / ok_count * 100:.1f}%" if ok_count else "—"

    # Agreement vs original judge
    ok_both = [
        r for r in rejudged
        if r.get("status") == "ok" and r.get("rejudge_status") == "ok"
        and r.get("winner") and r.get("rejudge_winner")
    ]
    agreements = sum(1 for r in ok_both if r.get("winner") == r.get("rejudge_winner"))
    disagreements = len(ok_both) - agreements

    summary_lines = [
        "SMD v1.1 Light — Rejudge Summary",
        f"Original run:    {orig_run_id}",
        f"Original file:   {raw_path.name}",
        f"Judge provider:  {args.judge_provider}",
        f"Judge model:     {judge_display}",
        f"Rejudge run:     {run_id}",
        f"Preserve A/B:    {args.preserve_ab}",
        f"RNG seed:        {seed if not args.preserve_ab else 'N/A (preserve-ab)'}",
        f"Records:         {len(records)} | Scored: {ok_count} | Errors: {errors}",
        "",
        "== REJUDGE RESULTS ==",
        f"  SMD wins:      {wins['smd']:3d} / {ok_count}  ({pct(wins['smd'])})",
        f"  Baseline wins: {wins['baseline']:3d} / {ok_count}  ({pct(wins['baseline'])})",
        f"  Ties:          {wins['tie']:3d} / {ok_count}  ({pct(wins['tie'])})",
        "",
        "== JUDGE TOKENS & COST ==",
        f"  Judge total tokens: {judge_tok_total:,}",
        f"  Judge cost:         ${judge_cost_total:.4f}",
        "",
        "== AGREEMENT WITH ORIGINAL JUDGE ==",
        f"  Compared:   {len(ok_both)} records",
        f"  Agree:      {agreements} ({agreements/len(ok_both)*100:.1f}%)" if ok_both else "  N/A",
        f"  Disagree:   {disagreements} ({disagreements/len(ok_both)*100:.1f}%)" if ok_both else "  N/A",
    ]

    if disagreements > 0:
        summary_lines += ["", "  Disagreement details:"]
        for r in ok_both:
            if r.get("winner") != r.get("rejudge_winner"):
                summary_lines.append(
                    f"    {r.get('prompt_id','?'):10s}  "
                    f"orig={r.get('winner','?'):8s} → new={r.get('rejudge_winner','?')}"
                )

    summary_lines += ["", f"Output: {out_path}"]
    summary_text = "\n".join(summary_lines)
    summary_path.write_text(summary_text, encoding="utf-8")

    print("")
    print(summary_text)
    print(f"\nSummary: {summary_path}")
    print(f"Raw:     {out_path}")


if __name__ == "__main__":
    main()
