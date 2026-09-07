#!/usr/bin/env python3
"""Valida o schema e a sanidade de um model.json do AVM-SP. Só stdlib.

Uso: python3 scripts/validate_model.py [caminho]  (default: site/assets/model.json)
Sai com código 1 e lista os problemas se algo falhar.
"""
from __future__ import annotations

import itertools
import json
import math
import re
import sys
from pathlib import Path

VARIABLE_ORDER = ["area", "age", "pattern", "fiscal"]
NUMERIC_GROUPS = {
    "area": ["log_area", "log_area2", "log_area3"],
    "age": ["age", "age2"],
    "fiscal": ["log_fiscal", "log_fiscal2"],
}
TOP_KEYS = [
    "version", "trained_at", "reference_date", "default_model_key", "variable_order",
    "variable_definitions", "applicability", "models", "patterns", "hyperparameters", "libraries",
    "source", "pgv_source", "metrics", "eda", "cep3_stats", "cep4_stats", "feature_effects",
]
METRIC_RANGES = {  # faixa sã: fora disso o treino deu errado ou a base mudou demais
    "r2_log": (-0.5, 0.999),  # subconjuntos como "age" explicam quase nada; o default é checado à parte
    "mape_pct": (1.0, 100.0),
    "med_ape_pct": (1.0, 100.0),
    "interval_80_coverage_pct": (70.0, 90.0),
    "mae_brl": (1_000.0, 1_000_000.0),
    "rmse_brl": (1_000.0, 2_000_000.0),
}
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def finite(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def validate(m: dict) -> list[str]:
    problems: list[str] = []
    bad = problems.append

    for key in TOP_KEYS:
        if key not in m:
            bad(f"chave top-level ausente: {key}")
    if problems:
        return problems

    if not isinstance(m["version"], str) or not m["version"]:
        bad("version vazio")
    for key in ("trained_at", "reference_date"):
        if not isinstance(m[key], str) or not ISO_DATE.match(m[key]):
            bad(f"{key} não é data ISO: {m[key]!r}")
    if m["variable_order"] != VARIABLE_ORDER:
        bad(f"variable_order inesperado: {m['variable_order']}")

    expected_keys = {
        "+".join(s)
        for n in range(1, len(VARIABLE_ORDER) + 1)
        for s in itertools.combinations(VARIABLE_ORDER, n)
    }
    models = m["models"]
    if set(models) != expected_keys:
        bad(f"models deveria ter exatamente as 15 combinações; faltam {sorted(expected_keys - set(models))}, sobram {sorted(set(models) - expected_keys)}")
    if m["default_model_key"] not in models:
        bad(f"default_model_key {m['default_model_key']!r} não está em models")

    for key, model in models.items():
        subset = key.split("+")
        where = f"models[{key}]"
        if model.get("variables") != subset:
            bad(f"{where}.variables != {subset}")
        if not finite(model.get("intercept")):
            bad(f"{where}.intercept não é número finito")
        num = model.get("numeric") or {}
        expected_features = [f for v in subset for f in NUMERIC_GROUPS.get(v, [])]
        if num.get("features") != expected_features:
            bad(f"{where}.numeric.features != {expected_features}")
        lengths = {k: len(num.get(k) or []) for k in ("features", "means", "scales", "coefficients")}
        if len(set(lengths.values())) != 1:
            bad(f"{where}.numeric arrays com comprimentos diferentes: {lengths}")
        for name in ("means", "scales", "coefficients"):
            if not all(finite(x) for x in num.get(name) or []):
                bad(f"{where}.numeric.{name} contém valor não finito")
        if any(s <= 0 for s in num.get("scales") or [] if finite(s)):
            bad(f"{where}.numeric.scales contém escala <= 0")
        cats = model.get("category_coefficients")
        if "pattern" in subset:
            pattern_coefs = (cats or {}).get("pattern")
            if not isinstance(pattern_coefs, dict) or not pattern_coefs:
                bad(f"{where}.category_coefficients.pattern ausente ou vazio")
            elif not all(finite(v) for v in pattern_coefs.values()):
                bad(f"{where}.category_coefficients.pattern com valor não finito")
        elif cats not in ({}, None):
            bad(f"{where}.category_coefficients deveria ser vazio sem 'pattern'")
        q = model.get("conformal_q80_log")
        if not finite(q) or not (0 < q < 2):
            bad(f"{where}.conformal_q80_log fora de (0, 2): {q!r}")
        metrics = model.get("metrics") or {}
        for name, (lo, hi) in METRIC_RANGES.items():
            value = metrics.get(name)
            if not finite(value) or not (lo <= value <= hi):
                bad(f"{where}.metrics.{name} fora de [{lo}, {hi}]: {value!r}")
        if not isinstance(metrics.get("test_rows"), int) or metrics["test_rows"] < 100:
            bad(f"{where}.metrics.test_rows < 100: {metrics.get('test_rows')!r}")
        if finite(metrics.get("mae_brl")) and finite(metrics.get("rmse_brl")) and metrics["rmse_brl"] < metrics["mae_brl"]:
            bad(f"{where}.metrics rmse < mae")

    default_metrics = models.get(m["default_model_key"], {}).get("metrics") or {}
    if m["metrics"] != default_metrics:
        bad("metrics top-level difere das metrics do modelo default")
    if not finite(default_metrics.get("r2_log")) or default_metrics["r2_log"] < 0.5:
        bad(f"modelo default com r2_log < 0.5: {default_metrics.get('r2_log')!r}")
    if not finite(default_metrics.get("mape_pct")) or default_metrics["mape_pct"] > 40:
        bad(f"modelo default com mape_pct > 40: {default_metrics.get('mape_pct')!r}")

    patterns = m["patterns"]
    if not isinstance(patterns, list) or not patterns:
        bad("patterns vazio")
    else:
        for item in patterns:
            if not (isinstance(item.get("code"), int) and 20 <= item["code"] <= 25 and item.get("label") and isinstance(item.get("n"), int)):
                bad(f"patterns com item inválido: {item}")
        default_cats = set(models.get(m["default_model_key"], {}).get("category_coefficients", {}).get("pattern", {}))
        listed = {str(p.get("code")) for p in patterns}
        if default_cats and not default_cats <= listed:
            bad(f"categorias do modelo default sem entrada em patterns: {sorted(default_cats - listed)}")

    nominal = m["hyperparameters"].get("interval_nominal_coverage_pct")
    if not isinstance(nominal, int) or not (50 <= nominal <= 99):
        bad(f"hyperparameters.interval_nominal_coverage_pct ausente ou fora de [50, 99]: {nominal!r}")
    for lib in ("python", "pandas", "numpy", "scikit_learn"):
        if not isinstance(m["libraries"].get(lib), str) or not m["libraries"][lib]:
            bad(f"libraries.{lib} ausente")
    for src in ("source", "pgv_source"):
        if not SHA256.match(str(m[src].get("sha256", ""))):
            bad(f"{src}.sha256 não é sha256 hex")
        if not m[src].get("file"):
            bad(f"{src}.file ausente")

    eda = m["eda"]
    parts = [eda.get(k) for k in ("rows_train", "rows_calibration", "rows_test")]
    if not all(isinstance(p, int) for p in parts) or sum(parts) != eda.get("rows_model"):
        bad(f"eda.rows_model != treino+calibração+teste: {eda.get('rows_model')} vs {parts}")
    if not isinstance(eda.get("rows_model"), int) or eda["rows_model"] < 1_000:
        bad(f"eda.rows_model muito pequeno: {eda.get('rows_model')!r}")
    for key in ("cep3_stats", "cep4_stats"):
        if not isinstance(m[key], dict) or not m[key]:
            bad(f"{key} vazio")

    app = m["applicability"]
    for key in ("area_m2", "year_built", "age_years", "price_brl", "price_m2_brl", "fiscal_vm2t_brl"):
        rng = app.get(key)
        if not (isinstance(rng, list) and len(rng) == 2 and all(finite(x) for x in rng) and rng[0] < rng[1]):
            bad(f"applicability.{key} deveria ser [min, max] com min < max: {rng!r}")
    if not isinstance(app.get("base_year"), int) or app["base_year"] != app.get("year_built", [0, 0])[1]:
        bad("applicability.base_year deveria ser igual a year_built[1]")
    codes = app.get("pattern_codes")
    if not (isinstance(codes, list) and codes and all(isinstance(c, int) for c in codes)):
        bad(f"applicability.pattern_codes inválido: {codes!r}")
    elif patterns and set(codes) != {p.get("code") for p in patterns}:
        bad("applicability.pattern_codes difere dos códigos em patterns")
    return problems


def main(argv: list[str]) -> int:
    path = Path(argv[1]) if len(argv) > 1 else Path("site/assets/model.json")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"ERRO: não foi possível ler {path}: {error}")
        return 1
    problems = validate(payload)
    if problems:
        print(f"model.json INVÁLIDO ({path}): {len(problems)} problema(s)")
        for p in problems:
            print(f" - {p}")
        return 1
    print(f"model.json OK: {path} · {payload['version']} · treinado em {payload['trained_at']} · {len(payload['models'])} modelos")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
