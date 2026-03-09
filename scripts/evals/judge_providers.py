"""
judge_providers.py
==================
Shared judge client, model-aware pricing, and JUDGE_RESPONSE_SCHEMA.
Imported by smd_eval.py and rejudge.py.

Supported judge providers:
  gemini    — Google Generative AI (default)
  external  — Pre-computed scores from a JSONL file (bypasses live API call)

External scores file format (one JSON object per line):
  {
    "prompt_id": "g001",
    "judgment": {
      "response_a": {"accuracy":9,"completeness":8,"precision":8,"conciseness":9,"risk_coverage":7,"total":41,"notes":"..."},
      "response_b": {"accuracy":9,"completeness":9,"precision":9,"conciseness":8,"risk_coverage":9,"total":44,"notes":"..."},
      "winner": "B",
      "winner_reason": "Response B surfaces more failure modes."
    },
    "a_is_baseline": true     <- required so winner can be decoded to smd/baseline
  }
  OR — if the external tool already decoded the winner:
  {
    "prompt_id": "g001",
    "judgment": { ..., "winner": "smd" },   <- "smd" | "baseline" | "tie"
    "a_is_baseline": true
  }

Generate an external scores file with any tool, then pass it to rejudge.py:
  python rejudge.py --raw results/raw_*.jsonl --judge-provider external \\
                    --scores-file my_claude_scores.jsonl --out results/
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# ── Model-aware pricing table ──────────────────────────────────────────────────
# Format: "model-key" -> (input_USD_per_M, output_USD_per_M)
# Keys are matched as case-insensitive substrings of the model name.
# Checked longest-first so "gpt-4o-mini" beats "gpt-4o".
# Verify prices at provider docs before using cost figures in reports.
MODEL_PRICING: dict[str, tuple[float, float]] = {
    # ── Gemini Flash ────────────────────────────────────────────────────────────
    "gemini-2.0-flash":         (0.075,  0.300),
    "gemini-2.5-flash":         (0.075,  0.300),  # preview; confirm on release
    "gemini-1.5-flash":         (0.075,  0.300),
    # ── Gemini Pro ──────────────────────────────────────────────────────────────
    "gemini-2.5-pro":           (1.250, 10.000),
    "gemini-2.0-pro":           (0.700,  2.100),
    "gemini-1.5-pro":           (1.250,  5.000),
    # ── Anthropic ───────────────────────────────────────────────────────────────
    "claude-opus-4":            (15.00, 75.000),
    "claude-sonnet-4":          ( 3.00, 15.000),
    "claude-haiku-4":           ( 0.80,  4.000),
    # ── OpenAI ──────────────────────────────────────────────────────────────────
    "gpt-4o-mini":              ( 0.15,  0.600),   # must precede "gpt-4o"
    "gpt-4o":                   ( 2.50, 10.000),
    "o3-mini":                  ( 1.10,  4.400),   # must precede "o3"
    "o3":                       (10.00, 40.000),
    "o1-mini":                  ( 1.10,  4.400),   # must precede "o1"
    "o1":                       (15.00, 60.000),
}

# Used when no model key matches — conservative (Flash) assumption
_FALLBACK_PRICING: tuple[float, float] = (0.075, 0.300)

# Keys sorted longest-first so more-specific strings match before shorter ones
_PRICING_KEYS_SORTED = sorted(MODEL_PRICING, key=len, reverse=True)


def get_pricing(model_name: str) -> tuple[float, float]:
    """Return (input_per_M_USD, output_per_M_USD) for a model identifier string."""
    lower = model_name.lower()
    for key in _PRICING_KEYS_SORTED:
        if key in lower:
            return MODEL_PRICING[key]
    return _FALLBACK_PRICING


def estimate_cost(tokens: dict, model_name: str) -> float:
    """Estimate USD cost from a token-count dict and model name."""
    inp, out = get_pricing(model_name)
    return (
        tokens.get("prompt", 0) / 1_000_000 * inp
        + tokens.get("output", 0) / 1_000_000 * out
    )


# ── Shared judge response schema ───────────────────────────────────────────────

JUDGE_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "response_a": {
            "type": "OBJECT",
            "properties": {
                "accuracy":     {"type": "INTEGER"},
                "completeness": {"type": "INTEGER"},
                "precision":    {"type": "INTEGER"},
                "conciseness":  {"type": "INTEGER"},
                "risk_coverage":{"type": "INTEGER"},
                "total":        {"type": "INTEGER"},
                "notes":        {"type": "STRING"},
            },
            "required": [
                "accuracy", "completeness", "precision",
                "conciseness", "risk_coverage", "total", "notes",
            ],
        },
        "response_b": {
            "type": "OBJECT",
            "properties": {
                "accuracy":     {"type": "INTEGER"},
                "completeness": {"type": "INTEGER"},
                "precision":    {"type": "INTEGER"},
                "conciseness":  {"type": "INTEGER"},
                "risk_coverage":{"type": "INTEGER"},
                "total":        {"type": "INTEGER"},
                "notes":        {"type": "STRING"},
            },
            "required": [
                "accuracy", "completeness", "precision",
                "conciseness", "risk_coverage", "total", "notes",
            ],
        },
        "winner":        {"type": "STRING", "enum": ["A", "B", "tie"]},
        "winner_reason": {"type": "STRING"},
    },
    "required": ["response_a", "response_b", "winner", "winner_reason"],
}


# ── JudgeClient ────────────────────────────────────────────────────────────────

class JudgeClient:
    """
    Thin abstraction over judge providers.

    Usage — Gemini (live):
        client = JudgeClient.gemini("gemini-2.5-pro", api_key="...")
        judgment, tokens = client.score(prompt_id, question, resp_a, resp_b)

    Usage — External (pre-computed scores, no API call):
        client = JudgeClient.external("my_claude_scores.jsonl")
        judgment, tokens = client.score(prompt_id, question, resp_a, resp_b)
        # tokens will be {"prompt":0,"output":0,"total":0} — no live call made

    Both return the same (judgment_dict, tokens_dict) tuple so callers are identical.
    """

    def __init__(
        self,
        provider: str,
        model_name: str,
        *,
        _genai_model: Any = None,
        _scores: dict[str, dict] | None = None,
    ) -> None:
        self.provider = provider
        self.model_name = model_name
        self._genai_model = _genai_model   # set for gemini provider
        self._scores = _scores             # set for external provider

    # ── Constructors ───────────────────────────────────────────────────────────

    @classmethod
    def gemini(cls, model_name: str, api_key: str) -> "JudgeClient":
        """Gemini live judge. Requires google-generativeai installed."""
        try:
            import google.generativeai as genai
        except ImportError:
            raise RuntimeError(
                "google-generativeai not installed. Run: pip install google-generativeai"
            )
        genai.configure(api_key=api_key)
        m = genai.GenerativeModel(model_name)
        return cls(provider="gemini", model_name=model_name, _genai_model=m)

    @classmethod
    def external(cls, scores_file: str | Path) -> "JudgeClient":
        """
        External judge — load pre-computed scores from a JSONL file.
        Each line: {"prompt_id": "...", "judgment": {...}, "a_is_baseline": true}
        The judgment dict may use A/B winner labels or decoded smd/baseline/tie labels.
        """
        path = Path(scores_file)
        if not path.exists():
            raise FileNotFoundError(f"External scores file not found: {path}")
        scores: dict[str, dict] = {}
        with open(path, encoding="utf-8") as f:
            for lineno, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ValueError(f"Invalid JSON on line {lineno} of {path}: {exc}")
                pid = entry.get("prompt_id")
                if not pid:
                    raise ValueError(f"Line {lineno} of {path} missing 'prompt_id'")
                if "judgment" not in entry:
                    raise ValueError(f"Line {lineno} of {path} missing 'judgment'")
                scores[pid] = entry
        model_label = f"external:{path.name}"
        return cls(provider="external", model_name=model_label, _scores=scores)

    # ── Core method ────────────────────────────────────────────────────────────

    def score(
        self,
        prompt_id: str,
        question: str,
        response_a: str,
        response_b: str,
        judge_template: str = "",
    ) -> tuple[dict, dict]:
        """
        Returns (judgment_dict, tokens_dict).
        judgment_dict always contains _judge_model and _judge_provider.
        tokens_dict is zeros for external provider.
        """
        if self.provider == "gemini":
            return self._score_gemini(question, response_a, response_b, judge_template)
        if self.provider == "external":
            return self._score_external(prompt_id)
        raise ValueError(f"Unknown provider: {self.provider!r}. Use 'gemini' or 'external'.")

    # ── Provider implementations ───────────────────────────────────────────────

    def _score_gemini(
        self,
        question: str,
        response_a: str,
        response_b: str,
        judge_template: str,
    ) -> tuple[dict, dict]:
        from google.generativeai.types import GenerationConfig

        prompt = (
            judge_template
            .replace("{question}", question)
            .replace("{response_a}", response_a)
            .replace("{response_b}", response_b)
        )
        result = self._genai_model.generate_content(
            prompt,
            generation_config=GenerationConfig(
                max_output_tokens=1024,
                response_mime_type="application/json",
                response_schema=JUDGE_RESPONSE_SCHEMA,
            ),
        )
        judgment = json.loads(result.text)
        tokens = _extract_tokens_from_result(result)
        judgment["_judge_model"] = self.model_name
        judgment["_judge_provider"] = "gemini"
        return judgment, tokens

    def _score_external(self, prompt_id: str) -> tuple[dict, dict]:
        assert self._scores is not None
        entry = self._scores.get(prompt_id)
        if entry is None:
            raise KeyError(
                f"prompt_id '{prompt_id}' not found in external scores. "
                f"Available: {sorted(self._scores)[:5]}..."
            )
        judgment = dict(entry["judgment"])
        judgment["_judge_model"] = self.model_name
        judgment["_judge_provider"] = "external"
        # Expose the a_is_baseline from the scores file so callers can decode winner
        judgment["_external_a_is_baseline"] = entry.get("a_is_baseline")
        zero_tokens: dict = {"prompt": 0, "output": 0, "total": 0}
        return judgment, zero_tokens

    # ── Helpers ────────────────────────────────────────────────────────────────

    @property
    def display_name(self) -> str:
        return self.model_name

    @property
    def pricing(self) -> tuple[float, float]:
        """Return (input_per_M, output_per_M) for this judge model."""
        return get_pricing(self.model_name)


def _extract_tokens_from_result(result: Any) -> dict:
    """Extract token counts from a google-generativeai response object."""
    um = getattr(result, "usage_metadata", None)
    if um is None:
        return {"prompt": 0, "output": 0, "total": 0}
    return {
        "prompt": getattr(um, "prompt_token_count", 0) or 0,
        "output": getattr(um, "candidates_token_count", 0) or 0,
        "total":  getattr(um, "total_token_count",     0) or 0,
    }


def decode_winner(raw_winner: str, a_is_baseline: bool) -> str:
    """Convert A/B/tie label to smd/baseline/tie using the A/B assignment."""
    if raw_winner in ("smd", "baseline", "tie"):
        return raw_winner  # already decoded (e.g. from external scores)
    if raw_winner == "tie":
        return "tie"
    if (raw_winner == "A" and a_is_baseline) or (raw_winner == "B" and not a_is_baseline):
        return "baseline"
    return "smd"


def build_judge_client(
    provider: str,
    model_name: str,
    api_key: str = "",
    scores_file: str | Path = "",
) -> JudgeClient:
    """
    Factory used by CLI scripts.
      provider="gemini"   -> JudgeClient.gemini(model_name, api_key)
      provider="external" -> JudgeClient.external(scores_file)
    """
    if provider == "gemini":
        if not api_key:
            raise ValueError("--api-key is required for gemini provider")
        return JudgeClient.gemini(model_name, api_key)
    if provider == "external":
        if not scores_file:
            raise ValueError("--scores-file is required for external provider")
        return JudgeClient.external(scores_file)
    raise ValueError(f"Unknown --judge-provider '{provider}'. Use: gemini, external")
